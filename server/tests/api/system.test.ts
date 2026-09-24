import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app.js';
import { openDatabase } from '../../src/persistence/database.js';

test('API-21-N01 health reports SQLite, FTS5 and version', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false, version: 'test' });
  t.after(async () => { await app.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await app.inject('/api/system/health');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { status: 'ok', database: 'ok', fts5: 'ok', activeTaskId: null, version: 'test' });
  assert.equal(response.json().code, 0);
  assert.match(response.json().requestId, /^req_/);
});

test('C01 migration is idempotent and FTS stays synchronized', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-'));
  const path = join(directory, 'test.db');
  const db = openDatabase(path);
  openDatabase(path).close();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO signals(cluster_key,title,summary,signal_type,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,rules_version,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run('cluster-1', 'AI signal', 'summary', 'technology', 50, 50, 50, 50, 50, 50, 50, 50, 'single_source', 'v1', 'active', now, now);
  assert.equal((db.prepare("SELECT count(*) AS count FROM signals_fts WHERE signals_fts MATCH 'AI'").get() as { count: number }).count, 1);
  db.close(); rmSync(directory, { recursive: true, force: true });
});

test('API-21 returns numeric error codes for unavailable database and FTS5', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-intelligence-'));
  const db = openDatabase(join(directory, 'test.db'));
  const app = createApp({ db, logger: false });
  t.after(async () => { await app.close(); if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.exec('DROP TABLE signals_fts');
  const fts = await app.inject('/api/system/health');
  assert.equal(fts.statusCode, 503);
  assert.equal(fts.json().code, 900001);
  assert.doesNotMatch(fts.body, /DROP TABLE|stack|sqlite/i);
  db.close();
  const unavailable = await app.inject('/api/system/health');
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.json().code, 100004);
  const unexpected = await app.inject('/api/sources');
  assert.equal(unexpected.statusCode, 500);
  assert.equal(unexpected.json().code, 100003);
  assert.doesNotMatch(unexpected.body, /database connection|stack|SQLITE/i);
});
