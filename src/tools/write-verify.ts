import { z } from 'zod';

/**
 * Read-after-write verification for EasyEDA property-bag writes.
 *
 * EasyEDA's `*.modify(primitiveId, property)` silently drops property keys it
 * does not recognise: a wrong-case key (`SupplierId` instead of `supplierId`)
 * or an invented one (`Component`) resolves successfully and changes nothing.
 * The returned primitive still carries the old values, so the call looks like a
 * success at every layer above it. Reading the primitive back and comparing the
 * requested keys against the stored values is the only way to tell an applied
 * write from an ignored one.
 *
 * Call sites fail a write when — and only when — `unapplied` is non-empty. A
 * missing read-back sets `unverifiable_reason` and leaves `unapplied` empty, so
 * an unobservable write is never reported as a failed one.
 */

export interface PropertyWriteMismatch {
  key: string;
  requested: unknown;
  before?: unknown;
  after?: unknown;
}

export interface WriteVerification {
  /** True only when every requested key was observed in the read-back. */
  verified: boolean;
  /** Set when no before/after read-back was possible. `verified` is then not evidence either way. */
  unverifiable_reason?: string;
  applied_keys: string[];
  /**
   * Requested keys the runtime accepted but stored differently — grid snap,
   * rounding, string coercion. The stored value changed, so the write landed.
   * Reported for visibility, never fatal.
   */
  normalized: PropertyWriteMismatch[];
  /**
   * Requested keys the runtime ignored: the read-back still holds the pre-write
   * value, or the key is absent from the read-back vocabulary entirely. Fatal.
   */
  unapplied: PropertyWriteMismatch[];
}

const propertyWriteMismatchSchema = z.object({
  key: z.string(),
  requested: z.unknown().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});

export const writeVerificationSchema = z.object({
  verified: z.boolean(),
  unverifiable_reason: z.string().optional(),
  applied_keys: z.array(z.string()),
  normalized: z.array(propertyWriteMismatchSchema),
  unapplied: z.array(propertyWriteMismatchSchema),
});

/** Placeholders `normalizeValue()` substitutes when it cannot read a field through. */
const UNREADABLE_VALUE = /^(\[MaxDepth\]|\[Circular\]|ERROR: )/;

function isUnreadable(value: unknown): boolean {
  return typeof value === 'string' && UNREADABLE_VALUE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * EasyEDA's `getState_*` read-back uses PascalCase keys (`SupplierId`) while
 * `modify()` takes camelCase (`supplierId`), and `schematic.getPrimitiveSnapshot`
 * uses camelCase throughout. Try the requested spelling first so a wrong-case
 * request is compared against the field it actually names.
 */
function readKey(bag: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
  const candidates = [
    key,
    key.charAt(0).toUpperCase() + key.slice(1),
    key.charAt(0).toLowerCase() + key.slice(1),
  ];
  for (const candidate of candidates) {
    if (Object.hasOwn(bag, candidate)) return { found: true, value: bag[candidate] };
  }
  return { found: false, value: undefined };
}

function matches(requested: unknown, actual: unknown): boolean {
  if (requested === null || requested === undefined) {
    return actual === null || actual === undefined;
  }
  if (Array.isArray(requested)) {
    return (
      Array.isArray(actual) &&
      requested.length === actual.length &&
      requested.every((item, index) => matches(item, actual[index]))
    );
  }
  if (isPlainObject(requested)) {
    // `otherProperty` merges into the existing bag rather than replacing it, so
    // a subset match is the correct test for every nested record.
    if (!isPlainObject(actual)) return false;
    return Object.entries(requested).every(([key, value]) =>
      matches(value, readKey(actual, key).value),
    );
  }
  // EasyEDA round-trips some scalars through strings ("1" for 1, "true" for true).
  return String(requested) === String(actual);
}

/**
 * Classify each requested property key against the primitive's state before and
 * after the write. Both read-backs are required for a verdict: without the
 * pre-write value a normalised store (grid snap) is indistinguishable from a
 * no-op, and guessing would fail writes that actually landed.
 */
export function verifyPropertyWrite(
  requested: Record<string, unknown>,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): WriteVerification {
  if (!before || !after) {
    return {
      verified: false,
      unverifiable_reason: before
        ? 'post-write read-back returned no state'
        : 'pre-write read-back returned no state',
      applied_keys: [],
      normalized: [],
      unapplied: [],
    };
  }

  const appliedKeys: string[] = [];
  const normalized: PropertyWriteMismatch[] = [];
  const unapplied: PropertyWriteMismatch[] = [];

  for (const [key, value] of Object.entries(requested)) {
    const stored = readKey(after, key);
    if (matches(value, stored.value)) {
      appliedKeys.push(key);
      continue;
    }
    const previous = readKey(before, key);
    const mismatch: PropertyWriteMismatch = {
      key,
      requested: value,
      before: previous.value,
      after: stored.value,
    };
    if (isUnreadable(stored.value) || isUnreadable(previous.value)) {
      // The read-back could not resolve this field — absence of evidence only.
      normalized.push(mismatch);
    } else if (stored.found && !matches(previous.value, stored.value)) {
      // Stored, just not verbatim: the runtime normalised the value.
      normalized.push(mismatch);
    } else {
      unapplied.push(mismatch);
    }
  }

  return {
    verified: unapplied.length === 0,
    applied_keys: appliedKeys,
    normalized,
    unapplied,
  };
}

/** Error message for a write whose read-back proved it changed nothing. */
export function unappliedWriteMessage(target: string, verification: WriteVerification): string {
  const keys = verification.unapplied.map((mismatch) => mismatch.key).join(', ');
  return (
    `${target} reported success but the read-back still shows the pre-write value for: ${keys}. ` +
    'EasyEDA silently ignores property keys it does not recognise — check spelling and case ' +
    'against the documented property bag (camelCase, e.g. supplierId, not SupplierId).'
  );
}
