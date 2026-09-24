import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { now, parseLimit, parsePositiveId } from '../http.js';
import { parseSource } from '../ingestion/parseSource.js';
import { publicUrl } from '../ingestion/publicHttp.js';
import { buildSearchQueries, QUERY_VERSION } from '../ingestion/searchQueries.js';
import { analyzeDiscoveries } from '../domain/analyzeDiscoveries.js';
import { updateTrends } from '../domain/trends.js';
import { extractArticle } from '../ingestion/extractArticle.js';
import { generateCards } from '../generation/cards.js';

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

export async function executeScan(app: FastifyInstance, taskId: number, rangeFrom: Date, rangeTo: Date, maxDurationMs = 30 * 60_000) {
  const deadline = Date.now() + maxDurationMs;
  const startedAt = now();
  app.db.prepare("UPDATE scan_tasks SET status='collecting',current_step='collecting',started_at=?,heartbeat_at=? WHERE task_id=?").run(startedAt, startedAt, taskId);
  app.taskEvents.emit('changed', taskId);
  const sources = app.db.prepare('SELECT source_id sourceId,url,kind FROM sources WHERE enabled=1 ORDER BY source_id').all() as { sourceId: number; url: string; kind: 'rss' | 'api' | 'web' }[];
  let failed = 0; let discovered = 0; let scanErrorCode: number | null = null;
  const saveDiscovery = app.db.transaction((sourceId: number | null, url: string, title: string, content: string, channel: 'source' | 'anysearch', publishedAt: string | null, extractionFailed = false) => {
    const timestamp = now(); const normalizedUrl = new URL(url).toString(); const hash = createHash('sha256').update(content).digest('hex');
    const inRange = !publishedAt || new Date(publishedAt) >= rangeFrom && new Date(publishedAt) <= rangeTo;
    const status = !inRange ? 'rejected' : extractionFailed ? 'extract_failed' : publishedAt ? 'accepted' : 'candidate';
    app.db.prepare("INSERT OR IGNORE INTO raw_discoveries(source_id,url,normalized_url,title,snippet,content,published_at,published_at_verified,fetched_at,content_hash,status,rejection_reason,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(sourceId, url, normalizedUrl, title, content.slice(0, 300), content.slice(0, 50000), publishedAt, publishedAt ? 1 : 0, timestamp, hash, status, status === 'rejected' ? 'outside_scan_range' : extractionFailed ? 'extraction_failed' : null, timestamp, timestamp);
    const row = app.db.prepare('SELECT discovery_id discoveryId FROM raw_discoveries WHERE normalized_url=? AND content_hash=?').get(normalizedUrl, hash) as { discoveryId: number };
    if (publishedAt) app.db.prepare("UPDATE raw_discoveries SET published_at=?,published_at_verified=1,status=?,rejection_reason=?,last_seen_at=? WHERE discovery_id=? AND published_at_verified=0").run(publishedAt, status, status === 'rejected' ? 'outside_scan_range' : null, timestamp, row.discoveryId);
    const linked = app.db.prepare('SELECT discovery_channel FROM scan_discoveries WHERE task_id=? AND discovery_id=?').get(taskId, row.discoveryId) as { discovery_channel: string } | undefined;
    if (linked) app.db.prepare("UPDATE scan_discoveries SET discovery_channel=? WHERE task_id=? AND discovery_id=?").run(linked.discovery_channel === channel ? channel : 'both', taskId, row.discoveryId);
    else app.db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,?,?)").run(taskId, row.discoveryId, channel, timestamp);
    return { discoveryId: row.discoveryId, isNew: !linked };
  });
  const queue = [...sources];
  const articleQueue: { sourceId: number; url: string; title: string; snippet: string; publishedAt: string | null }[] = [];
  const timedOut = () => Date.now() >= deadline;
  const worker = async () => { while (queue.length && discovered + articleQueue.length < 2000 && !timedOut()) { const source = queue.shift(); if (!source) return; try { const response = await app.fetchSource(source.url); const items = parseSource(response.text, response.url, source.kind, response.contentType); for (const item of items) { if (discovered + articleQueue.length >= 2000) break; articleQueue.push({ ...item, sourceId: source.sourceId }); } app.db.prepare('UPDATE sources SET last_checked_at=?,last_success_at=?,last_error_code=NULL WHERE source_id=?').run(now(), now(), source.sourceId); app.log.info({ event: 'source.fetch.completed', taskId, sourceId: source.sourceId, resultCount: items.length }, 'source fetch completed'); } catch (error) { const code = error instanceof BusinessError ? error.code : ErrorCodes.SOURCE_UNREACHABLE; app.db.prepare('UPDATE sources SET last_checked_at=?,last_error_code=? WHERE source_id=?').run(now(), code, source.sourceId); failed += 1; scanErrorCode ??= code; app.log.warn({ event: 'source.fetch.failed', taskId, sourceId: source.sourceId, businessCode: code }, 'source fetch failed'); } } };
  await Promise.all(Array.from({ length: Math.min(8, sources.length) }, () => worker()));
  const articleWorker = async () => { while (articleQueue.length && discovered < 2000 && !timedOut()) {
    const item = articleQueue.shift(); if (!item) return;
    let content = item.snippet; let publishedAt = item.publishedAt; let extractionFailed = false;
    try {
      const page = await app.fetchSource(item.url);
      const article = extractArticle(page.text, page.contentType);
      content = article.content || content;
      publishedAt ??= article.publishedAt;
    } catch (error) {
      extractionFailed = true; failed++; scanErrorCode ??= ErrorCodes.EXTRACTION_FAILED;
      app.db.prepare('UPDATE sources SET last_error_code=? WHERE source_id=?').run(ErrorCodes.EXTRACTION_FAILED, item.sourceId);
      app.log.warn({ event: 'source.article.failed', taskId, sourceId: item.sourceId, businessCode: ErrorCodes.EXTRACTION_FAILED, errorType: error instanceof Error ? error.name : 'unknown' }, 'article unavailable, metadata retained');
    }
    if (saveDiscovery(item.sourceId, item.url, item.title, content, 'source', publishedAt, extractionFailed).isNew) discovered++;
  } };
  await Promise.all(Array.from({ length: 3 }, () => articleWorker()));
  let pendingSearch = 0;
  if (app.searchClient) {
    const searchQueue = buildSearchQueries();
    const knownHosts = new Set((app.db.prepare('SELECT url FROM sources').all() as { url: string }[]).map(({ url }) => new URL(url).hostname));
    const extractionQueue: { url: string; title: string; snippet: string; publishedAt: string | null; searchRunId: number; rank: number }[] = [];
    let quotaExhausted = false;
    const searchWorker = async () => { while (searchQueue.length && discovered + extractionQueue.length < 2000 && !quotaExhausted && !timedOut()) {
      const query = searchQueue.shift(); if (!query) return;
      const started = Date.now();
      const searchRun = app.db.prepare("INSERT INTO search_runs(task_id,query_key,query_version,query_text,zone,language,status,started_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,query_key,zone,language) DO UPDATE SET status='running',error_code=NULL,started_at=excluded.started_at RETURNING search_run_id searchRunId").get(taskId, query.queryKey, QUERY_VERSION, query.queryText, query.zone, query.language, 'running', now()) as { searchRunId: number };
      try {
        const { requestId, results } = await app.searchClient!.search(query);
        for (const [index, result] of results.entries()) {
          if (discovered >= 2000) break;
          try {
            const url = publicUrl(result.url).toString();
            const origin = new URL(url).origin;
            const host = new URL(url).hostname;
            if (!knownHosts.has(host)) {
              const timestamp = now();
              app.db.prepare("INSERT OR IGNORE INTO sources(name,source_group,kind,url,language,region,trust_level,enabled,fetch_interval_minutes,created_at,updated_at) VALUES(?,'新发现候选','web',?,?,?,1,0,1440,?,?)").run(host, origin, query.language, query.zone, timestamp, timestamp);
              knownHosts.add(host);
              app.log.info({ event: 'source.candidate.discovered', taskId, host, businessCode: 0 }, 'new source candidate saved');
            }
            const date = result.publishedAt ?? result.published_at;
            const publishedAt = date && Number.isFinite(new Date(date).valueOf()) && new Date(date) <= new Date() ? new Date(date).toISOString() : null;
            if (!result.content?.trim()) extractionQueue.push({ url, title: result.title || url, snippet: result.snippet ?? '', publishedAt, searchRunId: searchRun.searchRunId, rank: index + 1 });
            else {
              const stored = saveDiscovery(null, url, result.title || url, result.content, 'anysearch', publishedAt);
              if (stored.isNew) discovered += 1;
              app.db.prepare('INSERT OR IGNORE INTO discovery_search_runs(discovery_id,search_run_id,result_rank) VALUES(?,?,?)').run(stored.discoveryId, searchRun.searchRunId, index + 1);
            }
          } catch (error) { if (!(error instanceof BusinessError)) throw error; }
        }
        app.db.prepare("UPDATE search_runs SET status='completed',anysearch_request_id=?,result_count=?,duration_ms=?,finished_at=? WHERE search_run_id=?").run(requestId, results.length, Date.now() - started, now(), searchRun.searchRunId);
        app.log.info({ event: 'anysearch.request.completed', taskId, searchRunId: searchRun.searchRunId, queryKey: query.queryKey, zone: query.zone, language: query.language, anysearchRequestId: requestId, resultCount: results.length }, 'AnySearch request completed');
      } catch (error) {
        const code = error instanceof BusinessError ? error.code : ErrorCodes.SEARCH_UNAVAILABLE;
        app.db.prepare("UPDATE search_runs SET status='failed',error_code=?,duration_ms=?,finished_at=? WHERE search_run_id=?").run(code, Date.now() - started, now(), searchRun.searchRunId);
        if (code === ErrorCodes.SEARCH_QUOTA_EXHAUSTED) quotaExhausted = true;
        failed += 1;
        scanErrorCode ??= code;
        app.log.warn({ event: 'anysearch.request.failed', taskId, searchRunId: searchRun.searchRunId, queryKey: query.queryKey, businessCode: code }, 'AnySearch request failed');
      }
    } };
    await Promise.all(Array.from({ length: 5 }, () => searchWorker()));
    const extractionWorker = async () => { while (extractionQueue.length && discovered < 2000 && !timedOut()) {
      const item = extractionQueue.shift(); if (!item) return;
      let content = item.snippet; let extractionFailed = false;
      try {
        const extracted = await app.searchClient!.extract(item.url);
        content = extracted.content;
        app.log.info({ event: 'anysearch.extract.completed', taskId, searchRunId: item.searchRunId, anysearchRequestId: extracted.requestId }, 'AnySearch extract completed');
      } catch (error) {
        const code = error instanceof BusinessError ? error.code : ErrorCodes.EXTRACTION_FAILED;
        extractionFailed = true; failed += 1; scanErrorCode ??= code;
        app.log.warn({ event: 'anysearch.extract.failed', taskId, searchRunId: item.searchRunId, businessCode: code }, 'AnySearch extract failed');
      }
      const stored = saveDiscovery(null, item.url, item.title, content, 'anysearch', item.publishedAt, extractionFailed);
      if (stored.isNew) discovered += 1;
      app.db.prepare('INSERT OR IGNORE INTO discovery_search_runs(discovery_id,search_run_id,result_rank) VALUES(?,?,?)').run(stored.discoveryId, item.searchRunId, item.rank);
    } };
    await Promise.all(Array.from({ length: 3 }, () => extractionWorker()));
    pendingSearch = searchQueue.length + extractionQueue.length;
  }
  if (timedOut() && (queue.length || articleQueue.length || pendingSearch)) { failed++; scanErrorCode ??= ErrorCodes.SCAN_TIMEOUT; }
  app.db.prepare('UPDATE scan_tasks SET status=?,current_step=?,progress=?,discovered_count=?,heartbeat_at=? WHERE task_id=?').run('analyzing', 'analyzing', 70, discovered, now(), taskId);
  app.taskEvents.emit('changed', taskId);
  const signals = analyzeDiscoveries(app, taskId);
  updateTrends(app, taskId);
  app.db.prepare("UPDATE scan_tasks SET status='generating',current_step='generating',progress=85,signal_count=?,heartbeat_at=? WHERE task_id=?").run(signals, now(), taskId);
  app.taskEvents.emit('changed', taskId);
  const generated = await generateCards(app, taskId, deadline);
  failed += generated.failed;
  scanErrorCode ??= generated.errorCode;
  const finalStatus = failed && discovered ? 'partial_failed' : failed ? 'failed' : 'completed';
  app.db.prepare('UPDATE scan_tasks SET status=?,current_step=?,progress=?,discovered_count=?,signal_count=?,opportunity_count=?,content_topic_count=?,error_code=?,error_message=?,finished_at=?,heartbeat_at=? WHERE task_id=?').run(finalStatus, 'generating', 100, discovered, signals, generated.opportunities, generated.topics, scanErrorCode, scanErrorCode === null ? null : new BusinessError(scanErrorCode as never).message, now(), now(), taskId);
  app.taskEvents.emit('changed', taskId);
  app.log.info({ event: finalStatus === 'completed' ? 'scan.task.completed' : 'scan.task.partial_failed', taskId, discovered, signals, opportunities: generated.opportunities, topics: generated.topics, failed }, 'scan task finished');
}

