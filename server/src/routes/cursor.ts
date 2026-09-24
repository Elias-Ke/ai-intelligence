import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';

const secret = randomBytes(32);
const invalid = () => new BusinessError(ErrorCodes.INVALID_CURSOR);

function scope(kind: string, query: Record<string, unknown>) {
  const filters = Object.entries(query).filter(([key]) => key !== 'cursor' && key !== 'limit').sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify([kind, filters])).digest('base64url').slice(0, 16);
}

export function readCursor(kind: string, query: Record<string, unknown>, size: number): (string | number)[] | null {
  if (query.cursor === undefined) return null;
  try {
    const [encoded, signature, extra] = String(query.cursor).slice(2).split('.');
    if (!encoded || !signature || extra) throw invalid();
    const expected = createHmac('sha256', secret).update(encoded).digest().subarray(0, 16);
    const received = Buffer.from(signature, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw invalid();
    const [fingerprint, expires, position] = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown[];
    if (fingerprint !== scope(kind, query) || typeof expires !== 'number' || expires < Date.now() || !Array.isArray(position) || position.length !== size || position.some((value) => typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value)))) throw invalid();
    return position as (string | number)[];
  } catch {
    throw invalid();
  }
}

export function writeCursor(kind: string, query: Record<string, unknown>, position: (string | number)[]) {
  const encoded = Buffer.from(JSON.stringify([scope(kind, query), Date.now() + 3600_000, position])).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest().subarray(0, 16).toString('base64url');
  return `c_${encoded}.${signature}`;
}

export function paged<T>(rows: T[], limit: number, cursorFor: (last: T) => string) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? cursorFor(items[items.length - 1]!) : null };
}
