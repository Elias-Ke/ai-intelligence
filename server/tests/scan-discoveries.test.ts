import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/persistence/database.js';
import { executeScan } from '../src/routes/scans.js';
import { AnySearchClient } from '../src/ingestion/AnySearchClient.js';
import { createHash } from 'node:crypto';

test('scan keeps undated articles as reviewable signals without inventing cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-scan-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => ({ url, contentType: 'text/html', text: '<main><article><h2><a href="/news/agent-case">Agent deployment in real workflows</a></h2><p>Reported by the company</p></article></main>' }) });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'undated-article' }, payload: { range: '24h' } });
    const taskId = result.json().data.taskId as number;
    const to = new Date(); const from = new Date(to.getTime() - 86_400_000);
    await executeScan(app, taskId, from, to);
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
    const raw = db.prepare('SELECT url,status,published_at_verified verified FROM raw_discoveries').get() as { url: string; status: string; verified: number };
    assert.match(raw.url, /\/news\/agent-case$/);
    assert.equal(raw.status, 'candidate'); assert.equal(raw.verified, 0);
    const signal = db.prepare('SELECT state FROM signals').get() as { state: string };
    assert.equal(signal.state, 'needs_review');
    assert.equal((db.prepare('SELECT is_highlight highlighted FROM scan_signals WHERE task_id=?').get(taskId) as { highlighted: number }).highlighted, 0);
    for (const table of ['opportunities', 'content_topics']) assert.equal((db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count, 0);
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('scan analyzes only entries whose publication date is inside its range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-scan-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare("UPDATE sources SET enabled=0 WHERE source_id!=1").run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  const current = new Date(Date.now() - 3_600_000).toUTCString();
  const old = new Date(Date.now() - 10 * 86_400_000).toUTCString();
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => ({ url, contentType: 'application/rss+xml', text: `<rss><channel><item><title>New AI deployment in schools</title><link>https://example.org/new-ai</link><description>School workflow</description><pubDate>${current}</pubDate></item><item><title>Old AI deployment in schools</title><link>https://example.org/old-ai</link><description>Old workflow</description><pubDate>${old}</pubDate></item></channel></rss>` }) });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'dated-articles' }, payload: { range: '24h' } });
    const taskId = result.json().data.taskId as number;
    const to = new Date(); await executeScan(app, taskId, new Date(to.getTime() - 86_400_000), to);
    const rows = db.prepare('SELECT url,status,published_at_verified verified FROM raw_discoveries ORDER BY url').all() as { url: string; status: string; verified: number }[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((entry) => entry.status).sort(), ['accepted', 'rejected']);
    assert.ok(rows.every((entry) => entry.verified === 1));
    assert.equal((db.prepare('SELECT count(*) count FROM signals').get() as { count: number }).count, 1);
    for (const table of ['opportunities', 'content_topics']) assert.equal((db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count, 0);
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a wider scan reuses an earlier out-of-range discovery without changing old task results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-range-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  const published = new Date(Date.now() - 3 * 86_400_000).toUTCString();
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => url.endsWith('/ai-case')
    ? { url, contentType: 'text/html', text: '<article>AI Agent deployed in schools</article>' }
    : { url, contentType: 'application/rss+xml', text: `<rss><channel><item><title>AI Agent deployed in schools</title><link>https://example.org/ai-case</link><description>Customer workflow</description><pubDate>${published}</pubDate></item></channel></rss>` } });
  try {
    const end = new Date();
    const scan = async (key: string, days: number) => {
      const start = new Date(end.getTime() - days * 86_400_000);
      const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,'created',?)").run(key, start.toISOString(), end.toISOString(), end.toISOString()).lastInsertRowid);
      await executeScan(app, taskId, start, end);
      return taskId;
    };
    const narrow = await scan('range-1d', 1);
    assert.equal((await app.inject(`/api/discoveries?taskId=${narrow}&status=rejected`)).json().data.items.length, 1);
    assert.equal((await app.inject(`/api/discoveries?taskId=${narrow}`)).json().data.items[0].rejectionReason, 'outside_scan_range');
    assert.equal((db.prepare('SELECT count(*) count FROM signals').get() as { count: number }).count, 0);
    const wider = await scan('range-7d', 7);
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
    assert.equal((await app.inject(`/api/discoveries?taskId=${wider}&status=accepted`)).json().data.items.length, 1);
    assert.equal((await app.inject(`/api/discoveries?taskId=${narrow}&status=rejected`)).json().data.items.length, 1);
    assert.equal((await app.inject(`/api/signals?taskId=${wider}`)).json().data.items.length, 1);
    assert.equal((await app.inject(`/api/signals?taskId=${narrow}`)).json().data.items.length, 0);
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed article extraction keeps feed metadata as a reviewable signal without generating cards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-extract-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  const published = new Date(Date.now() - 3_600_000).toUTCString();
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => {
    if (url.endsWith('/ai-case')) throw new Error('article blocked');
    return { url, contentType: 'application/rss+xml', text: `<rss><channel><item><title>AI Agent launched and deployed in schools</title><link>https://example.org/ai-case</link><description>Customer production workflow</description><pubDate>${published}</pubDate></item></channel></rss>` };
  } });
  try {
    const end = new Date(); const start = new Date(end.getTime() - 86_400_000);
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('extract-failure',?,?,'created',?)").run(start.toISOString(), end.toISOString(), end.toISOString()).lastInsertRowid);
    await executeScan(app, taskId, start, end);
    assert.equal((await app.inject(`/api/discoveries?taskId=${taskId}&status=extract_failed`)).json().data.items.length, 1);
    const signal = (await app.inject(`/api/signals?taskId=${taskId}`)).json().data.items[0];
    assert.ok(signal);
    assert.equal(signal.state, 'needs_review');
    assert.equal(signal.isHighlighted, 0);
    assert.equal(signal.publishedAtVerified, 1);
    assert.equal((db.prepare('SELECT count(*) count FROM opportunities').get() as { count: number }).count, 0);
    assert.equal((db.prepare('SELECT count(*) count FROM content_topics').get() as { count: number }).count, 0);
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('successful re-extraction upgrades a reused failed discovery and its signal', async () => {
  const db = openDatabase(':memory:');
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  const published = new Date(Date.now() - 3_600_000).toUTCString();
  let fail = true;
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => {
    if (url.endsWith('/ai-case')) {
      if (fail) throw new Error('temporary article failure');
      return { url, contentType: 'text/html', text: '<article>Customer workflow</article>' };
    }
    return { url, contentType: 'application/rss+xml', text: `<rss><channel><item><title>AI Agent deployed in schools</title><link>https://example.org/ai-case</link><description>Customer workflow</description><pubDate>${published}</pubDate></item></channel></rss>` };
  } });
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const end = new Date(); const start = new Date(end.getTime() - 86_400_000);
      const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,'created',?)").run(`extract-attempt-${attempt}`, start.toISOString(), end.toISOString(), end.toISOString()).lastInsertRowid);
      await executeScan(app, taskId, start, end);
      const row = db.prepare('SELECT status,rejection_reason rejectionReason FROM raw_discoveries').get() as { status: string; rejectionReason: string | null };
      assert.deepEqual(row, attempt === 1 ? { status: 'extract_failed', rejectionReason: 'extraction_failed' } : { status: 'accepted', rejectionReason: null });
      assert.equal((db.prepare('SELECT state FROM signals').get() as { state: string }).state, attempt === 1 ? 'needs_review' : 'active');
      fail = false;
    }
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT count(*) count FROM signals').get() as { count: number }).count, 1);
  } finally { await app.close(); db.close(); }
});

