import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { analyzeDiscoveries } from '../src/domain/analyzeDiscoveries.js';
import { contradicts, eventSimilarity } from '../src/domain/clustering.js';
import { openDatabase } from '../src/persistence/database.js';

test('Jaccard distinguishes events and treats negated claims as potentially conflicting', () => {
  assert.equal(eventSimilarity('AI platform launched for schools', 'AI platform launched for schools'), 1);
  assert.ok(eventSimilarity('AI platform launched for schools', 'AI platform acquired by schools') < 0.82);
  assert.ok(eventSimilarity('AI platform launched for schools', 'AI platform not launched for schools') >= 0.82);
  assert.ok(contradicts('AI platform launched for schools', 'AI platform not launched for schools'));
});

test('same event groups independent evidence, preserves different events and flags conflict', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-clusters-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  const time = '2026-09-23T12:00:00.000Z';
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('cluster-test','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','completed',?)").run(time).lastInsertRowid);
    const stories = [
      ['https://primary.example.com/launch', 'AI platform launched for schools'],
      ['https://independent.example.net/launch', 'AI platform launched for schools'],
      ['https://other.example.org/acquisition', 'AI platform acquired by schools'],
      ['https://challenge.example.io/launch', 'AI platform not launched for schools']
    ];
    for (const [index, [url, title]] of stories.entries()) {
      const discoveryId = Number(db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,snippet,content,published_at,published_at_verified,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,1,?,?,'accepted',?,?)").run(url, url, title, 'Published evidence', 'Published evidence', time, time, `hash-${index}`, time, time).lastInsertRowid);
      db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'anysearch',?)").run(taskId, discoveryId, time);
    }
    assert.equal(analyzeDiscoveries(app, taskId), 2);
    const grouped = db.prepare('SELECT signal_id signalId,evidence_level evidenceLevel,has_conflict hasConflict FROM signals WHERE title=?').get('AI platform launched for schools') as { signalId: number; evidenceLevel: string; hasConflict: number };
    assert.equal(grouped.evidenceLevel, 'conflicting');
    assert.equal(grouped.hasConflict, 1);
    assert.deepEqual((db.prepare('SELECT relation_type relationType,is_independent independent FROM signal_sources WHERE signal_id=? ORDER BY discovery_id').all(grouped.signalId) as { relationType: string; independent: number }[]).map((row) => row.relationType), ['primary', 'supporting', 'conflicting']);
    assert.equal((db.prepare('SELECT count(*) count FROM signal_sources WHERE signal_id=? AND is_independent=1').get(grouped.signalId) as { count: number }).count, 3);
    assert.equal((db.prepare('SELECT is_highlight highlighted FROM scan_signals WHERE task_id=? AND signal_id=?').get(taskId, grouped.signalId) as { highlighted: number }).highlighted, 0);
    assert.equal(analyzeDiscoveries(app, taskId), 2);
    assert.equal((db.prepare('SELECT count(*) count FROM signal_sources WHERE signal_id=?').get(grouped.signalId) as { count: number }).count, 3);
  } finally {
    await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('undated AI discoveries become reviewable signals without pretending the date is verified', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-undated-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  const time = '2026-09-23T12:00:00.000Z';
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('undated-test','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','completed',?)").run(time).lastInsertRowid);
    const sourceId = (db.prepare("SELECT source_id sourceId FROM sources WHERE name='OpenAI'").get() as { sourceId: number }).sourceId;
    const discoveryId = Number(db.prepare("INSERT INTO raw_discoveries(source_id,url,normalized_url,title,snippet,content,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES(?,'https://example.org/undated','https://example.org/undated','AI agent deployed for education','Customer case study', 'Customer case study',?,'undated-hash','candidate',?,?)").run(sourceId, time, time, time).lastInsertRowid);
    db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'source',?)").run(taskId, discoveryId, time);
    assert.equal(analyzeDiscoveries(app, taskId), 1);
    const signal = (await app.inject(`/api/signals?taskId=${taskId}`)).json().data.items[0];
    assert.equal(signal.state, 'needs_review');
    assert.equal(signal.isHighlighted, 0);
    assert.equal(signal.publishedAtVerified, 0);
    assert.equal((await app.inject(`/api/signals/${signal.signalId}`)).json().data.scoreExplanation.publishedAtVerified, 0);
    assert.equal((db.prepare('SELECT status FROM raw_discoveries WHERE discovery_id=?').get(discoveryId) as { status: string }).status, 'candidate');
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('a later scan updates evidence without restoring a manually archived signal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-archive-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  const time = '2026-09-23T12:00:00.000Z';
  try {
    const firstTask = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('archive-first','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','completed',?)").run(time).lastInsertRowid);
    const discoveryId = Number(db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,snippet,published_at,published_at_verified,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES('https://example.org/archive','https://example.org/archive','AI agent launched for schools','Customer deployment',?,1,?,'archive-hash','accepted',?,?)").run(time, time, time, time).lastInsertRowid);
    db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'anysearch',?)").run(firstTask, discoveryId, time);
    assert.equal(analyzeDiscoveries(app, firstTask), 1);
    const signalId = (db.prepare('SELECT signal_id signalId FROM signals').get() as { signalId: number }).signalId;
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/signals/${signalId}/state`, payload: { state: 'archived' } })).json().code, 0);
    const nextTask = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('archive-next','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','completed',?)").run(time).lastInsertRowid);
    db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'anysearch',?)").run(nextTask, discoveryId, time);
    assert.equal(analyzeDiscoveries(app, nextTask), 1);
    assert.equal((await app.inject(`/api/signals/${signalId}`)).json().data.state, 'archived');
    assert.equal((db.prepare('SELECT is_highlight highlighted FROM scan_signals WHERE task_id=?').get(nextTask) as { highlighted: number }).highlighted, 0);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
