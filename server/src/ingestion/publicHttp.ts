import { BlockList, isIP } from 'node:net';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';

export type SourceErrorReason = 'dns_failed' | 'timeout' | 'connection_failed' | 'tls_failed' | 'http_4xx' | 'http_5xx' | 'invalid_content_type' | 'response_too_large' | 'redirect_failed' | 'unknown';

export class SourceFetchError extends BusinessError {
  constructor(public readonly reason: SourceErrorReason, public readonly httpStatus?: number) {
    super(ErrorCodes.SOURCE_UNREACHABLE);
  }
}

const blocked = new BlockList();
for (const [range, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
] as const) blocked.addSubnet(range, prefix, 'ipv4');
for (const [range, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32]
] as const) blocked.addSubnet(range, prefix, 'ipv6');

export function publicUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new BusinessError(ErrorCodes.INVALID_SOURCE_URL); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw new BusinessError(ErrorCodes.INVALID_SOURCE_URL);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host) && blocked.check(host, isIP(host) === 4 ? 'ipv4' : 'ipv6'))) throw new BusinessError(ErrorCodes.UNSAFE_SOURCE_URL);
  url.hash = '';
  return url;
}

function errorReason(error: unknown): SourceErrorReason {
  const candidate = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  const code = candidate?.code ?? candidate?.cause?.code;
  if (candidate?.name === 'AbortError' || candidate?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failed';
  if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code?.startsWith('ERR_TLS')) return 'tls_failed';
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'connection_failed';
  return 'unknown';
}

export async function fetchPublic(input: string, options: { fetchImpl?: typeof fetch; maxBytes?: number; redirects?: number; timeoutMs?: number } = {}): Promise<{ url: string; text: string; contentType: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? 512_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  let url = publicUrl(input);
  for (let hops = 0; hops <= (options.redirects ?? 3); hops++) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': 'AI-Intelligence-Workbench/0.1',
          accept: 'text/html, application/xml, application/rss+xml, application/json'
        }
      });
    } catch (error) {
      throw new SourceFetchError(errorReason(error));
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || hops === (options.redirects ?? 3)) throw new SourceFetchError('redirect_failed', response.status);
      try {
        url = publicUrl(new URL(location, url).toString());
      } catch (error) {
        if (error instanceof BusinessError) throw error;
        throw new SourceFetchError('redirect_failed', response.status);
      }
      continue;
    }
    if (!response.ok) throw new SourceFetchError(response.status >= 500 ? 'http_5xx' : 'http_4xx', response.status);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/|application\/(xml|rss\+xml|atom\+xml|json|xhtml\+xml)/i.test(contentType)) throw new SourceFetchError('invalid_content_type', response.status);
    const reader = response.body?.getReader();
    if (!reader) return { url: url.toString(), text: '', contentType };
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new SourceFetchError('response_too_large', response.status); }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
    return { url: url.toString(), text, contentType };
  }
  throw new SourceFetchError('redirect_failed');
}
