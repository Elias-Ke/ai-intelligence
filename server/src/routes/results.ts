import type { FastifyInstance } from 'fastify';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { now, parseLimit, parsePositiveId } from '../http.js';

const bool = (value: unknown, code: number, field: string) => {
  if (value === undefined) return undefined;
  if (value !== 'true' && value !== 'false') throw new BusinessError(code as never, { field });
  return value === 'true' ? 1 : 0;
};
const page = (items: unknown[]) => ({ items, nextCursor: null });
const parseJson = (value: unknown, fallback: unknown) => { try { return JSON.parse(String(value ?? '')); } catch { return fallback; } };

function targetExists(app: FastifyInstance, type: string, id: number) {
  const table = type === 'signal' ? 'signals' : type === 'opportunity' ? 'opportunities' : type === 'content_topic' ? 'content_topics' : null;
  const key = type === 'signal' ? 'signal_id' : type === 'opportunity' ? 'opportunity_id' : 'content_topic_id';
  return table && app.db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(id);
}

export function registerResultRoutes(app: FastifyInstance) {
  app.get('/api/discoveries', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    const statuses = ['candidate', 'accepted', 'rejected', 'extract_failed']; const channels = ['source', 'anysearch', 'both'];
    if ((q.status && !statuses.includes(String(q.status))) || (q.channel && !channels.includes(String(q.channel))) || (q.q && String(q.q).length > 200)) throw new BusinessError(ErrorCodes.INVALID_DISCOVERY_FILTER);
    if (q.taskId && !app.db.prepare('SELECT 1 FROM scan_tasks WHERE task_id=?').get(Number(q.taskId))) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.taskId) { clauses.push('sd.task_id=?'); params.push(Number(q.taskId)); }
    if (q.status) { clauses.push('d.status=?'); params.push(q.status); }
    if (q.channel) { clauses.push('sd.discovery_channel=?'); params.push(q.channel); }
    if (q.publishedAtVerified !== undefined) { clauses.push('d.published_at_verified=?'); params.push(bool(q.publishedAtVerified, ErrorCodes.INVALID_DISCOVERY_FILTER, 'publishedAtVerified')); }
    if (q.q) { clauses.push('(d.title LIKE ? OR d.url LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`); }
    const rows = app.db.prepare(`SELECT d.discovery_id discoveryId,d.title,d.url,d.snippet,s.name sourceName,sd.discovery_channel channel,d.published_at publishedAt,d.published_at_verified publishedAtVerified,d.status,d.rejection_reason rejectionReason,d.first_seen_at firstSeenAt,d.last_seen_at lastSeenAt FROM raw_discoveries d LEFT JOIN sources s ON s.source_id=d.source_id LEFT JOIN scan_discoveries sd ON sd.discovery_id=d.discovery_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY d.last_seen_at DESC LIMIT ?`).all(...params, limit);
    return reply.send({ code: 0, message: 'success', data: page(rows), requestId: request.id });
  });

  app.get('/api/signals', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    const types = ['technology', 'product', 'paper', 'funding', 'company_action', 'use_case', 'open_source', 'market']; const levels = ['single_source', 'multi_source', 'first_party', 'conflicting']; const states = ['active', 'needs_review', 'archived'];
    if ((q.signalType && !types.includes(String(q.signalType))) || (q.evidenceLevel && !levels.includes(String(q.evidenceLevel))) || (q.state && !states.includes(String(q.state))) || (q.sort && !['value', 'newest', 'evidence'].includes(String(q.sort)))) throw new BusinessError(ErrorCodes.INVALID_SIGNAL_FILTER);
    if (q.q && (String(q.q).length > 200 || /["'();]/.test(String(q.q)))) throw new BusinessError(ErrorCodes.INVALID_FTS_QUERY);
    if (q.taskId && !app.db.prepare('SELECT 1 FROM scan_tasks WHERE task_id=?').get(Number(q.taskId))) throw new BusinessError(ErrorCodes.SCAN_NOT_FOUND);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.taskId) { clauses.push('ss.task_id=?'); params.push(Number(q.taskId)); }
    if (q.signalType) { clauses.push('s.signal_type=?'); params.push(q.signalType); }
    if (q.evidenceLevel) { clauses.push('s.evidence_level=?'); params.push(q.evidenceLevel); }
    if (q.state) { clauses.push('s.state=?'); params.push(q.state); }
    if (q.entityId) { clauses.push('EXISTS(SELECT 1 FROM signal_entities se WHERE se.signal_id=s.signal_id AND se.entity_id=?)'); params.push(Number(q.entityId)); }
    if (q.saved !== undefined) { clauses.push('COALESCE(i.saved,0)=?'); params.push(bool(q.saved, ErrorCodes.INVALID_SIGNAL_FILTER, 'saved')); }
    if (q.ignored !== undefined) { clauses.push('COALESCE(i.ignored,0)=?'); params.push(bool(q.ignored, ErrorCodes.INVALID_SIGNAL_FILTER, 'ignored')); }
    if (q.highlighted !== undefined) { if (!q.taskId) throw new BusinessError(ErrorCodes.INVALID_SIGNAL_FILTER); clauses.push('ss.is_highlight=?'); params.push(bool(q.highlighted, ErrorCodes.INVALID_SIGNAL_FILTER, 'highlighted')); }
    if (q.q) { clauses.push('(s.title LIKE ? OR s.summary LIKE ? OR s.search_text LIKE ?)'); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
    const order = q.sort === 'newest' ? 's.event_at DESC' : q.sort === 'evidence' ? 's.truth_score DESC, s.value_score DESC' : 's.value_score DESC, s.event_at DESC';
    const rows = (app.db.prepare(`SELECT s.signal_id signalId,s.title,s.summary,s.signal_type signalType,s.tags_text tagsText,s.novelty_score noveltyScore,s.truth_score truthScore,s.technology_score technologyScore,s.adoption_score adoptionScore,s.monetization_score monetizationScore,s.content_value_score contentValueScore,s.value_score valueScore,s.evidence_level evidenceLevel,(SELECT count(*) FROM signal_sources sx WHERE sx.signal_id=s.signal_id) evidenceCount,s.has_conflict hasConflict,s.state,s.event_at eventAt,COALESCE(ss.is_highlight,0) isHighlighted,COALESCE(i.saved,0) saved,COALESCE(i.ignored,0) ignored,s.created_at createdAt FROM signals s LEFT JOIN scan_signals ss ON ss.signal_id=s.signal_id LEFT JOIN item_states i ON i.target_type='signal' AND i.target_id=s.signal_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order},s.signal_id LIMIT ?`).all(...params, limit) as Record<string, unknown>[]).map((row) => ({ ...row, tags: String(row.tagsText || '').split(',').filter(Boolean) }));
    return reply.send({ code: 0, message: 'success', data: page(rows), requestId: request.id });
  });

  app.get('/api/signals/:signalId', async (request, reply) => {
    const id = parsePositiveId((request.params as { signalId: string }).signalId);
    const signal = app.db.prepare('SELECT * FROM signals WHERE signal_id=?').get(id) as Record<string, unknown> | undefined;
    if (!signal) throw new BusinessError(ErrorCodes.SIGNAL_NOT_FOUND);
    const evidence = app.db.prepare("SELECT d.discovery_id discoveryId,ss.relation_type relationType,ss.is_independent isIndependent,d.title,d.url,src.name sourceName,src.trust_level trustLevel,d.published_at publishedAt,d.snippet FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id LEFT JOIN sources src ON src.source_id=d.source_id WHERE ss.signal_id=?").all(id) as Record<string, unknown>[];
    const entities = app.db.prepare('SELECT e.entity_id entityId,e.entity_type entityType,e.name,se.role,e.followed FROM signal_entities se JOIN entities e ON e.entity_id=se.entity_id WHERE se.signal_id=?').all(id);
    const opportunities = app.db.prepare('SELECT opportunity_id opportunityId,title,opportunity_type opportunityType,status,evidence_score evidenceScore FROM opportunities WHERE signal_id=?').all(id);
    const topic = app.db.prepare('SELECT content_topic_id contentTopicId,title,core_viewpoint coreViewpoint,status FROM content_topics WHERE signal_id=?').get(id) ?? null;
    const itemState = app.db.prepare("SELECT saved,ignored,value_rating valueRating FROM item_states WHERE target_type='signal' AND target_id=?").get(id) ?? { saved: 0, ignored: 0, valueRating: 0 };
    return reply.send({ code: 0, message: 'success', data: { signalId: id, title: signal.title, summary: signal.summary, signalType: signal.signal_type, tags: String(signal.tags_text).split(',').filter(Boolean), relevanceScore: signal.relevance_score, noveltyScore: signal.novelty_score, truthScore: signal.truth_score, technologyScore: signal.technology_score, adoptionScore: signal.adoption_score, monetizationScore: signal.monetization_score, contentValueScore: signal.content_value_score, valueScore: signal.value_score, evidenceLevel: signal.evidence_level, hasConflict: signal.has_conflict, state: signal.state, eventAt: signal.event_at, scoreExplanation: parseJson(signal.score_explanation_json, {}), evidence, conflicts: evidence.filter((e: Record<string, unknown>) => e.relationType === 'conflicting'), entities, opportunities, contentTopic: topic, itemState }, requestId: request.id });
  });

  app.patch('/api/signals/:signalId/state', async (request, reply) => {
    const id = parsePositiveId((request.params as { signalId: string }).signalId); const state = (request.body as { state?: unknown })?.state;
    if (!['active', 'archived'].includes(String(state))) throw new BusinessError(ErrorCodes.INVALID_SIGNAL_STATE);
    if (!app.db.prepare('SELECT 1 FROM signals WHERE signal_id=?').get(id)) throw new BusinessError(ErrorCodes.SIGNAL_NOT_FOUND);
    app.db.prepare('UPDATE signals SET state=?,updated_at=? WHERE signal_id=?').run(state, now(), id);
    return reply.send({ code: 0, message: 'success', data: { signalId: id, state, updatedAt: now() }, requestId: request.id });
  });

  app.put('/api/item-states/:targetType/:targetId', async (request, reply) => {
    const { targetType, targetId } = request.params as { targetType: string; targetId: string }; const id = parsePositiveId(targetId);
    if (!['signal', 'opportunity', 'content_topic'].includes(targetType)) throw new BusinessError(ErrorCodes.INVALID_REQUEST);
    if (!targetExists(app, targetType, id)) throw new BusinessError(ErrorCodes.ITEM_NOT_FOUND);
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!['saved', 'ignored', 'valueRating'].some((key) => key in body)) throw new BusinessError(ErrorCodes.EMPTY_ITEM_STATE);
    if ((body.saved !== undefined && typeof body.saved !== 'boolean') || (body.ignored !== undefined && typeof body.ignored !== 'boolean') || (body.valueRating !== undefined && ![-1, 0, 1].includes(Number(body.valueRating)))) throw new BusinessError(ErrorCodes.INVALID_REQUEST);
    const current = app.db.prepare('SELECT saved,ignored,value_rating valueRating FROM item_states WHERE target_type=? AND target_id=?').get(targetType, id) as { saved: number; ignored: number; valueRating: number } | undefined;
    const saved = body.saved === undefined ? current?.saved ?? 0 : Number(body.saved); const ignored = body.ignored === undefined ? current?.ignored ?? 0 : Number(body.ignored); const valueRating = body.valueRating === undefined ? current?.valueRating ?? 0 : Number(body.valueRating);
    if (saved && ignored) throw new BusinessError(ErrorCodes.CONTRADICTORY_ITEM_STATE);
    const updatedAt = now(); app.db.prepare('INSERT INTO item_states(target_type,target_id,saved,ignored,value_rating,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(target_type,target_id) DO UPDATE SET saved=excluded.saved,ignored=excluded.ignored,value_rating=excluded.value_rating,updated_at=excluded.updated_at').run(targetType, id, saved, ignored, valueRating, updatedAt);
    return reply.send({ code: 0, message: 'success', data: { targetType, targetId: id, saved: Boolean(saved), ignored: Boolean(ignored), valueRating, updatedAt }, requestId: request.id });
  });

  app.get('/api/opportunities', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    if ((q.status && !['candidate', 'prepare_verification', 'verified'].includes(String(q.status))) || (q.sort && !['evidence', 'newest'].includes(String(q.sort)))) throw new BusinessError(ErrorCodes.INVALID_OPPORTUNITY_FILTER);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.status) { clauses.push('o.status=?'); params.push(q.status); } if (q.opportunityType) { clauses.push('o.opportunity_type=?'); params.push(q.opportunityType); }
    for (const key of ['saved', 'ignored']) if (q[key] !== undefined) { clauses.push(`COALESCE(i.${key},0)=?`); params.push(bool(q[key], ErrorCodes.INVALID_OPPORTUNITY_FILTER, key)); }
    const rows = app.db.prepare(`SELECT o.opportunity_id opportunityId,o.signal_id signalId,o.opportunity_type opportunityType,o.title,o.summary,o.evidence_score evidenceScore,o.status,COALESCE(i.saved,0) saved,COALESCE(i.ignored,0) ignored,o.created_at createdAt,o.updated_at updatedAt FROM opportunities o LEFT JOIN item_states i ON i.target_type='opportunity' AND i.target_id=o.opportunity_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${q.sort === 'newest' ? 'o.updated_at DESC' : 'o.evidence_score DESC,o.updated_at DESC'} LIMIT ?`).all(...params, limit);
    return reply.send({ code: 0, message: 'success', data: page(rows), requestId: request.id });
  });

  app.get('/api/opportunities/:opportunityId', async (request, reply) => {
    const id = parsePositiveId((request.params as { opportunityId: string }).opportunityId); const row = app.db.prepare('SELECT * FROM opportunities WHERE opportunity_id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.OPPORTUNITY_NOT_FOUND);
    return reply.send({ code: 0, message: 'success', data: { opportunityId: id, signalId: row.signal_id, opportunityType: row.opportunity_type, title: row.title, summary: row.summary, evidenceScore: row.evidence_score, status: row.status, ...parseJson(row.body_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }, requestId: request.id });
  });

  app.patch('/api/opportunities/:opportunityId/status', async (request, reply) => {
    const id = parsePositiveId((request.params as { opportunityId: string }).opportunityId); const status = (request.body as { status?: unknown })?.status;
    if (!['candidate', 'prepare_verification', 'verified'].includes(String(status))) throw new BusinessError(ErrorCodes.INVALID_OPPORTUNITY_STATUS);
    if (!app.db.prepare('SELECT 1 FROM opportunities WHERE opportunity_id=?').get(id)) throw new BusinessError(ErrorCodes.OPPORTUNITY_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE opportunities SET status=?,updated_at=? WHERE opportunity_id=?').run(status, updatedAt, id);
    return reply.send({ code: 0, message: 'success', data: { opportunityId: id, status, updatedAt }, requestId: request.id });
  });

  app.get('/api/content-topics', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit);
    if ((q.status && !['candidate', 'preparing', 'published'].includes(String(q.status))) || (q.sort && !['evidence', 'newest'].includes(String(q.sort)))) throw new BusinessError(ErrorCodes.INVALID_TOPIC_FILTER);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.status) { clauses.push('c.status=?'); params.push(q.status); } if (q.platform) { clauses.push('c.platforms_json LIKE ?'); params.push(`%${q.platform}%`); }
    for (const key of ['saved', 'ignored']) if (q[key] !== undefined) { clauses.push(`COALESCE(i.${key},0)=?`); params.push(bool(q[key], ErrorCodes.INVALID_TOPIC_FILTER, key)); }
    const rows = (app.db.prepare(`SELECT c.content_topic_id contentTopicId,c.signal_id signalId,c.title,c.core_viewpoint coreViewpoint,c.platforms_json platformsJson,c.evidence_score evidenceScore,c.status,COALESCE(i.saved,0) saved,COALESCE(i.ignored,0) ignored,c.created_at createdAt,c.updated_at updatedAt FROM content_topics c LEFT JOIN item_states i ON i.target_type='content_topic' AND i.target_id=c.content_topic_id ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${q.sort === 'newest' ? 'c.updated_at DESC' : 'c.evidence_score DESC,c.updated_at DESC'} LIMIT ?`).all(...params, limit) as Record<string, unknown>[]).map((row) => ({ ...row, platforms: parseJson(row.platformsJson, []) }));
    return reply.send({ code: 0, message: 'success', data: page(rows), requestId: request.id });
  });

  app.get('/api/content-topics/:contentTopicId', async (request, reply) => {
    const id = parsePositiveId((request.params as { contentTopicId: string }).contentTopicId); const row = app.db.prepare('SELECT * FROM content_topics WHERE content_topic_id=?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError(ErrorCodes.TOPIC_NOT_FOUND);
    return reply.send({ code: 0, message: 'success', data: { contentTopicId: id, signalId: row.signal_id, title: row.title, coreViewpoint: row.core_viewpoint, platforms: parseJson(row.platforms_json, []), evidenceScore: row.evidence_score, status: row.status, ...parseJson(row.body_json, {}), createdAt: row.created_at, updatedAt: row.updated_at }, requestId: request.id });
  });

  app.patch('/api/content-topics/:contentTopicId/status', async (request, reply) => {
    const id = parsePositiveId((request.params as { contentTopicId: string }).contentTopicId); const status = (request.body as { status?: unknown })?.status;
    if (!['candidate', 'preparing', 'published'].includes(String(status))) throw new BusinessError(ErrorCodes.INVALID_TOPIC_STATUS);
    if (!app.db.prepare('SELECT 1 FROM content_topics WHERE content_topic_id=?').get(id)) throw new BusinessError(ErrorCodes.TOPIC_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE content_topics SET status=?,updated_at=? WHERE content_topic_id=?').run(status, updatedAt, id);
    return reply.send({ code: 0, message: 'success', data: { contentTopicId: id, status, updatedAt }, requestId: request.id });
  });

  app.get('/api/entities', async (request, reply) => {
    const q = request.query as Record<string, unknown>; const limit = parseLimit(q.limit); const types = ['company', 'product', 'technology', 'topic', 'industry', 'problem'];
    if ((q.entityType && !types.includes(String(q.entityType))) || (q.sort && !['latest', 'signals'].includes(String(q.sort))) || (q.q && String(q.q).length > 100)) throw new BusinessError(ErrorCodes.INVALID_ENTITY_FILTER);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.entityType) { clauses.push('e.entity_type=?'); params.push(q.entityType); } if (q.followed !== undefined) { clauses.push('e.followed=?'); params.push(bool(q.followed, ErrorCodes.INVALID_ENTITY_FILTER, 'followed')); } if (q.q) { clauses.push('e.name LIKE ?'); params.push(`%${q.q}%`); }
    const rows = (app.db.prepare(`SELECT e.entity_id entityId,e.entity_type entityType,e.name,e.summary,e.followed,(SELECT count(*) FROM signal_entities se WHERE se.entity_id=e.entity_id) signalCount,e.first_seen_at firstSeenAt,e.last_seen_at lastSeenAt,(SELECT json_object('signalId',ee.signal_id,'eventType',ee.event_type,'eventAt',ee.event_at,'headline',ee.headline) FROM entity_events ee WHERE ee.entity_id=e.entity_id ORDER BY ee.event_at DESC LIMIT 1) latestEventJson FROM entities e ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${q.sort === 'signals' ? 'signalCount DESC,e.last_seen_at DESC' : 'e.last_seen_at DESC'} LIMIT ?`).all(...params, limit) as Record<string, unknown>[]).map((row) => ({ ...row, latestEvent: parseJson(row.latestEventJson, null) }));
    return reply.send({ code: 0, message: 'success', data: page(rows), requestId: request.id });
  });

  app.get('/api/entities/:entityId', async (request, reply) => {
    const id = parsePositiveId((request.params as { entityId: string }).entityId); const q = request.query as Record<string, unknown>; const eventLimit = q.eventLimit === undefined ? 50 : parseLimit(q.eventLimit);
    const entity = app.db.prepare('SELECT * FROM entities WHERE entity_id=?').get(id) as Record<string, unknown> | undefined; if (!entity) throw new BusinessError(ErrorCodes.ENTITY_NOT_FOUND);
    const events = app.db.prepare('SELECT ee.signal_id signalId,ee.event_type eventType,ee.event_at eventAt,ee.headline,s.title signalTitle,s.evidence_level evidenceLevel,s.value_score valueScore FROM entity_events ee JOIN signals s ON s.signal_id=ee.signal_id WHERE ee.entity_id=? ORDER BY ee.event_at DESC LIMIT ?').all(id, eventLimit);
    return reply.send({ code: 0, message: 'success', data: { entityId: id, entityType: entity.entity_type, name: entity.name, summary: entity.summary, followed: entity.followed, firstSeenAt: entity.first_seen_at, lastSeenAt: entity.last_seen_at, events: page(events) }, requestId: request.id });
  });

  app.put('/api/entities/:entityId/follow', async (request, reply) => {
    const id = parsePositiveId((request.params as { entityId: string }).entityId); const followed = (request.body as { followed?: unknown })?.followed;
    if (typeof followed !== 'boolean') throw new BusinessError(ErrorCodes.INVALID_REQUEST); if (!app.db.prepare('SELECT 1 FROM entities WHERE entity_id=?').get(id)) throw new BusinessError(ErrorCodes.ENTITY_NOT_FOUND);
    const updatedAt = now(); app.db.prepare('UPDATE entities SET followed=?,updated_at=? WHERE entity_id=?').run(followed ? 1 : 0, updatedAt, id);
    return reply.send({ code: 0, message: 'success', data: { entityId: id, followed, updatedAt }, requestId: request.id });
  });
}
