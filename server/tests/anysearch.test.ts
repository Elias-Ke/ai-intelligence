import assert from 'node:assert/strict';
import test from 'node:test';
import { AnySearchClient } from '../src/ingestion/AnySearchClient.js';
import { buildSearchQueries, QUERY_VERSION } from '../src/ingestion/searchQueries.js';

test('query matrix has 80 distinct language and zone combinations', () => {
  const queries = buildSearchQueries();
  assert.equal(QUERY_VERSION, 'v1');
  assert.equal(queries.length, 80);
  assert.equal(new Set(queries.map(({ queryKey, zone, language }) => `${queryKey}:${zone}:${language}`)).size, 80);
  assert.equal(queries.filter((query) => query.zone === 'cn' && query.language === 'zh-CN').length, 40);
  assert.equal(queries.filter((query) => query.zone === 'intl' && query.language === 'en').length, 40);
});

test('AnySearch client reads official data envelope and request ID', async () => {
  const calls: RequestInit[] = [];
  const client = new AnySearchClient('https://api.anysearch.com/', 'test-key', async (_input, init) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify({ code: 0, request_id: 'search-id', data: { results: [{ title: 'Real article', url: 'https://example.org/article', snippet: 'summary' }] } }), { status: 200 });
  });
  const result = await client.search({ queryText: 'AI 教育', zone: 'cn', language: 'zh-CN' });
  assert.equal(result.requestId, 'search-id');
  assert.equal(result.results[0].url, 'https://example.org/article');
  assert.deepEqual(JSON.parse(String(calls[0].body)), { query: 'AI 教育', max_results: 10, zone: 'cn', language: 'zh-CN' });
});

test('402 quota response is never parsed or logged', async () => {
  const client = new AnySearchClient('https://api.anysearch.com', 'test-key', async () => new Response('username=x\npassword=secret\napi_key=secret', { status: 402 }));
  await assert.rejects(client.search({ queryText: 'AI', zone: 'intl', language: 'en' }), { code: 300005 });
});

test('invalid successful response is treated as unavailable', async () => {
  const client = new AnySearchClient('https://api.anysearch.com', 'test-key', async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  await assert.rejects(client.search({ queryText: 'AI', zone: 'intl', language: 'en' }), { code: 300007 });
});

test('429 is retried once before succeeding', async () => {
  let attempts = 0;
  const client = new AnySearchClient('https://api.anysearch.com', 'test-key', async () => {
    attempts += 1;
    if (attempts === 1) return new Response('rate limited', { status: 429 });
    return new Response(JSON.stringify({ code: 0, request_id: 'retry-id', data: { results: [] } }), { status: 200 });
  });
  const result = await client.search({ queryText: 'AI', zone: 'intl', language: 'en' });
  assert.equal(result.requestId, 'retry-id');
  assert.equal(attempts, 2);
});
