import type { FastifyInstance } from 'fastify';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { now, parseLimit, parsePositiveId } from '../http.js';
import { paged, readCursor, writeCursor } from './cursor.js';

const bool = (value: unknown, code: number, field: string) => {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new BusinessError(code as never, { field });
  return value === 'true' ? 1 : 0;
};
const parseJson = (value: unknown, fallback: unknown) => { try { return JSON.parse(String(value ?? '')); } catch { return fallback; } };

function targetExists(app: FastifyInstance, type: string, id: number) {
  const table = type === 'signal' ? 'signals' : type === 'opportunity' ? 'opportunities' : type === 'content_topic' ? 'content_topics' : null;
  const key = type === 'signal' ? 'signal_id' : type === 'opportunity' ? 'opportunity_id' : 'content_topic_id';
  return table && app.db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(id);
}

export function registerResultRoutes(app: FastifyInstance) {
  app.get('/api/discoveries', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    const statuses = ['candidate', 'accepted', 'rejected', 'extract_failed']; const channels = ['source', 'anysearch', 'both'];
    if ((q.status && !statuses.includes(String(q.status))) || (q.channel && !channels.includes(String(q.channel))) || (q.q && String(q.q).length > 200)) throw new BusinessError(ErrorCodes.INVALID_DISCOVERY_FILTER);
    const taskId = q.taskId === undefined ? null : parsePositiveId(String(q.taskId));
    if (taskId && !app.db.prepare('SELECT 1 FROM scan_tasks WHERE task_id=?').get(taskId)) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const status = taskId ? "CASE WHEN d.published_at IS NOT NULL AND d.published_at NOT BETWEEN t.range_from AND t.range_to THEN 'rejected' ELSE d.status END" : 'd.status';
    const rejectionReason = taskId ? "CASE WHEN d.published_at IS NOT NULL AND d.published_at NOT BETWEEN t.range_from AND t.range_to THEN 'outside_scan_range' ELSE d.rejection_reason END" : 'd.rejection_reason';
    const clauses: string[] = []; const params: unknown[] = [];
    if (taskId) { clauses.push('EXISTS (SELECT 1 FROM scan_discoveries sd WHERE sd.discovery_id=d.discovery_id AND sd.task_id=?)'); params.push(taskId); }
    if (q.status) { clauses.push(`${status}=?`); params.push(q.status); }
    if (q.channel) { clauses.push(`EXISTS (SELECT 1 FROM scan_discoveries sd WHERE sd.discovery_id=d.discovery_id AND sd.discovery_channel=? ${taskId ? 'AND sd.task_id=?' : ''})`); params.push(q.channel); if (taskId) params.push(taskId); }
    if (q.publishedAtVerified !== undefined) { clauses.push('d.published_at_verified=?'); params.push(bool(q.publishedAtVerified, ErrorCodes.INVALID_DISCOVERY_FILTER, 'publishedAtVerified')); }
    if (q.q) { clauses.push('(d.title LIKE ? OR d.url LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    const cursor = readCursor('discoveries', q, 2);
    if (cursor) { clauses.push('(d.last_seen_at,d.discovery_id) < (?,?)'); params.push(...cursor); }
    const rows = app.db.prepare(`SELECT d.discovery_id discoveryId,d.title,d.url,d.snippet,s.name sourceName,(SELECT sd.discovery_channel FROM scan_discoveries sd WHERE sd.discovery_id=d.discovery_id ${taskId ? 'AND sd.task_id=?' : ''} ORDER BY sd.task_id DESC LIMIT 1) channel,d.published_at publishedAt,d.published_at_verified publishedAtVerified,${status} status,${rejectionReason} rejectionReason,d.first_seen_at firstSeenAt,d.last_seen_at lastSeenAt FROM raw_discoveries d LEFT JOIN sources s ON s.source_id=d.source_id ${taskId ? 'JOIN scan_tasks t ON t.task_id=?' : ''} ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY d.last_seen_at DESC,d.discovery_id DESC LIMIT ?`).all(...(taskId ? [taskId, taskId] : []), ...params, limit + 1) as { discoveryId: number; lastSeenAt: string }[];
    return reply.send({ code: 0, message: 'success', data: paged(rows, limit, (row) => writeCursor('discoveries', q, [row.lastSeenAt, row.discoveryId])), requestId: request.id });
  });

  app.get('/api/signals', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    const types = ['technology', 'product', 'paper', 'funding', 'company_action', 'use_case', 'open_source', 'market']; const levels = ['single_source', 'multi_source', 'first_party', 'conflicting']; const states = ['active', 'needs_review', 'archived'];
    if ((q.signalType && !types.includes(String(q.signalType))) || (q.evidenceLevel && !levels.includes(String(q.evidenceLevel))) || (q.state && !states.includes(String(q.state))) || (q.sort && !['value', 'newest', 'evidence'].includes(String(q.sort)))) throw new BusinessError(ErrorCodes.INVALID_SIGNAL_FILTER);
    if (q.q && (String(q.q).length > 200 || /["'();]/.test(String(q.q)))) throw new BusinessError(ErrorCodes.INVALID_FTS_QUERY);
    if (q.taskId && !app.db.prepare('SELECT 1 FROM scan_tasks WHERE task_id=?').get(Number(q.taskId))) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.taskId) { clauses.push('EXISTS(SELECT 1 FROM scan_signals ss WHERE ss.signal_id=s.signal_id AND ss.task_id=?)'); params.push(Number(q.taskId)); }
    if (q.signalType) { clauses.push('s.signal_type=?'); params.push(q.signalType); }
    if (q.evidenceLevel) { clauses.push('s.evidence_level=?'); params.push(q.evidenceLevel); }
    if (q.state) { clauses.push('s.state=?'); params.push(q.state); }
    if (q.entityId) { clauses.push('EXISTS(SELECT 1 FROM signal_entities se WHERE se.signal_id=s.signal_id AND se.entity_id=?)'); params.push(Number(q.entityId)); }
    if (q.saved !== undefined) { clauses.push('COALESCE(i.saved,0)=?'); params.push(bool(q.saved, ErrorCodes.INVALID_SIGNAL_FILTER, 'saved')); }
    if (q.ignored !== undefined) { clauses.push('COALESCE(i.ignored,0)=?'); params.push(bool(q.ignored, ErrorCodes.INVALID_SIGNAL_FILTER, 'ignored')); }
    if (q.highlighted !== undefined) { if (!q.taskId) throw new BusinessError(ErrorCodes.INVALID_SIGNAL_FILTER); clauses.push('EXISTS(SELECT 1 FROM scan_signals ss WHERE ss.signal_id=s.signal_id AND ss.task_id=? AND ss.is_highlight=?)'); params.push(Number(q.taskId), bool(q.highlighted, ErrorCodes.INVALID_SIGNAL_FILTER, 'highlighted')); }
    if (q.q) {
      const term = String(q.q).trim();
      if (!term || !/^[\p{L}\p{N}\s-]+$/u.test(term)) throw new BusinessError(ErrorCodes.INVALID_FTS_QUERY);
      const match = term.split(/\s+/).map((part) => `"${part.replaceAll('"', '')}"*`).join(' AND ');
      if (/\p{Script=Han}/u.test(term)) {
        clauses.push('(s.signal_id IN (SELECT rowid FROM signals_fts WHERE signals_fts MATCH ?) OR s.title LIKE ? OR s.summary LIKE ? OR s.search_text LIKE ?)');
        params.push(match, `%${term}%`, `%${term}%`, `%${term}%`);
      } else { clauses.push('s.signal_id IN (SELECT rowid FROM signals_fts WHERE signals_fts MATCH ?)'); params.push(match); }
    }
    const sort = q.sort === 'newest' ? 'newest' : q.sort === 'evidence' ? 'evidence' : 'value';
    const priority = 's.value_score + COALESCE(i.value_rating,0)*10 + CASE WHEN EXISTS(SELECT 1 FROM signal_entities se JOIN entities e ON e.entity_id=se.entity_id WHERE se.signal_id=s.signal_id AND e.followed=1) THEN 10 ELSE 0 END';
    const primarySource = "(SELECT COALESCE(src.name,d.url) FROM signal_sources ev JOIN raw_discoveries d ON d.discovery_id=ev.discovery_id LEFT JOIN sources src ON src.source_id=d.source_id WHERE ev.signal_id=s.signal_id ORDER BY (ev.relation_type='primary') DESC,ev.discovery_id LIMIT 1)";
    const keys = sort === 'newest' ? ["COALESCE(s.event_at,'')", 's.signal_id'] : sort === 'evidence' ? ['s.truth_score', 's.value_score', 's.signal_id'] : [priority, "COALESCE(s.event_at,'')", 's.signal_id'];
    const cursor = readCursor('signals', q, keys.length);
    if (cursor) { clauses.push(`(${keys.join(',')}) < (${keys.map(() => '?').join(',')})`); params.push(...cursor); }
    const rows = (app.db.prepare(`SELECT s.signal_id signalId,s.title,s.summary,s.signal_type signalType,s.tags_text tagsText,${primarySource} sourceName,s.novelty_score noveltyScore,s.truth_score truthScore,s.technology_score technologyScore,s.adoption_score adoptionScore,s.monetization_score monetizationScore,s.content_value_score contentValueScore,s.value_score valueScore,${priority} priorityScore,s.evidence_level evidenceLevel,(SELECT count(*) FROM signal_sources sx WHERE sx.signal_id=s.signal_id) evidenceCount,s.has_conflict hasConflict,COALESCE(json_extract(s.score_explanation_json,'$.publishedAtVerified'),1) publishedAtVerified,s.state,s.event_at eventAt,COALESCE((SELECT ss.is_highlight FROM scan_signals ss WHERE ss.signal_id=s.signal_id ${q.taskId ? 'AND ss.task_id=?' : ''} ORDER BY ss.task_id DESC LIMIT 1),0) isHighlighted,COALESCE(i.saved,0) saved,COALESCE(i.ignored,0) ignored,s.created_at createdAt FROM signals s LEFT JOIN item_states i ON i.target_type='signal' AND i.target_id=s.signal_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${keys.map((key) => `${key} DESC`).join(',')} LIMIT ?`).all(...(q.taskId ? [Number(q.taskId)] : []), ...params, limit + 1) as Record<string, unknown>[]).map((row) => ({ ...row, sourceName: typeof row.sourceName === 'string' && /^https?:\/\//.test(row.sourceName) ? new URL(row.sourceName).hostname : row.sourceName, tags: String(row.tagsText || '').split(',').filter(Boolean) }));
    const position = (row: Record<string, unknown>) => sort === 'newest' ? [String(row.eventAt ?? ''), Number(row.signalId)] : sort === 'evidence' ? [Number(row.truthScore), Number(row.valueScore), Number(row.signalId)] : [Number(row.priorityScore), String(row.eventAt ?? ''), Number(row.signalId)];
    return reply.send({ code: 0, message: 'success', data: paged(rows, limit, (row) => writeCursor('signals', q, position(row))), requestId: request.id });
  });

  app.get('/api/signals/:signalId', async (request, reply) => {
    const id = parsePositiveId((request.params as { signalId: string }).signalId);
    const signal = app.db.prepare('SELECT * FROM signals WHERE signal_id=?').get(id) as Record<string, unknown> | undefined;
    if (!signal) throw new BusinessError(ErrorCodes.SIGNAL_NOT_FOUND);
    const evidence = app.db.prepare("SELECT d.discovery_id discoveryId,ss.relation_type relationType,ss.is_independent isIndependent,d.title,d.url,src.name sourceName,src.trust_level trustLevel,d.published_at publishedAt,d.snippet FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id LEFT JOIN sources src ON src.source_id=d.source_id WHERE ss.signal_id=?").all(id) as Record<string, unknown>[];
    const entities = app.db.prepare('SELECT e.entity_id entityId,e.entity_type entityType,e.name,se.role,e.followed FROM signal_entities se JOIN entities e ON e.entity_id=se.entity_id WHERE se.signal_id=?').all(id);
    const opportunities = app.db.prepare('SELECT opportunity_id opportunityId,title,opportunity_type opportunityType,status,evidence_score evidenceScore FROM opportunities WHERE signal_id=?').all(id);
    const topic = app.db.prepare('SELECT content_topic_id contentTopicId,title,core_viewpoint coreViewpoint,status FROM content_topics WHERE signal_id=?').get(id) ?? null;
    const itemState = app.db.prepare("SELECT saved,ignored,value_rating valueRating FROM item_states WHERE target_type='signal' AND target_id=?").get(id) ?? { saved: 0, ignored: 0, valueRating: 0 };
    return reply.send({ code: 0, message: 'success', data: { signalId: id, title: signal.title, summary: signal.summary, signalType: signal.signal_type, tags: String(signal.tags_text).split(',').filter(Boolean), relevanceScore: signal.relevance_score, noveltyScore: signal.novelty_score, truthScore: signal.truth_score, technologyScore: signal.technology_score, adoptionScore: signal.adoption_score, monetizationScore: signal.monetization_score, contentValueScore: signal.content_value_score, valueScore: signal.value_score, evidenceLevel: signal.evidence_level, hasConflict: signal.has_conflict, state: signal.state, eventAt: signal.event_at, scoreExplanation: parseJson(signal.score_explanation_json, {}), evidence, conflicts: evidence.filter((e: Record<string, unknown>) => e.relationType === 'conflicting'), entities, opportunities, contentTopic: topic, itemState }, requestId: request.id });
  });

  app.patch('/api/signals/:signalId/state', async (request, reply) => {
    const id = parsePositiveId((request.params as { signalId: string }).signalId); const state = (request.body as { state?: unknown })?.state;
    if (typeof state !== 'string') throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'state' });
    if (!['active', 'archived'].includes(String(state))) throw new BusinessError(ErrorCodes.INVALID_SIGNAL_STATE);
    const previous = app.db.prepare('SELECT state FROM signals WHERE signal_id=?').get(id) as { state: string } | undefined;
    if (!previous) throw new BusinessError(ErrorCodes.SIGNAL_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE signals SET state=?,updated_at=? WHERE signal_id=?').run(state, updatedAt, id);
    app.log.info({ event: 'signal.state_changed', requestId: request.id, signalId: id, oldState: previous.state, state, businessCode: 0 }, 'signal state changed');
    return reply.send({ code: 0, message: 'success', data: { signalId: id, state, updatedAt }, requestId: request.id });
  });

  app.put('/api/item-states/:targetType/:targetId', async (request, reply) => {
    const { targetType, targetId } = request.params as { targetType: string; targetId: string }; const id = parsePositiveId(targetId);
    if (!['signal', 'opportunity', 'content_topic'].includes(targetType)) throw new BusinessError(ErrorCodes.INVALID_REQUEST);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!['saved', 'ignored', 'valueRating'].some((key) => key in body)) throw new BusinessError(ErrorCodes.EMPTY_ITEM_STATE);
    if ((body.saved !== undefined && typeof body.saved !== 'boolean') || (body.ignored !== undefined && typeof body.ignored !== 'boolean') || (body.valueRating !== undefined && (typeof body.valueRating !== 'number' || ![-1, 0, 1].includes(body.valueRating)))) throw new BusinessError(ErrorCodes.INVALID_REQUEST);
    const { current, saved, ignored, valueRating, updatedAt } = app.db.transaction(() => {
      if (!targetExists(app, targetType, id)) throw new BusinessError(ErrorCodes.ITEM_NOT_FOUND);
      const current = app.db.prepare('SELECT saved,ignored,value_rating valueRating FROM item_states WHERE target_type=? AND target_id=?').get(targetType, id) as { saved: number; ignored: number; valueRating: number } | undefined;
      const saved = body.saved === undefined ? current?.saved ?? 0 : Number(body.saved); const ignored = body.ignored === undefined ? current?.ignored ?? 0 : Number(body.ignored); const valueRating = body.valueRating === undefined ? current?.valueRating ?? 0 : Number(body.valueRating);
      if (saved && ignored) throw new BusinessError(ErrorCodes.CONTRADICTORY_ITEM_STATE);
      const updatedAt = now(); app.db.prepare('INSERT INTO item_states(target_type,target_id,saved,ignored,value_rating,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(target_type,target_id) DO UPDATE SET saved=excluded.saved,ignored=excluded.ignored,value_rating=excluded.value_rating,updated_at=excluded.updated_at').run(targetType, id, saved, ignored, valueRating, updatedAt);
      return { current, saved, ignored, valueRating, updatedAt };
    })();
    app.log.info({ event: 'item_state.updated', requestId: request.id, targetType, targetId: id, fields: Object.keys(body), oldValues: current ?? { saved: 0, ignored: 0, valueRating: 0 }, newValues: { saved, ignored, valueRating }, businessCode: 0 }, 'item state updated');
    return reply.send({ code: 0, message: 'success', data: { targetType, targetId: id, saved: Boolean(saved), ignored: Boolean(ignored), valueRating, updatedAt }, requestId: request.id });
  });

  app.get('/api/opportunities', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    if ((q.status && !['candidate', 'prepare_verification', 'verified'].includes(String(q.status))) || (q.sort && !['evidence', 'newest'].includes(String(q.sort))) || (q.opportunityType && !['product', 'implementation_service', 'knowledge_service', 'content_business', 'digital_product'].includes(String(q.opportunityType)))) throw new BusinessError(ErrorCodes.INVALID_OPPORTUNITY_FILTER);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.status) { clauses.push('o.status=?'); params.push(q.status); } if (q.opportunityType) { clauses.push('o.opportunity_type=?'); params.push(q.opportunityType); }
    for (const key of ['saved', 'ignored']) if (q[key] !== undefined) { clauses.push(`COALESCE(i.${key},0)=?`); params.push(bool(q[key], ErrorCodes.INVALID_OPPORTUNITY_FILTER, key)); }
    const keys = q.sort === 'newest' ? ['o.updated_at', 'o.opportunity_id'] : ['o.evidence_score', 'o.updated_at', 'o.opportunity_id'];
    const cursor = readCursor('opportunities', q, keys.length);
    if (cursor) { clauses.push(`(${keys.join(',')}) < (${keys.map(() => '?').join(',')})`); params.push(...cursor); }
    const rows = app.db.prepare(`SELECT o.opportunity_id opportunityId,o.signal_id signalId,o.opportunity_type opportunityType,o.title,o.summary,o.evidence_score evidenceScore,o.status,COALESCE(i.saved,0) saved,COALESCE(i.ignored,0) ignored,o.created_at createdAt,o.updated_at updatedAt FROM opportunities o LEFT JOIN item_states i ON i.target_type='opportunity' AND i.target_id=o.opportunity_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${keys.map((key) => `${key} DESC`).join(',')} LIMIT ?`).all(...params, limit + 1) as { opportunityId: number; evidenceScore: number; updatedAt: string }[];
    return reply.send({ code: 0, message: 'success', data: paged(rows, limit, (row) => writeCursor('opportunities', q, q.sort === 'newest' ? [row.updatedAt, row.opportunityId] : [row.evidenceScore, row.updatedAt, row.opportunityId])), requestId: request.id });
  });

  app.get('/api/opportunities/:opportunityId', async (request, reply) => {
    const id = parsePositiveId((request.params as { opportunityId: string }).opportunityId); const row = app.db.prepare('SELECT * FROM opportunities WHERE opportunity_id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.OPPORTUNITY_NOT_FOUND);
    return reply.send({ code: 0, message: 'success', data: { opportunityId: id, signalId: row.signal_id, opportunityType: row.opportunity_type, title: row.title, summary: row.summary, evidenceScore: row.evidence_score, status: row.status, ...parseJson(row.body_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }, requestId: request.id });
  });

  app.patch('/api/opportunities/:opportunityId/status', async (request, reply) => {
    const id = parsePositiveId((request.params as { opportunityId: string }).opportunityId); const status = (request.body as { status?: unknown })?.status;
    if (typeof status !== 'string') throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'status' });
    if (!['candidate', 'prepare_verification', 'verified'].includes(String(status))) throw new BusinessError(ErrorCodes.INVALID_OPPORTUNITY_STATUS);
    const previous = app.db.prepare('SELECT status FROM opportunities WHERE opportunity_id=?').get(id) as { status: string } | undefined;
    if (!previous) throw new BusinessError(ErrorCodes.OPPORTUNITY_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE opportunities SET status=?,updated_at=? WHERE opportunity_id=?').run(status, updatedAt, id);
    app.log.info({ event: 'opportunity.status_changed', requestId: request.id, opportunityId: id, oldStatus: previous.status, status, businessCode: 0 }, 'opportunity status changed');
    return reply.send({ code: 0, message: 'success', data: { opportunityId: id, status, updatedAt }, requestId: request.id });
  });

  app.get('/api/content-topics', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    if ((q.status && !['candidate', 'preparing', 'published'].includes(String(q.status))) || (q.sort && !['evidence', 'newest'].includes(String(q.sort))) || (q.platform && !['wechat', 'video_account', 'xiaohongshu', 'zhihu', 'bilibili', 'douyin', 'x', 'newsletter'].includes(String(q.platform)))) throw new BusinessError(ErrorCodes.INVALID_TOPIC_FILTER);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.status) { clauses.push('c.status=?'); params.push(q.status); } if (q.platform) { clauses.push('EXISTS(SELECT 1 FROM json_each(c.platforms_json) WHERE json_each.value=?)'); params.push(q.platform); }
    for (const key of ['saved', 'ignored']) if (q[key] !== undefined) { clauses.push(`COALESCE(i.${key},0)=?`); params.push(bool(q[key], ErrorCodes.INVALID_TOPIC_FILTER, key)); }
    const keys = q.sort === 'newest' ? ['c.updated_at', 'c.content_topic_id'] : ['c.evidence_score', 'c.updated_at', 'c.content_topic_id'];
    const cursor = readCursor('content-topics', q, keys.length);
    if (cursor) { clauses.push(`(${keys.join(',')}) < (${keys.map(() => '?').join(',')})`); params.push(...cursor); }
    const rows = (app.db.prepare(`SELECT c.content_topic_id contentTopicId,c.signal_id signalId,c.title,c.core_viewpoint coreViewpoint,c.platforms_json platformsJson,c.evidence_score evidenceScore,c.status,COALESCE(i.saved,0) saved,COALESCE(i.ignored,0) ignored,c.created_at createdAt,c.updated_at updatedAt FROM content_topics c LEFT JOIN item_states i ON i.target_type='content_topic' AND i.target_id=c.content_topic_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${keys.map((key) => `${key} DESC`).join(',')} LIMIT ?`).all(...params, limit + 1) as (Record<string, unknown> & { contentTopicId: number; evidenceScore: number; updatedAt: string })[]).map((row) => ({ ...row, platforms: parseJson(row.platformsJson, []) }));
    return reply.send({ code: 0, message: 'success', data: paged(rows, limit, (row) => writeCursor('content-topics', q, q.sort === 'newest' ? [String(row.updatedAt), Number(row.contentTopicId)] : [Number(row.evidenceScore), String(row.updatedAt), Number(row.contentTopicId)])), requestId: request.id });
  });

  app.get('/api/content-topics/:contentTopicId', async (request, reply) => {
    const id = parsePositiveId((request.params as { contentTopicId: string }).contentTopicId); const row = app.db.prepare('SELECT * FROM content_topics WHERE content_topic_id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.TOPIC_NOT_FOUND);
    return reply.send({ code: 0, message: 'success', data: { contentTopicId: id, signalId: row.signal_id, title: row.title, coreViewpoint: row.core_viewpoint, platforms: parseJson(row.platforms_json, []), evidenceScore: row.evidence_score, status: row.status, ...parseJson(row.body_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }, requestId: request.id });
  });

  app.patch('/api/content-topics/:contentTopicId/status', async (request, reply) => {
    const id = parsePositiveId((request.params as { contentTopicId: string }).contentTopicId); const status = (request.body as { status?: unknown })?.status;
    if (typeof status !== 'string') throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'status' });
    if (!['candidate', 'preparing', 'published'].includes(String(status))) throw new BusinessError(ErrorCodes.INVALID_TOPIC_STATUS);
    const previous = app.db.prepare('SELECT status FROM content_topics WHERE content_topic_id=?').get(id) as { status: string } | undefined;
    if (!previous) throw new BusinessError(ErrorCodes.TOPIC_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE content_topics SET status=?,updated_at=? WHERE content_topic_id=?').run(status, updatedAt, id);
    app.log.info({ event: 'content_topic.status_changed', requestId: request.id, contentTopicId: id, oldStatus: previous.status, status, businessCode: 0 }, 'content topic status changed');
    return reply.send({ code: 0, message: 'success', data: { contentTopicId: id, status, updatedAt }, requestId: request.id });
  });

  app.get('/api/entities', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit); const types = ['company', 'product', 'technology', 'topic', 'industry', 'problem'];
    if ((q.entityType && !types.includes(String(q.entityType))) || (q.sort && !['latest', 'signals'].includes(String(q.sort))) || (q.q && String(q.q).length > 100)) throw new BusinessError(ErrorCodes.INVALID_ENTITY_FILTER);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.entityType) { clauses.push('e.entity_type=?'); params.push(q.entityType); } if (q.followed !== undefined) { clauses.push('e.followed=?'); params.push(bool(q.followed, ErrorCodes.INVALID_ENTITY_FILTER, 'followed')); } if (q.q) { clauses.push('e.name LIKE ?'); params.push(`%${q.q}%`); }
    const count = '(SELECT count(*) FROM signal_entities se WHERE se.entity_id=e.entity_id)';
    const keys = q.sort === 'signals' ? [count, 'e.last_seen_at', 'e.entity_id'] : ['e.last_seen_at', 'e.entity_id'];
    const cursor = readCursor('entities', q, keys.length);
    if (cursor) { clauses.push(`(${keys.join(',')}) < (${keys.map(() => '?').join(',')})`); params.push(...cursor); }
    const rows = (app.db.prepare(`SELECT e.entity_id entityId,e.entity_type entityType,e.name,e.summary,e.followed,${count} signalCount,e.first_seen_at firstSeenAt,e.last_seen_at lastSeenAt,(SELECT json_object('signalId',ee.signal_id,'eventType',ee.event_type,'eventAt',ee.event_at,'headline',ee.headline) FROM entity_events ee WHERE ee.entity_id=e.entity_id ORDER BY ee.event_at DESC LIMIT 1) latestEventJson FROM entities e ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${keys.map((key) => `${key} DESC`).join(',')} LIMIT ?`).all(...params, limit + 1) as { signalCount: number; lastSeenAt: string; entityId: number; latestEventJson: string }[]).map((row) => ({ ...row, latestEvent: parseJson(row.latestEventJson, null) }));
    return reply.send({ code: 0, message: 'success', data: paged(rows, limit, (row) => writeCursor('entities', q, q.sort === 'signals' ? [Number(row.signalCount), String(row.lastSeenAt), Number(row.entityId)] : [String(row.lastSeenAt), Number(row.entityId)])), requestId: request.id });
  });

  app.get('/api/entities/:entityId', async (request, reply) => {
    const id = parsePositiveId((request.params as { entityId: string }).entityId); const q = request.query as Record<string, unknown>; const eventLimit = q.eventLimit === undefined ? 50 : parseLimit(q.eventLimit);
    const entity = app.db.prepare('SELECT * FROM entities WHERE entity_id=?').get(id) as Record<string, unknown> | undefined; if (!entity) throw new BusinessError(ErrorCodes.ENTITY_NOT_FOUND);
    const eventQuery: Record<string, unknown> = { ...q, cursor: q.eventCursor }; delete eventQuery.eventCursor;
    const cursor = readCursor(`entity-events-${id}`, eventQuery, 3);
    const events = app.db.prepare(`SELECT ee.signal_id signalId,ee.event_type eventType,ee.event_at eventAt,ee.headline,s.title signalTitle,s.evidence_level evidenceLevel,s.value_score valueScore FROM entity_events ee JOIN signals s ON s.signal_id=ee.signal_id WHERE ee.entity_id=? ${cursor ? 'AND (ee.event_at,ee.signal_id,ee.event_type) < (?,?,?)' : ''} ORDER BY ee.event_at DESC,ee.signal_id DESC,ee.event_type DESC LIMIT ?`).all(id, ...(cursor ?? []), eventLimit + 1) as { eventAt: string; signalId: number; eventType: string }[];
    return reply.send({ code: 0, message: 'success', data: { entityId: id, entityType: entity.entity_type, name: entity.name, summary: entity.summary, followed: entity.followed, firstSeenAt: entity.first_seen_at, lastSeenAt: entity.last_seen_at, events: paged(events, eventLimit, (row) => writeCursor(`entity-events-${id}`, eventQuery, [row.eventAt, row.signalId, row.eventType])) }, requestId: request.id });
  });

  app.put('/api/entities/:entityId/follow', async (request, reply) => {
    const id = parsePositiveId((request.params as { entityId: string }).entityId); const followed = (request.body as { followed?: unknown })?.followed;
    if (typeof followed !== 'boolean') throw new BusinessError(ErrorCodes.INVALID_REQUEST);
    const previous = app.db.prepare('SELECT followed FROM entities WHERE entity_id=?').get(id) as { followed: number } | undefined;
    if (!previous) throw new BusinessError(ErrorCodes.ENTITY_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE entities SET followed=?,updated_at=? WHERE entity_id=?').run(followed ? 1 : 0, updatedAt, id);
    app.log.info({ event: 'entity.follow_changed', requestId: request.id, entityId: id, oldFollowed: Boolean(previous.followed), followed, businessCode: 0 }, 'entity follow changed');
    return reply.send({ code: 0, message: 'success', data: { entityId: id, followed, updatedAt }, requestId: request.id });
  });
}