export async function runScan(app: FastifyInstance, taskId: number) {
  try {
    const task = app.db.prepare('SELECT range_from rangeFrom,range_to rangeTo FROM scan_tasks WHERE task_id=?').get(taskId) as { rangeFrom: string; rangeTo: string } | undefined;
    if (!task) return;
    await executeScan(app, taskId, new Date(task.rangeFrom), new Date(task.rangeTo));
  } catch (error) {
    const code = error instanceof BusinessError ? error.code : ErrorCodes.INTERNAL;
    app.db.prepare("UPDATE scan_tasks SET status='failed',error_code=?,error_message=?,finished_at=?,heartbeat_at=? WHERE task_id=?").run(code, '扫描执行失败，请重试', now(), now(), taskId);
    app.taskEvents.emit('changed', taskId);
    app.log.error({ event: 'scan.task.failed', taskId, businessCode: code }, 'scan task failed');
  }
}

function scheduleScan(app: FastifyInstance, taskId: number) {
  if (app.autoRunScans) setImmediate(() => { void runScan(app, taskId); });
}

export function registerScanRoutes(app: FastifyInstance) {
  app.post('/api/scans', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 1 || key.length > 100) throw new BusinessError(ErrorCodes.MISSING_IDEMPOTENCY_KEY);
    if (!/^[\x20-\x7e]+$/.test(key)) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'Idempotency-Key' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const { from, to } = rangeWindow(body);
    if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf()) || from >= to || to.getTime() - from.getTime() > 30 * 86400000) throw new BusinessError(ErrorCodes.INVALID_SCAN_RANGE);
    const existing = app.db.prepare('SELECT * FROM scan_tasks WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    if (existing) {
      const sameRange = body.range === 'custom'
        ? existing.range_from === from.toISOString() && existing.range_to === to.toISOString()
        : new Date(String(existing.range_to)).getTime() - new Date(String(existing.range_from)).getTime() === to.getTime() - from.getTime();
      if (!sameRange) throw new BusinessError(ErrorCodes.IDEMPOTENCY_CONFLICT);
      return reply.send({ code: 0, message: 'success', data: { ...taskView(existing), reused: true }, requestId: request.id });
    }
    const active = app.db.prepare(`SELECT * FROM scan_tasks WHERE status IN (${activeStatuses.map(() => '?').join(',')}) LIMIT 1`).get(...activeStatuses) as Record<string, unknown> | undefined;
    if (active) return reply.send({ code: 0, message: 'success', data: { ...taskView(active), reused: true }, requestId: request.id });
    const sourceCount = (app.db.prepare('SELECT count(*) count FROM sources WHERE enabled = 1').get() as { count: number }).count;
    if (!sourceCount && !app.searchClient) throw new BusinessError(ErrorCodes.NO_AVAILABLE_SOURCE);
    const createdAt = now();
    const result = app.db.prepare('INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,?,?)').run(key, from.toISOString(), to.toISOString(), 'created', createdAt);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    app.log.info({ event: 'scan.task.created', taskId: result.lastInsertRowid, rangeFrom: from.toISOString(), rangeTo: to.toISOString() }, 'scan task created');
    scheduleScan(app, Number(result.lastInsertRowid));
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
    app.taskEvents.emit('changed', id);
    scheduleScan(app, id);
    return reply.code(202).send({ code: 0, message: 'success', data: { taskId: id, status: 'retrying', resumeFromStep: row.current_step ?? 'collecting', reused: true }, requestId: request.id });
  });

  app.get('/api/scans/:taskId/events', async (request, reply) => {
    if (!String(request.headers.accept ?? '').includes('text/event-stream')) throw new BusinessError(ErrorCodes.SSE_ACCEPT_REQUIRED);
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const lastEventId = request.headers['last-event-id'];
    if (lastEventId !== undefined && (typeof lastEventId !== 'string' || !/^\d{1,20}$/.test(lastEventId))) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'Last-Event-ID' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); app.taskEvents.off('changed', sendSnapshot); };
    const send = (event: string, data: unknown) => { if (!closed) reply.raw.write(`id: ${Date.now()}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const sendSnapshot = (changedId: number) => {
      if (changedId !== id || closed) return;
      const latest = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id=?').get(id) as Record<string, unknown>;
      send('task_snapshot', taskView(latest));
      if (['completed', 'partial_failed', 'failed'].includes(String(latest.status))) {
        send(latest.status === 'completed' ? 'task_completed' : 'task_failed', taskView(latest));
        cleanup(); reply.raw.end();
      }
    };
    const heartbeat = setInterval(() => send('heartbeat', { timestamp: now() }), 15_000);
    reply.raw.on('close', cleanup);
    app.taskEvents.on('changed', sendSnapshot);
    sendSnapshot(id);
  });
}
