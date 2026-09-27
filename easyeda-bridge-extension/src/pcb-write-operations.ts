import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';

export type PrimitiveIdExtractor = (value: unknown) => string;

export interface PcbWriteOperationDependencies {
  callFirst: ApiRuntime['callFirst'];
  extractPrimitiveId: PrimitiveIdExtractor;
  createBridgeError: BridgeErrorFactory;
}

export interface PcbWriteOperations {
  addTrack(params: Record<string, unknown>): Promise<unknown>;
  addText(params: Record<string, unknown>): Promise<unknown>;
  addSilkscreenLine(params: Record<string, unknown>): Promise<unknown>;
  addVia(params: Record<string, unknown>): Promise<unknown>;
  modifyVia(params: Record<string, unknown>): Promise<unknown>;
  addArc(params: Record<string, unknown>): Promise<unknown>;
  addHole(params: Record<string, unknown>): Promise<unknown>;
}

/** Board Outline layer id, confirmed live via PCB_Layer.getAllLayers (2026-09-05). */
export const BOARD_OUTLINE_LAYER = 11;
/** Multi-Layer id: through-hole pads live here. */
export const MULTI_LAYER = 12;

function viaState(value: unknown): Record<string, unknown> {
  const v = value as { state?: Record<string, unknown> } | null;
  const s = v?.state ?? (value as Record<string, unknown>) ?? {};
  const read = (key: string) => {
    const fn = (value as Record<string, unknown>)?.[`getState_${key}`];
    return typeof fn === 'function' ? fn.call(value) : s[key];
  };
  return {
    net: read('Net'),
    x: read('X'),
    y: read('Y'),
    holeDiameter: read('HoleDiameter'),
    diameter: read('Diameter'),
  };
}

