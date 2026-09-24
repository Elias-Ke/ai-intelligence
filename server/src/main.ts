import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './app.js';
import { openDatabase } from './persistence/database.js';
import { recoverInterruptedScans } from './persistence/recoverInterruptedScans.js';

const dbPath = resolve(process.env.SQLITE_PATH ?? './data/ai-intelligence.db');
mkdirSync(dirname(dbPath), { recursive: true });
const migrationStartedAt = Date.now();
const db = openDatabase(dbPath);
const interrupted = recoverInterruptedScans(db);
const app = createApp({ db });
app.log.info({ event: 'migration.completed', migration: 'schema-and-initial-sources', outcome: 'completed', durationMs: Date.now() - migrationStartedAt, businessCode: 0 }, 'database migration completed');
app.log[interrupted.length ? 'warn' : 'info']({ event: 'recovery.completed', taskIds: interrupted, recoveredCount: interrupted.length, businessCode: 0 }, 'startup scan recovery completed');
app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' })
  .then(() => app.log.info({ event: 'app.started', databasePathHash: createHash('sha256').update(dbPath).digest('hex').slice(0, 12), nodeVersion: process.version }, 'application started'))
  .catch((error) => { app.log.error({ event: 'app.start.failed', errorType: error instanceof Error ? error.name : 'unknown' }, 'application could not start'); process.exit(1); });

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.close().then(() => process.exit(0)));
