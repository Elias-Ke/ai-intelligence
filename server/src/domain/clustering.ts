const generic = new Set(['ai', 'llm', 'gpt', 'agent', 'new', 'the', 'and', 'for', 'with', 'not', 'no', 'denies', 'denied', '人工智能', '大模型', '智能体', '尚未', '否认']);

export function eventTokens(title: string) {
  const normalized = title.toLowerCase().normalize('NFKC').replace(/https?:\/\/\S+/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ');
  const parts = normalized.match(/[a-z][a-z0-9]*|\p{N}+|\p{Script=Han}+/gu) ?? [];
  return new Set(parts.flatMap((part) => /\p{Script=Han}/u.test(part) && part.length > 2 ? [...part].slice(0, -1).map((_, index) => part.slice(index, index + 2)) : [part]).filter((part) => !generic.has(part)));
}

export function eventSimilarity(a: string, b: string) {
  const left = eventTokens(a); const right = eventTokens(b);
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / (left.size + right.size - overlap);
}

export function contradicts(a: string, b: string) {
  const negation = /\b(?:denies|denied|not|no|cancelled|failed)\b|否认|尚未|未能|未发布|取消|失败/i;
  const assertion = /\b(?:launches|launched|released|deployed|confirmed|successful)\b|已发布|正式发布|上线|已部署|确认|成功/i;
  return (negation.test(a) && assertion.test(b)) || (negation.test(b) && assertion.test(a));
}
