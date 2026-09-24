import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { AnySearchClient } from '../../src/ingestion/AnySearchClient.js';
import { openDatabase } from '../../src/persistence/database.js';
import { runScan } from '../../src/routes/scans.js';

test('scan extracts missing search bodies with three workers and retains metadata on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-extract-'));
  const db = openDatabase(join(directory, 'test.db'));
  let searchCalls = 0; let active = 0; let peak = 0;
  const requests: string[] = [];
  const client = new AnySearchClient('https://api.example.org', 'secret', (async (input, init) => {
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer secret');
    if (String(input).endsWith('/v1/search')) {
      const index = ++searchCalls;
      const results = index === 1 ? [1, 2, 3, 4, 5].map((number) => ({ title: `AI Result ${number}`, url: `https://example.org/${number}`, snippet: `Snippet ${number}`, published_at: '2026-09-23T12:00:00.000Z' })) : [];
      return Response.json({ code: 0, request_id: `search-${index}`, data: { results } });
    }
    assert.ok(String(input).endsWith('/v1/extract'));
    const body = JSON.parse(String(init?.body)) as { url: string };
    requests.push(body.url);
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (body.url.endsWith('/5')) return Response.json({ code: 422, message: 'unavailable' }, { status: 422 });
    return Response.json({ code: 0, request_id: 'extract-request', data: { url: body.url, content: 'x'.repeat(60_000) } });
  }) as typeof fetch);
  const app = createApp({ db, logger: false, searchClient: client, fetchSource: async (url) => url.includes('api.github.com') ? { url, text: '{"items":[]}', contentType: 'application/json' } : { url, text: '', contentType: 'text/html' } });
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('extraction-test','2026-09-23T00:00:00.000Z','2026-09-24T00:00:00.000Z','created',?)").run(new Date().toISOString()).lastInsertRowid);
    await runScan(app, taskId);
    const result = db.prepare('SELECT status,discovered_count discoveredCount,signal_count signalCount,error_code errorCode FROM scan_tasks WHERE task_id=?').get(taskId) as Record<string, unknown>;
    assert.deepEqual(result, { status: 'partial_failed', discoveredCount: 5, signalCount: 4, errorCode: 300004 });
    assert.equal(searchCalls, 80);
    assert.equal(requests.length, 5);
    assert.equal(peak, 3);
    const discoveries = db.prepare('SELECT status,length(content) contentLength,snippet FROM raw_discoveries ORDER BY discovery_id').all() as { status: string; contentLength: number; snippet: string }[];
    assert.deepEqual(discoveries.map(({ status }) => status), ['accepted', 'accepted', 'accepted', 'accepted', 'extract_failed']);
    assert.equal(discoveries[0]?.contentLength, 50_000);
    assert.equal(discoveries[4]?.snippet, 'Snippet 5');
  } finally {
    await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('AnySearch extract rejects invalid envelope and mismatched URL without leaking response text', async () => {
  const client = new AnySearchClient('https://api.example.org', 'secret', (async () => Response.json({ code: 0, request_id: 'id', data: { url: 'https://other.example.org', content: 'secret' } })) as typeof fetch);
  await assert.rejects(client.extract('https://example.org/article'), { code: 300004 });
  const quota = new AnySearchClient('https://api.example.org', 'secret', (async () => Response.json({ message: 'secret bearer token' }, { status: 402 })) as typeof fetch);
  await assert.rejects(quota.extract('https://example.org/article'), { code: 300005 });
});
