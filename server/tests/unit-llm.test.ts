import assert from 'node:assert/strict';
import test from 'node:test';
import { generateStructured } from '../src/generation/LlmClient.js';

test('LLM adapter validates structured JSON and normalizes endpoint', async (t) => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), 'http://model.test/v1/chat/completions');
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'valid', evidenceIds: [1], uncertainties: [] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
  process.env.LLM_BASE_URL = 'http://model.test/'; process.env.LLM_API_KEY = 'test'; process.env.LLM_MODEL = 'test-model';
  t.after(() => { globalThis.fetch = previousFetch; if (previous.base === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = previous.base; if (previous.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previous.key; if (previous.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = previous.model; });
  const result = await generateStructured('return a card'); assert.deepEqual(result?.evidenceIds, [1]);
});

test('LLM adapter returns null when no model configuration exists', async () => {
  const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL }; delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
  try { assert.equal(await generateStructured('not sent'), null); } finally { if (previous.base !== undefined) process.env.LLM_BASE_URL = previous.base; if (previous.key !== undefined) process.env.LLM_API_KEY = previous.key; if (previous.model !== undefined) process.env.LLM_MODEL = previous.model; }
});
