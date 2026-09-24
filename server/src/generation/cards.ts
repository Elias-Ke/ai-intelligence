import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { hasLlmConfig, generateStructured } from './LlmClient.js';

const evidenceIds = z.array(z.number().int().positive()).min(1);
const text = z.string().min(1).max(2000);
const opportunitySchema = z.object({
  title: text, summary: text, targetUsers: text, problem: text,
  alternatives: z.array(text), timingReason: text, solutionForm: text,
  deliveryDifficulty: text, acquisitionDifficulty: text, monetization: text,
  validationAction: text, risks: z.array(text), openQuestions: z.array(text), evidenceIds
});
const topicSchema = z.object({
  title: text, coreViewpoint: text, coreFacts: z.array(text).min(1), background: text,
  technologyChange: text, useCases: z.array(text), arguments: z.array(text),
  controversies: z.array(text), uncertainties: z.array(text),
  platformAngles: z.record(z.string(), text), evidenceIds
});

type Signal = { signalId: number; title: string; summary: string; signalType: string; valueScore: number };
type Evidence = { discoveryId: number; title: string; url: string; snippet: string };

export async function generateCards(app: FastifyInstance, taskId: number) {
  const counts = { opportunities: 0, topics: 0, failed: 0, errorCode: null as number | null };
  if (!hasLlmConfig()) {
    app.log.warn({ event: 'generation.skipped', taskId, reason: 'model_not_configured' }, 'model configuration unavailable');
    return counts;
  }
  const signals = app.db.prepare('SELECT s.signal_id signalId,s.title,s.summary,s.signal_type signalType,s.value_score valueScore FROM signals s JOIN scan_signals ss ON ss.signal_id=s.signal_id WHERE ss.task_id=? AND s.value_score>=55 ORDER BY s.value_score DESC,s.signal_id DESC').all(taskId) as Signal[];
  for (const signal of signals) {
    const evidence = app.db.prepare('SELECT d.discovery_id discoveryId,d.title,d.url,d.snippet FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=?').all(signal.signalId) as Evidence[];
    if (!evidence.length) continue;
    const allowed = new Set(evidence.map(({ discoveryId }) => discoveryId));
    const facts = JSON.stringify({ signalId: signal.signalId, title: signal.title, summary: signal.summary, evidence: evidence.map(({ discoveryId, title, url, snippet }) => ({ discoveryId, title, url, snippet: snippet.slice(0, 300) })) });
    for (const kind of ['opportunity', 'topic'] as const) {
      const schema = kind === 'opportunity' ? opportunitySchema : topicSchema;
      let saved = false;
      for (let attempt = 0; attempt < 2 && !saved; attempt++) {
        try {
          const prompt = `cardType:${kind}\n根据以下可核查事实输出中文 JSON。只引用 evidence 中真实存在的 discoveryId；没有证据支持的判断写入风险或不确定性，不能编造数据。不要写整篇文章或脚本。必须提供所有字段，evidenceIds 至少一个。\n${facts}`;
          const card = await generateStructured(prompt, schema);
          if (!card || !card.evidenceIds.every((id: number) => allowed.has(id))) throw new BusinessError(ErrorCodes.CARD_MISSING_EVIDENCE);
          const timestamp = new Date().toISOString();
          const references = evidence.filter(({ discoveryId }) => card.evidenceIds.includes(discoveryId)).map(({ discoveryId, title, url }) => ({ discoveryId, title, url }));
          if (kind === 'opportunity') {
            const entry = card as z.output<typeof opportunitySchema>;
            const opportunityType = signal.signalType === 'use_case' ? 'implementation_service' : 'product';
            app.db.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,'candidate','v1',?,?) ON CONFLICT(signal_id,opportunity_type) DO UPDATE SET title=excluded.title,summary=excluded.summary,body_json=excluded.body_json,evidence_score=excluded.evidence_score,updated_at=excluded.updated_at").run(signal.signalId, opportunityType, entry.title, entry.summary, JSON.stringify({ ...entry, evidence: references }), signal.valueScore, timestamp, timestamp);
            counts.opportunities++;
          } else {
            const entry = card as z.output<typeof topicSchema>;
            const platforms = Object.keys(entry.platformAngles).filter((value) => ['wechat', 'video_account', 'xiaohongshu', 'zhihu', 'bilibili', 'douyin', 'x', 'newsletter'].includes(value));
            app.db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,created_at,updated_at) VALUES(?,?,?,?,?,?,'candidate','v1',?,?) ON CONFLICT(signal_id) DO UPDATE SET title=excluded.title,core_viewpoint=excluded.core_viewpoint,body_json=excluded.body_json,platforms_json=excluded.platforms_json,evidence_score=excluded.evidence_score,updated_at=excluded.updated_at").run(signal.signalId, entry.title, entry.coreViewpoint, JSON.stringify({ ...entry, evidence: references }), JSON.stringify(platforms), signal.valueScore, timestamp, timestamp);
            counts.topics++;
          }
          saved = true;
          app.log.info({ event: 'generation.card.completed', taskId, signalId: signal.signalId, cardType: kind, schemaVersion: 'v1', retryCount: attempt, evidenceCount: references.length }, 'card generated');
        } catch (error) {
          const code = error instanceof BusinessError ? error.code : ErrorCodes.LLM_INVALID_RESPONSE;
          app.log.warn({ event: 'generation.card.failed', taskId, signalId: signal.signalId, cardType: kind, schemaVersion: 'v1', businessCode: code, retryCount: attempt, retryable: attempt === 0 }, 'card generation failed');
          if (attempt === 1) { counts.failed++; counts.errorCode ??= code; }
        }
      }
    }
  }
  return counts;
}
