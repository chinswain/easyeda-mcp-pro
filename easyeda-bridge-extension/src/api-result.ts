import { normalizeValue } from './api-introspection.js';
import type { JsonValue } from './utils.js';

// Copper polygons and native DRC trees exceed the former five-level limit.
const RESULT_DEPTH = 20;

function containsOmission(value: JsonValue | undefined): boolean {
  if (typeof value === 'string') {
    return value === '[MaxDepth]' || value === '[Circular]' || value.startsWith('ERROR: ');
  }
  if (value && typeof value === 'object') return Object.values(value).some(containsOmission);
  return false;
}

export function normalizeApiResult(value: unknown) {
  const result = normalizeValue(value, RESULT_DEPTH);
  return {
    result,
    serialization: { maxDepth: RESULT_DEPTH, incomplete: containsOmission(result) },
  };
}
