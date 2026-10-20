/**
 * dsh-toolset feature registry (Host side).
 *
 * Every feature is identified by a stable id; the Host persists one boolean per
 * id in `state.json` and the Client renders one switch per id in
 * Settings → Toolset. Adding a feature means adding it here (and, for any UI
 * it contributes, one entry in the Client's FEATURES list).
 */

/** Feature ids this version understands. Unknown ids are rejected on write. */
export const FEATURE_IDS = ['request-status', 'safe-restart', 'rewind', 'prompt-tuning'];

/** Every feature is on for a fresh installation. */
export const DEFAULT_FEATURES = {
  'request-status': true,
  'safe-restart': true,
  rewind: true,
  'prompt-tuning': true,
};

/** Human-facing host-side titles, used by the tool inventory only. */
export const FEATURE_LABELS = {
  'request-status': 'Request status',
  'safe-restart': 'Safe restart',
  rewind: 'Rewind to a message',
  'prompt-tuning': 'System prompt tuning',
};

/**
 * Normalize any stored/requested feature map to known, boolean-valued ids.
 * @param {unknown} value - raw feature map.
 * @returns {Record<string, boolean>} complete feature map with defaults filled.
 */
export function normalizeFeatures(value) {
  const input = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const features = { ...DEFAULT_FEATURES };
  for (const id of FEATURE_IDS) {
    if (typeof input[id] === 'boolean') features[id] = input[id];
  }
  return features;
}
