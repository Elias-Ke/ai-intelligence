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
  const app = createApp({ db, logger: false, fetchSource: async (url) => ({ url, text: '<title>Test</title>', contentType: 'text/html' }) });
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
    const events = await app.inject({ method: 'GET', url: `/api/scans/${taskId}/events`, headers: { accept: 'text/event-stream' } });
    assert.equal(events.statusCode, 200);
    assert.match(events.headers['content-type'] as string, /text\/event-stream/);
    assert.match(events.body, /task_snapshot/);
    const wrongAccept = await app.inject(`/api/scans/${taskId}/events`);
    assert.equal(wrongAccept.json().code, 200008);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
