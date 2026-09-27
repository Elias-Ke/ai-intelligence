import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { AnySearchClient } from '../../src/ingestion/AnySearchClient.js';
import { openDatabase } from '../../src/persistence/database.js';
import { executeScan } from '../../src/routes/scans.js';
import { SourceFetchError } from '../../src/ingestion/publicHttp.js';
import { BusinessError, ErrorCodes } from '../../src/domain/errorCodes.js';

test('source articles provide dated body and new search domains remain disabled candidates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-articles-'));
  const db = openDatabase(join(directory, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  let searches = 0;
  const searchClient = new AnySearchClient('https://api.example.org', 'secret', (async () => Response.json({ code: 0, request_id: 'search-id', data: { results: ++searches === 1 ? [{ url: 'https://novel-source.example.org/news', title: 'AI Agent launched in schools', content: 'Verified AI Agent case study', publishedAt: '2026-09-23T12:00:00.000Z' }] : [] } })) as typeof fetch);
  const app = createApp({ db, logger: false, searchClient, fetchSource: async (url) => url.endsWith('/news/1') ? ({ url, contentType: 'text/html', text: '<html><head><meta property="article:published_time" content="2026-09-23T12:00:00Z"></head><body><article>AI Agent was deployed in classrooms with documented workflows.</article></body></html>' }) : ({ url, contentType: 'application/rss+xml', text: '<rss><channel><item><title>AI Agent launched for schools</title><link>https://original.example.org/news/1</link><description>School workflow</description></item></channel></rss>' }) });
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('articles','2026-09-23T00:00:00.000Z','2026-09-24T00:00:00.000Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await executeScan(app, taskId, new Date('2026-09-23T00:00:00Z'), new Date('2026-09-24T00:00:00Z'));
    const article = db.prepare("SELECT status,content,published_at publishedAt FROM raw_discoveries WHERE url='https://original.example.org/news/1'").get() as { status: string; content: string; publishedAt: string };
    assert.equal(article.status, 'accepted');
    assert.match(article.content, /deployed in classrooms/);
    assert.equal(article.publishedAt, '2026-09-23T12:00:00.000Z');
    const candidate = db.prepare("SELECT source_group sourceGroup,enabled,trust_level trustLevel FROM sources WHERE url='https://novel-source.example.org'").get() as { sourceGroup: string; enabled: number; trustLevel: number };
    assert.deepEqual(candidate, { sourceGroup: '新发现候选', enabled: 0, trustLevel: 1 });
    assert.equal((db.prepare('SELECT last_error_code lastError,last_success_at lastSuccess FROM sources WHERE source_id=1').get() as { lastError: number | null; lastSuccess: string }).lastError, null);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('scan deadline stops new article requests and retains completed source metadata', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-time-budget-'));
  const db = openDatabase(join(directory, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  let requests = 0;
  const app = createApp({ db, logger: false, fetchSource: async (url) => {
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { url, contentType: 'application/rss+xml', text: '<rss><channel><item><title>AI business use case launch</title><link>https://example.org/1</link><pubDate>2026-09-23T12:00:00Z</pubDate></item></channel></rss>' };
  } });
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('timeout','2026-09-23T00:00:00Z','2026-09-24T00:00:00Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await executeScan(app, taskId, new Date('2026-09-23T00:00:00Z'), new Date('2026-09-24T00:00:00Z'), 100);
    assert.equal(requests, 1);
    const task = db.prepare('SELECT status,error_code errorCode FROM scan_tasks WHERE task_id=?').get(taskId) as { status: string; errorCode: number };
    assert.deepEqual(task, { status: 'failed', errorCode: 200010 });
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('RSS collection accepts larger official feeds without lifting article response limits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-feed-budget-'));
  const db = openDatabase(join(directory, 'test.db'));
  db.prepare("UPDATE sources SET enabled=(name='arXiv cs.AI')").run();
  const limits: number[] = [];
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url, options) => {
    limits.push(options?.maxBytes ?? 0);
    return url.includes('/rss/') ? { url, contentType: 'application/rss+xml', text: '<rss><channel><item><title>AI Agent deployed in schools</title><link>https://example.org/ai-case</link><pubDate>Wed, 23 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>' } : { url, contentType: 'text/html', text: '<article>AI deployment details</article>' };
  } });
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('feed-budget','2026-09-23T00:00:00Z','2026-09-24T00:00:00Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await executeScan(app, taskId, new Date('2026-09-23T00:00:00Z'), new Date('2026-09-24T00:00:00Z'));
    assert.deepEqual(limits, [2_000_000, 0]);
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('source collection retries transient failures once and isolates permanent failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-source-retry-'));
  const db = openDatabase(join(directory, 'test.db'));
  db.prepare('UPDATE sources SET enabled=source_id IN (1,2)').run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  let officialAttempts = 0;
  const app = createApp({ db, logger: false, searchClient: undefined, fetchSource: async (url) => {
    if (url === 'https://openai.com/news/' && officialAttempts++ === 0) throw new SourceFetchError('timeout');
    if (url === 'https://www.anthropic.com/news') throw new SourceFetchError('http_4xx', 404);
    if (url === 'https://openai.com/news/') return { url, contentType: 'application/rss+xml', text: '<rss><channel><item><title>AI launch</title><link>https://example.org/ai-launch</link><pubDate>2026-09-23T12:00:00Z</pubDate></item></channel></rss>' };
    return { url, contentType: 'text/html', text: '<article>AI launch details</article>' };
  }});
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('source-retry','2026-09-23T00:00:00Z','2026-09-24T00:00:00Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await executeScan(app, taskId, new Date('2026-09-23T00:00:00Z'), new Date('2026-09-24T00:00:00Z'));
    assert.equal(officialAttempts, 2);
    assert.equal((db.prepare('SELECT status FROM scan_tasks WHERE task_id=?').get(taskId) as { status: string }).status, 'partial_failed');
    assert.deepEqual(db.prepare('SELECT source_success_count sourceSuccessCount,source_failure_count sourceFailureCount,anysearch_query_count anysearchQueryCount FROM scan_tasks WHERE task_id=?').get(taskId), { sourceSuccessCount: 1, sourceFailureCount: 1, anysearchQueryCount: 0 });
    assert.deepEqual(db.prepare('SELECT last_error_code lastError,last_error_reason reason FROM sources WHERE source_id=1').get(), { lastError: null, reason: null });
    assert.deepEqual(db.prepare('SELECT last_error_code lastError,last_error_reason reason FROM sources WHERE source_id=2').get(), { lastError: 800007, reason: 'http_4xx' });
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('source and AnySearch collection run in parallel and quota preserves returned discoveries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-search-parallel-'));
  const db = openDatabase(join(directory, 'test.db'));
  db.prepare('UPDATE sources SET enabled=source_id=1').run();
  let sourceDone = false;
  let searchObservedSourcePending = false;
  let searches = 0;
  const searchClient = {
    async search() {
      if (!sourceDone) searchObservedSourcePending = true;
      searches += 1;
      if (searches > 2) throw new BusinessError(ErrorCodes.SEARCH_QUOTA_EXHAUSTED);
      return { requestId: `search-${searches}`, results: searches === 1 ? [{ title: 'AI case', url: 'https://search.example.org/case', content: 'AI workflow deployed in education', publishedAt: '2026-09-23T12:00:00Z' }] : [] };
    },
    async extract() { return { requestId: 'extract-id', content: 'unused' }; }
  } as unknown as AnySearchClient;
  const app = createApp({ db, logger: false, searchClient, fetchSource: async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    sourceDone = true;
    return { url, contentType: 'text/html', text: '<html><body>empty</body></html>' };
  }});
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('search-parallel','2026-09-23T00:00:00Z','2026-09-24T00:00:00Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await executeScan(app, taskId, new Date('2026-09-23T00:00:00Z'), new Date('2026-09-24T00:00:00Z'));
    assert.equal(searchObservedSourcePending, true);
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT anysearch_query_count count FROM scan_tasks WHERE task_id=?').get(taskId) as { count: number }).count, searches);
    assert.equal((db.prepare('SELECT status FROM scan_tasks WHERE task_id=?').get(taskId) as { status: string }).status, 'partial_failed');
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
