import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-')); const db = openDatabase(join(directory, 'test.db')); const app = createApp({ db, logger: false }); await app.ready();
  const timestamp = new Date().toISOString();
  const signal = db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,score_explanation_json,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('matrix-signal', 'Matrix signal', 'summary', 'technology', 60, 60, 60, 60, 60, 60, 60, 60, 'single_source', 0, '{}', 'v1', 'active', timestamp, timestamp, timestamp);
  const signalId = Number(signal.lastInsertRowid);
  const entity = db.prepare("INSERT INTO entities(entity_type,name,normalized_name,summary,first_seen_at,last_seen_at,created_at,updated_at) VALUES('topic','Matrix','matrix','topic',?,?,?,?)").run(timestamp, timestamp, timestamp, timestamp);
  const entityId = Number(entity.lastInsertRowid);
  db.prepare("INSERT INTO signal_entities(signal_id,entity_id,role) VALUES(?,?,?)").run(signalId, entityId, 'primary');
  const opportunity = db.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(signalId, 'product', 'Matrix opportunity', 'summary', '{}', 60, 'candidate', 'v1', timestamp, timestamp);
  const topic = db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(signalId, 'Matrix topic', 'viewpoint', '{}', '["zhihu"]', 60, 'candidate', 'v1', timestamp, timestamp);
  return { app, db, directory, signalId, entityId, opportunityId: Number(opportunity.lastInsertRowid), topicId: Number(topic.lastInsertRowid) };
}

test('API matrix covers list success and validation failures', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/scans', '/api/discoveries', '/api/signals', '/api/opportunities', '/api/content-topics', '/api/entities', '/api/sources']) {
      const response = await f.app.inject(`${path}?limit=1`);
      assert.equal(response.statusCode, 200, path);
      assert.equal(response.json().code, 0, path);
      assert.ok('items' in response.json().data, path);
    }
    const invalid = [
      ['/api/scans?status=bad', 200009], ['/api/discoveries?status=bad', 300001], ['/api/signals?q=%27', 400002],
      ['/api/opportunities?sort=bad', 500001], ['/api/content-topics?status=bad', 600001], ['/api/entities?entityType=bad', 700001], ['/api/sources?kind=bad', 800001],
      ['/api/signals?cursor=bad', 100002]
    ] as const;
    for (const [path, code] of invalid) assert.equal((await f.app.inject(path)).json().code, code, path);
  } finally { await f.app.close(); f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('API matrix covers missing resources and invalid state transitions', async () => {
  const f = await fixture();
  try {
    const missing = [
      ['/api/scans/999999', 200005], ['/api/scans/999999/events', 200005], ['/api/discoveries?taskId=999999', 200005],
      ['/api/signals/999999', 400003], ['/api/opportunities/999999', 500002], ['/api/content-topics/999999', 600002], ['/api/entities/999999', 700002]
    ] as const;
    for (const [path, code] of missing) {
      const response = path.endsWith('/events') ? await f.app.inject({ method: 'GET', url: path, headers: { accept: 'text/event-stream' } }) : await f.app.inject(path);
      assert.equal(response.json().code, code, path);
    }
    assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/sources/999999', payload: { enabled: false } })).json().code, 800002);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/item-states/signal/${f.signalId}`, payload: {} })).json().code, 450002);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/item-states/signal/${f.signalId}`, payload: { saved: true, ignored: true } })).json().code, 450003);
    assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/signals/${f.signalId}/state`, payload: { state: 'needs_review' } })).json().code, 400004);
    assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/opportunities/${f.opportunityId}/status`, payload: { status: 'bad' } })).json().code, 500003);
    assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/content-topics/${f.topicId}/status`, payload: { status: 'bad' } })).json().code, 600003);
    assert.equal((await f.app.inject({ method: 'PUT', url: `/api/entities/${f.entityId}/follow`, payload: { followed: 'yes' } })).json().code, 100001);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/sources', payload: { name: 'private', sourceGroup: 'test', kind: 'web', url: 'http://127.0.0.1', language: 'en', region: 'intl', trustLevel: 1 } })).json().code, 800005);
  } finally { await f.app.close(); f.db.close(); rmSync(f.directory, { recursive: true, force: true }); }
});
