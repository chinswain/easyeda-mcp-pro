import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { type ToolRegistry } from './registry.js';
import { componentRefInput, componentRefRefine, resolveComponentRef } from './component-ref.js';
import { fetchComponentPins } from './schematic-helpers.js';
import {
  boardGuardInput,
  confirmWriteSchema,
  expectOf,
  failure,
  layerId,
  layerName,
  milToMm,
  mmToMil,
  opIdInput,
  optMilToMm,
  pageInput,
  pageSchema,
  paginate,
  pointMmSchema,
  pointsToMil,
  readMeta,
  resultSchema,
  sha256File,
  ToolFailure,
  verifySchema,
  withOpId,
  writeResult,
  writeMeta,
  type PointMm,
} from './agentic-common.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const call = (ctx: ToolContext, method: string, params: Any = {}) =>
  ctx.bridge.call<Any, Any>(method, params);

/** Registers a write tool: board guard + op_id + confirmWrite + structured failure. */
function write(
  registry: ToolRegistry,
  spec: { name: string; title: string; description: string; group: string; input: z.ZodRawShape; output: z.ZodRawShape; run: (ctx: ToolContext, p: Any) => Promise<Any> },
) {
  registry.register({
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Units: mm from the board origin, degrees CCW, layer names ("Top", "Inner1", "Bottom"). Fails with WRONG_DOCUMENT unless the focused PCB matches projectId/boardName.`,
    ...writeMeta,
    group: spec.group,
    inputSchema: z.object({ ...boardGuardInput, ...opIdInput, ...spec.input, confirmWrite: confirmWriteSchema }),
    outputSchema: z.object({ ...resultSchema, ...verifySchema, ...spec.output }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { confirmWrite: _c, op_id, ...p } = params as Any;
      try {
        return await withOpId(ctx, op_id, async () => writeResult(await spec.run(ctx, p)));
      } catch (err) {
        return failure(err);
      }
    },
  });
}

function read(
  registry: ToolRegistry,
  spec: { name: string; title: string; description: string; group: string; input: z.ZodRawShape; output: z.ZodRawShape; run: (ctx: ToolContext, p: Any) => Promise<Any>; refine?: boolean },
) {
  const base = z.object({ ...boardGuardInput, ...spec.input });
  registry.register({
    name: spec.name,
    title: spec.title,
    description: `${spec.description} Units: mm, degrees CCW, layer names. Never returns an empty list for a failed read: check success/error_code.`,
    ...readMeta,
    group: spec.group,
    inputSchema: spec.refine ? base.refine(componentRefRefine[0] as (v: unknown) => boolean, componentRefRefine[1]) : base,
    outputSchema: z.object({ ...resultSchema, ...spec.output }),
    handler: async (ctx: ToolContext, params: unknown) => {
      try {
        return { success: true, ...(await spec.run(ctx, params as Any)) };
      } catch (err) {
        return failure(err);
      }
    },
  });
}

const componentMm = (c: Any) => ({
  primitiveId: c.primitiveId,
  designator: c.designator,
  found: c.found,
  layer: layerName(c.layer),
  x_mm: optMilToMm(c.x),
  y_mm: optMilToMm(c.y),
  rotation_deg: c.rotation,
  locked: c.locked,
  add_into_bom: c.addIntoBom,
  height_mm: c.heightMm,
  bbox_mm: c.bbox
    ? {
        min_x: milToMm(c.bbox.minX), min_y: milToMm(c.bbox.minY), max_x: milToMm(c.bbox.maxX), max_y: milToMm(c.bbox.maxY),
        width: milToMm(c.bbox.maxX - c.bbox.minX), height: milToMm(c.bbox.maxY - c.bbox.minY),
      }
    : undefined,
});
const componentSchema = z.object({
  primitiveId: z.string().optional(),
  designator: z.string().optional(),
  found: z.boolean().optional(),
  layer: z.string().optional(),
  x_mm: z.number().optional(),
  y_mm: z.number().optional(),
  rotation_deg: z.number().optional(),
  locked: z.boolean().optional(),
  add_into_bom: z.boolean().optional(),
  height_mm: z.number().optional(),
  bbox_mm: z.object({ min_x: z.number(), min_y: z.number(), max_x: z.number(), max_y: z.number(), width: z.number(), height: z.number() }).optional(),
});

// ── keepout registry (height rules are not native) ─────────────────────────
interface KeepoutRecord {
  primitiveId: string;
  name: string;
  projectId: string;
  layer: string;
  rules: string[];
  polygon_mm: PointMm[];
  max_height_mm?: number;
}
const keepoutFile = (ctx: ToolContext) => path.resolve(ctx.config.artifactDir, 'keepouts.json');
function readKeepouts(ctx: ToolContext): KeepoutRecord[] {
  try {
    return JSON.parse(fs.readFileSync(keepoutFile(ctx), 'utf-8'));
  } catch {
    return [];
  }
}
function writeKeepouts(ctx: ToolContext, list: KeepoutRecord[]) {
  fs.mkdirSync(path.dirname(keepoutFile(ctx)), { recursive: true });
  fs.writeFileSync(keepoutFile(ctx), JSON.stringify(list, null, 2));
}
const keepoutSchema = z.object({
  primitiveId: z.string(),
  name: z.string(),
  projectId: z.string(),
  layer: z.string(),
  rules: z.array(z.string()),
  polygon_mm: z.array(pointMmSchema),
  max_height_mm: z.number().optional(),
});

function pointInPoly(x: number, y: number, poly: PointMm[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function bboxTouchesPolygon(b: { min_x: number; min_y: number; max_x: number; max_y: number }, poly: PointMm[]): boolean {
  const corners = [
    [b.min_x, b.min_y], [b.max_x, b.min_y], [b.max_x, b.max_y], [b.min_x, b.max_y],
    [(b.min_x + b.max_x) / 2, (b.min_y + b.max_y) / 2],
  ];
  return (
    corners.some(([x, y]) => pointInPoly(x!, y!, poly)) ||
    poly.some((p) => p.x >= b.min_x && p.x <= b.max_x && p.y >= b.min_y && p.y <= b.max_y)
  );
}
const circlePolygon = (cx: number, cy: number, r: number, n = 32): PointMm[] =>
  Array.from({ length: n }, (_, i) => ({
    x: +(cx + r * Math.cos((2 * Math.PI * i) / n)).toFixed(4),
    y: +(cy + r * Math.sin((2 * Math.PI * i) / n)).toFixed(4),
  }));
const pathLength = (pts: PointMm[]) =>
  pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y) : 0), 0);

// ── manufacturing profiles (public capability pages) ──────────────────────
const MFG_PROFILES: Record<string, { copper_layers: number; min_track_mm: number; min_clearance_mm: number; min_via_hole_mm: number; min_via_diameter_mm: number; source: string }> = {
  'JLCPCB 4-layer': { copper_layers: 4, min_track_mm: 0.09, min_clearance_mm: 0.09, min_via_hole_mm: 0.15, min_via_diameter_mm: 0.25, source: 'https://jlcpcb.com/capabilities/pcb-capabilities' },
  'JLCPCB 2-layer': { copper_layers: 2, min_track_mm: 0.127, min_clearance_mm: 0.127, min_via_hole_mm: 0.3, min_via_diameter_mm: 0.5, source: 'https://jlcpcb.com/capabilities/pcb-capabilities' },
};

// ── artifact writer with checksum ──────────────────────────────────────────
function writeArtifact(ctx: ToolContext, data: unknown, requested: string | undefined, defaultName: string) {
  const bin = (data ?? {}) as { base64?: string; fileName?: string };
  if (!data || (typeof data === 'object' && !Object.keys(data).length)) {
    throw new ToolFailure('EXPORT_EMPTY', 'Bridge did not return export data.', 'Focus the PCB tab and retry; re-import the .eext if the extension is stale.');
  }
  const buffer = typeof bin.base64 === 'string' ? Buffer.from(bin.base64, 'base64') : Buffer.from(JSON.stringify(data, null, 2));
  const dir = path.resolve(ctx.config.artifactDir);
  const target = requested ? path.resolve(requested) : path.resolve(dir, bin.fileName || defaultName);
  const rel = path.relative(dir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ToolFailure('PATH_OUTSIDE_ARTIFACT_DIR', 'File path must be inside the artifact directory.', `Use a path under ${dir}.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { artifact_path: target, byte_length: buffer.byteLength, sha256: sha256File(target), buffer };
}
const artifactSchema = { artifact_path: z.string().optional(), byte_length: z.number().optional(), sha256: z.string().optional() };

// ponytail: minimal quoted-CSV splitter; enough for EasyEDA BOM exports.
function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === ',' && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function registerPcbAgenticTools(registry: ToolRegistry, _config: EnvConfig): void {
  // ── A. placement ─────────────────────────────────────────────────────────
  read(registry, {
    name: 'easyeda_pcb_component_bounds',
    title: 'PCB component bounds',
    description: 'Position, rotation, layer, height (from "Height Above Board") and bounding box of PCB components.',
    group: 'pcb-read',
    input: { primitiveIds: z.array(z.string()).optional(), references: z.array(z.string()).optional() },
    output: { items: z.array(componentSchema), ...pageSchema },
    run: async (ctx, p) => {
      const ids = [...(p.primitiveIds ?? [])];
      for (const reference of p.references ?? []) ids.push(await resolveComponentRef(ctx, 'pcb', { reference }));
      if (!ids.length) throw new ToolFailure('INVALID_PARAMS', 'Give primitiveIds or references.', 'List designators with easyeda_pcb_components.');
      const r = await call(ctx, 'pcb.componentBounds', { primitiveIds: ids, expect: expectOf(p) });
      const items = (r.items as Any[]).map(componentMm);
      return { items, total: items.length };
    },
  });

  write(registry, {
    name: 'easyeda_pcb_move_component',
    title: 'Move PCB component',
    description: 'Move/rotate/flip one component (by primitiveId or designator) and verify the read-back.',
    group: 'pcb-write',
    input: { ...componentRefInput, x_mm: z.number().optional(), y_mm: z.number().optional(), rotation_deg: z.number().optional(), layer: z.string().optional() },
    output: { primitiveId: z.string().optional(), designator: z.string().optional(), before: componentSchema.optional() },
    run: async (ctx, p) => {
      const primitiveId = await resolveComponentRef(ctx, 'pcb', p);
      const r = await call(ctx, 'pcb.moveComponent', {
        primitiveId,
        x: p.x_mm === undefined ? undefined : mmToMil(p.x_mm),
        y: p.y_mm === undefined ? undefined : mmToMil(p.y_mm),
        rotation: p.rotation_deg,
        layer: p.layer === undefined ? undefined : layerId(p.layer),
        expect: expectOf(p),
      });
      return { primitiveId, designator: r.designator, before: componentMm(r.before ?? {}), verified: r.verified, expected: r.expected, actual: r.actual };
    },
  });

  write(registry, {
    name: 'easyeda_pcb_move_group',
    title: 'Move PCB component group',
    description: 'Shift several components by the same delta, preserving their relative placement.',
    group: 'pcb-write',
    input: { primitiveIds: z.array(z.string()).optional(), references: z.array(z.string()).optional(), dx_mm: z.number(), dy_mm: z.number() },
    output: { items: z.array(z.unknown()).optional() },
    run: async (ctx, p) => {
      const ids = [...(p.primitiveIds ?? [])];
      for (const reference of p.references ?? []) ids.push(await resolveComponentRef(ctx, 'pcb', { reference }));
      const r = await call(ctx, 'pcb.moveGroup', { primitiveIds: ids, dx: mmToMil(p.dx_mm), dy: mmToMil(p.dy_mm), expect: expectOf(p) });
      return { items: r.items, verified: r.verified };
    },
  });

  write(registry, {
    name: 'easyeda_pcb_add_keepout',
    title: 'Add keep-out region',
    description:
      'Create a keep-out region as polygon, rect or ring (filled disc around a hole). max_height_mm is a server-side ' +
      'rule (EasyEDA has no height keep-outs): it is stored in the keepout registry and enforced by easyeda_pcb_check_placement.',
    group: 'pcb-write',
    input: {
      name: z.string().min(1),
      polygon_mm: z.array(pointMmSchema).min(3).optional(),
      rect_mm: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional(),
      ring_mm: z.object({ cx: z.number(), cy: z.number(), radius: z.number().positive() }).optional(),
      layer: z.string().default('MultiLayer'),
      rules: z.array(z.enum(['Copper', 'Wire', 'Via', 'Component'])).default(['Component']),
      max_height_mm: z.number().positive().optional().describe('When set, parts of any height are allowed but taller ones violate.'),
    },
    output: { keepout: keepoutSchema.optional(), signature: z.string().optional() },
    run: async (ctx, p) => {
      const polygon: PointMm[] | undefined = p.polygon_mm
        ?? (p.rect_mm && [{ x: p.rect_mm.x, y: p.rect_mm.y }, { x: p.rect_mm.x + p.rect_mm.width, y: p.rect_mm.y }, { x: p.rect_mm.x + p.rect_mm.width, y: p.rect_mm.y + p.rect_mm.height }, { x: p.rect_mm.x, y: p.rect_mm.y + p.rect_mm.height }])
        ?? (p.ring_mm && circlePolygon(p.ring_mm.cx, p.ring_mm.cy, p.ring_mm.radius));
      if (!polygon) throw new ToolFailure('INVALID_PARAMS', 'Give polygon_mm, rect_mm or ring_mm.', 'Coordinates are mm from the board origin.');
      // Height-limited zones must not block components natively; only forbid the native rules the caller asked for.
      const nativeRules = p.max_height_mm ? p.rules.filter((r: string) => r !== 'Component') : p.rules;
      const r = await call(ctx, 'pcb.addKeepout', { layer: layerId(p.layer), points: pointsToMil(polygon), rules: nativeRules, expect: expectOf(p) });
      const keepout: KeepoutRecord = { primitiveId: String(r.primitiveId), name: p.name, projectId: p.projectId, layer: p.layer, rules: p.rules, polygon_mm: polygon, max_height_mm: p.max_height_mm };
      writeKeepouts(ctx, [...readKeepouts(ctx).filter((k) => k.name !== p.name), keepout]);
      return { keepout, signature: r.signature, verified: r.verified, expected: r.expected, actual: r.actual };
    },
  });

  read(registry, {
    name: 'easyeda_pcb_list_keepouts',
    title: 'List keep-out regions',
    description: 'Keep-outs created through easyeda_pcb_add_keepout (with their height rules) plus native regions on the board.',
    group: 'pcb-read',
    input: { ...pageInput },
    output: { items: z.array(keepoutSchema), native_regions: z.unknown().optional(), ...pageSchema },
    run: async (ctx, p) => {
      const mine = readKeepouts(ctx).filter((k) => k.projectId === p.projectId);
      let native: unknown;
      try {
        native = await call(ctx, 'pcb.listRegions', { limit: p.limit, offset: p.offset, expect: expectOf(p) });
      } catch (err) {
        native = { not_available: true, error: (err as Error).message };
      }
      return { ...paginate(mine, p), native_regions: native };
    },
  });

  read(registry, {
    name: 'easyeda_pcb_check_placement',
    title: 'Check placement against keep-outs',
    description: 'Every component bbox is tested against the keep-out registry: forbidden zones and max_height_mm rules.',
    group: 'pcb-read',
    input: { ...pageInput },
    output: {
      items: z.array(z.object({ designator: z.string(), primitiveId: z.string(), keepout: z.string(), reason: z.enum(['component_forbidden', 'too_tall', 'height_unknown']), height_mm: z.number().optional(), max_height_mm: z.number().optional() })),
      components_checked: z.number(),
      ...pageSchema,
    },
    run: async (ctx, p) => {
      const keepouts = readKeepouts(ctx).filter((k) => k.projectId === p.projectId);
      const listed = await call(ctx, 'pcb.listComponents', { limit: 100000, expect: expectOf(p) });
      const ids = (listed.items as Any[]).map((c) => String(c.primitiveId)).filter(Boolean);
      const bounds = ids.length ? ((await call(ctx, 'pcb.componentBounds', { primitiveIds: ids })).items as Any[]).map(componentMm) : [];
      const items: Any[] = [];
      for (const c of bounds) {
        if (!c.bbox_mm) continue;
        for (const k of keepouts) {
          if (!bboxTouchesPolygon(c.bbox_mm, k.polygon_mm)) continue;
          const base = { designator: c.designator ?? '', primitiveId: c.primitiveId ?? '', keepout: k.name, height_mm: c.height_mm, max_height_mm: k.max_height_mm };
          if (k.max_height_mm === undefined) {
            if (k.rules.includes('Component')) items.push({ ...base, reason: 'component_forbidden' });
          } else if (c.height_mm === undefined) items.push({ ...base, reason: 'height_unknown' });
          else if (c.height_mm > k.max_height_mm) items.push({ ...base, reason: 'too_tall' });
        }
      }
      return { ...paginate(items, p), components_checked: bounds.length };
    },
  });

  // ── B. rules / nets ──────────────────────────────────────────────────────
  read(registry, {
    name: 'easyeda_pcb_get_design_rules',
    title: 'Get design rules',
    description: 'Current native rule configuration and net classes (native units; sizes are mil unless the key says otherwise).',
    group: 'pcb-read',
    input: {},
    output: { rules: z.unknown() },
    run: async (ctx, p) => ({ rules: await call(ctx, 'pcb.getDesignRules', { expect: expectOf(p) }) }),
  });

  write(registry, {
    name: 'easyeda_pcb_set_design_rules',
    title: 'Set design rules',
    description: 'Overwrite the native rule configuration (pass the object shape returned by easyeda_pcb_get_design_rules, edited).',
    group: 'pcb-write',
    input: { config: z.record(z.string(), z.unknown()) },
    output: {},
    run: async (ctx, p) => call(ctx, 'pcb.setDesignRules', { config: p.config, expect: expectOf(p) }),
  });

  write(registry, {
    name: 'easyeda_pcb_set_net_class',
    title: 'Set net class',
    description: 'Create/replace a net class with member nets; optional rules_native are applied per net via PCB_Drc.overwriteNetRules.',
    group: 'pcb-write',
    input: { name: z.string().min(1), nets: z.array(z.string().min(1)).min(1), rules_native: z.record(z.string(), z.unknown()).optional().describe('Keys as returned by easyeda_pcb_get_design_rules; values in native units.') },
    output: { replaced: z.boolean().optional(), net_rules: z.array(z.unknown()).optional() },
    run: async (ctx, p) => {
      const r = await call(ctx, 'pcb.setNetClass', { name: p.name, nets: p.nets, expect: expectOf(p) });
      const net_rules = p.rules_native ? await Promise.all(p.nets.map((netName: string) => call(ctx, 'pcb.setNetRules', { netName, rules: p.rules_native }))) : undefined;
      return { replaced: r.replaced, verified: r.verified && (net_rules?.every((n) => n.verified) ?? true), expected: r.expected, actual: r.actual, net_rules };
    },
  });

  write(registry, {
    name: 'easyeda_pcb_set_diff_pair',
    title: 'Set differential pair',
    description: 'Create/replace a differential pair; optional rules_native (e.g. impedance-derived width/gap) applied to both nets.',
    group: 'pcb-write',
    input: { name: z.string().min(1), positive_net: z.string().min(1), negative_net: z.string().min(1), rules_native: z.record(z.string(), z.unknown()).optional() },
    output: { replaced: z.boolean().optional(), net_rules: z.array(z.unknown()).optional() },
    run: async (ctx, p) => {
      const r = await call(ctx, 'pcb.setDiffPair', { name: p.name, positiveNet: p.positive_net, negativeNet: p.negative_net, expect: expectOf(p) });
      const net_rules = p.rules_native ? await Promise.all([p.positive_net, p.negative_net].map((netName) => call(ctx, 'pcb.setNetRules', { netName, rules: p.rules_native }))) : undefined;
      return { replaced: r.replaced, verified: r.verified && (net_rules?.every((n) => n.verified) ?? true), expected: r.expected, actual: r.actual, net_rules };
    },
  });

  read(registry, {
    name: 'easyeda_pcb_net_status',
    title: 'PCB net status',
    description: 'Pad/track/via counts and routed length of one net, with pad positions.',
    group: 'pcb-read',
    input: { net_name: z.string().min(1), ...pageInput },
    output: { found: z.boolean(), pad_count: z.number(), track_count: z.number(), via_count: z.number(), length_mm: z.number().optional(), items: z.array(z.unknown()), ...pageSchema },
    run: async (ctx, p) => {
      const r = await call(ctx, 'pcb.netStatus', { netName: p.net_name, expect: expectOf(p) });
      const pads = (r.pads as Any[]).map((pad) => ({ ...pad, x_mm: optMilToMm(pad.x), y_mm: optMilToMm(pad.y), x: undefined, y: undefined }));
      return { found: r.found, pad_count: r.padCount, track_count: r.trackCount, via_count: r.viaCount, length_mm: optMilToMm(r.length), ...paginate(pads, p) };
    },
  });

  write(registry, {
    name: 'easyeda_pcb_set_stackup',
    title: 'Set copper layer count',
    description: 'Set the number of copper layers (1, 2, 4, 6 or 8). Thickness/material editing is not exposed by the API.',
    group: 'pcb-write',
    input: { copper_layers: z.number().int() },
    output: {},
    run: async (ctx, p) => call(ctx, 'pcb.setStackup', { copperLayers: p.copper_layers, expect: expectOf(p) }),
  });

  // ── C. routing / copper ──────────────────────────────────────────────────
  const routeOut = { primitiveIds: z.array(z.string()).optional(), segments: z.number().optional(), length_mm: z.number().optional() };
  const routeNet = async (ctx: ToolContext, p: Any, netName: string, points: PointMm[]) => {
    const r = await call(ctx, 'pcb.routeNet', { netName, layer: layerId(p.layer), width: mmToMil(p.width_mm), points: pointsToMil(points), expect: expectOf(p) });
    return { primitiveIds: r.primitiveIds, segments: r.segments, length_mm: optMilToMm(r.length), verified: r.verified, expected: r.expected, actual: r.actual };
  };

  write(registry, {
    name: 'easyeda_pcb_route_net',
    title: 'Route net (explicit path)',
    description: 'Draw one polyline of copper segments for a net on one layer and verify every segment exists.',
    group: 'pcb-write',
    input: { net_name: z.string().min(1), layer: z.string(), width_mm: z.number().positive(), points_mm: z.array(pointMmSchema).min(2) },
    output: routeOut,
    run: (ctx, p) => routeNet(ctx, p, p.net_name, p.points_mm),
  });

  write(registry, {
    name: 'easyeda_pcb_route_diff_pair',
    title: 'Route differential pair',
    description: 'Route both nets of a pair with explicit paths; refuses before writing when the length skew exceeds max_skew_mm.',
    group: 'pcb-write',
    input: { positive_net: z.string().min(1), negative_net: z.string().min(1), layer: z.string(), width_mm: z.number().positive(), positive_points_mm: z.array(pointMmSchema).min(2), negative_points_mm: z.array(pointMmSchema).min(2), max_skew_mm: z.number().nonnegative().default(0.5) },
    output: { positive: z.unknown().optional(), negative: z.unknown().optional(), skew_mm: z.number().optional() },
    run: async (ctx, p) => {
      const skew_mm = +Math.abs(pathLength(p.positive_points_mm) - pathLength(p.negative_points_mm)).toFixed(4);
      if (skew_mm > p.max_skew_mm) throw new ToolFailure('SKEW_EXCEEDED', `Path skew ${skew_mm} mm exceeds ${p.max_skew_mm} mm.`, 'Lengthen the shorter path (serpentine) before routing.', { skew_mm });
      const positive = await routeNet(ctx, p, p.positive_net, p.positive_points_mm);
      const negative = await routeNet(ctx, p, p.negative_net, p.negative_points_mm);
      return { positive, negative, skew_mm, verified: positive.verified && negative.verified };
    },
  });

  write(registry, {
    name: 'easyeda_pcb_delete_tracks',
    title: 'Delete tracks',
    description: 'Delete track/arc/via primitives by id and verify they are gone.',
    group: 'pcb-write',
    input: { primitiveIds: z.array(z.string().min(1)).min(1) },
    output: { deleted: z.array(z.string()).optional(), notFound: z.array(z.string()).optional() },
    run: (ctx, p) => call(ctx, 'pcb.deleteTracks', { primitiveIds: p.primitiveIds, expect: expectOf(p) }),
  });

  write(registry, {
    name: 'easyeda_pcb_ripup_net',
    title: 'Rip up net',
    description: 'Delete all copper (lines, arcs, vias; pads/pours untouched) of one net.',
    group: 'pcb-write',
    input: { net_name: z.string().min(1) },
    output: { deleted: z.array(z.string()).optional(), remaining: z.number().optional() },
    run: (ctx, p) => call(ctx, 'pcb.ripupNet', { netName: p.net_name, expect: expectOf(p) }),
  });

  const viaOut = { primitiveIds: z.array(z.string()).optional(), points_mm: z.array(pointMmSchema).optional() };
  const viaResult = (r: Any) => ({ primitiveIds: r.primitiveIds, points_mm: (r.points as Any[] | undefined)?.map((q) => ({ x: milToMm(q.x), y: milToMm(q.y) })), verified: r.verified, expected: r.expected, actual: r.actual });

  write(registry, {
    name: 'easyeda_pcb_add_via_fence',
    title: 'Add via fence',
    description: 'Place vias along a path at a fixed pitch (ground fence / shielding).',
    group: 'pcb-write',
    input: { net_name: z.string().min(1), path_mm: z.array(pointMmSchema).min(2), pitch_mm: z.number().positive(), hole_mm: z.number().positive().default(0.3), diameter_mm: z.number().positive().default(0.6), max_vias: z.number().int().positive().default(500) },
    output: viaOut,
    run: async (ctx, p) => viaResult(await call(ctx, 'pcb.addVias', { mode: 'fence', netName: p.net_name, path: pointsToMil(p.path_mm), pitch: mmToMil(p.pitch_mm), holeSize: mmToMil(p.hole_mm), outerDiameter: mmToMil(p.diameter_mm), maxVias: p.max_vias, expect: expectOf(p) })),
  });

  write(registry, {
    name: 'easyeda_pcb_stitch_region',
    title: 'Stitch region with vias',
    description: 'Place a via grid inside a polygon (ground stitching), keeping margin_mm from the edge.',
    group: 'pcb-write',
    input: { net_name: z.string().min(1), polygon_mm: z.array(pointMmSchema).min(3), pitch_mm: z.number().positive(), margin_mm: z.number().nonnegative().default(0.5), hole_mm: z.number().positive().default(0.3), diameter_mm: z.number().positive().default(0.6), max_vias: z.number().int().positive().default(500) },
    output: viaOut,
    run: async (ctx, p) => viaResult(await call(ctx, 'pcb.addVias', { mode: 'stitch', netName: p.net_name, polygon: pointsToMil(p.polygon_mm), pitch: mmToMil(p.pitch_mm), margin: mmToMil(p.margin_mm), holeSize: mmToMil(p.hole_mm), outerDiameter: mmToMil(p.diameter_mm), maxVias: p.max_vias, expect: expectOf(p) })),
  });

  write(registry, {
    name: 'easyeda_pcb_add_copper_pour',
    title: 'Add copper pour',
    description: 'Create a copper pour (PCB_PrimitivePour) for a net on one layer from a polygon or rect. Rebuild is not exposed: run the native "Rebuild all copper" once afterwards.',
    group: 'pcb-write',
    input: { net_name: z.string().min(1), layer: z.string(), polygon_mm: z.array(pointMmSchema).min(3).optional(), rect_mm: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() }).optional() },
    output: { primitiveId: z.string().optional(), signature: z.string().optional(), rebuilt: z.unknown().optional() },
    run: async (ctx, p) => {
      const polygon: PointMm[] | undefined = p.polygon_mm ?? (p.rect_mm && [{ x: p.rect_mm.x, y: p.rect_mm.y }, { x: p.rect_mm.x + p.rect_mm.width, y: p.rect_mm.y }, { x: p.rect_mm.x + p.rect_mm.width, y: p.rect_mm.y + p.rect_mm.height }, { x: p.rect_mm.x, y: p.rect_mm.y + p.rect_mm.height }]);
      if (!polygon) throw new ToolFailure('INVALID_PARAMS', 'Give polygon_mm or rect_mm.', 'Coordinates are mm from the board origin.');
      return call(ctx, 'pcb.addCopperPour', { netName: p.net_name, layer: layerId(p.layer), points: pointsToMil(polygon), expect: expectOf(p) });
    },
  });

  read(registry, {
    name: 'easyeda_pcb_copper_islands',
    title: 'Copper islands',
    description: 'Poured copper areas that contain no pad of their net (islands). island="geometry_unknown" when the pour outline could not be read.',
    group: 'pcb-read',
    input: { net_name: z.string().optional(), ...pageInput },
    output: { items: z.array(z.unknown()), islands: z.number(), ...pageSchema },
    run: async (ctx, p) => {
      const r = await call(ctx, 'pcb.copperIslands', { netName: p.net_name, expect: expectOf(p) });
      return { ...paginate((r.items as Any[]).map((i) => ({ ...i, layer: layerName(i.layer) ?? i.layer })), p), islands: r.islands };
    },
  });

  // ── D. verification ──────────────────────────────────────────────────────
  read(registry, {
    name: 'easyeda_pcb_connectivity_check',
    title: 'Connectivity check',
    description: 'Per-net copper presence: "open" = pads but no copper, "single_pin", or "routed_or_partial" (EasyEDA exposes no unrouted-ratline count; use DRC for opens).',
    group: 'pcb-read',
    input: { only_open: z.boolean().default(true), ...pageInput },
    output: { items: z.array(z.unknown()), open_nets: z.array(z.string()), method: z.string().optional(), ...pageSchema },
    run: async (ctx, p) => {
      const r = await call(ctx, 'pcb.connectivityCheck', { expect: expectOf(p) });
      const items = (r.items as Any[]).filter((i) => !p.only_open || i.status === 'open').map((i) => ({ ...i, length_mm: optMilToMm(i.length), length: undefined }));
      return { ...paginate(items, p), open_nets: r.openNets, method: r.method };
    },
  });

  read(registry, {
    name: 'easyeda_pcb_manufacturing_check',
    title: 'Manufacturing check',
    description: 'Native DRC plus a fab capability table (track width, via hole/diameter, copper layer count). Profiles: ' + Object.keys(MFG_PROFILES).join(', ') + '.',
    group: 'pcb-read',
    input: { profile: z.string().optional().describe('Omit to pick the JLCPCB profile matching the board copper layer count.'), ...pageInput },
    output: {
      profile: z.string(), limits: z.unknown(), passed: z.boolean().nullable(),
      drc: z.object({ passed: z.boolean().nullable(), error_count: z.number().optional(), warning_count: z.number().optional(), total_violations: z.number().optional(), error: z.string().optional() }),
      items: z.array(z.object({ kind: z.string(), primitiveId: z.string().optional(), value_mm: z.number().optional(), limit_mm: z.number().optional(), message: z.string() })),
      copper_layers: z.number().nullable(), ...pageSchema,
    },
    run: async (ctx, p) => {
      let copper_layers: number | null = null;
      try {
        const s = await call(ctx, 'board.getStackup', { projectId: p.projectId });
        copper_layers = s.copperLayers ?? s.copper_layers ?? (Array.isArray(s.layers) ? s.layers.filter((l: Any) => /copper|signal|plane/i.test(String(l.type ?? ''))).length || null : null);
      } catch { /* stackup read is optional */ }
      const profile = p.profile ?? (copper_layers !== null && copper_layers <= 2 ? 'JLCPCB 2-layer' : 'JLCPCB 4-layer');
      const limits = MFG_PROFILES[profile];
      if (!limits) throw new ToolFailure('UNKNOWN_PROFILE', `Unknown profile "${profile}".`, `Use one of ${Object.keys(MFG_PROFILES).join(', ')}.`);
      const items: Any[] = [];
      const tracks = await call(ctx, 'pcb.listTracks', { limit: 100000, expect: expectOf(p) });
      for (const t of (tracks.items ?? []) as Any[]) {
        const w = optMilToMm(t.width);
        if (w !== undefined && w < limits.min_track_mm) items.push({ kind: 'track_width', primitiveId: t.primitiveId, value_mm: w, limit_mm: limits.min_track_mm, message: `Track ${t.primitiveId} width ${w} mm < ${limits.min_track_mm} mm` });
      }
      const vias = await call(ctx, 'pcb.listVias', { limit: 100000 });
      for (const v of (vias.items ?? []) as Any[]) {
        const hole = optMilToMm(v.holeDiameter), dia = optMilToMm(v.diameter);
        if (hole !== undefined && hole < limits.min_via_hole_mm) items.push({ kind: 'via_hole', primitiveId: v.primitiveId, value_mm: hole, limit_mm: limits.min_via_hole_mm, message: `Via ${v.primitiveId} hole ${hole} mm < ${limits.min_via_hole_mm} mm` });
        if (dia !== undefined && dia < limits.min_via_diameter_mm) items.push({ kind: 'via_diameter', primitiveId: v.primitiveId, value_mm: dia, limit_mm: limits.min_via_diameter_mm, message: `Via ${v.primitiveId} diameter ${dia} mm < ${limits.min_via_diameter_mm} mm` });
      }
      if (copper_layers !== null && copper_layers !== limits.copper_layers) items.push({ kind: 'copper_layers', value_mm: copper_layers, limit_mm: limits.copper_layers, message: `Board has ${copper_layers} copper layers, profile expects ${limits.copper_layers}` });
      let drc: Any;
      try {
        const d = await call(ctx, 'design.drc', { projectId: p.projectId });
        const violations = (d.violations ?? []) as Any[];
        const error_count = d.errorCount ?? violations.filter((v) => v.severity === 'error').length;
        drc = { passed: error_count === 0, error_count, warning_count: d.warningCount ?? violations.filter((v) => v.severity === 'warning').length, total_violations: d.totalViolations ?? violations.length };
      } catch (err) {
        drc = { passed: null, error: (err as Error).message };
      }
      return { profile, limits, drc, copper_layers, passed: drc.passed === null ? null : drc.passed && items.length === 0, ...paginate(items, p) };
    },
  });

  // ── E. export / attributes ───────────────────────────────────────────────
  write(registry, {
    name: 'easyeda_pcb_set_component_attribute',
    title: 'Set component attribute',
    description: 'Set AddIntoBom and/or custom properties on a PCB component. dnp=true sets Fitted=No and removes it from the BOM; exclude_from_bom=true keeps it in pick-and-place.',
    group: 'pcb-write',
    input: { ...componentRefInput, dnp: z.boolean().optional(), exclude_from_bom: z.boolean().optional(), properties: z.record(z.string(), z.string()).optional() },
    output: { primitiveId: z.string().optional(), designator: z.string().optional() },
    run: async (ctx, p) => {
      const primitiveId = await resolveComponentRef(ctx, 'pcb', p);
      const properties = { ...(p.properties ?? {}), ...(p.dnp === undefined ? {} : { Fitted: p.dnp ? 'No' : 'Yes', DNP: p.dnp ? 'Yes' : 'No' }) };
      const addIntoBom = p.dnp || p.exclude_from_bom ? false : p.dnp === false || p.exclude_from_bom === false ? true : undefined;
      const r = await call(ctx, 'pcb.setComponentAttribute', { primitiveId, addIntoBom, properties: Object.keys(properties).length ? properties : undefined, expect: expectOf(p) });
      return { primitiveId, designator: r.designator, verified: r.verified, expected: r.expected, actual: r.actual };
    },
  });

  const exportTool = (name: string, title: string, description: string, method: string, defaultName: string, extra: Any = {}) =>
    read(registry, {
      name, title, description, group: 'export',
      input: { filePath: z.string().optional() },
      output: { ...artifactSchema, exported: z.boolean(), note: z.string().optional() },
      run: async (ctx, p) => {
        const { buffer: _b, ...w } = writeArtifact(ctx, await call(ctx, method, { projectId: p.projectId, ...extra }), p.filePath, defaultName);
        return { exported: true, ...w, note: extra.note };
      },
    });
  exportTool('easyeda_export_drill', 'Export drill files', 'Excellon drill files. EasyEDA emits them inside the Gerber zip (board.exportGerbers); the zip is written with its sha256.', 'board.exportGerbers', 'gerbers-with-drill.zip', { drillFormat: 'excellon', note: 'Drill files are inside the Gerber zip.' });
  exportTool('easyeda_export_step', 'Export STEP model', '3D STEP export of the board via PCB_ManufactureData.get3DFile, written with its sha256.', 'export.step', 'board.step');

  read(registry, {
    name: 'easyeda_export_bom',
    title: 'Export BOM (honours DNP)',
    description: 'Native BOM (AddIntoBom=false parts already excluded) with rows whose Fitted=No / DNP=Yes column removed; optionally confirms designators are absent.',
    group: 'export',
    input: { filePath: z.string().optional(), expect_absent: z.array(z.string()).default([]) },
    output: { ...artifactSchema, exported: z.boolean(), entry_count: z.number().optional(), dnp_excluded: z.number().optional(), unexpected_present: z.array(z.string()).optional(), absent_ok: z.boolean().optional() },
    run: async (ctx, p) => {
      const raw = writeArtifact(ctx, await call(ctx, 'export.bom', { projectId: p.projectId }), p.filePath, 'bom.csv');
      const lines = raw.buffer.toString('utf-8').split(/\r?\n/).filter((l) => l.trim());
      const header = csvSplit(lines[0] ?? '').map((h) => h.toLowerCase());
      const col = (names: string[]) => header.findIndex((h) => names.includes(h));
      const fitted = col(['fitted']), dnp = col(['dnp']), des = col(['designator', 'reference', 'refdes']);
      const kept = lines.slice(1).filter((l) => {
        const c = csvSplit(l);
        return !(fitted >= 0 && /^no$/i.test(c[fitted] ?? '')) && !(dnp >= 0 && /^(yes|true|1)$/i.test(c[dnp] ?? ''));
      });
      fs.writeFileSync(raw.artifact_path, [lines[0], ...kept].join('\n'));
      const designators = new Set(kept.flatMap((l) => (des >= 0 ? (csvSplit(l)[des] ?? '').split(/[\s,;]+/) : [])).map((d) => d.toUpperCase()));
      const unexpected_present = p.expect_absent.filter((d: string) => designators.has(d.toUpperCase()));
      return { exported: true, artifact_path: raw.artifact_path, byte_length: fs.statSync(raw.artifact_path).size, sha256: sha256File(raw.artifact_path), entry_count: kept.length, dnp_excluded: lines.length - 1 - kept.length, unexpected_present, absent_ok: unexpected_present.length === 0 };
    },
  });

  registry.register({
    name: 'easyeda_project_export_epro',
    title: 'Export .epro project (unavailable)',
    description: 'The EasyEDA Pro extension API exposes no project-archive export; this tool fails closed with the manual path.',
    ...readMeta,
    group: 'export',
    inputSchema: z.object({ projectId: z.string().min(1) }),
    outputSchema: z.object({ ...resultSchema, not_available: z.boolean() }),
    handler: async () => ({ success: false, not_available: true, error_code: 'NOT_SUPPORTED', error: 'No API for .epro export.', hint: 'Use File > Export > EasyEDA Pro project in the editor; easyeda_project_save persists the design first.' }),
  });

  // ── F. schematic ─────────────────────────────────────────────────────────
  const schematicGuard = { projectId: z.string().min(1) };
  read(registry, {
    name: 'easyeda_schematic_wires_at_pin',
    title: 'Wires touching a pin',
    description: 'Wires whose endpoints touch a component pin (reference + pin_number) or an explicit x/y (native schematic units).',
    group: 'schematic',
    input: { reference: z.string().optional(), pin_number: z.string().optional(), x: z.number().optional(), y: z.number().optional(), tolerance: z.number().positive().default(1) },
    output: { items: z.array(z.unknown()), pin: z.unknown().optional(), ...pageSchema },
    run: async (ctx, p) => {
      let { x, y } = p, pin: Any | undefined;
      if (p.reference) {
        const id = await resolveComponentRef(ctx, 'schematic', { reference: p.reference });
        pin = (await fetchComponentPins(ctx, id)).find((q) => q.pinNumber === String(p.pin_number));
        if (!pin) throw new ToolFailure('PIN_NOT_FOUND', `Pin ${p.pin_number} not found on ${p.reference}.`, 'List pins with easyeda_schematic_component_pins.');
        x = pin.x; y = pin.y;
      }
      if (typeof x !== 'number' || typeof y !== 'number') throw new ToolFailure('INVALID_PARAMS', 'Give reference+pin_number or x+y.', undefined);
      const r = await call(ctx, 'schematic.wiresAtPin', { x, y, tolerance: p.tolerance });
      return { items: r.items, total: (r.items as unknown[]).length, pin };
    },
  });
  void schematicGuard;

  const schematicWrite = (name: string, title: string, description: string, method: string, input: z.ZodRawShape, output: z.ZodRawShape, map: (p: Any) => Any = (p) => p) =>
    registry.register({
      name, title, description,
      ...writeMeta,
      group: 'schematic-write',
      inputSchema: z.object({ ...opIdInput, ...input, confirmWrite: confirmWriteSchema }),
      outputSchema: z.object({ ...resultSchema, ...verifySchema, ...output }),
      handler: async (ctx: ToolContext, params: unknown) => {
        const { confirmWrite: _c, op_id, ...p } = params as Any;
        try {
          return await withOpId(ctx, op_id, async () => writeResult(await call(ctx, method, map(p))));
        } catch (err) {
          return failure(err);
        }
      },
    });
  schematicWrite('easyeda_schematic_delete_wire', 'Delete schematic wires', 'Delete wires by primitiveId and verify they are gone.', 'schematic.deleteWire', { primitiveIds: z.array(z.string().min(1)).min(1) }, { deleted: z.array(z.string()).optional() });
  schematicWrite('easyeda_schematic_rename_net', 'Rename net', 'Rename every net label/flag carrying `from` to `to` and verify.', 'schematic.renameNet', { from: z.string().min(1), to: z.string().min(1) }, { labelIds: z.array(z.string()).optional() });
  schematicWrite('easyeda_schematic_set_net_label', 'Place net label', 'Create a net label at x/y (native schematic units) and verify its text.', 'schematic.setNetLabel', { net_name: z.string().min(1), x: z.number(), y: z.number(), rotation: z.number().default(0) }, { primitiveId: z.string().optional() }, (p) => ({ netName: p.net_name, x: p.x, y: p.y, rotation: p.rotation }));
  schematicWrite('easyeda_schematic_component_replace', 'Replace component device', 'Swap the device/footprint of a schematic component (property keys as SCH_PrimitiveComponent.modify accepts, e.g. deviceUuid, footprintUuid) and verify.', 'schematic.componentReplace', { primitiveId: z.string().min(1), property: z.record(z.string(), z.unknown()) }, { primitiveId: z.string().optional() });
}
