import * as cheerio from 'cheerio';

export function extractArticle(body: string, contentType: string) {
  if (!/html|xhtml/i.test(contentType)) return { content: '', publishedAt: null as string | null };
  const $ = cheerio.load(body);
  $('script,style,nav,footer,header,aside').remove();
  const text = ($('article').first().text() || $('main').first().text() || $('body').text()).replace(/\s+/g, ' ').trim().slice(0, 50_000);
  const rawDate = $('meta[property="article:published_time"],meta[name="datePublished"],meta[name="date"]').first().attr('content') || $('time[datetime]').first().attr('datetime');
  const value = rawDate && new Date(rawDate);
  return { content: text, publishedAt: value && Number.isFinite(value.valueOf()) && value <= new Date() ? value.toISOString() : null };
}
