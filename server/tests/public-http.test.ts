import assert from 'node:assert/strict';
import test from 'node:test';
import { publicUrl, fetchPublic } from '../src/ingestion/publicHttp.js';

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

test('rejects a public hostname resolving to a private or mixed private address', async () => {
  await assert.rejects(fetchPublic('https://example.org/feed', { resolve: async () => [{ address: '127.0.0.1', family: 4 }] }), { code: 800005 });
  await assert.rejects(fetchPublic('https://example.org/feed', { resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] }), { code: 800005 });
  await assert.rejects(fetchPublic('https://example.org/feed', { resolve: async () => [] }), { code: 800007 });
});
