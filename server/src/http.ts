import type { FastifyReply } from 'fastify';
import { BusinessError } from './domain/errorCodes.js';

export function sendError(reply: FastifyReply, error: unknown, requestId: string) {
  const business = error instanceof BusinessError ? error : new BusinessError(100003);
  (reply as FastifyReply & { businessCode?: number }).businessCode = business.code;
  return reply.status(business.statusCode).send({ code: business.code, message: business.message, ...(business.details ? { details: business.details } : {}), requestId });
}

export function parsePositiveId(value: string) {
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new BusinessError(100001, { field: 'id', reason: 'must be a positive integer' });
  return Number(value);
}

export function parseLimit(value: unknown) {
  if (value === undefined) return 30;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new BusinessError(100001, { field: 'limit', reason: 'must be between 1 and 100' });
  return limit;
}

export function now() { return new Date().toISOString(); }
