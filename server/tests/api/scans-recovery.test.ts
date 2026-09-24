import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';
import { recoverInterruptedScans } from '../../src/persistence/recoverInterruptedScans.js';

test('startup recovery preserves discoveries, closes running steps, and permits retry', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-recovery-'));
  const db = openDatabase(join(directory, 'test.db'));
  const time = '2026-09-23T12:00:00.000Z';
  const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,discovered_count,current_step,created_at) VALUES('interrupted','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','collecting',1,'collecting',?)").run(time).lastInsertRowid);
  db.prepare("INSERT INTO scan_task_steps(task_id,step_name,status,started_at) VALUES(?,'collecting','running',?)").run(taskId, time);
  const discoveryId = Number(db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES('https://example.org/interrupted','https://example.org/interrupted','AI case',?,'old-hash','candidate',?,?)").run(time, time, time).lastInsertRowid);
  db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'anysearch',?)").run(taskId, discoveryId, time);
  const recovered = recoverInterruptedScans(db);
  assert.deepEqual(recovered, [taskId]);
  assert.deepEqual(recoverInterruptedScans(db), []);
  const app = createApp({ db, logger: false, autoRunScans: false });
  try {
    const detail = (await app.inject(`/api/scans/${taskId}`)).json();
    assert.equal(detail.code, 0);
    assert.equal(detail.data.status, 'partial_failed');
    assert.equal(detail.data.errorCode, 100003);
    assert.equal(detail.data.steps[0].status, 'failed');
    assert.equal(detail.data.steps[0].errorCode, 100003);
    assert.equal((await app.inject('/api/system/health')).json().data.activeTaskId, null);
    assert.equal((await app.inject(`/api/discoveries?taskId=${taskId}`)).json().data.items.length, 1);
    const retry = await app.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': 'retry-interrupted' } });
    assert.equal(retry.statusCode, 202);
    assert.equal(retry.json().data.taskId, taskId);
    assert.equal((db.prepare('SELECT count(*) count FROM raw_discoveries').get() as { count: number }).count, 1);
  } finally {
    await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('retry keys and original resume steps remain idempotent after database reopen', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-retry-persist-'));
  const path = join(directory, 'test.db');
  let db = openDatabase(path);
  const timestamp = new Date().toISOString();
  const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,current_step,created_at,started_at,finished_at) VALUES('persist-create','2026-09-22','2026-09-24','failed','generating',?,?,?)").run(timestamp, timestamp, timestamp).lastInsertRowid);
  db.prepare("INSERT INTO scan_task_steps(task_id,step_name,status) VALUES(?,'generating','failed')").run(taskId);
  const key = 'persist-retry-one';
  const firstApp = createApp({ db, logger: false, autoRunScans: false });
  try {
    const first = await firstApp.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': key } });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().data.resumeFromStep, 'generating');
    assert.equal((await firstApp.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': 'different' } })).json().code, 200003);
  } finally { await firstApp.close(); db.close(); }

  db = openDatabase(path);
  const secondApp = createApp({ db, logger: false, autoRunScans: false });
  try {
    assert.deepEqual(recoverInterruptedScans(db), [taskId]);
    const replay = await secondApp.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': key } });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().data.resumeFromStep, 'generating');
    assert.equal((db.prepare('SELECT count(*) count FROM scan_retry_requests WHERE task_id=?').get(taskId) as { count: number }).count, 1);
    const next = await secondApp.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': 'persist-retry-two' } });
    assert.equal(next.statusCode, 202);
    const historicalReplay = await secondApp.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': key } });
    assert.equal(historicalReplay.statusCode, 200);
    assert.equal(historicalReplay.json().data.resumeFromStep, 'generating');
    assert.equal((db.prepare('SELECT count(*) count FROM scan_retry_requests WHERE task_id=?').get(taskId) as { count: number }).count, 2);
  } finally { await secondApp.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
