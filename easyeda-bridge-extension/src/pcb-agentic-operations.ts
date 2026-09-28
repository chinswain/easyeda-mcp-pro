/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import type { BinaryResultNormalizer } from './binary-result.js';

/**
 * Agentic PCB operations (Section 2/3): placement, rules, routing, copper,
 * verification, export and schematic edits. Everything speaks native units
 * (mil, degrees CCW, numeric layer ids); the server converts mm/layer names.
 * Every write reads back and returns `verified` with expected/actual.
 */
export interface PcbAgenticOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  readFirstPath: ApiRuntime['readFirstPath'];
  extractPrimitiveId(result: unknown): string;
  createBridgeError: BridgeErrorFactory;
  deletePrimitives(ids: string[]): Promise<{ deleted: string[]; notFound: string[] }>;
  normalizeBinaryResult: BinaryResultNormalizer;
}

type Params = Record<string, unknown>;
type Point = { x: number; y: number };

export interface PcbAgenticOperations {
  requireExpectedBoard(params: Params): Promise<void>;
  componentBounds(params: Params): Promise<unknown>;
  moveComponent(params: Params): Promise<unknown>;
  moveGroup(params: Params): Promise<unknown>;
  addKeepout(params: Params): Promise<unknown>;
  setNetClass(params: Params): Promise<unknown>;
  setDiffPair(params: Params): Promise<unknown>;
  netStatus(params: Params): Promise<unknown>;
  getDesignRules(): Promise<unknown>;
  setDesignRules(params: Params): Promise<unknown>;
  setNetRules(params: Params): Promise<unknown>;
  setStackup(params: Params): Promise<unknown>;
  routeNet(params: Params): Promise<unknown>;
  deleteTracks(params: Params): Promise<unknown>;
  ripupNet(params: Params): Promise<unknown>;
  addVias(params: Params): Promise<unknown>;
  addCopperPour(params: Params): Promise<unknown>;
  copperIslands(params: Params): Promise<unknown>;
  connectivityCheck(): Promise<unknown>;
  setComponentAttribute(params: Params): Promise<unknown>;
  exportBom(params: Params): Promise<unknown>;
  exportStep(params: Params): Promise<unknown>;
  schematicWiresAtPin(params: Params): Promise<unknown>;
  schematicDeleteWire(params: Params): Promise<unknown>;
  schematicSetNetLabel(params: Params): Promise<unknown>;
  schematicRenameNet(params: Params): Promise<unknown>;
  schematicComponentReplace(params: Params): Promise<unknown>;
}

/** Read `state.Key`, `getState_Key()` or lower-case `key` from a native wrapper. */
export function stateOf(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as any;
  const state = o.state;
  if (state && typeof state === 'object' && key in state) return state[key];
  const getter = o[`getState_${key}`];
  if (typeof getter === 'function') {
    try {
      return getter.call(o);
    } catch {
      /* fall through */
    }
  }
  const lower = key.charAt(0).toLowerCase() + key.slice(1);
  return o[key] ?? o[lower];
}

/**
 * Read-back comparison. A uuid written as a string reads back as {uuid, libraryUuid};
 * an object written reads back with extra keys. Both count as a match.
 */
export function matchesValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (!actual || typeof actual !== 'object') return false;
  const a = actual as Record<string, unknown>;
  if (expected && typeof expected === 'object') {
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => matchesValue(a[k], v));
  }
  return Object.values(a).some((v) => v === expected);
}

