import * as cheerio from 'cheerio';
import { publicUrl } from './publicHttp.js';

export type SourceItem = { url: string; title: string; snippet: string; publishedAt: string | null };

function date(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.getTime() <= Date.now() ? parsed.toISOString() : null;
}

function item(base: string, href: string, title: string, snippet: string, publishedAt?: string): SourceItem | null {
  if (title.trim().length < 8 || !href) return null;
  try {
    const url = publicUrl(new URL(href, base).toString()).toString();
    if (url === base) return null;
    return { url, title: title.trim().slice(0, 500), snippet: snippet.trim().slice(0, 1000), publishedAt: date(publishedAt) };
  } catch { return null; }
}

export function parseSource(body: string, base: string, kind: 'rss' | 'api' | 'web', contentType: string): SourceItem[] {
  let entries: Array<SourceItem | null> = [];
  if (kind === 'api' || contentType.includes('json')) {
    const data: unknown = JSON.parse(body);
    const rows: unknown = Array.isArray(data) ? data : data && typeof data === 'object' ? (data as Record<string, unknown>).items ?? (data as Record<string, unknown>).results : null;
    if (!Array.isArray(rows)) return [];
    entries = rows.slice(0, 100).map((row) => {
      if (!row || typeof row !== 'object') return null;
      const record = row as Record<string, unknown>;
      return item(base, String(record.html_url ?? record.url ?? record.link ?? ''), String(record.title ?? record.full_name ?? ''), String(record.summary ?? record.description ?? ''), String(record.publishedAt ?? record.published_at ?? ''));
    });
  } else if (kind === 'rss' || /xml|rss|atom/.test(contentType)) {
    const $ = cheerio.load(body, { xml: true });
    entries = $('item, entry').slice(0, 100).map((_index, entry) => {
      const element = $(entry);
      return item(base, element.children('link').attr('href') ?? element.children('link').first().text(), element.children('title').first().text(), element.children('description, summary, content').first().text(), element.children('pubDate, published, updated').first().text());
    }).get();
  } else {
    const $ = cheerio.load(body);
    const anchors = $('article a[href], main h2 a[href], main h3 a[href]');
    entries = (anchors.length ? anchors : $('main a[href], [role=main] a[href], dl dt a[href]')).slice(0, 100).map((_index, anchor) => {
      const link = $(anchor);
      const container = link.closest('article');
      return item(base, link.attr('href') ?? '', link.text(), container.find('p').first().text(), container.find('time[datetime]').first().attr('datetime') ?? container.find('time').first().text());
    }).get();
  }
  return [...new Map(entries.filter((entry): entry is SourceItem => entry !== null).map((entry) => [entry.url, entry])).values()].slice(0, kind === 'rss' ? 100 : 40);
}
