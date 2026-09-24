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