/** Ray-cast point-in-polygon; polygon as flat [x0,y0,x1,y1,...]. */
export function pointInPolygon(x: number, y: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[2 * i]!, yi = poly[2 * i + 1]!, xj = poly[2 * j]!, yj = poly[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Points along a polyline every `pitch`, including the start. */
export function samplePolyline(path: Point[], pitch: number): Point[] {
  const out: Point[] = [];
  let carry = 0;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const a = path[i]!, b = path[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    for (let d = carry; d <= len; d += pitch) {
      out.push({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
      carry = d + pitch - len;
    }
  }
  return out;
}

/** Grid points inside a polygon at `pitch`, inset by `margin` from the edges. */
export function gridInPolygon(poly: number[], pitch: number, margin = 0): Point[] {
  const xs = poly.filter((_, i) => i % 2 === 0), ys = poly.filter((_, i) => i % 2 === 1);
  const out: Point[] = [];
  for (let x = Math.min(...xs) + margin; x <= Math.max(...xs) - margin; x += pitch) {
    for (let y = Math.min(...ys) + margin; y <= Math.max(...ys) - margin; y += pitch) {
      if (pointInPolygon(x, y, poly)) out.push({ x, y });
    }
  }
  return out;
}

function flatPolygon(points: unknown): number[] {
  const flat = Array.isArray(points)
    ? points.flatMap((p: any) => (typeof p === 'number' ? [p] : [Number(p?.x), Number(p?.y)]))
    : [];
  if (flat.length < 6 || flat.length % 2 !== 0 || !flat.every(Number.isFinite)) {
    throw new TypeError('polygon needs at least three finite {x,y} points');
  }
  return flat;
}

const num = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const near = (a: unknown, b: unknown, tol = 0.01) =>
  typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= tol : a === b;

export function createPcbAgenticOperations({
  callFirst,
  readFirstPath,
  extractPrimitiveId,
  createBridgeError,
  deletePrimitives,
  normalizeBinaryResult,
}: PcbAgenticOperationDependencies): PcbAgenticOperations {
  const invalid = (message: string, hint: string) =>
    createBridgeError('INVALID_PARAMS', message, hint);

  // ── Section 3: active-document guard ──────────────────────────────────
  async function requireExpectedBoard(params: Params): Promise<void> {
    const expect = params.expect as { projectId?: string; boardName?: string } | undefined;
    if (!expect?.projectId && !expect?.boardName) return;
    const info = (await callFirst(['DMT_Pcb.getCurrentPcbInfo', 'dmt_Pcb.getCurrentPcbInfo'])) as any;
    if (!info?.uuid) {
      throw createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'No PCB document is focused.',
        'Activate the PCB tab (DMT_EditorControl.activateDocument("<docUuid>@<projectUuid>")) and retry.',
      );
    }
    const isBoard = (want: string) =>
      [info.name, info.parentBoardName].some((n) => String(n ?? '').toLowerCase() === want.toLowerCase());
    // Agents often pass the board name as projectId; accept it rather than fail WRONG_DOCUMENT.
    const projectOk =
      !expect.projectId || info.parentProjectUuid === expect.projectId || isBoard(expect.projectId);
    const boardOk = !expect.boardName || isBoard(expect.boardName);
    if (!projectOk || !boardOk) {
      throw createBridgeError(
        'WRONG_DOCUMENT',
        `Focused PCB is ${info.parentBoardName ?? info.name} (${info.parentProjectUuid}); expected ${expect.boardName ?? 'any board'} (${expect.projectId}).`,
        'Focus the expected board with easyeda_project_open / activateDocument, or pass the focused board’s projectId and boardName.',
        { actual: { projectId: info.parentProjectUuid, boardName: info.parentBoardName ?? info.name, pcbName: info.name } },
      );
    }
  }

  const getComponent = (id: string) =>
    callFirst(['PCB_PrimitiveComponent.get', 'pcb_PrimitiveComponent.get'], id);

  function componentState(c: unknown) {
    const other = (stateOf(c, 'OtherProperty') ?? {}) as Record<string, unknown>;
    const heightRaw = other['Height Above Board'] ?? other.Height;
    const height = parseFloat(String(heightRaw ?? ''));
    return {
      primitiveId: String(stateOf(c, 'PrimitiveId') ?? ''),
      designator: String(stateOf(c, 'Designator') ?? ''),
      layer: num(stateOf(c, 'Layer'), 1),
      x: num(stateOf(c, 'X')),
      y: num(stateOf(c, 'Y')),
      rotation: num(stateOf(c, 'Rotation')),
      locked: stateOf(c, 'PrimitiveLock') === true,
      addIntoBom: stateOf(c, 'AddIntoBom') !== false,
      // ponytail: property strings like "3mm"/"3" both parse; unit assumed mm.
      heightMm: Number.isFinite(height) ? height : undefined,
      otherProperty: other,
    };
  }

  // ── A. placement ──────────────────────────────────────────────────────
  async function componentBounds(params: Params): Promise<unknown> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    if (ids.length === 0) throw invalid('primitiveIds is required', 'Pass one or more component primitiveIds.');
    const items = [];
    for (const id of ids) {
      const c = await getComponent(id);
      if (!c) {
        items.push({ primitiveId: id, found: false });
        continue;
      }
      const bbox = (await callFirst(['PCB_Primitive.getPrimitivesBBox', 'pcb_Primitive.getPrimitivesBBox'], [id])) as any;
      items.push({ found: true, ...componentState(c), bbox: bbox ?? null });
    }
    return { items };
  }

  async function verifyComponent(id: string, expected: Partial<{ x: number; y: number; rotation: number; layer: number }>) {
    const actual = componentState(await getComponent(id));
    const keys = Object.keys(expected) as Array<keyof typeof expected>;
    const verified = keys.every((k) => near(expected[k], actual[k], k === 'rotation' ? 0.5 : 0.01));
    return { verified, expected, actual: { x: actual.x, y: actual.y, rotation: actual.rotation, layer: actual.layer } };
  }

  async function moveComponent(params: Params): Promise<unknown> {
    const id = String(params.primitiveId ?? '');
    if (!id) throw invalid('primitiveId is required', 'Resolve a designator with pcb.listComponents first.');
    const before = componentState(await getComponent(id));
    if (!before.primitiveId && !before.designator) {
      throw createBridgeError('NOT_FOUND', `Component ${id} not found`, 'List components with pcb.listComponents.');
    }
    const property: Record<string, number> = {};
    for (const k of ['x', 'y', 'rotation', 'layer'] as const) {
      if (typeof params[k] === 'number') property[k] = params[k] as number;
    }
    if (Object.keys(property).length === 0) throw invalid('nothing to change', 'Pass x, y, rotation and/or layer.');
    await callFirst(['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'], id, property);
    return { primitiveId: id, designator: before.designator, before: { x: before.x, y: before.y, rotation: before.rotation, layer: before.layer }, ...(await verifyComponent(id, property)) };
  }

  async function moveGroup(params: Params): Promise<unknown> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    const dx = num(params.dx), dy = num(params.dy);
    if (ids.length === 0) throw invalid('primitiveIds is required', 'Pass the group members.');
    const items = [];
    for (const id of ids) {
      const before = componentState(await getComponent(id));
      const target = { x: before.x + dx, y: before.y + dy };
      await callFirst(['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'], id, target);
      items.push({ primitiveId: id, designator: before.designator, ...(await verifyComponent(id, target)) });
    }
    return { items, verified: items.every((i) => i.verified) };
  }

  /** Try the native polygon object first, then a plain array. Reports which signature stuck. */
  async function createWithPolygon(
    label: string,
    poly: number[],
    build: (polygon: unknown) => Promise<unknown>,
  ): Promise<{ primitiveId: string; signature: string }> {
    // Native polygon source format: [x1, y1, 'L', x2, y2, x3, y3, ...]. Region/pour create() rejects
    // open polygons, so repeat the first point at the end.
    const n = poly.length;
    const closed = poly[n - 2] === poly[0] && poly[n - 1] === poly[1] ? poly : [...poly, poly[0], poly[1]];
    const source = [closed[0], closed[1], 'L', ...closed.slice(2)];
    const attempts: Array<[string, () => Promise<unknown>]> = [
      ['polygon-object', async () => {
        const polygon = await callFirst(['PCB_MathPolygon.createPolygon', 'pcb_MathPolygon.createPolygon'], source);
        if (!polygon) throw new Error('PCB_MathPolygon.createPolygon returned nothing');
        return build(polygon);
      }],
      ['plain-array', () => build(source)],
    ];
    const errors: string[] = [];
    for (const [signature, run] of attempts) {
      try {
        const id = extractPrimitiveId(await run());
        if (id) return { primitiveId: id, signature };
        errors.push(`${signature}: no primitiveId returned`);
      } catch (err) {
        errors.push(`${signature}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw createBridgeError(
      'EASYEDA_API_ERROR',
      `${label} creation failed for every known signature: ${errors.join(' | ')}`,
      'Draw the polygon in the EasyEDA UI, or report the runtime error text so the signature can be fixed.',
    );
  }

  async function addKeepout(params: Params): Promise<unknown> {
    const poly = flatPolygon(params.points);
    const layer = num(params.layer, 12);
    const rules = Array.isArray(params.rules) && params.rules.length ? params.rules : ['Copper', 'Wire', 'Via', 'Component'];
    // EPCB_PrimitiveRegionRuleType values (the enum is not exposed at runtime; create() rejects a missing rule list):
    // 2 no components, 3 no vias, 5 no wires, 6 no fills, 7 no pours.
    const ruleCodes: Record<string, number[]> = { Component: [2], Via: [3], Wire: [5], Copper: [6, 7] };
    const nativeRules = [...new Set((rules as string[]).flatMap((r) => ruleCodes[r] ?? []))];
    const created = await createWithPolygon('Keep-out region', poly, (polygon) =>
      callFirst(['PCB_PrimitiveRegion.create', 'pcb_PrimitiveRegion.create'], layer, polygon, nativeRules),
    );
    const readBack = await callFirst(['PCB_PrimitiveRegion.get', 'pcb_PrimitiveRegion.get'], created.primitiveId);
    return { ...created, layer, rules, points: poly, verified: !!readBack, actual: readBack ? { layer: stateOf(readBack, 'Layer') } : null };
  }

  // ── B. rules / nets ───────────────────────────────────────────────────
  async function setNetClass(params: Params): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const nets = Array.isArray(params.nets) ? (params.nets as string[]) : [];
    if (!name || nets.length === 0) throw invalid('name and nets[] are required', 'PCB_Drc.createNetClass needs the net list; a bare name does not persist.');
    const existing = ((await callFirst(['PCB_Drc.getAllNetClasses'])) as any[]) ?? [];
    const replaced = existing.some((c) => c?.name === name);
    if (replaced) await callFirst(['PCB_Drc.deleteNetClass'], name);
    await callFirst(['PCB_Drc.createNetClass'], name, nets);
    const after = (((await callFirst(['PCB_Drc.getAllNetClasses'])) as any[]) ?? []).find((c) => c?.name === name);
    const actualNets = Array.isArray(after?.nets) ? after.nets : [];
    const verified = !!after && nets.every((n) => actualNets.includes(n)) && actualNets.length === nets.length;
    return { name, replaced, verified, expected: { nets }, actual: after ? { nets: actualNets } : null };
  }

  async function setDiffPair(params: Params): Promise<unknown> {
    const name = String(params.name ?? '').trim();
    const positiveNet = String(params.positiveNet ?? ''), negativeNet = String(params.negativeNet ?? '');
    if (!name || !positiveNet || !negativeNet) throw invalid('name, positiveNet and negativeNet are required', 'Use net names from PCB_Net.getAllNets.');
    const existing = ((await callFirst(['PCB_Drc.getAllDifferentialPairs'])) as any[]) ?? [];
    const replaced = existing.some((p) => p?.name === name);
    if (replaced) await callFirst(['PCB_Drc.deleteDifferentialPair'], name);
    await callFirst(['PCB_Drc.createDifferentialPair'], name, positiveNet, negativeNet);
    const after = (((await callFirst(['PCB_Drc.getAllDifferentialPairs'])) as any[]) ?? []).find((p) => p?.name === name);
    const verified = after?.positiveNet === positiveNet && after?.negativeNet === negativeNet;
    return { name, replaced, verified, expected: { positiveNet, negativeNet }, actual: after ?? null };
  }

  async function netPrimitives(net: string): Promise<any[]> {
    const list = await callFirst(['PCB_Net.getAllPrimitivesByNet', 'pcb_Net.getAllPrimitivesByNet'], net);
    return Array.isArray(list) ? list : [];
  }
  const primType = (p: any) => String(p?.pcbItemPrimitiveType ?? p?.primitiveType ?? stateOf(p, 'PrimitiveType') ?? '');
  const primId = (p: any) => String(p?.primitiveId ?? stateOf(p, 'PrimitiveId') ?? p?.globalIndex ?? '');

  async function netStatus(params: Params): Promise<unknown> {
    const net = String(params.netName ?? '');
    if (!net) throw invalid('netName is required', 'Use easyeda_schematic_nets or PCB_Net.getAllNets for names.');
    const prims = await netPrimitives(net);
    const counts: Record<string, number> = {};
    for (const p of prims) counts[primType(p) || 'Unknown'] = (counts[primType(p) || 'Unknown'] ?? 0) + 1;
    const length = await callFirst(['PCB_Net.getNetLength', 'pcb_Net.getNetLength'], net);
    const pads = prims.filter((p) => primType(p) === 'Pad');
    return {
      netName: net,
      found: prims.length > 0,
      counts,
      padCount: pads.length,
      trackCount: counts.Line ?? 0,
      viaCount: counts.Via ?? 0,
      length: num(length),
      pads: pads.map((p) => ({ primitiveId: primId(p), parentId: p?.parentId, padNumber: p?.num ?? p?.padNumber, layerId: p?.layerId, x: num(p?.center?.x ?? p?.x), y: num(p?.center?.y ?? p?.y) })),
    };
  }

  const getDesignRules = () => callFirst(['PCB_Drc.getCurrentRuleConfiguration']);

  async function setDesignRules(params: Params): Promise<unknown> {
    if (!params.config || typeof params.config !== 'object') throw invalid('config object is required', 'Read PCB_Drc.getCurrentRuleConfiguration, patch it, send it back.');
    await callFirst(['PCB_Drc.overwriteCurrentRuleConfiguration'], params.config);
    const actual = await getDesignRules();
    return { verified: JSON.stringify((actual as any)?.config ?? actual) === JSON.stringify((params.config as any).config ?? params.config), actual };
  }

  async function setNetRules(params: Params): Promise<unknown> {
    const net = String(params.netName ?? '');
    if (!net || !params.rules || typeof params.rules !== 'object') throw invalid('netName and rules are required', 'rules keys follow PCB_Drc.getNetRules (e.g. Track, "Safe Spacing").');
    await callFirst(['PCB_Drc.overwriteNetRules'], net, params.rules);
    const actual = (await callFirst(['PCB_Drc.getNetRules'], net)) as Record<string, unknown> | null;
    const verified = !!actual && Object.entries(params.rules as Record<string, unknown>).every(([k, v]) => actual[k] === v);
    return { netName: net, verified, expected: params.rules, actual };
  }

  async function setStackup(params: Params): Promise<unknown> {
    const n = num(params.copperLayers);
    if (![1, 2, 4, 6, 8].includes(n)) throw invalid('copperLayers must be 1, 2, 4, 6 or 8', 'JLCPCB supports 1–8 copper layers; 4 for Transceiver_V2.');
    await callFirst(['PCB_Layer.setTheNumberOfCopperLayers', 'pcb_Layer.setTheNumberOfCopperLayers'], n);
    const actual = num(await callFirst(['PCB_Layer.getTheNumberOfCopperLayers', 'pcb_Layer.getTheNumberOfCopperLayers']));
    return { verified: actual === n, expected: { copperLayers: n }, actual: { copperLayers: actual } };
  }

  // ── C. routing / copper ───────────────────────────────────────────────
  async function routeNet(params: Params): Promise<unknown> {
    const net = String(params.netName ?? '');
    const points = Array.isArray(params.points) ? (params.points as Point[]) : [];
    const width = num(params.width), layer = num(params.layer, 1);
    if (!net || points.length < 2 || width <= 0) throw invalid('netName, width > 0 and at least two points are required', 'Points in native mils.');
    const ids: string[] = [];
    let length = 0;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i]!, b = points[i + 1]!;
      const created = await callFirst(['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'], net, layer, a.x, a.y, b.x, b.y, width, false);
      ids.push(extractPrimitiveId(created));
      length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    const missing: string[] = [];
    for (const id of ids) {
      if (!id || !(await callFirst(['PCB_PrimitiveLine.get', 'pcb_PrimitiveLine.get'], id))) missing.push(id || '(no id)');
    }
    return { netName: net, layer, width, primitiveIds: ids, segments: ids.length, length, verified: missing.length === 0, expected: { segments: ids.length }, actual: { segments: ids.length - missing.length, missing } };
  }

  async function deleteTracks(params: Params): Promise<unknown> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    if (ids.length === 0) throw invalid('primitiveIds is required', 'List tracks with pcb.listTracks or pcb.netStatus.');
    const result = await deletePrimitives(ids);
    return { ...result, verified: result.notFound.length === 0 };
  }

  async function ripupNet(params: Params): Promise<unknown> {
    const net = String(params.netName ?? '');
    if (!net) throw invalid('netName is required', 'Use PCB_Net.getAllNets for names.');
    const kinds = new Set(Array.isArray(params.kinds) && params.kinds.length ? (params.kinds as string[]) : ['Line', 'Arc', 'Via']);
    const ids = (await netPrimitives(net)).filter((p) => kinds.has(primType(p))).map(primId).filter(Boolean);
    const result = ids.length ? await deletePrimitives(ids) : { deleted: [], notFound: [] };
    const remaining = (await netPrimitives(net)).filter((p) => kinds.has(primType(p))).length;
    return { netName: net, ...result, remaining, verified: remaining === 0 };
  }

  async function addVias(params: Params): Promise<unknown> {
    const net = String(params.netName ?? '');
    const hole = num(params.holeSize), outer = num(params.outerDiameter);
    if (!net || hole <= 0 || outer <= hole) throw invalid('netName, holeSize > 0 and outerDiameter > holeSize are required', 'Native mils, e.g. holeSize 12, outerDiameter 24.');
    let points: Point[];
    if (params.mode === 'fence') {
      points = samplePolyline(params.path as Point[], num(params.pitch));
    } else if (params.mode === 'stitch') {
      points = gridInPolygon(flatPolygon(params.polygon), num(params.pitch), num(params.margin, outer));
    } else {
      points = Array.isArray(params.points) ? (params.points as Point[]) : [];
    }
    if (points.length === 0) throw invalid('no via positions computed', 'Check pitch/path/polygon.');
    if (points.length > num(params.maxVias, 500)) {
      throw invalid(`${points.length} vias exceeds maxVias`, 'Raise pitch or maxVias.');
    }
    const ids: string[] = [];
    for (const p of points) {
      const created = await callFirst(['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'], net, p.x, p.y, hole, outer, 0, '', false, undefined);
      ids.push(extractPrimitiveId(created));
    }
    let found = 0;
    for (const id of ids) if (id && (await callFirst(['PCB_PrimitiveVia.get', 'pcb_PrimitiveVia.get'], id))) found += 1;
    return { netName: net, primitiveIds: ids, points, verified: found === ids.length, expected: { vias: ids.length }, actual: { vias: found } };
  }

  async function addCopperPour(params: Params): Promise<unknown> {
    const net = String(params.netName ?? ''), layer = num(params.layer, 1);
    const poly = flatPolygon(params.points);
    if (!net) throw invalid('netName is required', 'e.g. GND');
    const created = await createWithPolygon('Copper pour', poly, (polygon) =>
      callFirst(['PCB_PrimitivePour.create', 'pcb_PrimitivePour.create'], net, layer, polygon, 'solid', false),
    );
    const readBack = await callFirst(['PCB_PrimitivePour.get', 'pcb_PrimitivePour.get'], created.primitiveId);
    let rebuilt: unknown = null;
    try {
      rebuilt = await callFirst(['PCB_PrimitivePour.rebuildAll', 'PCB_PrimitivePour.rebuild', 'pcb_PrimitivePour.rebuildAll'], [created.primitiveId]);
    } catch {
      rebuilt = 'not_available';
    }
    return { ...created, netName: net, layer, points: poly, verified: !!readBack, rebuilt, actual: readBack ? { net: stateOf(readBack, 'Net'), layer: stateOf(readBack, 'Layer') } : null };
  }

  async function copperIslands(params: Params): Promise<unknown> {
    const filterNet = typeof params.netName === 'string' ? params.netName : undefined;
    const poured = (await callFirst(['PCB_PrimitivePoured.getAll', 'pcb_PrimitivePoured.getAll'])) as any[];
    const items = [];
    const padCache = new Map<string, Point[]>();
    for (const p of Array.isArray(poured) ? poured : []) {
      const net = String(stateOf(p, 'Net') ?? '');
      if (filterNet && net !== filterNet) continue;
      const raw = stateOf(p, 'Polygon') ?? stateOf(p, 'Points');
      const src = typeof (raw as any)?.getSource === 'function' ? (raw as any).getSource() : raw;
      const poly = Array.isArray(src) && src.every((v) => typeof v === 'number') ? (src as number[]) : null;
      if (!padCache.has(net)) padCache.set(net, (await netPrimitives(net)).filter((q) => primType(q) === 'Pad').map((q) => ({ x: num(q?.center?.x ?? q?.x), y: num(q?.center?.y ?? q?.y) })));
      const pads = padCache.get(net)!;
      const connected = poly ? pads.some((pt) => pointInPolygon(pt.x, pt.y, poly)) : undefined;
      items.push({ primitiveId: String(stateOf(p, 'PrimitiveId') ?? ''), netName: net, layer: stateOf(p, 'Layer'), island: poly ? !connected : 'geometry_unknown', pointCount: poly ? poly.length / 2 : 0 });
    }
    return { items, islands: items.filter((i) => i.island === true).length };
  }

  // ── D. verification ───────────────────────────────────────────────────
  async function connectivityCheck(): Promise<unknown> {
    const nets = (await callFirst(['PCB_Net.getAllNets', 'pcb_Net.getAllNets'])) as any[];
    const items = [];
    for (const n of Array.isArray(nets) ? nets : []) {
      const name = String(n?.net ?? n?.name ?? '');
      if (!name) continue;
      const prims = await netPrimitives(name);
      const pads = prims.filter((p) => primType(p) === 'Pad').length;
      const copper = prims.filter((p) => ['Line', 'Arc', 'Via', 'Pour', 'Poured', 'Fill'].includes(primType(p))).length;
      // ponytail: heuristic — pads ≥ 2 with no copper is certainly open; partial routes need DRC.
      items.push({ netName: name, padCount: pads, copperCount: copper, length: num(n?.length), status: pads < 2 ? 'single_pin' : copper === 0 ? 'open' : 'routed_or_partial' });
    }
    return { items, openNets: items.filter((i) => i.status === 'open').map((i) => i.netName), method: 'heuristic: nets with ≥2 pads and no copper primitives are open; partial routes are reported by DRC' };
  }

  // ── E. attributes / export ────────────────────────────────────────────
  async function setComponentAttribute(params: Params): Promise<unknown> {
    const id = String(params.primitiveId ?? '');
    const c = (await getComponent(id)) as any;
    if (!c) throw createBridgeError('NOT_FOUND', `Component ${id} not found`, 'List components with pcb.listComponents.');
    const expected: Record<string, unknown> = {};
    if (typeof params.addIntoBom === 'boolean') {
      expected.addIntoBom = params.addIntoBom;
      if (typeof c.setState_AddIntoBom === 'function') c.setState_AddIntoBom(params.addIntoBom);
      else await callFirst(['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'], id, { addIntoBom: params.addIntoBom });
    }
    const props = params.properties && typeof params.properties === 'object' ? (params.properties as Record<string, string>) : {};
    for (const [k, v] of Object.entries(props)) {
      expected[k] = v;
      if (typeof c.setAttribute === 'function') c.setAttribute(k, v);
      else if (typeof c.setState_OtherProperty === 'function') c.setState_OtherProperty({ ...(stateOf(c, 'OtherProperty') as object), [k]: v });
      else await callFirst(['PCB_PrimitiveComponent.modify', 'pcb_PrimitiveComponent.modify'], id, { otherProperty: { [k]: v } });
    }
    if (Object.keys(expected).length === 0) throw invalid('nothing to change', 'Pass addIntoBom and/or properties.');
    const after = componentState(await getComponent(id));
    const actual: Record<string, unknown> = { addIntoBom: after.addIntoBom, ...Object.fromEntries(Object.keys(props).map((k) => [k, after.otherProperty[k]])) };
    const verified = Object.entries(expected).every(([k, v]) => actual[k] === v);
    return { primitiveId: id, designator: after.designator, verified, expected, actual };
  }

  function requireProjectId(params: Params, op: string): string {
    const id = typeof params.projectId === 'string' ? params.projectId.trim() : '';
    if (!id) throw invalid(`${op} requires projectId`, 'Pass the current EasyEDA projectId.');
    return id;
  }
  const exportBom = async (params: Params) =>
    normalizeBinaryResult(await callFirst(['PCB_ManufactureData.getBomFile', 'SCH_ManufactureData.getBomFile'], requireProjectId(params, 'BOM export')), 'bom.csv');
  const exportStep = async (params: Params) =>
    normalizeBinaryResult(await callFirst(['PCB_ManufactureData.get3DFile'], requireProjectId(params, 'STEP export'), params.format ?? 'step'), 'board.step');

  // ── F. schematic ──────────────────────────────────────────────────────
  const wireEnds = (w: unknown): Point[] => {
    // Live wires keep coordinates in `Line`: flat [x1,y1,x2,y2,...] or nested per segment.
    const pts = stateOf(w, 'Line') ?? stateOf(w, 'Points') ?? stateOf(w, 'Polyline') ?? (w as any)?.points;
    const flat = Array.isArray(pts) ? pts.flat() : [];
    const out: Point[] = [];
    if (flat.every((v) => typeof v === 'number')) for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
    else for (const p of flat) if (p && typeof p === 'object') out.push({ x: num((p as any).x), y: num((p as any).y) });
    return out;
  };

  const allWires = async () => {
    const wires = (await callFirst(['SCH_PrimitiveWire.getAll', 'sch_PrimitiveWire.getAll'])) as any[];
    return (Array.isArray(wires) ? wires : []).map((w) => ({ primitiveId: String(stateOf(w, 'PrimitiveId') ?? ''), net: String(stateOf(w, 'Net') ?? ''), points: wireEnds(w) }));
  };
  const wireNet = async (id: string) => String(stateOf(await callFirst(['SCH_PrimitiveWire.get', 'sch_PrimitiveWire.get'], id), 'Net') ?? '');

  async function schematicWiresAtPin(params: Params): Promise<unknown> {
    const x = num(params.x, NaN), y = num(params.y, NaN), tol = num(params.tolerance, 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw invalid('x and y (pin position) are required', 'Get pin positions from easyeda_schematic_component_pins.');
    const items = (await allWires()).filter((w) => w.points.some((p) => Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol));
    return { x, y, items };
  }

  async function schematicDeleteWire(params: Params): Promise<unknown> {
    const ids = Array.isArray(params.primitiveIds) ? (params.primitiveIds as string[]) : [];
    if (ids.length === 0) throw invalid('primitiveIds is required', 'Find wires with schematic.wiresAtPin.');
    await callFirst(['SCH_PrimitiveWire.delete', 'sch_PrimitiveWire.delete'], ids);
    const remaining: string[] = [];
    for (const id of ids) if (await callFirst(['SCH_PrimitiveWire.get', 'sch_PrimitiveWire.get'], id)) remaining.push(id);
    return { deleted: ids.filter((i) => !remaining.includes(i)), remaining, verified: remaining.length === 0 };
  }

  // A net label in EasyEDA Pro is the Name of the wire it sits on. createNetLabel
  // returns null and leaves the name empty on 3.2.x, so name the wire directly.
  async function schematicSetNetLabel(params: Params): Promise<unknown> {
    const net = String(params.netName ?? ''), x = num(params.x, NaN), y = num(params.y, NaN);
    if (!net || !Number.isFinite(x) || !Number.isFinite(y)) throw invalid('netName, x and y are required', 'Place the label on a wire end.');
    const wire = (await allWires()).find((w) => w.points.some((p) => Math.abs(p.x - x) <= 1 && Math.abs(p.y - y) <= 1));
    if (!wire) throw invalid(`no wire endpoint at (${x}, ${y})`, 'Draw a wire first (easyeda_schematic_add_wire, which also takes netName) or use easyeda_schematic_connect_pin_to_net.');
    await callFirst(['SCH_PrimitiveWire.modify', 'sch_PrimitiveWire.modify'], wire.primitiveId, { net });
    const actual = await wireNet(wire.primitiveId);
    return { primitiveId: wire.primitiveId, netName: net, verified: actual === net, expected: { net }, actual: { net: actual } };
  }

  async function schematicRenameNet(params: Params): Promise<unknown> {
    const from = String(params.from ?? ''), to = String(params.to ?? '');
    if (!from || !to) throw invalid('from and to are required', 'Net names are case-sensitive.');
    // SCH_PrimitiveAttribute.getAll returns [] on 3.2.x; wire Net carries the label.
    const ids = (await allWires()).filter((w) => w.net === from).map((w) => w.primitiveId);
    if (ids.length === 0) throw invalid(`no wire carries net "${from}"`, 'Power/ground flags are symbols, not wire labels; replace them instead.');
    for (const id of ids) await callFirst(['SCH_PrimitiveWire.modify', 'sch_PrimitiveWire.modify'], id, { net: to });
    let renamed = 0;
    for (const id of ids) if ((await wireNet(id)) === to) renamed += 1;
    return { from, to, labelIds: ids, verified: renamed === ids.length, expected: { renamed: ids.length }, actual: { renamed } };
  }

  async function schematicComponentReplace(params: Params): Promise<unknown> {
    const id = String(params.primitiveId ?? '');
    const property = params.property && typeof params.property === 'object' ? (params.property as Record<string, unknown>) : {};
    if (!id || Object.keys(property).length === 0) throw invalid('primitiveId and property (e.g. {deviceUuid, footprintUuid}) are required', 'Search the replacement with easyeda_schematic_search_device.');
    await callFirst(['SCH_PrimitiveComponent.modify', 'sch_PrimitiveComponent.modify'], id, property);
    // getComponentDetail is not on SCH_PrimitiveComponent in current Pro builds; get() is.
    const detail = await callFirst(['SCH_PrimitiveComponent.get', 'sch_PrimitiveComponent.get'], id);
    const actual = Object.fromEntries(Object.keys(property).map((k) => [k, stateOf(detail, k.charAt(0).toUpperCase() + k.slice(1))]));
    return { primitiveId: id, verified: Object.entries(property).every(([k, v]) => matchesValue(actual[k], v)), expected: property, actual };
  }

  void readFirstPath;
  return {
    requireExpectedBoard, componentBounds, moveComponent, moveGroup, addKeepout,
    setNetClass, setDiffPair, netStatus, getDesignRules, setDesignRules, setNetRules, setStackup,
    routeNet, deleteTracks, ripupNet, addVias, addCopperPour, copperIslands, connectivityCheck,
    setComponentAttribute, exportBom, exportStep,
    schematicWiresAtPin, schematicDeleteWire, schematicSetNetLabel, schematicRenameNet, schematicComponentReplace,
  };
}
