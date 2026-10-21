import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FEATURES, FEATURE_IDS, normalizeFeatures } from '../lib/features.js';

const DEFAULTS = { 'request-status': true, 'safe-restart': true, rewind: true, 'prompt-tuning': true, 'ask-model': true };

test('feature ids include every shipped feature', () => {
  assert.deepEqual(FEATURE_IDS, ['request-status', 'safe-restart', 'rewind', 'prompt-tuning', 'ask-model']);
  for (const id of FEATURE_IDS) assert.equal(DEFAULT_FEATURES[id], true);
});

test('normalizeFeatures fills defaults and drops unknown/non-boolean values', () => {
  assert.deepEqual(normalizeFeatures(undefined), DEFAULTS);
  assert.deepEqual(normalizeFeatures(null), DEFAULTS);
  assert.deepEqual(normalizeFeatures({ 'request-status': false }), { ...DEFAULTS, 'request-status': false });
  assert.deepEqual(normalizeFeatures({ 'safe-restart': false, unknown: true }), { ...DEFAULTS, 'safe-restart': false });
  assert.deepEqual(normalizeFeatures({ rewind: false }), { ...DEFAULTS, rewind: false });
  assert.deepEqual(normalizeFeatures({ 'prompt-tuning': false }), { ...DEFAULTS, 'prompt-tuning': false });
  assert.deepEqual(normalizeFeatures({ 'ask-model': false }), { ...DEFAULTS, 'ask-model': false });
  assert.deepEqual(normalizeFeatures({ 'safe-restart': 'no' }), DEFAULTS);
  assert.deepEqual(normalizeFeatures([]), DEFAULTS);
});
