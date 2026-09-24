import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { openDatabase } from '../src/persistence/database.js';
import { executeScan } from '../src/routes/scans.js';
import { AnySearchClient } from '../src/ingestion/AnySearchClient.js';

test('scan keeps undated articles as raw discoveries without inventing cards', async () => {
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
    for (const table of ['signals', 'opportunities', 'content_topics']) assert.equal((db.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }).count, 0);
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

test('scan persists 80 AnySearch runs and connects repeated results to their requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-intelligence-scan-'));
  const db = openDatabase(join(dir, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  const publishedAt = new Date(Date.now() - 3_600_000).toISOString();
  const searchClient = new AnySearchClient('https://api.anysearch.com', 'test-key', async () => new Response(JSON.stringify({ code: 0, request_id: 'provider-request-1', data: { results: [{ title: 'Published AI use case', url: 'https://example.org/real-case', snippet: 'Real case detail', publishedAt }] } }), { status: 200 }));
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
