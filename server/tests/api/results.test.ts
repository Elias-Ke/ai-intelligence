import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';

test('API-07/08/09/10-18 results and feedback contracts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-')); const db = openDatabase(join(directory, 'test.db')); const app = createApp({ db, logger: false }); await app.ready();
  try {
    const timestamp = new Date().toISOString();
    const signal = db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,score_explanation_json,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('c-result', 'AI signal', 'AI summary', 'technology', 80, 70, 80, 70, 60, 65, 90, 75, 'first_party', 0, '{}', 'v1', 'active', timestamp, timestamp, timestamp);
    const signalId = Number(signal.lastInsertRowid);
    const entity = db.prepare("INSERT INTO entities(entity_type,name,normalized_name,summary,first_seen_at,last_seen_at,created_at,updated_at) VALUES('company','Example','example','company',?,?,?,?)").run(timestamp, timestamp, timestamp, timestamp);
    const entityId = Number(entity.lastInsertRowid);
    db.prepare("INSERT INTO signal_entities(signal_id,entity_id,role) VALUES(?,?,?)").run(signalId, entityId, 'primary');
    db.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(signalId, 'product', 'Build an AI product', 'summary', JSON.stringify({ validationAction: 'interview users' }), 80, 'candidate', 'v1', timestamp, timestamp);
    db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(signalId, 'AI topic', 'viewpoint', JSON.stringify({ coreFacts: ['fact'] }), JSON.stringify(['zhihu']), 80, 'candidate', 'v1', timestamp, timestamp);
    const list = await app.inject('/api/signals?q=AI&sort=value'); assert.equal(list.statusCode, 200); assert.equal(list.json().data.items.length, 1);
    const detail = await app.inject(`/api/signals/${signalId}`); assert.equal(detail.statusCode, 200); assert.equal(detail.json().data.entities[0].entityId, entityId);
    const saved = await app.inject({ method: 'PUT', url: `/api/item-states/signal/${signalId}`, payload: { saved: true, valueRating: 1 } }); assert.equal(saved.statusCode, 200); assert.equal(saved.json().data.saved, true);
    const conflict = await app.inject({ method: 'PUT', url: `/api/item-states/signal/${signalId}`, payload: { saved: true, ignored: true } }); assert.equal(conflict.json().code, 450003);
    const opps = await app.inject('/api/opportunities'); assert.equal(opps.statusCode, 200); const opportunityId = opps.json().data.items[0].opportunityId;
    assert.equal((await app.inject(`/api/opportunities/${opportunityId}`)).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/opportunities/${opportunityId}/status`, payload: { status: 'verified' } })).statusCode, 200);
    const topics = await app.inject('/api/content-topics?platform=zhihu'); assert.equal(topics.statusCode, 200); const topicId = topics.json().data.items[0].contentTopicId;
    assert.equal((await app.inject(`/api/content-topics/${topicId}`)).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/content-topics/${topicId}/status`, payload: { status: 'preparing' } })).statusCode, 200);
    const entities = await app.inject('/api/entities?followed=false'); assert.equal(entities.statusCode, 200);
    assert.equal((await app.inject(`/api/entities/${entityId}`)).statusCode, 200);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/entities/${entityId}/follow`, payload: { followed: true } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/signals/${signalId}/state`, payload: { state: 'archived' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/signals/${signalId}/state`, payload: { state: 'needs_review' } })).json().code, 400004);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
