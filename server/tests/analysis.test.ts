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
    assert.equal(signal.sourceName, 'OpenAI');
    assert.equal(signal.evidenceCount, 1);
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

test('Chinese event joins its earlier signal after more than 100 nearby candidates', async () => {
  const db = openDatabase(':memory:');
  const app = createApp({ db, logger: false, autoRunScans: false });
  const time = '2026-09-23T12:00:00.000Z';
  const title = 'AI 智能体落地教育服务';
  const insertDiscovery = db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,snippet,published_at,published_at_verified,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,1,?,?,'accepted',?,?)");
  const insertTask = db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,'2026-09-22T00:00:00.000Z','2026-09-24T00:00:00.000Z','completed',?)");
  try {
    const firstTask = Number(insertTask.run('chinese-first', time).lastInsertRowid);
    const firstDiscovery = Number(insertDiscovery.run('https://first.example.org/ai-case', 'https://first.example.org/ai-case', title, '客户场景', time, time, 'first-chinese', time, time).lastInsertRowid);
    db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'source',?)").run(firstTask, firstDiscovery, time);
    assert.equal(analyzeDiscoveries(app, firstTask), 1);
    const originalId = (db.prepare('SELECT signal_id signalId FROM signals').get() as { signalId: number }).signalId;
    const insertNoise = db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,'technology',60,60,60,60,60,60,60,60,'single_source','v1','active',?,?,?)");
    for (let index = 0; index < 110; index++) insertNoise.run(`noise-${index}`, `腾讯客服方案 ${index}`, 'unrelated', time, time, time);
    const nextTask = Number(insertTask.run('chinese-next', time).lastInsertRowid);
    const nextDiscovery = Number(insertDiscovery.run('https://second.example.net/ai-case', 'https://second.example.net/ai-case', `${title}！`, '独立报道', time, time, 'second-chinese', time, time).lastInsertRowid);
    db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'source',?)").run(nextTask, nextDiscovery, time);
    assert.equal(analyzeDiscoveries(app, nextTask), 1);
    assert.equal((db.prepare('SELECT count(*) count FROM signals').get() as { count: number }).count, 111);
    assert.equal((db.prepare('SELECT signal_id signalId FROM signal_sources WHERE discovery_id=?').get(nextDiscovery) as { signalId: number }).signalId, originalId);
  } finally { await app.close(); db.close(); }
});
