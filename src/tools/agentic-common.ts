import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { ToolContext } from './types.js';
import { CURRENT_PROJECT } from './input-normalize.js';

/**
 * Shared contract for the agentic PCB tools: units (mm / degrees / layer names), the
 * expected-board guard, op_id idempotency, and structured failures.
 */

// ── units ──────────────────────────────────────────────────────────────────
const MM_PER_MIL = 0.0254;
export const mmToMil = (mm: number): number => Math.round((mm / MM_PER_MIL) * 1000) / 1000;
export const milToMm = (mil: number): number => Math.round(mil * MM_PER_MIL * 10000) / 10000;
export const optMilToMm = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? milToMm(v) : undefined;

export const pointMmSchema = z.object({ x: z.number(), y: z.number() });
export type PointMm = z.infer<typeof pointMmSchema>;
export const pointsToMil = (pts: PointMm[]) =>
  pts.map((p) => ({ x: mmToMil(p.x), y: mmToMil(p.y) }));

/** EasyEDA Pro PCB layer ids (verified against the live editor). */
export const LAYERS: Record<string, number> = {
  Top: 1,
  Bottom: 2,
  TopSilkscreen: 3,
  BottomSilkscreen: 4,
  TopSolderMask: 5,
  BottomSolderMask: 6,
  TopPasteMask: 7,
  BottomPasteMask: 8,
  TopAssembly: 9,
  BottomAssembly: 10,
  BoardOutline: 11,
  MultiLayer: 12,
  Document: 13,
  Mechanical: 14,
  Hole: 47,
  DrillDrawing: 56,
  Ratline: 57,
};
for (let i = 1; i <= 32; i++) LAYERS[`Inner${i}`] = 14 + i;
const LAYER_BY_ID = new Map(Object.entries(LAYERS).map(([name, id]) => [id, name]));

export class ToolFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Accepts "Top", "inner 1", "L2" (copper index: L1=Top, L2=Inner1 …, last=Bottom) or a numeric id. */
export function layerId(layer: string | number, copperLayers = 4): number {
  if (typeof layer === 'number') return layer;
  const key = layer.replace(/[\s_-]/g, '').toLowerCase();
  const l = /^l(\d+)$/.exec(key);
  if (l) {
    const n = Number(l[1]);
    if (n === 1) return LAYERS.Top!;
    if (n === copperLayers) return LAYERS.Bottom!;
    if (n > 1 && n < copperLayers) return LAYERS[`Inner${n - 1}`]!;
  }
  const hit = Object.entries(LAYERS).find(([name]) => name.toLowerCase() === key);
  if (!hit) {
    throw new ToolFailure(
      'INVALID_LAYER',
      `Unknown layer "${layer}".`,
      `Use one of ${Object.keys(LAYERS).slice(0, 16).join(', ')} … or Inner1..Inner32.`,
    );
  }
  return hit[1];
}
export const layerName = (id: unknown): string | undefined =>
  typeof id === 'number' ? (LAYER_BY_ID.get(id) ?? `Layer${id}`) : undefined;

// ── guard + idempotency ────────────────────────────────────────────────────
export const boardGuardInput = {
  projectId: z
    .string()
    .min(1)
    .describe('Project uuid the write is meant for. The bridge refuses if another PCB is focused.'),
  boardName: z
    .string()
    .optional()
    .describe('Board name (e.g. "Transceiver_V2"); checked when given.'),
};
/** projectId "current" (the default when omitted) means no project check. */
const guardProject = (id?: string) => (id && id !== CURRENT_PROJECT ? id : undefined);
export const expectOf = (p: { projectId: string; boardName?: string }) => ({
  projectId: guardProject(p.projectId),
  boardName: p.boardName,
});

/** Optional form for legacy write tools: guard only when projectId is given. */
export const boardGuardOptInput = {
  projectId: boardGuardInput.projectId.optional(),
  boardName: boardGuardInput.boardName,
};
export const guardOf = (p: { projectId?: string; boardName?: string }) =>
  guardProject(p.projectId) || p.boardName
    ? { expect: expectOf({ projectId: p.projectId ?? '', boardName: p.boardName }) }
    : {};

export const opIdInput = {
  op_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Idempotency key: a repeat call with the same op_id returns the stored result (replayed: true).',
    ),
};

const opCache = new Map<string, unknown>();
function opFile(ctx: ToolContext) {
  return path.resolve(ctx.config.artifactDir, 'op-ids.json');
}
// ponytail: whole-file JSON store; fine for hundreds of ops, switch to append-log if it grows.
export async function withOpId<T extends Record<string, unknown>>(
  ctx: ToolContext,
  opId: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (!opId) return run();
  const file = opFile(ctx);
  if (!opCache.size && fs.existsSync(file)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf-8'))))
        opCache.set(k, v);
    } catch {
      /* corrupt store: start fresh */
    }
  }
  if (opCache.has(opId)) return { ...(opCache.get(opId) as T), replayed: true, op_id: opId };
  const result = await run();
  if ((result as { success?: boolean }).success !== false) {
    opCache.set(opId, result);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(Object.fromEntries(opCache)));
  }
  return { ...result, replayed: false, op_id: opId };
}
export const resetOpIdsForTests = () => opCache.clear();

// ── results ────────────────────────────────────────────────────────────────
export const writeMeta = {
  profile: 'full' as const,
  evidence: ['runtime-probe' as const],
  risk: 'high' as const,
  confirmWrite: true,
  version: '1.0.0',
  annotations: { readOnlyHint: false, destructiveHint: false },
};
export const readMeta = {
  profile: 'full' as const,
  evidence: ['runtime-probe' as const],
  risk: 'low' as const,
  confirmWrite: false,
  version: '1.0.0',
  annotations: { readOnlyHint: true, idempotentHint: true },
};
export const confirmWriteSchema = z
  .literal(true)
  .describe('Must be the literal boolean true (not the string "true") to allow this write.');
export const resultSchema = {
  success: z.boolean(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  hint: z.string().optional(),
  error_data: z.unknown().optional(),
  replayed: z.boolean().optional(),
  op_id: z.string().optional(),
};
export const verifySchema = {
  verified: z.boolean().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
};
export const pageInput = {
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
};
export const pageSchema = {
  total: z.number().int().nonnegative(),
  next_offset: z.number().int().nonnegative().optional(),
};
export function paginate<T>(items: T[], p: { limit: number; offset: number }) {
  const page = items.slice(p.offset, p.offset + p.limit);
  const next = p.offset + p.limit;
  return { items: page, total: items.length, next_offset: next < items.length ? next : undefined };
}

/** A write whose read-back disagrees is a failure, not a success with verified:false. */
export function writeResult<T extends Record<string, unknown>>(r: T) {
  if (r.verified !== false) return { ...r, success: true };
  return {
    ...r,
    success: false as const,
    error: 'The write did not read back as requested; EasyEDA ignored or altered it.',
    error_code: 'WRITE_NOT_VERIFIED',
    hint: 'Compare expected vs actual. Re-read the object before retrying.',
  };
}

/** Never a bare string: every failure carries error_code + hint. */
export function failure(err: unknown) {
  const e = err as {
    message?: string;
    code?: string;
    error_code?: string;
    suggestion?: string;
    hint?: string;
    data?: unknown;
  };
  return {
    success: false as const,
    error: e?.message ?? String(err),
    error_code: e?.code ?? e?.error_code ?? 'BRIDGE_ERROR',
    hint:
      e?.suggestion ??
      e?.hint ??
      'Check easyeda_bridge_status and that the expected PCB tab is focused.',
    error_data: e?.data,
  };
}

export function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
