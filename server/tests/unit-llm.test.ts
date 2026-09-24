import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { generateStructured } from '../src/generation/LlmClient.js';

test('LLM adapter validates structured JSON and normalizes endpoint', async (t) => {
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'valid', evidenceIds: [1], uncertainties: [] }) } }] })); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
  process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/`; process.env.LLM_API_KEY = 'test'; process.env.LLM_MODEL = 'test-model';
  t.after(() => { server.close(); if (previous.base === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = previous.base; if (previous.key === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previous.key; if (previous.model === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = previous.model; });
  const result = await generateStructured('return a card'); assert.deepEqual(result?.evidenceIds, [1]);
});

test('LLM adapter returns null when no model configuration exists', async () => {
  const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL }; delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
  try { assert.equal(await generateStructured('not sent'), null); } finally { if (previous.base !== undefined) process.env.LLM_BASE_URL = previous.base; if (previous.key !== undefined) process.env.LLM_API_KEY = previous.key; if (previous.model !== undefined) process.env.LLM_MODEL = previous.model; }
});
