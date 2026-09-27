import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';
import { hasLlmConfig, generateStructured } from './LlmClient.js';

const evidenceIds = z.array(z.number().int().positive()).min(1);
const text = z.string().min(1).max(2000);
const summarySchema = z.object({ signalId: z.number().int().positive(), summary: text, evidenceIds });
const opportunitySchema = z.object({
  signalId: z.number().int().positive(), title: text, summary: text, targetUsers: text, problem: text,
  alternatives: z.array(text), timingReason: text, solutionForm: text,
  deliveryDifficulty: text, acquisitionDifficulty: text, monetization: text,
  validationAction: text, paybackPeriod: text, risks: z.array(text), openQuestions: z.array(text), evidenceIds
});
const topicSchema = z.object({
  signalId: z.number().int().positive(), title: text, coreViewpoint: text, coreFacts: z.array(text).min(1), background: text,
  technologyChange: text, useCases: z.array(text), arguments: z.array(text),
  controversies: z.array(text), uncertainties: z.array(text),
  platformAngles: z.record(z.string(), text), evidenceIds
});

type Signal = { signalId: number; title: string; summary: string; signalType: string; valueScore: number; monetizationScore: number; adoptionScore: number; contentValueScore: number; evidenceLevel: string; hasConflict: number };
type Evidence = { discoveryId: number; title: string; url: string; snippet: string; publishedAt: string | null };

