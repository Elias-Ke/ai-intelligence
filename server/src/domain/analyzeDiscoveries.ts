import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isFirstPartyArticle, scoreDiscovery } from './scoring.js';
import { contradicts, eventSimilarity, eventTokens } from './clustering.js';

type Discovery = { discovery_id: number; title: string; snippet: string; url: string; normalized_url: string; content_hash: string; published_at: string | null; fetched_at: string; status: string; trustLevel: number | null; sourceName: string | null; sourceUrl: string | null };
type Candidate = { signalId: number; title: string; eventAt: string | null };

export function analyzeDiscoveries(app: FastifyInstance, taskId: number) {
  const discoveries = app.db.prepare("SELECT d.*,src.trust_level trustLevel,src.name sourceName,src.url sourceUrl FROM raw_discoveries d JOIN scan_discoveries sd ON sd.discovery_id=d.discovery_id JOIN scan_tasks t ON t.task_id=sd.task_id LEFT JOIN sources src ON src.source_id=d.source_id WHERE sd.task_id=? AND ((d.status IN ('accepted','extract_failed') AND d.published_at BETWEEN t.range_from AND t.range_to) OR (d.status IN ('candidate','extract_failed') AND d.published_at IS NULL)) ORDER BY d.discovery_id").all(taskId) as Discovery[];
  const save = app.db.transaction((discovery: Discovery, rank: number) => {
    const timestamp = new Date().toISOString();
    const title = discovery.title || discovery.url;
    const summary = discovery.snippet.slice(0, 500);
    const assessment = scoreDiscovery({ title, snippet: summary, trustLevel: discovery.trustLevel, publishedAt: discovery.published_at, sourceName: discovery.sourceName, sourceUrl: discovery.sourceUrl, articleUrl: discovery.url });
    if (assessment.relevance < 35) return false;

    const tokens = [...eventTokens(title)].filter((token) => /[a-z0-9]/.test(token)).slice(0, 4);
    const fts = tokens.length ? `AND s.signal_id IN (SELECT rowid FROM signals_fts WHERE signals_fts MATCH ?)` : '';
    const match = tokens.map((token) => `"${token}"`).join(' OR ');
    const observedAt = discovery.published_at ?? discovery.fetched_at;
    const date = new Date(observedAt).getTime();
    const from = new Date(date - 72 * 3600_000).toISOString();
    const to = new Date(date + 72 * 3600_000).toISOString();
    const candidates = app.db.prepare(`SELECT s.signal_id signalId,s.title,s.event_at eventAt FROM signals s WHERE s.event_at BETWEEN ? AND ? ${fts} ORDER BY s.signal_id DESC`).all(
      from, to,
      ...(tokens.length ? [match] : [])
    ) as Candidate[];
    // ponytail: Chinese FTS can miss token matches, so scan the dated window; index event tokens if this becomes slow.
    const nearby = candidates.length || !tokens.length ? candidates : app.db.prepare('SELECT signal_id signalId,title,event_at eventAt FROM signals WHERE event_at BETWEEN ? AND ? ORDER BY signal_id DESC').all(from, to) as Candidate[];
    const related = nearby.find((candidate) => eventSimilarity(title, candidate.title) >= 0.82);
    const clusterKey = createHash('sha256').update(`${discovery.normalized_url}:${discovery.content_hash}`).digest('hex');
    if (!related) app.db.prepare("INSERT OR IGNORE INTO signals(cluster_key,title,summary,signal_type,tags_text,search_text,relevance_score,novelty_score,truth_score,technology_score,adoption_score,monetization_score,content_value_score,value_score,evidence_level,has_conflict,score_explanation_json,rules_version,state,event_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(clusterKey, title, summary, assessment.type, 'AI', `${title} ${summary}`, assessment.relevance, assessment.scores.novelty, discovery.status === 'extract_failed' ? 40 : assessment.scores.truth, assessment.scores.technology, assessment.scores.adoption, assessment.scores.monetization, assessment.scores.contentValue, assessment.value, assessment.evidenceLevel, 0, JSON.stringify(assessment.explanation), 'v1', !discovery.published_at || assessment.value < 65 ? 'needs_review' : 'active', observedAt, timestamp, timestamp);
    const signalId = related?.signalId ?? (app.db.prepare('SELECT signal_id signalId FROM signals WHERE cluster_key=?').get(clusterKey) as { signalId: number }).signalId;
    const existing = app.db.prepare('SELECT d.discovery_id discoveryId,d.url,d.normalized_url normalizedUrl,d.title FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=?').all(signalId) as { discoveryId: number; url: string; normalizedUrl: string; title: string }[];
    const sameUrl = existing.some((row) => row.normalizedUrl === discovery.normalized_url);
    const conflict = existing.some((row) => contradicts(title, row.title));
    const domain = new URL(discovery.url).hostname.replace(/^www\./, '');
    const independent = !existing.some((row) => new URL(row.url).hostname.replace(/^www\./, '') === domain);
    app.db.prepare('INSERT OR IGNORE INTO signal_sources(signal_id,discovery_id,relation_type,is_independent,added_at) VALUES(?,?,?,?,?)').run(signalId, discovery.discovery_id, conflict ? 'conflicting' : sameUrl ? 'duplicate' : existing.length ? 'supporting' : 'primary', independent ? 1 : 0, timestamp);
    const evidenceCount = (app.db.prepare('SELECT count(*) count FROM signal_sources WHERE signal_id=?').get(signalId) as { count: number }).count;
    const independentCount = (app.db.prepare("SELECT count(*) count FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=? AND ss.is_independent=1 AND d.status='accepted'").get(signalId) as { count: number }).count;
    const datedCount = (app.db.prepare('SELECT count(*) count FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=? AND d.published_at_verified=1').get(signalId) as { count: number }).count;
    const verifiedCount = (app.db.prepare("SELECT count(*) count FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=? AND d.published_at_verified=1 AND d.status='accepted'").get(signalId) as { count: number }).count;
    const completeCount = (app.db.prepare("SELECT count(*) count FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id WHERE ss.signal_id=? AND d.status='accepted'").get(signalId) as { count: number }).count;
    const hasFirstParty = (app.db.prepare("SELECT d.url articleUrl,src.url sourceUrl FROM signal_sources ss JOIN raw_discoveries d ON d.discovery_id=ss.discovery_id JOIN sources src ON src.source_id=d.source_id WHERE ss.signal_id=? AND d.status='accepted' AND src.trust_level=5").all(signalId) as { articleUrl: string; sourceUrl: string }[]).some(({ articleUrl, sourceUrl }) => isFirstPartyArticle(sourceUrl, articleUrl));
    const prior = app.db.prepare('SELECT evidence_level evidenceLevel,has_conflict hasConflict,truth_score truthScore,value_score valueScore,state FROM signals WHERE signal_id=?').get(signalId) as { evidenceLevel: string; hasConflict: number; truthScore: number; valueScore: number; state: string };
    const hasConflict = conflict || Boolean(prior.hasConflict);
    const evidenceLevel = hasConflict ? 'conflicting' : hasFirstParty ? 'first_party' : independentCount >= 2 ? 'multi_source' : 'single_source';
    const truthScore = hasConflict ? Math.min(prior.truthScore, 40) : Math.min(100, Math.max(prior.truthScore, discovery.status === 'extract_failed' ? 40 : assessment.scores.truth) + (independentCount >= 2 && completeCount === 2 && prior.evidenceLevel === 'single_source' ? 10 : 0));
    const valueScore = Math.max(0, Math.min(100, Math.max(prior.valueScore, assessment.value) + Math.round((truthScore - Math.max(prior.truthScore, assessment.scores.truth)) * 0.2)));
    app.db.prepare("UPDATE signals SET evidence_level=?,has_conflict=?,truth_score=?,value_score=?,state=?,score_explanation_json=json_set(score_explanation_json,'$.evidenceCount',?,'$.independentSourceCount',?,'$.hasConflict',?,'$.publishedAtVerified',?,'$.rulesVersion','v1'),updated_at=? WHERE signal_id=?").run(evidenceLevel, hasConflict ? 1 : 0, truthScore, valueScore, prior.state === 'archived' ? 'archived' : !verifiedCount || !completeCount || hasConflict || (valueScore >= 65 && evidenceLevel === 'single_source') ? 'needs_review' : 'active', evidenceCount, independentCount, hasConflict ? 1 : 0, datedCount ? 1 : 0, timestamp, signalId);
    const highlight = prior.state !== 'archived' && valueScore >= 65 && verifiedCount > 0 && completeCount > 0 && !hasConflict && evidenceLevel !== 'single_source' ? 1 : 0;
    app.db.prepare('INSERT OR IGNORE INTO scan_signals(task_id,signal_id,rank_no,is_highlight,created_at) VALUES(?,?,?,?,?)').run(taskId, signalId, rank, highlight, timestamp);
    app.db.prepare('UPDATE scan_signals SET is_highlight=? WHERE task_id=? AND signal_id=?').run(highlight, taskId, signalId);
    app.log.info({ event: 'analysis.signal.scored', taskId, signalId, discoveryId: discovery.discovery_id, rulesVersion: 'v1', valueScore, evidenceCount, evidenceLevel, businessCode: 0 }, 'signal scored');
    if (conflict) app.log.warn({ event: 'analysis.evidence.conflict', taskId, signalId, discoveryId: discovery.discovery_id, businessCode: 0 }, 'conflicting evidence');
    return true;
  });
  let signals = 0;
  for (const discovery of discoveries) if (save(discovery, signals + 1)) signals++;
  return (app.db.prepare('SELECT count(*) count FROM scan_signals WHERE task_id=?').get(taskId) as { count: number }).count;
}
