export const QUERY_VERSION = 'v1';

const signals = [
  ['technology', '模型技术突破', 'AI model technology breakthrough'],
  ['product', 'AI 产品发布', 'AI product launch'],
  ['paper', '人工智能 论文研究', 'AI research paper'],
  ['funding', 'AI 公司融资并购', 'AI startup funding acquisition'],
  ['company', 'AI 公司战略动作', 'AI company strategy'],
  ['use_case', 'AI 真实落地案例', 'AI real world deployment case study'],
  ['open_source', 'AI 开源项目', 'AI open source project'],
  ['demand', 'AI 用户需求 痛点', 'AI user demand pain points'],
  ['business', 'AI 商业模式', 'AI business model'],
  ['ecosystem', 'AI 政策 生态', 'AI policy ecosystem']
] as const;
const industries = [
  ['marketing', '营销', 'marketing'], ['education', '教育', 'education'],
  ['developer', '开发者工具', 'developer tools'], ['enterprise', '企业服务', 'enterprise services']
] as const;

export function buildSearchQueries() {
  return signals.flatMap(([type, zh, en]) => industries.flatMap(([industry, zhIndustry, enIndustry]) => [
    { queryKey: `${type}:${industry}`, queryText: `${zh} ${zhIndustry}`, zone: 'cn' as const, language: 'zh-CN' as const },
    { queryKey: `${type}:${industry}`, queryText: `${en} ${enIndustry}`, zone: 'intl' as const, language: 'en' as const }
  ]));
}