test('official source collection attributes a discovery first found through search', async () => {
  const db = openDatabase(':memory:');
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  db.prepare("UPDATE sources SET kind='rss' WHERE source_id=1").run();
  const published = new Date(Date.now() - 3_600_000);
  const content = 'Customer workflow';
  const hash = createHash('sha256').update(content).digest('hex');
  db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,snippet,content,published_at,published_at_verified,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES('https://example.org/ai-case','https://example.org/ai-case','AI Agent deployed in schools',?,?,?,1,?,?,'accepted',?,?)").run(content, content, published.toISOString(), published.toISOString(), hash, published.toISOString(), published.toISOString());
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => url.endsWith('/ai-case')
    ? { url, contentType: 'text/html', text: '<article>Customer workflow</article>' }
    : { url, contentType: 'application/rss+xml', text: `<rss><channel><item><title>AI Agent deployed in schools</title><link>https://example.org/ai-case</link><description>Customer workflow</description><pubDate>${published.toUTCString()}</pubDate></item></channel></rss>` } });
  try {
    const end = new Date(); const start = new Date(end.getTime() - 86_400_000);
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('source-attribution',?,?,'created',?)").run(start.toISOString(), end.toISOString(), end.toISOString()).lastInsertRowid);
    await executeScan(app, taskId, start, end);
    const discovery = (await app.inject(`/api/discoveries?taskId=${taskId}`)).json().data.items[0];
    assert.equal(discovery.sourceName, 'OpenAI');
    const signal = (await app.inject(`/api/signals?taskId=${taskId}`)).json().data.items[0];
    assert.equal(signal.sourceName, 'OpenAI');
    assert.equal(signal.evidenceLevel, 'first_party');
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
  } finally { await app.close(); db.close(); }
});

