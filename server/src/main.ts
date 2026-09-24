import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './persistence/database.js';

const dbPath = resolve(process.env.SQLITE_PATH ?? './data/ai-intelligence.db');
mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp({ db: openDatabase(dbPath) });
app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' })
  .then(() => app.log.info({ event: 'app.started', databasePath: dbPath, nodeVersion: process.version }, 'application started'))
  .catch((error) => { app.log.error(error); process.exit(1); });

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.close().then(() => process.exit(0)));