export function createPcbWriteOperations({
  callFirst,
  extractPrimitiveId,
  createBridgeError,
}: PcbWriteOperationDependencies): PcbWriteOperations {
  async function addTrack(params: Record<string, unknown>): Promise<unknown> {
    // PCB_PrimitivePolyline.create's real argument order could not be
    // determined live. PCB_PrimitiveLine.create was confirmed as
    // create(net, layer, startX, startY, endX, endY, lineWidth, locked).
    const points: Array<{ x: number; y: number }> = Array.isArray(params.points)
      ? params.points
      : [];
    if (points.length < 2) {
      throw createBridgeError(
        'INVALID_PARAMS',
        'pcb.addTrack requires at least 2 points',
        'Provide a points array with at least a start and end coordinate.',
      );
    }

    const createdIds: string[] = [];
    for (let index = 1; index < points.length; index += 1) {
      const start = points[index - 1];
      const end = points[index];
      const created = await callFirst(
        ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
        params.netName,
        params.layer,
        start.x,
        start.y,
        end.x,
        end.y,
        params.width,
        false,
      );
      createdIds.push(extractPrimitiveId(created));
    }

    return { primitiveId: createdIds[0], primitiveIds: createdIds };
  }

  async function addText(params: Record<string, unknown>): Promise<unknown> {
    // PCB_PrimitiveString.create was live-confirmed as:
    // create(layer, x, y, text, fontFamily, fontSize, lineWidth, alignMode,
    // rotation, reverse, expansion, mirror, primitiveLock).
    return callFirst(
      ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
      params.layer,
      params.x,
      params.y,
      params.text,
      params.fontFamily ?? 'NotoSansMonoCJKsc-Regular',
      params.fontSize ?? 1,
      params.lineWidth ?? 0.15,
      params.alignMode ?? 0,
      params.rotation ?? 0,
      params.reverse ?? false,
      params.expansion ?? 0,
      params.mirror ?? false,
      params.locked ?? false,
    );
  }

  async function addSilkscreenLine(params: Record<string, unknown>): Promise<unknown> {
    // Reuse PCB_PrimitiveLine.create with an empty net and a non-copper layer
    // so the result remains decorative rather than electrical.
    return callFirst(
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      '',
      params.layer,
      params.startX,
      params.startY,
      params.endX,
      params.endY,
      params.lineWidth ?? 0.2,
      false,
    );
  }

  async function addVia(params: Record<string, unknown>): Promise<unknown> {
    // PCB_PrimitiveVia.create was live-confirmed as:
    // create(net, x, y, holeDiameter, diameter, viaType,
    // designRuleBlindViaName, locked, solderMaskExpansion).
    return callFirst(
      ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
      params.netName,
      params.x,
      params.y,
      params.holeSize,
      params.outerDiameter,
      0,
      '',
      false,
      undefined,
    );
  }

  async function modifyVia(params: Record<string, unknown>): Promise<unknown> {
    // Defect 4: PCB_PrimitiveVia.modify updates the state readback but the
    // DRC/connectivity index kept the old position live. Moving a via is
    // therefore delete + create; size/net-only edits use modify.
    const id = String(params.primitiveId ?? '');
    if (!id) {
      throw createBridgeError('INVALID_PARAMS', 'pcb.modifyVia requires primitiveId', 'Pass the via primitiveId from pcb.listVias.');
    }
    const before = await callFirst(['PCB_PrimitiveVia.get', 'pcb_PrimitiveVia.get'], id);
    if (!before) {
      throw createBridgeError('NOT_FOUND', `Via ${id} not found`, 'List vias with pcb.listVias and retry with an existing id.');
    }
    const old = viaState(before);
    const next = {
      net: params.netName ?? old.net,
      x: params.x ?? old.x,
      y: params.y ?? old.y,
      holeDiameter: params.holeSize ?? old.holeDiameter,
      diameter: params.outerDiameter ?? old.diameter,
    };
    const moved = next.x !== old.x || next.y !== old.y;
    let primitiveId = id;
    if (moved) {
      await callFirst(['PCB_PrimitiveVia.delete', 'pcb_PrimitiveVia.delete'], [id]);
      const created = await callFirst(
        ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
        next.net, next.x, next.y, next.holeDiameter, next.diameter, 0, '', false, undefined,
      );
      primitiveId = extractPrimitiveId(created);
    } else {
      await callFirst(['PCB_PrimitiveVia.modify', 'pcb_PrimitiveVia.modify'], id, {
        net: next.net, holeDiameter: next.holeDiameter, diameter: next.diameter,
      });
    }
    const after = viaState(await callFirst(['PCB_PrimitiveVia.get', 'pcb_PrimitiveVia.get'], primitiveId));
    const verified = (['net', 'x', 'y', 'holeDiameter', 'diameter'] as const).every((k) => after[k] === next[k]);
    return { primitiveId, previousPrimitiveId: moved ? id : undefined, recreated: moved, verified, expected: next, actual: after };
  }

  async function addArc(params: Record<string, unknown>): Promise<unknown> {
    // Defect 5: PCB_PrimitiveArc.create returns an id but nothing persists
    // (getAll/get empty, modify throws). ponytail: emit chord lines instead;
    // swap for the native arc when a build fixes it.
    const { cx, cy, radius, startAngle, endAngle } = params as Record<string, number>;
    const width = (params.lineWidth as number | undefined) ?? 10;
    const layer = (params.layer as number | undefined) ?? BOARD_OUTLINE_LAYER;
    const segments = Math.max(4, Math.min(64, Math.ceil(Math.abs(endAngle - startAngle) / 10)));
    if (![cx, cy, radius, startAngle, endAngle].every(Number.isFinite) || radius <= 0) {
      throw createBridgeError('INVALID_PARAMS', 'pcb.addArc requires cx, cy, radius > 0, startAngle, endAngle', 'Angles in degrees CCW; native units.');
    }
    const pt = (deg: number) => ({ x: cx + radius * Math.cos((deg * Math.PI) / 180), y: cy + radius * Math.sin((deg * Math.PI) / 180) });
    const ids: string[] = [];
    for (let i = 0; i < segments; i += 1) {
      const a = pt(startAngle + ((endAngle - startAngle) * i) / segments);
      const b = pt(startAngle + ((endAngle - startAngle) * (i + 1)) / segments);
      const created = await callFirst(['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'], params.netName ?? '', layer, a.x, a.y, b.x, b.y, width, false);
      ids.push(extractPrimitiveId(created));
    }
    return { primitiveId: ids[0], primitiveIds: ids, segments, approximated: true };
  }

  async function addHole(params: Record<string, unknown>): Promise<unknown> {
    // Defect 6: PCB_PrimitivePad.create decoded live (2026-09-05) as
    // create(layer, padNumber, x, y, rotation, pad, net, hole, holeOffsetX,
    // holeOffsetY, holeRotation, metallization). Unplated + no net = NPTH.
    const plated = params.plated === true;
    const hole = params.holeDiameter as number;
    const pad = (params.padDiameter as number | undefined) ?? hole;
    if (!Number.isFinite(hole) || hole <= 0 || pad < hole) {
      throw createBridgeError('INVALID_PARAMS', 'pcb.addHole requires holeDiameter > 0 and padDiameter >= holeDiameter', 'Omit padDiameter for a bare hole.');
    }
    return callFirst(
      ['PCB_PrimitivePad.create', 'pcb_PrimitivePad.create'],
      MULTI_LAYER, params.name ?? 'H', params.x, params.y, 0,
      ['ELLIPSE', pad, pad], plated ? (params.netName ?? '') : '', ['ROUND', hole], 0, 0, 0, plated,
    );
  }

  return {
    addTrack,
    addText,
    addSilkscreenLine,
    addVia,
    modifyVia,
    addArc,
    addHole,
  };
}
