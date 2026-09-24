import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { AnySearchClient } from '../../src/ingestion/AnySearchClient.js';
import { openDatabase } from '../../src/persistence/database.js';
import { executeScan } from '../../src/routes/scans.js';

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
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { url, contentType: 'application/rss+xml', text: '<rss><channel><item><title>AI business use case launch</title><link>https://example.org/1</link><pubDate>2026-09-23T12:00:00Z</pubDate></item></channel></rss>' };
  } });
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('timeout','2026-09-23T00:00:00Z','2026-09-24T00:00:00Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await executeScan(app, taskId, new Date('2026-09-23T00:00:00Z'), new Date('2026-09-24T00:00:00Z'), 1);
    assert.equal(requests, 1);
    const task = db.prepare('SELECT status,error_code errorCode FROM scan_tasks WHERE task_id=?').get(taskId) as { status: string; errorCode: number };
    assert.deepEqual(task, { status: 'failed', errorCode: 200010 });
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
