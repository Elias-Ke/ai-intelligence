import { z } from 'zod';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';

const resultSchema = z.object({ title: z.string(), url: z.string().url(), snippet: z.string().optional(), content: z.string().optional(), publishedAt: z.string().optional(), published_at: z.string().optional() });
const searchSchema = z.object({ code: z.literal(0), request_id: z.string(), data: z.object({ results: z.array(resultSchema).max(10) }) });
export type SearchResult = z.infer<typeof resultSchema>;

export class AnySearchClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async search(query: { queryText: string; zone: 'cn' | 'intl'; language: 'zh-CN' | 'en' }) {
    for (let attempt = 0; attempt < 2; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/v1/search`, {
          method: 'POST', signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ query: query.queryText, max_results: 10, zone: query.zone, language: query.language })
        });
      } catch { throw new BusinessError(ErrorCodes.SEARCH_UNAVAILABLE); }
      if (response.status === 402) throw new BusinessError(ErrorCodes.SEARCH_QUOTA_EXHAUSTED);
      if (response.status === 429) {
        if (attempt === 0) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
        throw new BusinessError(ErrorCodes.SEARCH_RATE_LIMITED);
      }
      if (!response.ok) throw new BusinessError(ErrorCodes.SEARCH_UNAVAILABLE);
      try {
        const parsed = searchSchema.parse(await response.json());
        return { requestId: parsed.request_id, results: parsed.data.results };
      } catch { throw new BusinessError(ErrorCodes.SEARCH_UNAVAILABLE); }
    }
    throw new BusinessError(ErrorCodes.SEARCH_RATE_LIMITED);
  }
}
