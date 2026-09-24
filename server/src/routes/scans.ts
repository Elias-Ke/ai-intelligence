import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { now, parseLimit, parsePositiveId } from '../http.js';

const activeStatuses = ['created', 'collecting', 'normalizing', 'clustering', 'analyzing', 'generating', 'retrying'];
function rangeWindow(body: Record<string, unknown>) {
  const range = body.range;
  const to = new Date();
  let from = new Date(to);
  if (range === '24h') from.setHours(from.getHours() - 24);
  else if (range === '3d') from.setDate(from.getDate() - 3);
  else if (range === '7d') from.setDate(from.getDate() - 7);
  else if (range === 'custom' && typeof body.from === 'string' && typeof body.to === 'string') { from = new Date(body.from); return { from, to: new Date(body.to) }; }
  else throw new BusinessError(ErrorCodes.INVALID_SCAN_RANGE);
  return { from, to };
}

function taskView(row: Record<string, unknown>) { return { taskId: row.task_id, status: row.status, currentStep: row.current_step, progress: row.progress, discoveredCount: row.discovered_count, signalCount: row.signal_count, opportunityCount: row.opportunity_count, contentTopicCount: row.content_topic_count, rangeFrom: row.range_from, rangeTo: row.range_to, errorCode: row.error_code, errorMessage: row.error_message, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at }; }

