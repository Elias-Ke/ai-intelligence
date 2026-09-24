import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { identifyEntities, updateTrends } from '../../src/domain/trends.js';
import { openDatabase } from '../../src/persistence/database.js';

test('entity extraction identifies technology, industry and official company', () => {
  const entities = identifyEntities('OpenAI launches AI Agent for schools', 'Customer case study', 'OpenAI', 5, 'use_case');
  assert.ok(entities.some((item) => item.type === 'industry' && item.name === '教育'));
  assert.ok(entities.some((item) => item.type === 'technology' && item.name === 'AI Agent'));
  assert.ok(entities.some((item) => item.type === 'company' && item.name === 'OpenAI'));
  assert.ok(entities.some((item) => item.type === 'topic' && item.name === 'AI 实际落地'));
});

test('scan signals populate timeline and followed entity boosts subsequent ranking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-trends-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  const time = '2026-09-23T12:00:00.000Z';
  try {
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('trend-test','2026-09-22T00:00:00Z','2026-09-24T00:00:00Z','completed',?)").run(time).lastInsertRowid);
    const titles = ['OpenAI launches AI Agent for schools', 'AI product launches for business'];
    const ids = titles.map((title, index) => Number(db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,'Customer case study','use_case',60,60,60,60,60,60,60,?,'first_party',0,'v1','active',?,?,?)").run(`trend-${index}`, title, 60 + index * 5, time, time, time).lastInsertRowid));
    for (const [index, signalId] of ids.entries()) db.prepare('INSERT INTO scan_signals(task_id,signal_id,rank_no,created_at) VALUES(?,?,?,?)').run(taskId, signalId, index + 1, time);
    const rawId = Number(db.prepare("INSERT INTO raw_discoveries(source_id,url,normalized_url,title,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES(1,'https://example.org/agent','https://example.org/agent','OpenAI launches AI Agent for schools',?,'trend-hash','accepted',?,?)").run(time, time, time).lastInsertRowid);
    db.prepare("INSERT INTO signal_sources(signal_id,discovery_id,relation_type,added_at) VALUES(?,?,'primary',?)").run(ids[0], rawId, time);
    assert.ok(updateTrends(app, taskId) >= 4);
    assert.ok(updateTrends(app, taskId) >= 4);
    const entity = db.prepare("SELECT entity_id entityId FROM entities WHERE name='OpenAI'").get() as { entityId: number };
    const detail = (await app.inject(`/api/entities/${entity.entityId}`)).json();
    assert.equal(detail.data.events.items.length, 1);
    assert.equal(detail.data.events.items[0].signalId, ids[0]);
    assert.equal((db.prepare('SELECT count(*) count FROM entity_events WHERE entity_id=?').get(entity.entityId) as { count: number }).count, 1);
    assert.deepEqual((await app.inject('/api/signals?sort=value')).json().data.items.map((signal: { signalId: number }) => signal.signalId), [ids[1], ids[0]]);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/entities/${entity.entityId}/follow`, payload: { followed: true } })).json().code, 0);
    assert.deepEqual((await app.inject('/api/signals?sort=value')).json().data.items.map((signal: { signalId: number }) => signal.signalId), [ids[0], ids[1]]);
  } finally {
    await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
