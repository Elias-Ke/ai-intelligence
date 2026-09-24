import { z } from 'zod';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';

const configSchema = z.object({ baseUrl: z.string().url(), apiKey: z.string().min(1), model: z.string().min(1) });
export const structuredCardSchema = z.object({
  summary: z.string().min(1),
  evidenceIds: z.array(z.number().int().positive()),
  uncertainties: z.array(z.string()).default([]),
  validationAction: z.string().min(1).optional()
});
export type StructuredCard = z.infer<typeof structuredCardSchema>;

function llmConfig() {
  const parsed = configSchema.safeParse({ baseUrl: process.env.LLM_BASE_URL, apiKey: process.env.LLM_API_KEY, model: process.env.LLM_MODEL });
  return parsed.success ? parsed.data : null;
}

export async function generateStructured(prompt: string, schema = structuredCardSchema): Promise<StructuredCard | null> {
  const config = llmConfig();
  if (!config) return null;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` }, body: JSON.stringify({ model: config.model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: '只输出符合要求的 JSON，不要输出 Markdown。' }, { role: 'user', content: prompt }] }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new BusinessError(ErrorCodes.LLM_INVALID_RESPONSE);
    let value: unknown;
    try { value = JSON.parse(content); } catch { throw new BusinessError(ErrorCodes.LLM_INVALID_RESPONSE); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new BusinessError(ErrorCodes.LLM_INVALID_RESPONSE, { fields: parsed.error.issues.map((issue) => issue.path.join('.')) });
    return parsed.data as StructuredCard;
  } catch (error) {
    if (error instanceof BusinessError) throw error;
    if (error instanceof Error && error.name === 'AbortError') throw new BusinessError(ErrorCodes.LLM_TIMEOUT);
    throw new BusinessError(ErrorCodes.LLM_TIMEOUT);
  } finally { clearTimeout(timer); }
}
