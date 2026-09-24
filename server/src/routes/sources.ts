import type { FastifyInstance } from 'fastify';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { now, parseLimit } from '../http.js';
import { publicUrl } from '../ingestion/publicHttp.js';
import { paged, readCursor, writeCursor } from './cursor.js';

const kinds = ['rss', 'api', 'web'] as const;
const languages = ['zh-CN', 'en', 'mixed'] as const;
const regions = ['cn', 'intl', 'global'] as const;

function boolQuery(value: unknown, field: string) {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new BusinessError(ErrorCodes.INVALID_SOURCE_FILTER, { field });
  return value === 'true' ? 1 : 0;
}

export function registerSourceRoutes(app: FastifyInstance) {
  app.get('/api/sources', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const limit = parseLimit(query.limit);
    if (query.kind !== undefined && !kinds.includes(query.kind as never)) throw new BusinessError(ErrorCodes.INVALID_SOURCE_FILTER, { field: 'kind' });
    if (query.region !== undefined && !regions.includes(query.region as never)) throw new BusinessError(ErrorCodes.INVALID_SOURCE_FILTER, { field: 'region' });
    const enabled = boolQuery(query.enabled, 'enabled');
    const clauses: string[] = []; const params: unknown[] = [];
    if (query.sourceGroup) { clauses.push('source_group = ?'); params.push(String(query.sourceGroup)); }
    if (query.kind) { clauses.push('kind = ?'); params.push(String(query.kind)); }
    if (query.region) { clauses.push('region = ?'); params.push(String(query.region)); }
    if (enabled !== undefined) { clauses.push('enabled = ?'); params.push(enabled); }
    const cursor = readCursor('sources', query, 1);
    if (cursor) { clauses.push('source_id > ?'); params.push(cursor[0]); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = app.db.prepare(`SELECT source_id sourceId,name,source_group sourceGroup,kind,url,language,region,trust_level trustLevel,enabled,fetch_interval_minutes fetchIntervalMinutes,last_checked_at lastCheckedAt,last_success_at lastSuccessAt,last_error_code lastErrorCode FROM sources ${where} ORDER BY source_id LIMIT ?`).all(...params, limit + 1) as { sourceId: number }[];
    return reply.send({ code: 0, message: 'success', data: paged(rows, limit, (row) => writeCursor('sources', query, [row.sourceId])), requestId: request.id });
  });

  app.post('/api/sources', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const required = ['name', 'sourceGroup', 'kind', 'url', 'language', 'region', 'trustLevel'];
    for (const field of required) if (field !== 'trustLevel' && typeof body[field] !== 'string') throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field });
    if (!(body.name as string).trim() || (body.name as string).length > 100 || !(body.sourceGroup as string).trim() || (body.sourceGroup as string).length > 50) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'name/sourceGroup' });
    if (!kinds.includes(body.kind as never) || !languages.includes(body.language as never) || !regions.includes(body.region as never)) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'enum' });
    if (!Number.isInteger(body.trustLevel) || Number(body.trustLevel) < 1 || Number(body.trustLevel) > 5) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'trustLevel' });
    if (typeof body.url !== 'string') throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'url' });
    if (body.url.length > 2048 || (body.enabled !== undefined && typeof body.enabled !== 'boolean')) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'url/enabled' });
    const url = publicUrl(body.url).toString();
    if (app.db.prepare('SELECT 1 FROM sources WHERE url=?').get(url)) throw new BusinessError(ErrorCodes.DUPLICATE_SOURCE_URL);
    const interval = body.fetchIntervalMinutes === undefined ? 1440 : Number(body.fetchIntervalMinutes);
    if (!Number.isInteger(body.fetchIntervalMinutes ?? 1440) || !Number.isInteger(interval) || interval < 5) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'fetchIntervalMinutes' });
    const createdAt = now();
    await app.fetchSource(url, { maxBytes: 16_384 });
    try {
      const result = app.db.prepare('INSERT INTO sources(name,source_group,kind,url,language,region,trust_level,enabled,fetch_interval_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(body.name, body.sourceGroup, body.kind, url, body.language, body.region, body.trustLevel, body.enabled === false ? 0 : 1, interval, createdAt, createdAt);
      const row = app.db.prepare('SELECT source_id sourceId,name,source_group sourceGroup,kind,url,language,region,trust_level trustLevel,enabled,fetch_interval_minutes fetchIntervalMinutes,last_checked_at lastCheckedAt,last_success_at lastSuccessAt,last_error_code lastErrorCode FROM sources WHERE source_id = ?').get(result.lastInsertRowid);
      app.log.info({ event: 'source.created', requestId: request.id, sourceId: result.lastInsertRowid, kind: body.kind, region: body.region, host: new URL(url).host, trustLevel: body.trustLevel, businessCode: 0 }, 'source created');
      return reply.code(201).send({ code: 0, message: 'success', data: row, requestId: request.id });
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) throw new BusinessError(ErrorCodes.DUPLICATE_SOURCE_URL);
      throw error;
    }
  });

  app.patch('/api/sources/:sourceId', async (request, reply) => {
    const id = Number((request.params as { sourceId: string }).sourceId);
    if (!Number.isInteger(id) || id < 1 || typeof (request.body as Record<string, unknown>)?.enabled !== 'boolean') throw new BusinessError(ErrorCodes.INVALID_REQUEST);
    const body = request.body as { enabled: boolean };
    const source = app.db.prepare('SELECT source_id sourceId,enabled FROM sources WHERE source_id = ?').get(id) as { sourceId: number; enabled: number } | undefined;
    if (!source) throw new BusinessError(ErrorCodes.SOURCE_NOT_FOUND);
    if (!body.enabled && source.enabled === 1) {
      const remaining = app.db.prepare('SELECT count(*) count FROM sources WHERE enabled = 1 AND source_id != ?').get(id) as { count: number };
      if (remaining.count === 0) throw new BusinessError(ErrorCodes.LAST_SOURCE);
    }
    app.db.prepare('UPDATE sources SET enabled = ?, updated_at = ? WHERE source_id = ?').run(body.enabled ? 1 : 0, now(), id);
    const row = app.db.prepare('SELECT source_id sourceId,name,source_group sourceGroup,kind,url,language,region,trust_level trustLevel,enabled,fetch_interval_minutes fetchIntervalMinutes,last_checked_at lastCheckedAt,last_success_at lastSuccessAt,last_error_code lastErrorCode FROM sources WHERE source_id = ?').get(id);
    app.log.info({ event: 'source.enabled_changed', requestId: request.id, sourceId: id, oldEnabled: Boolean(source.enabled), enabled: body.enabled, businessCode: 0 }, 'source enabled changed');
    return reply.send({ code: 0, message: 'success', data: row, requestId: request.id });
  });
}
