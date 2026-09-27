import { z } from 'zod';
import type { ToolContext } from './types.js';

/** Input fragment: exactly one of primitiveId or reference (designator, e.g. "U2"). */
export const componentRefInput = {
  primitiveId: z.string().min(1).optional(),
  reference: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Designator such as U2 or R36 (case-insensitive). Alternative to primitiveId.'),
};
export const componentRefRefine = [
  (v: { primitiveId?: string; reference?: string }) => !!v.primitiveId !== !!v.reference,
  { message: 'Provide exactly one of primitiveId or reference.' },
] as const;

export class ComponentRefError extends Error {
  constructor(
    readonly error_code: 'REF_NOT_FOUND' | 'REF_AMBIGUOUS',
    message: string,
    readonly hint: string,
  ) {
    super(message);
  }
}

/**
 * Resolve a designator to a primitiveId by listing components.
 * `bridgeMethod` is `schematic.listComponents` (field `reference`) or `pcb.listComponents` (field `designator`).
 */
export async function resolveComponentRef(
  ctx: ToolContext,
  doc: 'schematic' | 'pcb',
  ref: { primitiveId?: string; reference?: string },
): Promise<string> {
  if (ref.primitiveId) return ref.primitiveId;
  const reference = ref.reference ?? '';
  const method = doc === 'schematic' ? 'schematic.listComponents' : 'pcb.listComponents';
  const field = doc === 'schematic' ? 'reference' : 'designator';
  // ponytail: one full list per resolve; cache per call if this shows up in traces.
  const listed = await ctx.bridge.call<Record<string, unknown>, { items?: unknown[] }>(
    method,
    doc === 'schematic' ? { limit: 5000, offset: 0, allPages: false } : {},
  );
  const hits = (Array.isArray(listed?.items) ? listed.items : []).filter(
    (c): c is Record<string, unknown> =>
      !!c &&
      typeof c === 'object' &&
      String((c as Record<string, unknown>)[field] ?? '').toLowerCase() === reference.toLowerCase(),
  );
  if (hits.length === 0) {
    throw new ComponentRefError(
      'REF_NOT_FOUND',
      `No ${doc} component with designator "${reference}".`,
      `List designators with easyeda_${doc}_components.`,
    );
  }
  if (hits.length > 1) {
    throw new ComponentRefError(
      'REF_AMBIGUOUS',
      `Designator "${reference}" matches ${hits.length} ${doc} components.`,
      `Pass primitiveId instead: ${hits.map((h) => String(h.primitiveId)).join(', ')}.`,
    );
  }
  return String(hits[0]?.primitiveId ?? '');
}

/** Fields to spread into a failed result when resolution throws. */
export function componentRefErrorFields(err: unknown) {
  if (err instanceof ComponentRefError) {
    return { error_code: err.error_code, error: err.message, hint: err.hint };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}
