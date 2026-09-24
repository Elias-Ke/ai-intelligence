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
    const conflict = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'scan-test-1' }, payload: { range: '3d' } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 200003);
    assert.equal(conflict.json().message, '该请求标识已用于其他扫描参数');
    const invalidKey = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'scan-é' }, payload: { range: '24h' } });
    assert.equal(invalidKey.json().code, 100001);
    const activeReuse = await app.inject({ method: 'POST', url: '/api/scans', headers: { 'idempotency-key': 'scan-test-2' }, payload: { range: '3d' } });
    assert.equal(activeReuse.json().data.taskId, taskId);
    assert.equal((db.prepare('SELECT count(*) count FROM scan_tasks').get() as { count: number }).count, 1);
    const details = await app.inject(`/api/scans/${taskId}`);
    assert.equal(details.statusCode, 200);
    assert.deepEqual(details.json().data.steps.map((step: { stepName: string; status: string }) => [step.stepName, step.status]), ['collecting', 'normalizing', 'clustering', 'analyzing', 'generating'].map((step) => [step, 'pending']));
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
    assert.deepEqual((await app.inject(`/api/scans/${id}`)).json().data.steps.map((step: { status: string }) => step.status), ['partial_failed', 'completed', 'completed', 'completed', 'completed']);
    app.fetchSource = async (url) => ({ url, contentType: 'text/html', text: '<main><article><h2><a href="/real-article">Real AI article title</a></h2></article></main>' });
    const retried = await app.inject({ method: 'POST', url: `/api/scans/${id}/retry`, headers: { 'idempotency-key': 'retry-attempt-1' } });
    assert.equal(retried.statusCode, 202);
    assert.equal(retried.json().data.taskId, id);
    assert.equal(await waitForTerminal(id), 'completed');
    assert.deepEqual((await app.inject(`/api/scans/${id}`)).json().data.steps.map((step: { status: string }) => step.status), Array(5).fill('completed'));
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
    app.taskEvents.emit('step_progress', { taskId: id, stepName: 'collecting', status: 'completed', itemsTotal: 2, itemsDone: 2, progress: 42 });
    app.taskEvents.emit('signal_ready', { taskId: id, signalId: 1, title: 'AI case', valueScore: 70 });
    app.taskEvents.emit('changed', id);
    const response = await stream;
    assert.match(response.body, /event: task_snapshot/);
    assert.match(response.body, /event: task_completed/);
    assert.match(response.body, /event: step_progress/);
    assert.match(response.body, /event: signal_ready/);
    const ids = [...response.body.matchAll(/id: (\d+)/g)].map((match) => Number(match[1]));
    assert.ok(ids.length >= 4 && ids.every((eventId, index) => index === 0 || eventId > ids[index - 1]));
    assert.equal(app.taskEvents.listenerCount('changed'), 0);
    const invalidId = await app.inject({ method: 'GET', url: `/api/scans/${id}/events`, headers: { accept: 'text/event-stream', 'last-event-id': 'invalid' } });
    assert.equal(invalidId.json().code, 100001);
    const reconnected = await app.inject({ method: 'GET', url: `/api/scans/${id}/events`, headers: { accept: 'text/event-stream', 'last-event-id': String(ids.at(-1)) } });
    assert.match(reconnected.body, /event: task_snapshot/);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('API-04 reruns a failed generation step without fetching sources or duplicating signals', async () => {
  const { app, db, directory } = await fixture();
  let sourceRequests = 0;
  app.fetchSource = async () => { sourceRequests++; throw new Error('should not fetch'); };
  const time = new Date().toISOString();
  const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,discovered_count,signal_count,current_step,created_at,started_at,finished_at) VALUES('generate-retry','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','failed',1,1,'generating',?,?,?)").run(time, time, time).lastInsertRowid);
  const discoveryId = Number(db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,snippet,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES('https://example.org/generate','https://example.org/generate','AI agent deployed','customer case',?,'generated-retry','accepted',?,?)").run(time, time, time).lastInsertRowid);
  const signalId = Number(db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,rules_version,state,event_at,created_at,updated_at) VALUES('generating-retry','AI agent deployed','customer case','use_case',65,65,65,65,70,65,65,65,'single_source',0,'v1','needs_review',?,?,?)").run(time, time, time).lastInsertRowid);
  db.prepare('INSERT INTO scan_signals(task_id,signal_id,rank_no,created_at) VALUES(?,?,1,?)').run(taskId, signalId, time);
  db.prepare("INSERT INTO signal_sources(signal_id,discovery_id,relation_type,added_at) VALUES(?,?,'primary',?)").run(signalId, discoveryId, time);
  db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'source',?)").run(taskId, discoveryId, time);
  for (const step of ['collecting', 'normalizing', 'clustering', 'analyzing', 'generating']) db.prepare('INSERT INTO scan_task_steps(task_id,step_name,status,error_code) VALUES(?,?,?,?)').run(taskId, step, step === 'generating' ? 'failed' : 'completed', step === 'generating' ? 910002 : null);
  try {
    const headers = { 'idempotency-key': 'retry-generating' };
    const first = await app.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers });
    assert.equal(first.statusCode, 202);
    assert.equal(first.json().data.resumeFromStep, 'generating');
    assert.equal((await app.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/scans/${taskId}/retry`, headers: { 'idempotency-key': 'different' } })).json().code, 200003);
    const { runScan } = await import('../../src/routes/scans.js');
    await runScan(app, taskId);
    assert.equal(sourceRequests, 0);
    assert.equal((db.prepare('SELECT count(*) count FROM scan_signals WHERE task_id=?').get(taskId) as { count: number }).count, 1);
    assert.deepEqual((await app.inject(`/api/scans/${taskId}`)).json().data.steps.slice(0, 4).map((step: { status: string }) => step.status), Array(4).fill('completed'));
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
