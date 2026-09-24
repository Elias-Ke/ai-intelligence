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
