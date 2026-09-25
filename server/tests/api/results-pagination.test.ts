import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';

test('discovery and signal cursors traverse unique results across scans and reject invalid scope', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-pagination-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, autoRunScans: false });
  const time = '2026-09-23T12:00:00.000Z';
  try {
    const tasks = [1, 2].map((id) => Number(db.prepare("INSERT INTO scan_tasks(idempotency_key,range_from,range_to,status,created_at) VALUES(?,?,?,'completed',?)").run(`pagination-${id}`, '2026-09-22T00:00:00Z', time, time).lastInsertRowid));
    const discoveryIds = [1, 2, 3].map((id) => Number(db.prepare("INSERT INTO raw_discoveries(url,normalized_url,title,fetched_at,content_hash,status,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,'candidate',?,?)").run(`https://example.org/${id}`, `https://example.org/${id}`, `Discovery ${id}`, time, `hash-${id}`, time, time).lastInsertRowid));
    const signalIds = [1, 2, 3].map((id) => Number(db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,? ,0,'v1','active',?,?,?)").run(`pagination-${id}`, `Signal ${id}`, 'summary', 'technology', 60, 60, 60 + id, 60, 60, 60, 60, id < 3 ? 70 : 60, 'single_source', time, time, time).lastInsertRowid));
    const opportunityIds = signalIds.map((signalId, index) => Number(db.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,'product',?,'summary','{}',?,'candidate','v1',?,?)").run(signalId, `Opportunity ${index}`, index < 2 ? 70 : 60, time, time).lastInsertRowid));
    const topicIds = signalIds.map((signalId, index) => Number(db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,'view','{}','[]',?,'candidate','v1',?,?)").run(signalId, `Topic ${index}`, index < 2 ? 70 : 60, time, time).lastInsertRowid));
    for (const [index, taskId] of tasks.entries()) {
      for (const [rank, discoveryId] of discoveryIds.entries()) db.prepare("INSERT INTO scan_discoveries(task_id,discovery_id,discovery_channel,discovered_at) VALUES(?,?,'source',?)").run(taskId, discoveryId, time);
      for (const [rank, signalId] of signalIds.entries()) db.prepare('INSERT INTO scan_signals(task_id,signal_id,rank_no,created_at) VALUES(?,?,?,?)').run(taskId, signalId, rank + 1, time);
    }

    for (const [route, key, expected] of [
      ['/api/discoveries', 'discoveryId', [...discoveryIds].reverse()],
      ['/api/signals', 'signalId', [signalIds[1], signalIds[0], signalIds[2]]],
      ['/api/signals?sort=newest', 'signalId', [...signalIds].reverse()],
      ['/api/signals?sort=evidence', 'signalId', [...signalIds].reverse()],
      ['/api/opportunities', 'opportunityId', [opportunityIds[1], opportunityIds[0], opportunityIds[2]]],
      ['/api/opportunities?sort=newest', 'opportunityId', [...opportunityIds].reverse()],
      ['/api/content-topics', 'contentTopicId', [topicIds[1], topicIds[0], topicIds[2]]],
      ['/api/content-topics?sort=newest', 'contentTopicId', [...topicIds].reverse()]
    ] as const) {
      const first = (await app.inject(`${route}${route.includes('?') ? '&' : '?'}limit=1`)).json();
      assert.equal(first.code, 0, route);
      assert.ok(first.data.nextCursor?.startsWith('c_'), route);
      const seen: number[] = [first.data.items[0][key]];
      let cursor = first.data.nextCursor as string | null;
      while (cursor) {
        const response = (await app.inject(`${route}${route.includes('?') ? '&' : '?'}limit=1&cursor=${encodeURIComponent(cursor)}`)).json();
        assert.equal(response.code, 0, route);
        seen.push(...response.data.items.map((item: Record<string, number>) => item[key]));
        cursor = response.data.nextCursor;
      }
      assert.deepEqual(seen, expected, route);
      const changedFilter = (await app.inject(`/api/signals?sort=newest&cursor=${encodeURIComponent(first.data.nextCursor)}`)).json();
      if (route !== '/api/signals?sort=newest') assert.equal(changedFilter.code, 100002);
      const fake = (await app.inject(`${route}${route.includes('?') ? '&' : '?'}cursor=c_${'a'.repeat(12)}`)).json();
      assert.equal(fake.code, 100002);
      if (route.startsWith('/api/opportunities') || route.startsWith('/api/content-topics')) {
        const swappedSort = route.includes('newest') ? route.split('?')[0] : `${route}?sort=newest`;
        assert.equal((await app.inject(`${swappedSort}${swappedSort.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(first.data.nextCursor)}`)).json().code, 100002);
      }
    }
    const scoped = (await app.inject(`/api/signals?taskId=${tasks[0]}&limit=10`)).json();
    assert.deepEqual(scoped.data.items.map((item: { signalId: number }) => item.signalId), [signalIds[1], signalIds[0], signalIds[2]]);
    assert.equal((await app.inject(`/api/discoveries?taskId=${tasks[0]}`)).json().data.items.length, 3);
    const firstDiscoveryPage = (await app.inject(`/api/discoveries?taskId=${tasks[0]}&limit=1`)).json().data;
    db.prepare('UPDATE raw_discoveries SET last_seen_at=? WHERE discovery_id=?').run('2026-09-25T00:00:00.000Z', discoveryIds[0]);
    const secondDiscoveryPage = (await app.inject(`/api/discoveries?taskId=${tasks[0]}&limit=1&cursor=${encodeURIComponent(firstDiscoveryPage.nextCursor)}`)).json().data;
    assert.deepEqual(secondDiscoveryPage.items.map((item: { discoveryId: number }) => item.discoveryId), [discoveryIds[1]]);
  } finally {
    await app.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
