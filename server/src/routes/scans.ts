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
import { paged, readCursor, writeCursor } from './cursor.js';

const activeStatuses = ['created', 'collecting', 'normalizing', 'clustering', 'analyzing', 'generating', 'retrying'];
const steps = ['collecting', 'normalizing', 'clustering', 'analyzing', 'generating'] as const;
type Step = typeof steps[number];

function setStep(app: FastifyInstance, taskId: number, step: Step, status: 'running' | 'completed' | 'partial_failed', count: number, errorCode: number | null = null) {
  const timestamp = now();
  const progress = [10, 42, 55, 70, 85][steps.indexOf(step)];
  app.db.transaction(() => {
    if (status === 'running') app.db.prepare('UPDATE scan_tasks SET status=?,current_step=?,progress=?,heartbeat_at=?,started_at=COALESCE(started_at,?) WHERE task_id=?').run(step, step, progress, timestamp, timestamp, taskId);
    app.db.prepare("INSERT INTO scan_task_steps(task_id,step_name,status,items_total,items_done,error_code,error_message,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(task_id,step_name) DO UPDATE SET status=excluded.status,items_total=excluded.items_total,items_done=excluded.items_done,error_code=excluded.error_code,error_message=excluded.error_message,started_at=COALESCE(scan_task_steps.started_at,excluded.started_at),finished_at=excluded.finished_at").run(taskId, step, status, count, count, errorCode, errorCode ? new BusinessError(errorCode as never).message : null, timestamp, status === 'running' ? null : timestamp);
  })();
  app.taskEvents.emit('changed', taskId);
  app.taskEvents.emit('step_progress', { taskId, stepName: step, status, itemsTotal: count, itemsDone: count, progress });
  app.log.info({ event: `scan.step.${status === 'running' ? 'started' : 'completed'}`, taskId, stepName: step, businessCode: errorCode ?? 0, itemsDone: count }, 'scan step changed');
}
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

