import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';

test('production migration creates the documented indexes and preserves state on repeat', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intelligence-migration-')); const path = join(directory, 'main.db');
  try {
    const db = openDatabase(path);
    const count = (db.prepare('SELECT count(*) AS count FROM sources').get() as { count: number }).count;
    db.prepare('UPDATE sources SET enabled=0 WHERE name=?').run('OpenAI');
    db.prepare("UPDATE sources SET url='https://arxiv.org/list/cs.AI/recent',kind='web',enabled=0 WHERE name='arXiv cs.AI'").run();
    db.prepare("UPDATE sources SET url='https://github.com/search?q=AI&type=repositories',kind='web' WHERE name='GitHub Search'").run();
    db.close();
    const reopened = openDatabase(path);
    try {
      assert.equal((reopened.prepare('SELECT count(*) AS count FROM sources').get() as { count: number }).count, count);
      assert.equal((reopened.prepare('SELECT enabled FROM sources WHERE name=?').get('OpenAI') as { enabled: number }).enabled, 0);
      assert.deepEqual(reopened.prepare("SELECT kind,url,enabled FROM sources WHERE name='arXiv cs.AI'").get(), { kind: 'rss', url: 'https://rss.arxiv.org/rss/cs.AI', enabled: 0 });
      assert.deepEqual(reopened.prepare("SELECT kind,url FROM sources WHERE name='GitHub Search'").get(), { kind: 'api', url: 'https://api.github.com/search/repositories?q=ai+agent&sort=updated&order=desc&per_page=40' });
      const indexes = reopened.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      for (const name of ['idx_search_runs_task_status', 'idx_raw_discoveries_published', 'idx_raw_discoveries_status_seen', 'idx_scan_discoveries_discovery', 'idx_discovery_search_runs_search_rank', 'idx_signals_type_event', 'idx_scan_signals_highlight', 'idx_signal_sources_relation', 'idx_entities_followed_seen', 'idx_signal_entities_entity', 'idx_entity_events_timeline', 'idx_opportunities_status_score', 'idx_content_topics_status_score', 'idx_item_states_saved']) assert.ok(indexes.some((row) => row.name === name), name);
      assert.throws(() => reopened.prepare("INSERT INTO item_states(target_type,target_id,saved,ignored,updated_at) VALUES('signal',1,1,1,?)").run(new Date().toISOString()));
      assert.throws(() => reopened.prepare("INSERT INTO signal_entities(signal_id,entity_id,role) VALUES(999999,999999,'primary')").run());
      assert.equal(reopened.pragma('foreign_keys', { simple: true }), 1);
      assert.equal(reopened.pragma('journal_mode', { simple: true }), 'wal');
      assert.ok((reopened.pragma('table_info(sources)') as { name: string }[]).some(({ name }) => name === 'last_error_reason'));
      for (const name of ['source_success_count', 'source_failure_count', 'anysearch_query_count']) assert.ok((reopened.pragma('table_info(scan_tasks)') as { name: string }[]).some((column) => column.name === name));
    } finally { reopened.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production migration adds scan status snapshots to an existing database only once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intelligence-legacy-')); const path = join(directory, 'main.db');
  try {
    const old = openDatabase(path);
    old.exec('ALTER TABLE scan_discoveries DROP COLUMN status; ALTER TABLE scan_discoveries DROP COLUMN rejection_reason');
    old.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openDatabase(path);
      try {
        const columns = db.pragma('table_info(scan_discoveries)') as { name: string }[];
        assert.equal(columns.filter(({ name }) => name === 'status' || name === 'rejection_reason').length, 2);
        assert.throws(() => db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,status,discovered_at) VALUES(1,1,'source','wrong',?)").run(new Date().toISOString()));
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production migration adds signal snapshots to an existing database only once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intelligence-legacy-signals-')); const path = join(directory, 'main.db');
  const names = ['summary', 'evidence_level', 'state', 'novelty_score', 'truth_score', 'technology_score', 'adoption_score', 'monetization_score', 'content_value_score', 'value_score', 'evidence_count', 'published_at_verified'];
  try {
    const old = openDatabase(path);
    for (const name of names) old.exec(`ALTER TABLE scan_signals DROP COLUMN ${name}`);
    old.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const db = openDatabase(path);
      try {
        const columns = db.pragma('table_info(scan_signals)') as { name: string }[];
        assert.equal(columns.filter(({ name }) => names.includes(name)).length, names.length);
        assert.ok((db.pragma('table_info(opportunities)') as { name: string }[]).some(({ name }) => name === 'last_generated_task_id'));
        assert.ok((db.pragma('table_info(content_topics)') as { name: string }[]).some(({ name }) => name === 'last_generated_task_id'));
      } finally { db.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('production migration backfills card generation task markers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'intelligence-legacy-cards-')); const path = join(directory, 'main.db');
  try {
    const old = openDatabase(path); const time = '2026-09-23T12:00:00.000Z';
    const taskId = Number(old.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at,started_at,finished_at) VALUES('legacy-card','2026-09-22','2026-09-24','completed',?,?,?)").run('2026-09-23T10:00:00.000Z', '2026-09-23T10:00:00.000Z', '2026-09-23T13:00:00.000Z').lastInsertRowid);
    const signalId = Number(old.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,created_at,updated_at) VALUES('legacy-card-signal','AI case','summary','use_case',60,60,60,60,60,60,60,60,'single_source','v1','active',?,?)").run(time, time).lastInsertRowid);
    old.prepare('INSERT INTO scan_signals(task_id,signal_id,rank_no,created_at) VALUES(?,?,1,?)').run(taskId, signalId, time);
    old.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,'product','legacy','legacy','{}',60,'candidate','v1',?,?)").run(signalId, time, '2026-09-23T12:00:00.000Z');
    old.exec('ALTER TABLE opportunities DROP COLUMN last_generated_task_id; ALTER TABLE content_topics DROP COLUMN last_generated_task_id'); old.close();
    const db = openDatabase(path);
    try {
      assert.equal((db.prepare('SELECT last_generated_task_id value FROM opportunities').get() as { value: number }).value, taskId);
      db.prepare('UPDATE opportunities SET last_generated_task_id=0').run(); db.close();
      const reopened = openDatabase(path);
      try { assert.equal((reopened.prepare('SELECT last_generated_task_id value FROM opportunities').get() as { value: number }).value, taskId); }
      finally { reopened.close(); }
    }
    finally { if (db.open) db.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('state changes emit safe correlated events only after successful writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'intelligence-logs-')); const db = openDatabase(join(directory, 'main.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  const events: Record<string, unknown>[] = [];
  app.log.info = ((record: Record<string, unknown>) => { if (record && typeof record === 'object') events.push(record); }) as typeof app.log.info;
  await app.ready();
  try {
    const now = new Date().toISOString();
    const signalId = Number(db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,created_at,updated_at) VALUES('log-signal','Sensitive full text','summary','technology',60,60,60,60,60,60,60,60,'single_source','v1','active',?,?)").run(now, now).lastInsertRowid);
    const opportunityId = Number(db.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,'product','opportunity','summary','{}',60,'candidate','v1',?,?)").run(signalId, now, now).lastInsertRowid);
    const topicId = Number(db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,'topic','point','{}','[]',60,'candidate','v1',?,?)").run(signalId, now, now).lastInsertRowid);
    const entityId = Number(db.prepare("INSERT INTO entities(entity_type,name,normalized_name,first_seen_at,last_seen_at,created_at,updated_at) VALUES('company','Company','company',?,?,?,?)").run(now, now, now, now).lastInsertRowid);
    const sourceId = (db.prepare("SELECT source_id AS id FROM sources WHERE name='OpenAI'").get() as { id: number }).id;
    const requests = [
      { method: 'PUT', url: `/api/item-states/signal/${signalId}`, payload: { saved: true } },
      { method: 'PATCH', url: `/api/signals/${signalId}/state`, payload: { state: 'archived' } },
      { method: 'PATCH', url: `/api/opportunities/${opportunityId}/status`, payload: { status: 'verified' } },
      { method: 'PATCH', url: `/api/content-topics/${topicId}/status`, payload: { status: 'published' } },
      { method: 'PUT', url: `/api/entities/${entityId}/follow`, payload: { followed: true } },
      { method: 'PATCH', url: `/api/sources/${sourceId}`, payload: { enabled: false } }
    ] as const;
    for (const request of requests) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 200, request.url);
      const event = events.find((row) => row.requestId === response.json().requestId && String(row.event).endsWith('_changed') || row.requestId === response.json().requestId && row.event === 'item_state.updated');
      assert.ok(event, request.url);
      assert.equal(event.businessCode, 0);
    }
    const successful = events.filter((event) => ['item_state.updated', 'signal.state_changed', 'opportunity.status_changed', 'content_topic.status_changed', 'entity.follow_changed', 'source.enabled_changed'].includes(String(event.event)));
    assert.equal(successful.length, 6);
    assert.equal((await app.inject({ method: 'PUT', url: `/api/item-states/signal/${signalId}`, payload: { saved: true, ignored: true } })).json().code, 450003);
    assert.equal(events.filter((event) => event.event === 'item_state.updated').length, 1);
    for (const url of [`/api/signals/${signalId}/state`, `/api/opportunities/${opportunityId}/status`, `/api/content-topics/${topicId}/status`]) {
      for (const payload of [{}, { status: 42, state: 42 }]) {
        const response = await app.inject({ method: 'PATCH', url, payload });
        assert.equal(response.statusCode, 400); assert.equal(response.json().code, 100001);
      }
      const malformed = await app.inject({ method: 'PATCH', url, payload: '{', headers: { 'content-type': 'application/json' } });
      assert.equal(malformed.statusCode, 400); assert.equal(malformed.json().code, 100001);
      const wrongType = await app.inject({ method: 'PATCH', url, payload: 'status=done', headers: { 'content-type': 'text/plain' } });
      assert.equal(wrongType.statusCode, 400); assert.equal(wrongType.json().code, 100001);
    }
    const serialized = JSON.stringify(successful);
    for (const secret of ['Sensitive full text', 'SELECT ', 'Cookie', 'API_KEY', 'prompt']) assert.equal(serialized.includes(secret), false);
  } finally { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});
