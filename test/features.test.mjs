import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_FEATURES, FEATURE_IDS, normalizeFeatures } from '../lib/features.js';

test('feature ids include both shipped features', () => {
  assert.deepEqual(FEATURE_IDS, ['request-status', 'safe-restart']);
  assert.equal(DEFAULT_FEATURES['request-status'], true);
  assert.equal(DEFAULT_FEATURES['safe-restart'], true);
});

test('normalizeFeatures fills defaults and drops unknown/non-boolean values', () => {
  assert.deepEqual(normalizeFeatures(undefined), { 'request-status': true, 'safe-restart': true });
  assert.deepEqual(normalizeFeatures(null), { 'request-status': true, 'safe-restart': true });
  assert.deepEqual(normalizeFeatures({ 'request-status': false }), { 'request-status': false, 'safe-restart': true });
  assert.deepEqual(normalizeFeatures({ 'safe-restart': false, unknown: true }), { 'request-status': true, 'safe-restart': false });
  assert.deepEqual(normalizeFeatures({ 'safe-restart': 'no' }), { 'request-status': true, 'safe-restart': true });
  assert.deepEqual(normalizeFeatures([]), { 'request-status': true, 'safe-restart': true });
});
