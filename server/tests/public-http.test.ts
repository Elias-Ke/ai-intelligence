import assert from 'node:assert/strict';
import test from 'node:test';
import { publicUrl, fetchPublic, SourceFetchError } from '../src/ingestion/publicHttp.js';

for (const address of ['127.0.0.1', '10.1.1.2', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '[::1]', '[::ffff:127.0.0.1]', '[fc00::1]', 'localhost', 'dev.localhost', 'metadata.google.internal']) {
  test(`rejects local or private source address ${address}`, () => {
    assert.throws(() => publicUrl(`http://${address}/feed`), { code: 800005 });
  });
}

for (const address of ['file:///etc/passwd', 'ftp://example.org/feed', 'http://user:password@example.org/feed', 'relative/path']) {
  test(`rejects non-public URL ${address}`, () => {
    assert.throws(() => publicUrl(address), { code: 800004 });
  });
}

test('allows public hostnames without application DNS preflight', () => {
  assert.equal(publicUrl('https://example.org/feed').hostname, 'example.org');
});

test('fetches supported content through an injected client and follows redirects', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    if (calls.length === 1) return new Response(null, { status: 302, headers: { location: 'https://example.org/feed.xml' } });
    return new Response('<rss><channel>ok</channel></rss>', { status: 200, headers: { 'content-type': 'application/rss+xml' } });
  };
  const result = await fetchPublic('https://example.org/feed', { fetchImpl });
  assert.equal(result.url, 'https://example.org/feed.xml');
  assert.match(result.text, /channel/);
  assert.deepEqual(calls, ['https://example.org/feed', 'https://example.org/feed.xml']);
});

test('classifies source failures without exposing the underlying error', async () => {
  const fetchImpl: typeof fetch = async () => { throw Object.assign(new Error('dns'), { code: 'ENOTFOUND' }); };
  await assert.rejects(fetchPublic('https://example.org/feed', { fetchImpl }), (error: unknown) => error instanceof SourceFetchError && error.reason === 'dns_failed' && error.code === 800007);
  await assert.rejects(fetchPublic('https://example.org/feed', { fetchImpl: async () => new Response('x', { status: 503 }) }), (error: unknown) => error instanceof SourceFetchError && error.reason === 'http_5xx' && error.httpStatus === 503);
  await assert.rejects(fetchPublic('https://example.org/feed', { fetchImpl: async () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }) }), (error: unknown) => error instanceof SourceFetchError && error.reason === 'invalid_content_type');
});

test('classifies timeout and response size failures', async () => {
  await assert.rejects(
    fetchPublic('https://example.org/feed', {
      timeoutMs: 1,
      fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
    }),
    (error: unknown) => error instanceof SourceFetchError && error.reason === 'timeout'
  );

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('0123456789'));
      controller.close();
    }
  });
  await assert.rejects(
    fetchPublic('https://example.org/feed', {
      maxBytes: 4,
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } })
    }),
    (error: unknown) => error instanceof SourceFetchError && error.reason === 'response_too_large'
  );
});

test('classifies undici timeout and TLS causes', async () => {
  for (const error of [
    Object.assign(new Error('connect timeout'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }),
    Object.assign(new Error('certificate'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })
  ]) {
    await assert.rejects(
      fetchPublic('https://example.org/feed', { fetchImpl: async () => { throw error; } }),
      (actual: unknown) => actual instanceof SourceFetchError && actual.reason === (error.cause.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout' : 'tls_failed')
    );
  }
});

test('rejects unsafe redirect targets', async () => {
  await assert.rejects(
    fetchPublic('https://example.org/feed', {
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
    }),
    { code: 800005 }
  );
});