async function executeScan(app: FastifyInstance, taskId: number, rangeFrom: Date, rangeTo: Date) {
  const startedAt = now();
  app.db.prepare("UPDATE scan_tasks SET status='collecting',current_step='collecting',started_at=?,heartbeat_at=? WHERE task_id=?").run(startedAt, startedAt, taskId);
  const sources = app.db.prepare('SELECT source_id sourceId,url FROM sources WHERE enabled=1 ORDER BY source_id').all() as { sourceId: number; url: string }[];
  let failed = 0; let discovered = 0;
  const saveDiscovery = app.db.transaction((sourceId: number | null, url: string, title: string, content: string, channel: 'source' | 'anysearch' = 'source') => {
    const timestamp = now(); const normalizedUrl = new URL(url).toString(); const hash = createHash('sha256').update(content).digest('hex');
    app.db.prepare("INSERT OR IGNORE INTO raw_discoveries(source_id,url,normalized_url,title,snippet,content,published_at,published_at_verified,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(sourceId, url, normalizedUrl, title, content.slice(0, 300), content.slice(0, 50000), null, 0, timestamp, hash, 'candidate', timestamp, timestamp);
    const row = app.db.prepare('SELECT discovery_id discoveryId FROM raw_discoveries WHERE normalized_url=? AND content_hash=?').get(normalizedUrl, hash) as { discoveryId: number };
    const linked = app.db.prepare('SELECT discovery_channel FROM scan_discoveries WHERE task_id=? AND discovery_id=?').get(taskId, row.discoveryId) as { discovery_channel: string } | undefined;
    if (linked) app.db.prepare("UPDATE scan_discoveries SET discovery_channel=? WHERE task_id=? AND discovery_id=?").run(linked.discovery_channel === channel ? channel : 'both', taskId, row.discoveryId);
    else app.db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,?,?)").run(taskId, row.discoveryId, channel, timestamp);
    return row.discoveryId;
  });
  const queue = [...sources];
  const worker = async () => { while (queue.length) { const source = queue.shift(); if (!source) return; try { const response = await app.fetchSource(source.url); const title = response.text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || new URL(response.url).hostname; saveDiscovery(source.sourceId, response.url, title, response.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); discovered += 1; } catch (error) { failed += 1; app.log.warn({ event: 'source.fetch.failed', taskId, sourceId: source.sourceId, businessCode: error instanceof BusinessError ? error.code : ErrorCodes.SOURCE_UNREACHABLE }, 'source fetch failed'); } } };
  await Promise.all(Array.from({ length: Math.min(8, sources.length) }, () => worker()));
  const searchBase = process.env.ANYSEARCH_BASE_URL;
  const searchKey = process.env.ANYSEARCH_API_KEY;
  if (searchBase && searchKey) {
    const queries = ['AI model release', 'AI product launch', 'AI paper agents', 'AI funding startup', 'AI enterprise use case', 'AI marketing automation', 'AI education workflow', 'AI developer tools', 'AI business service', 'AI user demand'];
    const queue = queries.flatMap((query) => [{ query, zone: 'intl', language: 'en' }, { query: `AI ${query}`, zone: 'cn', language: 'zh-CN' }]);
    const searchWorker = async () => { while (queue.length) { const item = queue.shift(); if (!item) return; const started = Date.now(); try { const response = await fetch(`${searchBase.replace(/\/$/, '')}/v1/search`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${searchKey}` }, body: JSON.stringify({ query: item.query, zone: item.zone, language: item.language, max_results: 10 }) }); if (!response.ok) throw new Error(`HTTP ${response.status}`); const payload = await response.json() as Record<string, unknown>; const results = (Array.isArray(payload.results) ? payload.results : Array.isArray((payload.data as Record<string, unknown> | undefined)?.results) ? (payload.data as Record<string, unknown>).results : []) as Record<string, unknown>[]; for (const result of results) { const url = typeof result.url === 'string' ? result.url : typeof result.link === 'string' ? result.link : ''; if (!url) continue; saveDiscovery(null, url, String(result.title ?? url), String(result.content ?? result.snippet ?? ''), 'anysearch'); discovered += 1; } app.log.info({ event: 'anysearch.request.completed', taskId, queryKey: item.query, zone: item.zone, language: item.language, resultCount: results.length, durationMs: Date.now() - started }, 'AnySearch request completed'); } catch (error) { failed += 1; app.log.warn({ event: 'anysearch.request.failed', taskId, zone: item.zone, language: item.language, error: error instanceof Error ? error.message : String(error) }, 'AnySearch request failed'); } } };
    await Promise.all(Array.from({ length: 5 }, () => searchWorker()));
  }
  app.db.prepare('UPDATE scan_tasks SET status=?,current_step=?,progress=?,discovered_count=?,heartbeat_at=? WHERE task_id=?').run('analyzing', 'analyzing', 70, discovered, now(), taskId);
  const discoveries = app.db.prepare('SELECT d.* FROM raw_discoveries d JOIN scan_discoveries sd ON sd.discovery_id=d.discovery_id WHERE sd.task_id=? ORDER BY d.discovery_id').all(taskId) as Record<string, unknown>[];
  let signals = 0; let opportunities = 0; let topics = 0;
  for (const discovery of discoveries) {
    const timestamp = now(); const title = String(discovery.title || discovery.url); const summary = String(discovery.snippet || '').slice(0, 500); const clusterKey = createHash('sha1').update(`${discovery.normalized_url}:${discovery.content_hash}`).digest('hex');
    const result = app.db.prepare("INSERT OR IGNORE INTO signals(cluster_key,title,summary,signal_type,tags_text,search_text,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,score_explanation_json,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(clusterKey, title, summary, 'market', 'AI', `${title} ${summary}`, 55, 50, 45, 45, 45, 45, 50, 48, 'single_source', 0, JSON.stringify({ rulesVersion: 'v1', reason: '公开来源候选，等待多源核验' }), 'v1', 'needs_review', null, timestamp, timestamp);
    const signal = app.db.prepare('SELECT signal_id signalId FROM signals WHERE cluster_key=?').get(clusterKey) as { signalId: number };
    app.db.prepare('INSERT OR IGNORE INTO scan_signals(task_id,signal_id,rank_no,is_highlight,created_at) VALUES(?,?,?,?,?)').run(taskId, signal.signalId, ++signals, result.changes ? 1 : 0, timestamp);
    app.db.prepare("INSERT OR IGNORE INTO signal_sources(signal_id,discovery_id,relation_type,is_independent,added_at) VALUES(?,?,?,?,?)").run(signal.signalId, discovery.discovery_id, 'primary', 1, timestamp);
    if (result.changes) {
      app.db.prepare("INSERT OR IGNORE INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(signal.signalId, 'product', `围绕“${title.slice(0, 60)}”做最小验证`, '先核查需求、替代方案和交付边界，再决定是否产品化。', JSON.stringify({ validationAction: '访谈 3 个目标用户', risks: ['单一来源，尚未形成独立证据'] }), 45, 'candidate', 'rules-v1', timestamp, timestamp); opportunities += 1;
      app.db.prepare("INSERT OR IGNORE INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(signal.signalId, `如何理解“${title.slice(0, 70)}”背后的 AI 落地变化`, '先讲事实变化，再说明它对产品和内容工作的影响。', JSON.stringify({ coreFacts: [summary], uncertainties: ['等待更多独立来源'] }), JSON.stringify(['wechat', 'zhihu', 'bilibili']), 45, 'candidate', 'rules-v1', timestamp, timestamp); topics += 1;
    }
  }
  const finalStatus = failed && discovered ? 'partial_failed' : failed ? 'failed' : 'completed';
  app.db.prepare('UPDATE scan_tasks SET status=?,current_step=?,progress=?,discovered_count=?,signal_count=?,opportunity_count=?,content_topic_count=?,finished_at=?,heartbeat_at=? WHERE task_id=?').run(finalStatus, 'generating', 100, discovered, signals, opportunities, topics, now(), now(), taskId);
  app.log.info({ event: finalStatus === 'completed' ? 'scan.task.completed' : 'scan.task.partial_failed', taskId, discovered, signals, opportunities, topics, failed }, 'scan task finished');
}

export function registerScanRoutes(app: FastifyInstance) {
  app.post('/api/scans', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 100) throw new BusinessError(ErrorCodes.MISSING_IDEMPOTENCY_KEY);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { from, to } = rangeWindow(body);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from >= to || to.getTime() - from.getTime() > 30 * 86400000) throw new BusinessError(ErrorCodes.INVALID_SCAN_RANGE);
    const existing = app.db.prepare('SELECT * FROM scan_tasks WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    if (existing) return reply.send({ code: 0, message: 'success', data: { ...taskView(existing), reused: true }, requestId: request.id });
    const active = app.db.prepare(`SELECT * FROM scan_tasks WHERE status IN (${activeStatuses.map(() => '?').join(',')}) LIMIT 1`).get(...activeStatuses) as Record<string, unknown> | undefined;
    if (active) return reply.send({ code: 0, message: 'success', data: { ...taskView(active), reused: true }, requestId: request.id });
    const sourceCount = (app.db.prepare('SELECT count(*) count FROM sources WHERE enabled = 1').get() as { count: number }).count;
    if (!sourceCount) throw new BusinessError(ErrorCodes.NO_AVAILABLE_SOURCE);
    const createdAt = now();
    const result = app.db.prepare('INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,?,?)').run(key, from.toISOString(), to.toISOString(), 'created', createdAt);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    app.log.info({ event: 'scan.task.created', taskId: result.lastInsertRowid, rangeFrom: from.toISOString(), rangeTo: to.toISOString() }, 'scan task created');
    if (process.env.NODE_ENV !== 'test') void executeScan(app, Number(result.lastInsertRowid), from, to);
    return reply.code(202).send({ code: 0, message: 'success', data: { ...taskView(row), reused: false }, requestId: request.id });
  });

  app.get('/api/scans', async (request, reply) => {
    const query = request.query as Record<string, unknown>; const limit = parseLimit(query.limit);
    const statuses = ['created', ...activeStatuses.slice(1), 'completed', 'partial_failed', 'failed'];
    if (query.status !== undefined && !statuses.includes(String(query.status))) throw new BusinessError(ErrorCodes.INVALID_SCAN_FILTER);
    const rows = app.db.prepare(`SELECT * FROM scan_tasks ${query.status ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT ?`).all(...(query.status ? [String(query.status), limit] : [limit])) as Record<string, unknown>[];
    return reply.send({ code: 0, message: 'success', data: { items: rows.map(taskView), nextCursor: null }, requestId: request.id });
  });

  app.get('/api/scans/:taskId', async (request, reply) => {
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const steps = app.db.prepare('SELECT step_name stepName,status,items_total itemsTotal,items_done itemsDone,error_code errorCode,error_message errorMessage,started_at startedAt,finished_at finishedAt FROM scan_task_steps WHERE task_id = ? ORDER BY rowid').all(id);
    return reply.send({ code: 0, message: 'success', data: { ...taskView(row), steps }, requestId: request.id });
  });

  app.post('/api/scans/:taskId/retry', async (request, reply) => {
    const key = request.headers['idempotency-key']; if (typeof key !== 'string' || !key) throw new BusinessError(ErrorCodes.MISSING_IDEMPOTENCY_KEY);
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    if (!['failed', 'partial_failed'].includes(String(row.status))) throw new BusinessError(ErrorCodes.RETRY_NOT_ALLOWED);
    const active = app.db.prepare(`SELECT task_id FROM scan_tasks WHERE status IN (${activeStatuses.map(() => '?').join(',')}) LIMIT 1`).get(...activeStatuses);
    if (active) throw new BusinessError(ErrorCodes.ACTIVE_SCAN_EXISTS);
    app.db.prepare("UPDATE scan_tasks SET status='retrying',error_code=NULL,error_message=NULL WHERE task_id=?").run(id);
    return reply.code(202).send({ code: 0, message: 'success', data: { taskId: id, status: 'retrying', resumeFromStep: row.current_step ?? 'collecting', reused: true }, requestId: request.id });
  });

  app.get('/api/scans/:taskId/events', async (request, reply) => {
    if (!String(request.headers.accept ?? '').includes('text/event-stream')) throw new BusinessError(ErrorCodes.SSE_ACCEPT_REQUIRED);
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    reply.raw.write(`event: task_snapshot\ndata: ${JSON.stringify({ taskId: id, status: row.status, currentStep: row.current_step, progress: row.progress, discoveredCount: row.discovered_count, signalCount: row.signal_count })}\n\n`);
    if (['completed', 'partial_failed', 'failed'].includes(String(row.status))) reply.raw.write(`event: task_${row.status === 'completed' ? 'completed' : 'failed'}\ndata: ${JSON.stringify(taskView(row))}\n\n`);
    reply.raw.end();
  });
}
