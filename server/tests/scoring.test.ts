import assert from 'node:assert/strict';
import test from 'node:test';
import { scoreDiscovery } from '../src/domain/scoring.js';

test('relevance keeps unrelated records out of analyzed signals', () => {
  const result = scoreDiscovery({ title: 'Autumn music event', snippet: 'A regional concert', trustLevel: 1 });
  assert.ok(result.relevance < 35);
  assert.equal(result.evidenceLevel, 'single_source');
  assert.ok(scoreDiscovery({ title: 'Autumn music event', snippet: 'A regional concert', trustLevel: 5 }).relevance < 35);
  assert.ok(scoreDiscovery({ title: 'Introducing Claude for Teams', snippet: 'New release', trustLevel: 5 }).relevance >= 35);
  assert.ok(scoreDiscovery({ title: 'A new approach to alignment', snippet: 'Experimental results', sourceName: 'arXiv cs.AI', trustLevel: 4 }).relevance >= 35);
  assert.ok(scoreDiscovery({ title: 'A regional concert', snippet: 'Tickets on sale', sourceName: 'OpenAI', trustLevel: 5 }).relevance < 35);
});

test('official dated deployment earns explainable six-dimensional score', () => {
  const official = scoreDiscovery({ title: 'AI agent launched in production', snippet: 'Customer case study: deployment and subscription revenue', trustLevel: 5, publishedAt: '2026-09-23T12:00:00.000Z' });
  const media = scoreDiscovery({ title: 'AI agent launched in production', snippet: 'Customer case study: deployment and subscription revenue', trustLevel: 3, publishedAt: '2026-09-23T12:00:00.000Z' });
  assert.equal(official.type, 'use_case');
  assert.equal(official.evidenceLevel, 'first_party');
  assert.equal(official.scores.truth, 70);
  assert.ok(official.value >= 55 && official.value <= 100);
  assert.ok(official.value > media.value);
  assert.deepEqual(official.explanation.matched, ['release', 'deployment', 'commercial', 'dated', 'official_source']);
  assert.equal(official.explanation.rulesVersion, 'v1');
});