export async function executeScan(app: FastifyInstance, taskId: number, rangeFrom: Date, rangeTo: Date, maxDurationMs = 30 * 60_000, resumeFrom: Step = 'collecting') {
  const deadline = Date.now() + maxDurationMs;
  const fromIndex = steps.indexOf(resumeFrom);
  if (fromIndex < 0) throw new BusinessError(ErrorCodes.INVALID_REQUEST);
  const sources = app.db.prepare('SELECT source_id sourceId,url,kind FROM sources WHERE enabled=1 ORDER BY source_id').all() as { sourceId: number; url: string; kind: 'rss' | 'api' | 'web' }[];
  const previous = fromIndex ? app.db.prepare(`SELECT error_code code FROM scan_task_steps WHERE task_id=? AND step_name IN (${steps.slice(0, fromIndex).map(() => '?').join(',')}) AND status IN ('partial_failed','failed')`).all(taskId, ...steps.slice(0, fromIndex)) as { code: number | null }[] : [];
  let failed = previous.length;
  let discovered = (app.db.prepare('SELECT count(*) count FROM scan_discoveries WHERE task_id=?').get(taskId) as { count: number }).count;
  let scanErrorCode: number | null = previous.find(({ code }) => code !== null)?.code ?? null;
  const saveDiscovery = app.db.transaction((sourceId: number | null, url: string, title: string, content: string, channel: 'source' | 'anysearch', publishedAt: string | null, extractionFailed = false) => {
    const timestamp = now(); const normalizedUrl = new URL(url).toString(); const hash = createHash('sha256').update(content).digest('hex');
    const inRange = !publishedAt || new Date(publishedAt) >= rangeFrom && new Date(publishedAt) <= rangeTo;
    const status = !inRange ? 'rejected' : extractionFailed ? 'extract_failed' : publishedAt ? 'accepted' : 'candidate';
    app.db.prepare("INSERT OR IGNORE INTO raw_discoveries(source_id,url,normalized_url,title,snippet,content,published_at,published_at_verified,fetched_at,content_hash,status,rejection_reason,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(sourceId, url, normalizedUrl, title, content.slice(0, 300), content.slice(0, 50000), publishedAt, publishedAt ? 1 : 0, timestamp, hash, status, status === 'rejected' ? 'outside_scan_range' : extractionFailed ? 'extraction_failed' : null, timestamp, timestamp);
    const row = app.db.prepare('SELECT discovery_id discoveryId FROM raw_discoveries WHERE normalized_url=? AND content_hash=?').get(normalizedUrl, hash) as { discoveryId: number };
    if (publishedAt) app.db.prepare("UPDATE raw_discoveries SET published_at=?,published_at_verified=1,status=?,rejection_reason=?,last_seen_at=? WHERE discovery_id=? AND published_at_verified=0").run(publishedAt, status, status === 'rejected' ? 'outside_scan_range' : null, timestamp, row.discoveryId);
    if (inRange && publishedAt) app.db.prepare("UPDATE raw_discoveries SET status=?,rejection_reason=?,last_seen_at=? WHERE discovery_id=? AND status='rejected'").run(extractionFailed ? 'extract_failed' : 'accepted', extractionFailed ? 'extraction_failed' : null, timestamp, row.discoveryId);
    if (inRange && !extractionFailed) app.db.prepare("UPDATE raw_discoveries SET status=?,rejection_reason=NULL,last_seen_at=? WHERE discovery_id=? AND status='extract_failed'").run(publishedAt ? 'accepted' : 'candidate', timestamp, row.discoveryId);
    const linked = app.db.prepare('SELECT discovery_channel FROM scan_discoveries WHERE task_id=? AND discovery_id=?').get(taskId, row.discoveryId) as { discovery_channel: string } | undefined;
    if (linked) app.db.prepare("UPDATE scan_discoveries SET discovery_channel=? WHERE task_id=? AND discovery_id=?").run(linked.discovery_channel === channel ? channel : 'both', taskId, row.discoveryId);
    else app.db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,?,?)").run(taskId, row.discoveryId, channel, timestamp);
    return { discoveryId: row.discoveryId, isNew: !linked };
  });
  if (fromIndex <= 0) setStep(app, taskId, 'collecting', 'running', discovered);
  const queue = fromIndex <= 0 ? [...sources] : [];
  const articleQueue: { sourceId: number; url: string; title: string; snippet: string; publishedAt: string | null }[] = [];
  const timedOut = () => Date.now() >= deadline;
  const worker = async () => { while (queue.length && discovered + articleQueue.length < 2000 && !timedOut()) { const source = queue.shift(); if (!source) return; try { const response = await app.fetchSource(source.url, { maxBytes: source.kind === 'rss' ? 2_000_000 : 512_000 }); const items = parseSource(response.text, response.url, source.kind, response.contentType); for (const item of items) { if (discovered + articleQueue.length >= 2000) break; articleQueue.push({ ...item, sourceId: source.sourceId }); } app.db.prepare('UPDATE sources SET last_checked_at=?,last_success_at=?,last_error_code=NULL WHERE source_id=?').run(now(), now(), source.sourceId); app.log[items.length ? 'info' : 'warn']({ event: items.length ? 'source.fetch.completed' : 'source.fetch.empty', taskId, sourceId: source.sourceId, resultCount: items.length }, 'source fetch completed'); } catch (error) { const code = error instanceof BusinessError ? error.code : ErrorCodes.SOURCE_UNREACHABLE; app.db.prepare('UPDATE sources SET last_checked_at=?,last_error_code=? WHERE source_id=?').run(now(), code, source.sourceId); failed += 1; scanErrorCode ??= code; app.log.warn({ event: 'source.fetch.failed', taskId, sourceId: source.sourceId, businessCode: code }, 'source fetch failed'); } } };
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
  if (app.searchClient && fromIndex <= 0) {
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
  if (fromIndex <= 0) {
    app.db.prepare('UPDATE scan_tasks SET discovered_count=? WHERE task_id=?').run(discovered, taskId);
    setStep(app, taskId, 'collecting', failed ? 'partial_failed' : 'completed', discovered, scanErrorCode);
  }
  if (fromIndex <= 1) { setStep(app, taskId, 'normalizing', 'running', discovered); setStep(app, taskId, 'normalizing', 'completed', discovered); }
  let signals = (app.db.prepare('SELECT count(*) count FROM scan_signals WHERE task_id=?').get(taskId) as { count: number }).count;
  if (fromIndex <= 2) {
    setStep(app, taskId, 'clustering', 'running', discovered);
    signals = analyzeDiscoveries(app, taskId);
    setStep(app, taskId, 'clustering', 'completed', signals);
    for (const signal of app.db.prepare('SELECT s.signal_id signalId,s.title,s.value_score valueScore FROM signals s JOIN scan_signals ss ON ss.signal_id=s.signal_id WHERE ss.task_id=?').all(taskId) as { signalId: number; title: string; valueScore: number }[]) app.taskEvents.emit('signal_ready', { taskId, ...signal });
  }
  if (fromIndex <= 3) { setStep(app, taskId, 'analyzing', 'running', signals); updateTrends(app, taskId); setStep(app, taskId, 'analyzing', 'completed', signals); }
  let generated = { opportunities: 0, topics: 0, failed: 0, errorCode: null as number | null };
  if (fromIndex <= 4) { setStep(app, taskId, 'generating', 'running', signals); generated = await generateCards(app, taskId, deadline); setStep(app, taskId, 'generating', generated.failed ? 'partial_failed' : 'completed', generated.opportunities + generated.topics, generated.errorCode); }
  failed += generated.failed; scanErrorCode ??= generated.errorCode;
  const persistedCards = app.db.prepare('SELECT (SELECT count(*) FROM opportunities o JOIN scan_signals ss ON ss.signal_id=o.signal_id WHERE ss.task_id=?) opportunities,(SELECT count(*) FROM content_topics c JOIN scan_signals ss ON ss.signal_id=c.signal_id WHERE ss.task_id=?) topics').get(taskId, taskId) as { opportunities: number; topics: number };
  const finalStatus = failed && discovered ? 'partial_failed' : failed ? 'failed' : 'completed';
  app.db.prepare('UPDATE scan_tasks SET status=?,current_step=?,progress=?,discovered_count=?,signal_count=?,opportunity_count=?,content_topic_count=?,error_code=?,error_message=?,finished_at=?,heartbeat_at=? WHERE task_id=?').run(finalStatus, 'generating', 100, discovered, signals, persistedCards.opportunities, persistedCards.topics, scanErrorCode, scanErrorCode === null ? null : new BusinessError(scanErrorCode as never).message, now(), now(), taskId);
  app.taskEvents.emit('changed', taskId);
  app.log.info({ event: finalStatus === 'completed' ? 'scan.task.completed' : 'scan.task.partial_failed', taskId, discovered, signals, opportunities: generated.opportunities, topics: generated.topics, failed }, 'scan task finished');
}

export async function runScan(app: FastifyInstance, taskId: number) {
  try {
    const task = app.db.prepare('SELECT range_from rangeFrom,range_to rangeTo FROM scan_tasks WHERE task_id=?').get(taskId) as { rangeFrom: string; rangeTo: string } | undefined;
    if (!task) return;
    const failedStep = app.db.prepare("SELECT step_name stepName FROM scan_task_steps WHERE task_id=? AND status IN ('partial_failed','failed') ORDER BY rowid LIMIT 1").get(taskId) as { stepName: Step } | undefined;
    await executeScan(app, taskId, new Date(task.rangeFrom), new Date(task.rangeTo), 30 * 60_000, failedStep?.stepName ?? 'collecting');
  } catch (error) {
    const code = error instanceof BusinessError ? error.code : ErrorCodes.INTERNAL;
    app.db.transaction(() => {
      app.db.prepare("UPDATE scan_task_steps SET status='failed',error_code=?,error_message='扫描执行失败，请重试',finished_at=? WHERE task_id=? AND status='running'").run(code, now(), taskId);
      app.db.prepare("UPDATE scan_tasks SET status='failed',error_code=?,error_message=?,started_at=COALESCE(started_at,created_at),finished_at=?,heartbeat_at=? WHERE task_id=?").run(code, '扫描执行失败，请重试', now(), now(), taskId);
    })();
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
    const row = app.db.transaction(() => {
      const result = app.db.prepare('INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,?,?)').run(key, from.toISOString(), to.toISOString(), 'created', createdAt);
      for (const step of steps) app.db.prepare("INSERT INTO scan_task_steps(task_id,step_name,status) VALUES(?,?,'pending')").run(result.lastInsertRowid, step);
      return app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(result.lastInsertRowid) as Record<string, unknown>;
    })();
    app.log.info({ event: 'scan.task.created', taskId: row.task_id, rangeFrom: from.toISOString(), rangeTo: to.toISOString() }, 'scan task created');
    scheduleScan(app, Number(row.task_id));
    return reply.code(202).send({ code: 0, message: 'success', data: { ...taskView(row), reused: false }, requestId: request.id });
  });

  app.get('/api/scans', async (request, reply) => {
    const query = request.query as Record<string, unknown>; const limit = parseLimit(query.limit);
    const statuses = ['created', ...activeStatuses.slice(1), 'completed', 'partial_failed', 'failed'];
    if (query.status !== undefined && !statuses.includes(String(query.status))) throw new BusinessError(ErrorCodes.INVALID_SCAN_FILTER);
    const cursor = readCursor('scans', query, 2);
    const filters = [query.status ? 'status = ?' : '', cursor ? '(created_at,task_id) < (?,?)' : ''].filter(Boolean);
    const rows = app.db.prepare(`SELECT * FROM scan_tasks ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC,task_id DESC LIMIT ?`).all(...(query.status ? [String(query.status)] : []), ...(cursor ?? []), limit + 1) as Record<string, unknown>[];
    const result = paged(rows, limit, (row) => writeCursor('scans', query, [String(row.created_at), Number(row.task_id)]));
    return reply.send({ code: 0, message: 'success', data: { ...result, items: result.items.map(taskView) }, requestId: request.id });
  });

  app.get('/api/scans/:taskId', async (request, reply) => {
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const steps = app.db.prepare('SELECT step_name stepName,status,items_total itemsTotal,items_done itemsDone,error_code errorCode,error_message errorMessage,started_at startedAt,finished_at finishedAt FROM scan_task_steps WHERE task_id = ? ORDER BY rowid').all(id);
    return reply.send({ code: 0, message: 'success', data: { ...taskView(row), steps }, requestId: request.id });
  });

  app.post('/api/scans/:taskId/retry', async (request, reply) => {
    const key = request.headers['idempotency-key']; if (typeof key !== 'string' || !key || key.length > 100) throw new BusinessError(ErrorCodes.MISSING_IDEMPOTENCY_KEY);
    if (!/^[\x20-\x7e]+$/.test(key)) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'Idempotency-Key' });
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const failedStep = app.db.prepare("SELECT step_name stepName FROM scan_task_steps WHERE task_id=? AND status IN ('partial_failed','failed') ORDER BY rowid LIMIT 1").get(id) as { stepName: Step } | undefined;
    const resumeFromStep = failedStep?.stepName ?? 'collecting';
    const existingRetry = app.db.prepare('SELECT resume_from_step resumeFromStep FROM scan_retry_requests WHERE task_id=? AND idempotency_key=?').get(id, key) as { resumeFromStep: Step } | undefined;
    if (existingRetry) return reply.send({ code: 0, message: 'success', data: { taskId: id, status: row.status, resumeFromStep: existingRetry.resumeFromStep, reused: true }, requestId: request.id });
    if (row.status === 'retrying') throw new BusinessError(ErrorCodes.IDEMPOTENCY_CONFLICT);
    if (!['failed', 'partial_failed'].includes(String(row.status))) throw new BusinessError(ErrorCodes.RETRY_NOT_ALLOWED);
    const active = app.db.prepare(`SELECT task_id FROM scan_tasks WHERE status IN (${activeStatuses.map(() => '?').join(',')}) LIMIT 1`).get(...activeStatuses);
    if (active) throw new BusinessError(ErrorCodes.ACTIVE_SCAN_EXISTS);
    app.db.transaction(() => {
      app.db.prepare('INSERT INTO scan_retry_requests(task_id,idempotency_key,resume_from_step,created_at) VALUES(?,?,?,?)').run(id, key, resumeFromStep, now());
      app.db.prepare("UPDATE scan_tasks SET status='retrying',error_code=NULL,error_message=NULL,finished_at=NULL WHERE task_id=?").run(id);
    })();
    app.taskEvents.emit('changed', id);
    scheduleScan(app, id);
    app.log.info({ event: 'scan.task.retried', taskId: id, resumeFromStep, businessCode: 0 }, 'scan task scheduled for retry');
    return reply.code(202).send({ code: 0, message: 'success', data: { taskId: id, status: 'retrying', resumeFromStep, reused: true }, requestId: request.id });
  });

  app.get('/api/scans/:taskId/events', async (request, reply) => {
    if (!String(request.headers.accept ?? '').includes('text/event-stream')) throw new BusinessError(ErrorCodes.SSE_ACCEPT_REQUIRED);
    const id = parsePositiveId((request.params as { taskId: string }).taskId);
    const row = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const lastEventId = request.headers['last-event-id'];
    if (lastEventId !== undefined && (typeof lastEventId !== 'string' || !/^\d{1,20}$/.test(lastEventId) || !Number.isSafeInteger(Number(lastEventId)))) throw new BusinessError(ErrorCodes.INVALID_REQUEST, { field: 'Last-Event-ID' });
    reply.hijack();
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let closed = false;
    const openedAt = Date.now(); let eventsSent = 0; let nextEventId = Math.max(openedAt, Number(lastEventId ?? 0) + 1);
    const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); app.taskEvents.off('changed', sendSnapshot); app.taskEvents.off('step_progress', sendStep); app.taskEvents.off('signal_ready', sendSignal); app.log.info({ event: 'sse.connection.closed', requestId: request.id, taskId: id, eventsSent, durationMs: Date.now() - openedAt, businessCode: 0 }, 'SSE connection closed'); };
    const send = (event: string, data: unknown) => { if (!closed) { reply.raw.write(`id: ${nextEventId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); eventsSent++; } };
    const sendStep = (event: { taskId: number }) => { if (event.taskId === id) send('step_progress', event); };
    const sendSignal = (event: { taskId: number }) => { if (event.taskId === id) send('signal_ready', event); };
    const sendSnapshot = (changedId: number) => {
      if (changedId !== id || closed) return;
      try {
      const latest = app.db.prepare('SELECT * FROM scan_tasks WHERE task_id=?').get(id) as Record<string, unknown>;
      send('task_snapshot', taskView(latest));
      const running = app.db.prepare("SELECT step_name stepName,status,items_total itemsTotal,items_done itemsDone FROM scan_task_steps WHERE task_id=? AND status='running'").get(id) as Record<string, unknown> | undefined;
      if (running) send('step_progress', { taskId: id, ...running, progress: latest.progress });
      if (['completed', 'partial_failed', 'failed'].includes(String(latest.status))) {
        send(latest.status === 'completed' ? 'task_completed' : 'task_failed', { ...taskView(latest), retryable: latest.status !== 'completed' });
        cleanup(); reply.raw.end();
      }
      } catch { send('task_failed', { taskId: id, status: 'failed', errorCode: ErrorCodes.INTERNAL, errorMessage: '任务进度暂时无法读取', retryable: true }); cleanup(); reply.raw.end(); }
    };
    const heartbeat = setInterval(() => send('heartbeat', { timestamp: now() }), 15_000);
    reply.raw.on('close', cleanup);
    app.taskEvents.on('changed', sendSnapshot);
    app.taskEvents.on('step_progress', sendStep);
    app.taskEvents.on('signal_ready', sendSignal);
    app.log.info({ event: 'sse.connection.opened', requestId: request.id, taskId: id, lastEventId: lastEventId ?? null, businessCode: 0 }, 'SSE connection opened');
    sendSnapshot(id);
  });
}