export async function generateCards(app: FastifyInstance, taskId: number, deadline = Infinity) {
  const counts = { opportunities: 0, topics: 0, failed: 0, errorCode: null as number | null };
  const configured = hasLlmConfig();
  const latestTaskId = (app.db.prepare("SELECT max(t.task_id) taskId FROM scan_tasks t WHERE EXISTS (SELECT 1 FROM scan_task_steps step WHERE step.task_id=t.task_id AND step.step_name='analyzing' AND step.status='completed') AND EXISTS (SELECT 1 FROM scan_task_steps step WHERE step.task_id=t.task_id AND step.step_name='generating' AND step.status IN ('running','completed','partial_failed'))").get() as { taskId: number | null } | undefined)?.taskId ?? taskId;
  const isLatestTask = latestTaskId === taskId;
  const signals = app.db.prepare("SELECT s.signal_id signalId,s.title,COALESCE(ss.summary,s.summary) summary,s.signal_type signalType,COALESCE(ss.value_score,s.value_score) valueScore,COALESCE(ss.monetization_score,s.monetization_score) monetizationScore,COALESCE(ss.adoption_score,s.adoption_score) adoptionScore,COALESCE(ss.content_value_score,s.content_value_score) contentValueScore,COALESCE(ss.evidence_level,s.evidence_level) evidenceLevel,CASE WHEN COALESCE(ss.evidence_level,s.evidence_level)='conflicting' THEN 1 ELSE s.has_conflict END hasConflict FROM signals s JOIN scan_signals ss ON ss.signal_id=s.signal_id WHERE ss.task_id=? ORDER BY COALESCE(ss.value_score,s.value_score) DESC,s.signal_id DESC").all(taskId) as Signal[];
  for (const signal of signals) {
    if (Date.now() >= deadline) { counts.failed++; counts.errorCode ??= ErrorCodes.SCAN_TIMEOUT; break; }
    const acceptedThisScan = app.db.prepare("SELECT 1 FROM signal_sources ss JOIN scan_discoveries sd ON sd.discovery_id=ss.discovery_id JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=? AND sd.task_id=? AND COALESCE(sd.status,d.status)='accepted' LIMIT 1").get(signal.signalId, taskId);
    if (!acceptedThisScan) continue;
    const evidence = app.db.prepare("SELECT d.discovery_id discoveryId,d.title,d.url,d.snippet,d.published_at publishedAt FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id JOIN scan_discoveries sd ON sd.discovery_id=d.discovery_id AND sd.task_id=? WHERE ss.signal_id=? AND COALESCE(sd.status,d.status)='accepted'").all(taskId, signal.signalId) as Evidence[];
    if (!evidence.length) continue;
    const allowed = new Set(evidence.map(({ discoveryId }) => discoveryId));
    const facts = JSON.stringify({ signalId: signal.signalId, title: signal.title, summary: signal.summary, evidence: evidence.map(({ discoveryId, title, url, snippet, publishedAt }) => ({ discoveryId, title, url, snippet: snippet.slice(0, 300), publishedAt })) });
    const fallback = `原文标题：${signal.title}。已记录 ${evidence.length} 条来源，${evidence.every(({ publishedAt }) => !publishedAt) ? '发布时间待核查，' : ''}具体变化请核查原文。`;
    let summary = signal.summary || fallback;
    if (configured) {
      try {
        const generated = await generateStructured(`cardType:summary\n根据以下证据用中文概括事实，不得补充未经证实的数字或日期；没有发布时间时不得称为近期发布。返回 signalId、summary、evidenceIds。\n${facts}`, summarySchema);
        if (generated?.signalId !== signal.signalId || !generated.evidenceIds.every((id) => allowed.has(id))) throw new BusinessError(ErrorCodes.CARD_MISSING_EVIDENCE);
        summary = generated.summary;
      } catch (error) {
        app.log.warn({ event: 'generation.summary.fallback', taskId, signalId: signal.signalId, businessCode: error instanceof BusinessError ? error.code : ErrorCodes.LLM_INVALID_RESPONSE }, 'rule summary preserved');
      }
    }
    if (isLatestTask && signal.summary !== summary) app.db.prepare('UPDATE signals SET summary=?,updated_at=? WHERE signal_id=?').run(summary, new Date().toISOString(), signal.signalId);
    const kinds = signal.hasConflict ? [] : [
      ...(signal.valueScore >= 55 && (signal.monetizationScore >= 60 || signal.adoptionScore >= 65) ? ['opportunity' as const] : []),
      ...(signal.valueScore >= 55 && signal.contentValueScore >= 60 ? ['topic' as const] : [])
    ];
    if (!configured && kinds.length) {
      counts.failed += kinds.length;
      counts.errorCode ??= ErrorCodes.LLM_NOT_CONFIGURED;
      app.log.warn({ event: 'generation.skipped', taskId, signalId: signal.signalId, businessCode: ErrorCodes.LLM_NOT_CONFIGURED, cardTypes: kinds }, 'model configuration unavailable');
      continue;
    }
    for (const kind of kinds) {
      const schema = kind === 'opportunity' ? opportunitySchema : topicSchema;
      let saved = false;
      for (let attempt = 0; attempt < 2 && !saved; attempt++) {
        if (Date.now() >= deadline) { counts.failed++; counts.errorCode ??= ErrorCodes.SCAN_TIMEOUT; break; }
        try {
          const prompt = `cardType:${kind}\n根据以下可核查事实输出中文 JSON。只引用 evidence 中真实存在的 discoveryId；没有证据支持的判断写入风险或不确定性，不能编造数据或日期；发布时间未知时明确列为待确认。不要写整篇文章或脚本。必须提供所有字段，evidenceIds 至少一个。\n${facts}`;
          const card = await generateStructured(prompt, schema);
          if (!card || card.signalId !== signal.signalId || !card.evidenceIds.every((id: number) => allowed.has(id))) throw new BusinessError(ErrorCodes.CARD_MISSING_EVIDENCE);
          const timestamp = new Date().toISOString();
          const references = evidence.filter(({ discoveryId }) => card.evidenceIds.includes(discoveryId)).map(({ discoveryId, title, url }) => ({ discoveryId, title, url }));
          if (kind === 'opportunity') {
            const entry = card as z.output<typeof opportunitySchema>;
            const opportunityType = signal.signalType === 'use_case' ? 'implementation_service' : signal.signalType === 'paper' ? 'knowledge_service' : signal.signalType === 'market' ? 'content_business' : signal.signalType === 'open_source' ? 'digital_product' : 'product';
            const existing = app.db.prepare('SELECT last_generated_task_id lastTaskId FROM opportunities WHERE signal_id=? AND opportunity_type=?').get(signal.signalId, opportunityType) as { lastTaskId: number | null } | undefined;
            if (!existing || existing.lastTaskId === null || existing.lastTaskId <= taskId) {
              app.db.prepare("INSERT INTO opportunities(signal_id,opportunity_type,title,summary,body_json,evidence_score,status,schema_version,last_generated_task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'candidate','v1',?,?,?) ON CONFLICT(signal_id,opportunity_type) DO UPDATE SET title=excluded.title,summary=excluded.summary,body_json=excluded.body_json,evidence_score=excluded.evidence_score,last_generated_task_id=excluded.last_generated_task_id,updated_at=excluded.updated_at").run(signal.signalId, opportunityType, entry.title, entry.summary, JSON.stringify({ ...entry, evidence: references }), signal.valueScore, taskId, timestamp, timestamp);
              counts.opportunities++;
            }
          } else {
            const entry = card as z.output<typeof topicSchema>;
            const platforms = Object.keys(entry.platformAngles).filter((value) => ['wechat', 'video_account', 'xiaohongshu', 'zhihu', 'bilibili', 'douyin', 'x', 'newsletter'].includes(value));
            const existing = app.db.prepare('SELECT last_generated_task_id lastTaskId FROM content_topics WHERE signal_id=?').get(signal.signalId) as { lastTaskId: number | null } | undefined;
            if (!existing || existing.lastTaskId === null || existing.lastTaskId <= taskId) {
              app.db.prepare("INSERT INTO content_topics(signal_id,title,core_viewpoint,body_json,platforms_json,evidence_score,status,schema_version,last_generated_task_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'candidate','v1',?,?,?) ON CONFLICT(signal_id) DO UPDATE SET title=excluded.title,core_viewpoint=excluded.core_viewpoint,body_json=excluded.body_json,platforms_json=excluded.platforms_json,evidence_score=excluded.evidence_score,last_generated_task_id=excluded.last_generated_task_id,updated_at=excluded.updated_at").run(signal.signalId, entry.title, entry.coreViewpoint, JSON.stringify({ ...entry, evidence: references }), JSON.stringify(platforms), signal.valueScore, taskId, timestamp, timestamp);
              counts.topics++;
            }
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
