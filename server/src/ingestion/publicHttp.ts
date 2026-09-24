import { lookup as systemLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { BusinessError, ErrorCodes } from '../domain/errorCodes.js';

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

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const resolveHost: Resolver = async (hostname) => systemLookup(hostname, { all: true, verbatim: true });

export async function fetchPublic(input: string, options: { resolve?: Resolver; maxBytes?: number; redirects?: number } = {}): Promise<{ url: string; text: string; contentType: string }> {
  const resolver = options.resolve ?? resolveHost;
  const maxBytes = options.maxBytes ?? 512_000;
  let url = publicUrl(input);
  for (let hops = 0; hops <= (options.redirects ?? 3); hops++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    let addresses: { address: string; family: number }[];
    try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolver(host); }
    catch { throw new BusinessError(ErrorCodes.SOURCE_UNREACHABLE); }
    if (!addresses.length) throw new BusinessError(ErrorCodes.SOURCE_UNREACHABLE);
    if (addresses.some(({ address, family }) => ![4, 6].includes(family) || !isIP(address) || blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'))) throw new BusinessError(ErrorCodes.UNSAFE_SOURCE_URL);
    const { address, family } = addresses[0];
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => callback(null, lookupOptions.all ? [{ address, family }] : address, family);
    const response = await new Promise<{ status: number; location?: string; contentType: string; text: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { lookup: pinnedLookup, timeout: 5_000, headers: { 'user-agent': 'AI-Intelligence-Workbench/0.1', accept: 'text/html, application/xml, application/rss+xml, application/json' } }, (stream) => {
        const status = stream.statusCode ?? 0;
        if (status >= 300 && status < 400) { stream.resume(); resolve({ status, location: stream.headers.location, contentType: '', text: '' }); return; }
        if (status < 200 || status >= 300) { stream.resume(); reject(new BusinessError(ErrorCodes.SOURCE_UNREACHABLE)); return; }
        const contentType = String(stream.headers['content-type'] ?? '');
        if (!/text\/|application\/(xml|rss\+xml|atom\+xml|json|xhtml\+xml)/i.test(contentType)) { stream.resume(); reject(new BusinessError(ErrorCodes.SOURCE_UNREACHABLE)); return; }
        const chunks: Buffer[] = []; let size = 0;
        stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { stream.destroy(); reject(new BusinessError(ErrorCodes.SOURCE_UNREACHABLE)); } else chunks.push(chunk); });
        stream.on('end', () => resolve({ status, contentType, text: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new BusinessError(ErrorCodes.SOURCE_UNREACHABLE)));
      request.on('error', reject);
      request.end();
    }).catch((error: unknown) => { if (error instanceof BusinessError) throw error; throw new BusinessError(ErrorCodes.SOURCE_UNREACHABLE); });
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new BusinessError(ErrorCodes.SOURCE_UNREACHABLE);
      url = publicUrl(new URL(response.location, url).toString());
      continue;
    }
    return { url: url.toString(), text: response.text, contentType: response.contentType };
  }
  throw new BusinessError(ErrorCodes.SOURCE_UNREACHABLE);
}
