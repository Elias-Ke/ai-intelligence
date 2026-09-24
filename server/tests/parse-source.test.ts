import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSource } from '../src/ingestion/parseSource.js';

test('RSS yields article links, not the channel home page', () => {
  const entries = parseSource('<rss><channel><title>Home</title><item><title>Concrete AI model release</title><link>https://example.org/article-1</link><description>Model details</description><pubDate>Wed, 23 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>', 'https://example.org/feed', 'rss', 'application/rss+xml');
  assert.deepEqual(entries.map((entry) => entry.url), ['https://example.org/article-1']);
  assert.equal(entries[0].publishedAt, '2026-09-23T12:00:00.000Z');
});

test('HTML uses article anchors and does not infer publication time from fetch time', () => {
  const entries = parseSource('<html><head><title>Home</title></head><main><article><h2><a href="/news/new-ai-agent">New AI agent workflow</a></h2><p>A real workflow case</p></article><nav><a href="/about">About</a></nav></main></html>', 'https://example.org/news', 'web', 'text/html');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, 'https://example.org/news/new-ai-agent');
  assert.equal(entries[0].publishedAt, null);
});

test('repository search uses the public HTML link instead of the API resource', () => {
  const entries = parseSource(JSON.stringify({ items: [{ full_name: 'example/ai-agents', html_url: 'https://github.com/example/ai-agents', url: 'https://api.github.com/repos/example/ai-agents', description: 'Open-source AI agent', updated_at: '2026-09-23T12:00:00Z' }] }), 'https://api.github.com/search/repositories?q=ai', 'api', 'application/json');
  assert.equal(entries[0].url, 'https://github.com/example/ai-agents');
  assert.equal(entries[0].title, 'example/ai-agents');
  assert.equal(entries[0].publishedAt, null);
});

test('HTML listing without article elements still yields article links', () => {
  const entries = parseSource('<main><ul><li><a href="/research/ai-agents">AI agents in practice</a></li></ul></main>', 'https://example.org/research', 'web', 'text/html');
  assert.deepEqual(entries.map((entry) => entry.url), ['https://example.org/research/ai-agents']);
});