test('scan persists 80 AnySearch runs and connects repeated results to their requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-scan-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  const publishedAt = new Date(Date.now() - 3_600_000).toISOString();
  const searchClient = new AnySearchClient('https://api.anysearch.com', 'test-key', async () => new Response(JSON.stringify({ code: 0, request_id: 'provider-request-1', data: { results: [{ title: 'Published AI use case', url: 'https://example.org/real-case', snippet: 'Real case detail', content: 'Verified public case body', publishedAt }] } }), { status: 200 }));
  const app = createApp({ db, logger: false, autoRunScans: false, searchClient, fetchSource: async (url) => ({ url, contentType: 'text/html', text: '<html><body>Empty index</body></html>' }) });
  try {
    const result = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'search-provenance' }, payload: { range: '24h' } });
    const taskId = result.json().data.taskId as number;
    const to = new Date(); await executeScan(app, taskId, new Date(to.getTime() - 86_400_000), to);
    assert.equal((db.prepare('SELECT count(*) count FROM search_runs WHERE task_id=?').get(taskId) as { count: number }).count, 80);
    assert.equal((db.prepare('SELECT count(*) count FROM discovery_search_runs').get() as { count: number }).count, 80);
    assert.equal((db.prepare('SELECT count(*) count FROM scan_discoveries WHERE task_id=?').get(taskId) as { count: number }).count, 1);
    const run = db.prepare('SELECT query_version version,anysearch_request_id requestId FROM search_runs LIMIT 1').get() as { version: string; requestId: string };
    assert.deepEqual(run, { version: 'v1', requestId: 'provider-request-1' });
    assert.equal((db.prepare('SELECT count(*) count FROM signals').get() as { count: number }).count, 1);
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('AnySearch quota failure stops pending queries without persisting credential text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-scan-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  let requests = 0;
  const searchClient = new AnySearchClient('https://api.anysearch.com', 'test-key', async () => {
    requests += 1;
    return new Response('username=user\npassword=secret\napi_key=secret', { status: 402 });
  });
  const app = createApp({ db, logger: false, autoRunScans: false, searchClient, fetchSource: async (url) => ({ url, contentType: 'text/html', text: '<html><body>No articles</body></html>' }) });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'quota-test' }, payload: { range: '24h' } });
    const taskId = response.json().data.taskId as number;
    const to = new Date(); await executeScan(app, taskId, new Date(to.getTime() - 86_400_000), to);
    assert.ok(requests <= 5, 'no new requests are scheduled after the five concurrent quota failures');
    const task = db.prepare('SELECT status,error_code code,error_message message FROM scan_tasks WHERE task_id=?').get(taskId) as { status: string; code: number; message: string };
    assert.equal(task.status, 'failed'); assert.equal(task.code, 300005);
    assert.doesNotMatch(task.message, /secret|password|api_key/);
    const runs = db.prepare('SELECT status,error_code code FROM search_runs WHERE task_id=?').all(taskId) as { status: string; code: number }[];
    assert.equal(runs.length, requests);
    assert.ok(runs.every((run) => run.status === 'failed' && run.code === 300005));
  } finally { await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});
