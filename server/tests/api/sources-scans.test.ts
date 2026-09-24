import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';
import { BusinessError, ErrorCodes } from '../../src/domain/errorCodes.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false, fetchSource: async (url) => ({ url, text: '<title>Test</title>', contentType: 'text/html' }) });
  await app.ready();
  return { app, db, directory };
}

test('API-19/20/23 sources list, create, duplicate and toggle', async () => {
  const { app, db, directory } = await fixture();
  try {
    const list = await app.inject('/api/sources?limit=30');
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.items.length, 30);
    const created = await app.inject({ method: 'POST', url: '/api/sources', payload: { name: 'Test source', sourceGroup: '新发现候选', kind: 'web', url: 'https://example.org/ai', language: 'mixed', region: 'global', trustLevel: 1 } });
    assert.equal(created.statusCode, 201);
    const sourceId = created.json().data.sourceId;
    const duplicate = await app.inject({ method: 'POST', url: '/api/sources', payload: { name: 'Duplicate', sourceGroup: '新发现候选', kind: 'web', url: 'https://example.org/ai', language: 'mixed', region: 'global', trustLevel: 1 } });
    assert.equal(duplicate.json().code, 800006);
    const toggled = await app.inject({ method: 'PATCH', url: `/api/sources/${sourceId}`, payload: { enabled: false } });
    assert.equal(toggled.statusCode, 200);
    const bad = await app.inject({ method: 'POST', url: '/api/sources', payload: { name: 'Private', sourceGroup: 'x', kind: 'web', url: 'http://127.0.0.1/x', language: 'en', region: 'intl', trustLevel: 1 } });
    assert.equal(bad.json().code, 800005);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API-23 rejects an unreachable source without writing it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, fetchSource: async () => { throw new BusinessError(ErrorCodes.SOURCE_UNREACHABLE); } });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/sources', payload: { name: 'Unreachable', sourceGroup: '测试', kind: 'web', url: 'https://example.org/absent', language: 'en', region: 'intl', trustLevel: 1 } });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().code, 800007);
    assert.equal(db.prepare('SELECT 1 FROM sources WHERE url=?').get('https://example.org/absent'), undefined);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API-01/02/03/04/05 scans validate idempotency and expose task SSE', async () => {
  const { app, db, directory } = await fixture();
  try {
    const missingKey = await app.inject({ method: 'POST', url: '/api/scans', payload: { range: '24h' } });
    assert.equal(missingKey.json().code, 200002);
    const first = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'scan-test-1' }, payload: { range: '24h' } });
    assert.equal(first.statusCode, 202);
    const taskId = first.json().data.taskId;
    const reused = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'scan-test-1' }, payload: { range: '24h' } });
    assert.equal(reused.statusCode, 200);
    assert.equal(reused.json().data.reused, true);
    const details = await app.inject(`/api/scans/${taskId}`);
    assert.equal(details.statusCode, 200);
    const history = await app.inject('/api/scans?status=created');
    assert.equal(history.statusCode, 200);
    db.prepare("UPDATE scan_tasks SET status='completed',started_at=?,finished_at=? WHERE task_id=?").run(new Date().toISOString(), new Date().toISOString(), taskId);
    const events = await app.inject({ method: 'GET', url: `/api/scans/${taskId}/events`, headers: { accept: 'text/event-stream' } });
    assert.equal(events.statusCode, 200);
    assert.match(events.headers['content-type'] as string, /text\/event-stream/);
    assert.match(events.body, /task_snapshot/);
    assert.match(events.body, /task_completed/);
    const wrongAccept = await app.inject(`/api/scans/${taskId}/events`);
    assert.equal(wrongAccept.json().code, 200008);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API-04 retries a failed scan in the same task without duplicating it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-'));
  const db = openDatabase(join(directory, 'test.db'));
  db.prepare('UPDATE sources SET enabled=0 WHERE source_id!=1').run();
  const app = createApp({ db, logger: false, fetchSource: async () => { throw new Error('source unavailable'); } });
  const waitForTerminal = (id: number) => new Promise<string>((resolve, reject) => {
    const check = (changedId: number) => {
      if (changedId !== id) return;
      const row = db.prepare('SELECT status FROM scan_tasks WHERE task_id=?').get(id) as { status: string };
      if (['completed', 'failed', 'partial_failed'].includes(row.status)) { clearTimeout(timeout); app.taskEvents.off('changed', check); resolve(row.status); }
    };
    const timeout = setTimeout(() => { app.taskEvents.off('changed', check); reject(new Error('scan did not reach terminal status')); }, 2000);
    app.taskEvents.on('changed', check);
    check(id);
  });
  try {
    const first = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'retry-create' }, payload: { range: '24h' } });
    const id = first.json().data.taskId as number;
    assert.equal(await waitForTerminal(id), 'failed');
    app.fetchSource = async (url) => ({ url, contentType: 'text/html', text: '<main><article><h2><a href="/real-article">Real AI article title</a></h2></article></main>' });
    const retried = await app.inject({ method: 'POST', url: `/api/scans/${id}/retry`, headers: { 'idempotency-key': 'retry-attempt-1' } });
    assert.equal(retried.statusCode, 202);
    assert.equal(retried.json().data.taskId, id);
    assert.equal(await waitForTerminal(id), 'completed');
    assert.equal((db.prepare('SELECT count(*) AS count FROM scan_tasks').get() as { count: number }).count, 1);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API-05 keeps SSE open until a task state changes to terminal', async () => {
  const { app, db, directory } = await fixture();
  try {
    const created = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'stream-task' }, payload: { range: '24h' } });
    const id = created.json().data.taskId as number;
    const stream = app.inject({ method: 'GET', url: `/api/scans/${id}/events`, headers: { accept: 'text/event-stream' } });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { clearInterval(check); reject(new Error('SSE listener did not attach')); }, 2000);
      const check = setInterval(() => { if (app.taskEvents.listenerCount('changed') > 0) { clearInterval(check); clearTimeout(timeout); resolve(); } }, 1);
    });
    db.prepare("UPDATE scan_tasks SET status='completed',started_at=?,finished_at=? WHERE task_id=?").run(new Date().toISOString(), new Date().toISOString(), id);
    app.taskEvents.emit('changed', id);
    const response = await stream;
    assert.match(response.body, /event: task_snapshot/);
    assert.match(response.body, /event: task_completed/);
    assert.equal(app.taskEvents.listenerCount('changed'), 0);
    const invalidId = await app.inject({ method: 'GET', url: `/api/scans/${id}/events`, headers: { accept: 'text/event-stream', 'last-event-id': 'invalid' } });
    assert.equal(invalidId.json().code, 100001);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
