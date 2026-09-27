import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'intelligence-pages-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  await app.ready();
  const close = async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); };
  return { db, app, close };
}

test('scan and source pages traverse identical timestamps without duplicates', async () => {
  const { db, app, close } = await fixture();
  try {
    const time = '2026-09-24T00:00:00.000Z';
    for (let i = 1; i <= 3; i++) {
      db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,'completed',?)").run(`page-${i}`, '2026-09-23', '2026-09-24', time);
      db.prepare("INSERT INTO sources(name,source_group,kind,url,language,region,trust_level,created_at,updated_at) VALUES(?,'official','rss',?,'en','intl',5,?,?)").run(`Source ${i}`, `https://example.com/feed/${i}`, time, time);
    }
    for (const [path, field] of [['/api/scans', 'taskId'], ['/api/sources', 'sourceId']] as const) {
      let cursor: string | null = null; const ids: number[] = []; let firstCursor = '';
      do {
        const page: { items: Record<string, number>[]; nextCursor: string | null } = (await app.inject(`${path}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json().data;
        ids.push(page.items[0][field]); cursor = page.nextCursor;
        if (ids.length === 1) firstCursor = cursor!;
        assert.ok(ids.length < 100);
      } while (cursor);
      assert.equal(new Set(ids).size, ids.length);
      assert.ok(ids.length >= 3);
      assert.equal((await app.inject(`${path}?cursor=forged`)).json().code, 100002);
      assert.equal((await app.inject(`${path}?${path === '/api/scans' ? 'status=failed' : 'kind=web'}&cursor=${encodeURIComponent(firstCursor)}`)).json().code, 100002);
    }
  } finally { await close(); }
});

test('entity and timeline pages use stable tie-breakers and scoped cursors', async () => {
  const { db, app, close } = await fixture();
  try {
    const timestamp = '2026-09-24T00:00:00.000Z';
    const entityIds: number[] = [];
    for (let i = 1; i <= 3; i++) {
      const entity = db.prepare("INSERT INTO entities(entity_type,name,normalized_name,first_seen_at,last_seen_at,created_at,updated_at) VALUES('company',?,?,?,?,?,?)").run(`Entity ${i}`, `entity-${i}`, timestamp, timestamp, timestamp, timestamp);
      entityIds.push(Number(entity.lastInsertRowid));
      const signal = db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,'technology',60,60,60,60,60,60,60,60,'first_party','v1','active',?,?,?)").run(`test-${i}`, `中文模型发布 ${i}`, '产品发售', timestamp, timestamp, timestamp);
      db.prepare("INSERT INTO signal_entities(signal_id,entity_id,role) VALUES(?,?,'primary')").run(signal.lastInsertRowid, entityIds[0]);
      db.prepare('INSERT INTO entity_events(entity_id,signal_id,event_type,event_at,headline,created_at) VALUES(?,?,?,?,?,?)').run(entityIds[0], signal.lastInsertRowid, 'released', timestamp, `Event ${i}`, timestamp);
    }
    const first = (await app.inject('/api/entities?limit=1')).json().data;
    const second = (await app.inject(`/api/entities?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json().data;
    assert.notEqual(first.items[0].entityId, second.items[0].entityId);
    assert.equal((await app.inject(`/api/entities?sort=signals&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).json().code, 100002);
    const timeline = (await app.inject(`/api/entities/${entityIds[0]}?eventLimit=1`)).json().data.events;
    const next = (await app.inject(`/api/entities/${entityIds[0]}?eventLimit=1&eventCursor=${encodeURIComponent(timeline.nextCursor)}`)).json().data.events;
    assert.notEqual(timeline.items[0].signalId, next.items[0].signalId);
    assert.equal((await app.inject(`/api/entities/${entityIds[1]}?eventLimit=1&eventCursor=${encodeURIComponent(timeline.nextCursor)}`)).json().code, 100002);
    assert.equal((await app.inject('/api/signals?q=%E4%B8%AD%E6%96%87')).json().data.items.length, 3);
    assert.equal((await app.inject('/api/signals?q=%E6%A8%A1%E5%9E%8B%E5%8F%91%E5%B8%83')).json().data.items.length, 3);
    assert.equal((await app.inject('/api/signals?q=broken%28')).json().code, 400002);
    for (const query of ['taskId=abc', 'taskId=0', 'taskId=1.5', 'entityId=abc', 'entityId=0']) assert.equal((await app.inject(`/api/signals?${query}`)).json().code, 400001, query);
  } finally { await close(); }
});

test('value feedback changes list priority and platform filter matches exact JSON member', async () => {
  const { db, app, close } = await fixture();
  try {
    const time = '2026-09-24T00:00:00.000Z';
    const ids: number[] = [];
    for (let i = 1; i <= 2; i++) {
      const signal = db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,'technology',60,60,60,60,60,60,60,?,'first_party','v1','active',?,?,?)").run(`value-${i}`, `Value ${i}`, 'summary', i === 1 ? 65 : 60, time, time, time);
      ids.push(Number(signal.lastInsertRowid));
      db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,'view','{}',?,60,'candidate','v1',?,?)").run(ids[i - 1], `Topic ${i}`, i === 1 ? '["x"]' : '["xiaohongshu"]', time, time);
    }
    const before = (await app.inject('/api/signals?sort=value')).json().data.items;
    assert.equal(before[0].signalId, ids[0]);
    const feedback = await app.inject({ method: 'PUT', url: `/api/item-states/signal/${ids[1]}`, payload: { valueRating: 1 } });
    assert.equal(feedback.statusCode, 200);
    assert.equal((await app.inject('/api/signals?sort=value')).json().data.items[0].signalId, ids[1]);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/item-states/signal/${ids[1]}`, payload: { valueRating: '1' } })).json().code, 100001);
    assert.equal((await app.inject('/api/content-topics?platform=x')).json().data.items.length, 1);
    assert.equal((await app.inject('/api/content-topics?platform=invalid')).json().code, 600001);
    assert.equal((await app.inject('/api/opportunities?opportunityType=invalid')).json().code, 500001);
  } finally { await close(); }
});

test('featured signals remain queryable beyond the first value-sorted page', async () => {
  const { db, app, close } = await fixture();
  try {
    const time = new Date().toISOString();
    const taskId = Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES('featured-test','2026-09-23','2026-09-24','completed',?)").run(time).lastInsertRowid);
    const insert = db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,'technology',60,60,60,60,60,60,60,?,'first_party','v1',?,?,?,?)");
    for (let i = 0; i < 35; i++) {
      const id = Number(insert.run(`normal-${i}`, `Normal ${i}`, 'summary', 90, 'active', time, time, time).lastInsertRowid);
      db.prepare('INSERT INTO scan_signals(task_id,signal_id,rank_no,created_at) VALUES(?,?,?,?)').run(taskId, id, i + 1, time);
    }
    const featured = Number(insert.run('featured', 'Featured', 'summary', 40, 'active', time, time, time).lastInsertRowid);
    db.prepare('INSERT INTO scan_signals(task_id,signal_id,rank_no,is_highlight,created_at) VALUES(?,?,36,1,?)').run(taskId, featured, time);
    assert.equal((await app.inject(`/api/signals?taskId=${taskId}&limit=30`)).json().data.items.some((item: { signalId: number }) => item.signalId === featured), false);
    assert.equal((await app.inject(`/api/signals?taskId=${taskId}&state=active&ignored=false&highlighted=true&limit=5`)).json().data.items[0].signalId, featured);
    await app.inject({ method: 'PUT', url: `/api/item-states/signal/${featured}`, payload: { ignored: true } });
    assert.equal((await app.inject(`/api/signals?taskId=${taskId}&state=active&ignored=false&highlighted=true&limit=5`)).json().data.items.length, 0);
  } finally { await close(); }
});
