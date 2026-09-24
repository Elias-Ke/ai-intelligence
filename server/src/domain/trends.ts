import type { FastifyInstance } from 'fastify';

type EntityType = 'company' | 'product' | 'technology' | 'topic' | 'industry' | 'problem';
type EntityInput = { type: EntityType; name: string; role: 'primary' | 'mentioned' | 'affected' };

const industries = [
  [/教育|学校|教学|学生|school|education|learning/i, '教育'],
  [/营销|广告|内容生产|电商|marketing|advertising|commerce/i, '营销与内容'],
  [/开发者|编程|代码|developer|coding|software/i, '开发者工具'],
  [/企业|客服|销售|知识管理|enterprise|customer service|sales/i, '企业服务']
] as const;
const technologies = [
  [/\b(?:agent|agents)\b|智能体/i, 'AI Agent'],
  [/\b(?:llm|large language model)\b|大模型/i, '大语言模型'],
  [/\b(?:inference|reasoning)\b|推理/i, '模型推理'],
  [/\b(?:multimodal)\b|多模态/i, '多模态']
] as const;

export function identifyEntities(title: string, summary: string, sourceName: string | null, sourceTrust: number | null, type: string): EntityInput[] {
  const text = `${title} ${summary}`;
  const entities: EntityInput[] = [];
  for (const [pattern, name] of industries) if (pattern.test(text)) entities.push({ type: 'industry', name, role: 'affected' });
  for (const [pattern, name] of technologies) if (pattern.test(text)) entities.push({ type: 'technology', name, role: 'mentioned' });
  if (sourceName && sourceTrust === 5 && !/arxiv|github|papers/i.test(sourceName)) entities.push({ type: 'company', name: sourceName, role: 'primary' });
  const brand = title.match(/\b(?:OpenAI|Anthropic|Google|Microsoft|Meta|NVIDIA|DeepSeek|Qwen|Mistral|MiniMax|ByteDance)\b|智谱|通义千问|腾讯混元|豆包|月之暗面/i)?.[0];
  if (brand && !entities.some((entity) => entity.type === 'company' && entity.name.toLowerCase() === brand.toLowerCase())) entities.push({ type: 'company', name: brand, role: 'mentioned' });
  const product = title.match(/(?:发布|推出|上线|推出了|launched?|releases?|introduces?)\s*([\p{L}\p{N}][\p{L}\p{N} .-]{1,28})/iu)?.[1]?.trim();
  if (product && !/^(?:ai|a new|new model|the|产品|模型)$/i.test(product)) entities.push({ type: 'product', name: product, role: 'mentioned' });
  if (/客户|痛点|成本|效率|工作流|customer|workflow|pain point/i.test(text)) entities.push({ type: 'problem', name: 'AI 工作流效率', role: 'affected' });
  entities.push({ type: 'topic', name: type === 'use_case' ? 'AI 实际落地' : type === 'paper' ? 'AI 研究进展' : type === 'funding' ? 'AI 商业生态' : type === 'open_source' ? 'AI 开源生态' : 'AI 产品与技术', role: 'primary' });
  return entities.filter((entity, index) => entities.findIndex((other) => other.type === entity.type && other.name.toLowerCase() === entity.name.toLowerCase()) === index);
}

export function updateTrends(app: FastifyInstance, taskId: number) {
  const signals = app.db.prepare("SELECT s.signal_id signalId,s.title,s.summary,s.signal_type signalType,s.event_at eventAt,src.name sourceName,src.trust_level sourceTrust FROM signals s JOIN scan_signals ss ON ss.signal_id=s.signal_id LEFT JOIN signal_sources ev ON ev.signal_id=s.signal_id AND ev.relation_type='primary' LEFT JOIN raw_discoveries d ON d.discovery_id=ev.discovery_id LEFT JOIN sources src ON src.source_id=d.source_id WHERE ss.task_id=? GROUP BY s.signal_id ORDER BY s.signal_id").all(taskId) as { signalId: number; title: string; summary: string; signalType: string; eventAt: string | null; sourceName: string | null; sourceTrust: number | null }[];
  const save = app.db.transaction((signal: typeof signals[number]) => {
    const timestamp = new Date().toISOString();
    const eventAt = signal.eventAt ?? timestamp;
    const eventType = signal.signalType;
    for (const entity of identifyEntities(signal.title, signal.summary, signal.sourceName, signal.sourceTrust, signal.signalType)) {
      const normalized = entity.name.toLowerCase().normalize('NFKC').trim();
      app.db.prepare('INSERT INTO entities(entity_type,name,normalized_name,summary,first_seen_at,last_seen_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(entity_type,normalized_name) DO UPDATE SET first_seen_at=min(first_seen_at,excluded.first_seen_at),last_seen_at=max(last_seen_at,excluded.last_seen_at),updated_at=excluded.updated_at').run(entity.type, entity.name, normalized, '', eventAt, eventAt, timestamp, timestamp);
      const row = app.db.prepare('SELECT entity_id entityId FROM entities WHERE entity_type=? AND normalized_name=?').get(entity.type, normalized) as { entityId: number };
      app.db.prepare('INSERT OR IGNORE INTO signal_entities(signal_id,entity_id,role) VALUES(?,?,?)').run(signal.signalId, row.entityId, entity.role);
      app.db.prepare('INSERT INTO entity_events(entity_id,signal_id,event_type,event_at,headline,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_id,signal_id,event_type) DO UPDATE SET event_at=excluded.event_at,headline=excluded.headline').run(row.entityId, signal.signalId, eventType, eventAt, signal.title, timestamp);
    }
  });
  for (const signal of signals) save(signal);
  const count = (app.db.prepare('SELECT count(DISTINCT se.entity_id) count FROM signal_entities se JOIN scan_signals ss ON ss.signal_id=se.signal_id WHERE ss.task_id=?').get(taskId) as { count: number }).count;
  app.log.info({ event: 'analysis.trends.updated', taskId, signalCount: signals.length, entityCount: count, businessCode: 0 }, 'trend timeline updated');
  return count;
}
