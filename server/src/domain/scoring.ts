const weights = { novelty: 15, truth: 20, technology: 15, adoption: 20, monetization: 15, contentValue: 15 } as const;

export function scoreDiscovery(discovery: { title: string; snippet: string; trustLevel?: number | null; publishedAt?: string | null; sourceName?: string | null }) {
  const text = `${discovery.title} ${discovery.snippet}`;
  const has = (pattern: RegExp) => pattern.test(text);
  const relevant = has(/\b(?:ai|llm|gpt|agent|inference|claude|gemini|deepseek|qwen|copilot|model|models|machine learning|automation)\b|人工智能|大模型|生成式|智能体|机器学习|深度学习|模型|推理|自动化/i);
  const release = has(/发布|推出|上线|开源|升级|首发|release|launch|open.source|introduc/i);
  const research = has(/论文|研究|基准|推理|训练|paper|research|benchmark|reasoning/i);
  const deployment = has(/落地|部署|实际应用|生产环境|客户案例|应用案例|实践|deplo|production|case study|customer/i);
  const commercial = has(/付费|收入|营收|订阅|定价|商业化|融资|pricing|subscription|revenue|funding/i);
  const verified = Boolean(discovery.publishedAt);
  const trust = discovery.trustLevel ?? 0;
  const scores = {
    novelty: 50 + Number(release) * 15,
    truth: 40 + Number(verified) * 10 + (trust >= 5 ? 20 : trust >= 4 ? 10 : 0),
    technology: 50 + Number(research) * 20,
    adoption: 50 + Number(deployment) * 20,
    monetization: 50 + Number(commercial) * 20,
    contentValue: 50 + Number(deployment || research) * 15
  };
  const curatedResearch = /^(?:arXiv cs\.(?:AI|CL|LG|CV)|HF Papers)$/.test(discovery.sourceName ?? '');
  const relevance = relevant ? 65 : curatedResearch ? 40 : 20;
  const value = Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + scores[key as keyof typeof scores] * weight, 0) / 100);
  const type = has(/融资|并购|funding|acquisition/i) ? 'funding' : research ? 'paper' : deployment ? 'use_case' : has(/开源|open.source/i) ? 'open_source' : release ? 'product' : 'market';
  const matched = [release && 'release', research && 'research', deployment && 'deployment', commercial && 'commercial', verified && 'dated', trust >= 5 && 'official_source'].filter(Boolean);
  return { relevance, scores, value, type, evidenceLevel: trust >= 5 ? 'first_party' : 'single_source', explanation: { rulesVersion: 'v1', weights, matched, trustLevel: trust, evidenceCount: 1 } };
}
