import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from './app.js';
import { openDatabase } from './persistence/database.js';
import { recoverInterruptedScans } from './persistence/recoverInterruptedScans.js';

const dbPath = resolve(process.env.SQLITE_PATH ?? './data/ai-intelligence.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDatabase(dbPath);
const interrupted = recoverInterruptedScans(db);
const app = createApp({ db });
if (interrupted.length) app.log.warn({ event: 'scan.tasks.recovered', taskIds: interrupted, businessCode: 100003 }, 'interrupted scans are ready for retry');
app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' })
  .then(() => app.log.info({ event: 'app.started', databasePathHash: createHash('sha256').update(dbPath).digest('hex').slice(0, 12), nodeVersion: process.version }, 'application started'))
  .catch((error) => { app.log.error({ event: 'app.start.failed', errorType: error instanceof Error ? error.name : 'unknown' }, 'application could not start'); process.exit(1); });

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.close().then(() => process.exit(0)));
