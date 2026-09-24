import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from './persistence/database.js';
import { ErrorCodes, BusinessError } from './domain/errorCodes.js';
import { registerSourceRoutes } from './routes/sources.js';
import { registerScanRoutes } from './routes/scans.js';
import { registerResultRoutes } from './routes/results.js';
import { fetchPublic } from './ingestion/publicHttp.js';

export type AppOptions = { db: SqliteDatabase; version?: string; logger?: boolean; fetchSource?: typeof fetchPublic };

declare module 'fastify' {
  interface FastifyInstance { db: SqliteDatabase; appVersion: string; fetchSource: typeof fetchPublic; }
}

export function createApp({ db, version = '0.1.0', logger = true, fetchSource = fetchPublic }: AppOptions): FastifyInstance {
  const app = Fastify({ logger, genReqId: () => `req_${randomUUID()}` });
  app.decorate('db', db);
  app.decorate('appVersion', version);
  app.decorate('fetchSource', fetchSource);

  app.addHook('onRequest', (request, _reply, done) => {
    (request as typeof request & { startedAt?: bigint }).startedAt = process.hrtime.bigint();
    done();
  });
  app.addHook('preValidation', async (request) => {
    const cursor = (request.query as Record<string, unknown> | undefined)?.cursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^c_[A-Za-z0-9_-]{6,200}$/.test(cursor))) throw new BusinessError(ErrorCodes.INVALID_CURSOR);
  });

  app.addHook('onResponse', (request, reply, done) => {
    const businessCode = (reply as typeof reply & { businessCode?: number }).businessCode ?? 0;
    const startedAt = (request as typeof request & { startedAt?: bigint }).startedAt ?? process.hrtime.bigint();
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    app.log[businessCode === 0 ? 'info' : 'warn']({ event: businessCode === 0 ? 'api.request.completed' : 'api.request.failed', requestId: request.id, method: request.method, route: request.routeOptions.url, httpStatus: reply.statusCode, businessCode, durationMs }, businessCode === 0 ? 'request completed' : 'request failed');
    done();
  });
  app.setErrorHandler((error, request, reply) => {
    const business = error instanceof BusinessError ? error : new BusinessError(ErrorCodes.INTERNAL);
    const decoratedReply = reply as typeof reply & { businessCode?: number };
    decoratedReply.businessCode = business.code;
    if (!(error instanceof BusinessError)) app.log.error({ event: 'api.request.exception', requestId: request.id, err: error }, 'unexpected request error');
    return reply.status(business.statusCode).send({ code: business.code, message: business.message, ...(business.details ? { details: business.details } : {}), requestId: request.id });
  });

  app.get('/api/system/health', async (request, reply) => {
    try {
      app.db.prepare('SELECT 1 FROM signals_fts LIMIT 1').get();
      const active = app.db.prepare("SELECT task_id FROM scan_tasks WHERE status IN ('created','collecting','normalizing','clustering','analyzing','generating','retrying') LIMIT 1").get() as { task_id?: number } | undefined;
      return reply.send({ code: 0, message: 'success', data: { status: 'ok', database: 'ok', fts5: 'ok', activeTaskId: active?.task_id ?? null, version: app.appVersion }, requestId: request.id });
    } catch (error) {
      const isFts = error instanceof Error && /fts/i.test(error.message);
      throw new BusinessError(isFts ? ErrorCodes.FTS_UNAVAILABLE : ErrorCodes.DATABASE_UNAVAILABLE);
    }
  });
  registerSourceRoutes(app);
  registerScanRoutes(app);
  registerResultRoutes(app);
  return app;
}
