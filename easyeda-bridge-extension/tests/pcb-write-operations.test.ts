import { describe, expect, it, vi } from 'vitest';
import { createPcbWriteOperations } from '../src/pcb-write-operations.js';

function bridgeError(code: string, message: string, suggestion: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, suggestion, data });
}

function makeOperations() {
  const callFirst = vi.fn(async (...args: unknown[]) => ({
    primitiveId: `id-${callFirst.mock.calls.length}`,
    args,
  }));
  const extractPrimitiveId = vi.fn((value: unknown) =>
    String((value as { primitiveId?: unknown } | null)?.primitiveId ?? ''),
  );
  return {
    callFirst,
    extractPrimitiveId,
    operations: createPcbWriteOperations({
      callFirst,
      extractPrimitiveId,
      createBridgeError: bridgeError,
    }),
  };
}

describe('PCB write operations', () => {
  it('modifyVia recreates the via when it moves and reports verified read-back', async () => {
    const { callFirst, operations } = makeOperations();
    const states = [
      { state: { Net: 'GND', X: 100, Y: 100, HoleDiameter: 12, Diameter: 24 } },
      { state: { Net: 'GND', X: 300, Y: 320, HoleDiameter: 12, Diameter: 30 } },
    ];
    callFirst.mockImplementation(async (paths: unknown) => {
      const p = (paths as string[])[0];
      if (p.endsWith('.get')) return states.shift();
      if (p.endsWith('.create')) return { primitiveId: 'via-new' };
      return true;
    });

    await expect(
      operations.modifyVia({ primitiveId: 'via-old', x: 300, y: 320, outerDiameter: 30 }),
    ).resolves.toMatchObject({
      primitiveId: 'via-new',
      previousPrimitiveId: 'via-old',
      recreated: true,
      verified: true,
    });
    const calls = callFirst.mock.calls.map((c) => (c[0] as string[])[0]);
    expect(calls).toEqual([
      'PCB_PrimitiveVia.get',
      'PCB_PrimitiveVia.delete',
      'PCB_PrimitiveVia.create',
      'PCB_PrimitiveVia.get',
    ]);
    expect(callFirst.mock.calls[2].slice(1)).toEqual([
      'GND',
      300,
      320,
      12,
      30,
      0,
      '',
      false,
      undefined,
    ]);
  });

  it('modifyVia uses native modify for size-only edits and flags mismatched read-back', async () => {
    const { callFirst, operations } = makeOperations();
    callFirst.mockImplementation(async (paths: unknown) => {
      const p = (paths as string[])[0];
      if (p.endsWith('.get'))
        return {
          getState_Net: () => 'GND',
          getState_X: () => 1,
          getState_Y: () => 2,
          getState_HoleDiameter: () => 12,
          getState_Diameter: () => 24,
        };
      return true;
    });

    await expect(
      operations.modifyVia({ primitiveId: 'v', outerDiameter: 30 }),
    ).resolves.toMatchObject({
      primitiveId: 'v',
      recreated: false,
      verified: false,
      expected: { diameter: 30 },
      actual: { diameter: 24 },
    });
    expect(callFirst.mock.calls[1][0]).toEqual([
      'PCB_PrimitiveVia.modify',
      'pcb_PrimitiveVia.modify',
    ]);
    expect(callFirst.mock.calls[1].slice(1)).toEqual([
      'v',
      { net: 'GND', holeDiameter: 12, diameter: 30 },
    ]);
  });

  it('modifyVia refuses unknown ids without writing', async () => {
    const { callFirst, operations } = makeOperations();
    callFirst.mockResolvedValue(null);
    await expect(operations.modifyVia({ primitiveId: 'nope', x: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(callFirst).toHaveBeenCalledTimes(1);
  });

  it('addArc emits chord lines on the board outline layer', async () => {
    const { callFirst, operations } = makeOperations();
    const result = (await operations.addArc({
      cx: 0,
      cy: 0,
      radius: 100,
      startAngle: 0,
      endAngle: 90,
    })) as {
      primitiveIds: string[];
      segments: number;
      approximated: boolean;
    };
    expect(result.segments).toBe(9);
    expect(result.primitiveIds).toHaveLength(9);
    expect(result.approximated).toBe(true);
    const first = callFirst.mock.calls[0];
    expect(first[0]).toEqual(['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create']);
    expect(first.slice(1, 5)).toEqual(['', 11, 100, 0]);
    const last = callFirst.mock.calls[8];
    expect(last[5] as number).toBeCloseTo(0, 6);
    expect(last[6] as number).toBeCloseTo(100, 6);
  });

  it('addHole creates an unplated Multi-Layer pad with the decoded signature', async () => {
    const { callFirst, operations } = makeOperations();
    await operations.addHole({ x: 400, y: 400, holeDiameter: 126, padDiameter: 252, name: 'H1' });
    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitivePad.create', 'pcb_PrimitivePad.create'],
      12,
      'H1',
      400,
      400,
      0,
      ['ELLIPSE', 252, 252],
      '',
      ['ROUND', 126],
      0,
      0,
      0,
      false,
    );
    await operations.addHole({ x: 1, y: 2, holeDiameter: 40, plated: true, netName: 'GND' });
    expect(callFirst.mock.calls[1].slice(1)).toEqual([
      12,
      'H',
      1,
      2,
      0,
      ['ELLIPSE', 40, 40],
      'GND',
      ['ROUND', 40],
      0,
      0,
      0,
      true,
    ]);
    await expect(
      operations.addHole({ x: 1, y: 2, holeDiameter: 40, padDiameter: 20 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('rejects missing or undersized track point arrays before native calls', async () => {
    const { callFirst, operations } = makeOperations();

    await expect(operations.addTrack({ points: 'not-an-array' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      message: 'pcb.addTrack requires at least 2 points',
      suggestion: 'Provide a points array with at least a start and end coordinate.',
    });
    await expect(operations.addTrack({ points: [{ x: 0, y: 0 }] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(callFirst).not.toHaveBeenCalled();
  });

  it('creates one native line per consecutive track point pair', async () => {
    const { callFirst, extractPrimitiveId, operations } = makeOperations();

    await expect(
      operations.addTrack({
        points: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
        netName: 'GND',
        layer: 1,
        width: 0.25,
      }),
    ).resolves.toEqual({
      primitiveId: 'id-1',
      primitiveIds: ['id-1', 'id-2'],
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      'GND',
      1,
      1,
      2,
      3,
      4,
      0.25,
      false,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      'GND',
      1,
      3,
      4,
      5,
      6,
      0.25,
      false,
    );
    expect(extractPrimitiveId).toHaveBeenCalledTimes(2);
  });

  it('applies the exact PCB text defaults when optional fields are absent', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.addText({ layer: 3, x: 10, y: 20, text: 'REF' });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
      3,
      10,
      20,
      'REF',
      'NotoSansMonoCJKsc-Regular',
      1,
      0.15,
      0,
      0,
      false,
      0,
      false,
      false,
    );
  });

  it('preserves explicit PCB text values including zero and false', async () => {
    const { callFirst, operations } = makeOperations();
    const params = {
      layer: 4,
      x: 1,
      y: 2,
      text: 'TXT',
      fontFamily: 'CustomFont',
      fontSize: 0,
      lineWidth: 0,
      alignMode: 0,
      rotation: 0,
      reverse: false,
      expansion: 0,
      mirror: false,
      locked: false,
    };

    await operations.addText(params);

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveString.create', 'pcb_PrimitiveString.create'],
      4,
      1,
      2,
      'TXT',
      'CustomFont',
      0,
      0,
      0,
      0,
      false,
      0,
      false,
      false,
    );
  });

  it('creates silkscreen lines with an empty net and preserves width fallback', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.addSilkscreenLine({
      layer: 3,
      startX: 1,
      startY: 2,
      endX: 3,
      endY: 4,
    });
    await operations.addSilkscreenLine({
      layer: 3,
      startX: 5,
      startY: 6,
      endX: 7,
      endY: 8,
      lineWidth: 0,
    });

    expect(callFirst).toHaveBeenNthCalledWith(
      1,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      '',
      3,
      1,
      2,
      3,
      4,
      0.2,
      false,
    );
    expect(callFirst).toHaveBeenNthCalledWith(
      2,
      ['PCB_PrimitiveLine.create', 'pcb_PrimitiveLine.create'],
      '',
      3,
      5,
      6,
      7,
      8,
      0,
      false,
    );
  });

  it('creates vias with the live-verified native argument order', async () => {
    const { callFirst, operations } = makeOperations();

    await operations.addVia({
      netName: 'VCC',
      x: 100,
      y: 200,
      holeSize: 30,
      outerDiameter: 60,
    });

    expect(callFirst).toHaveBeenCalledWith(
      ['PCB_PrimitiveVia.create', 'pcb_PrimitiveVia.create'],
      'VCC',
      100,
      200,
      30,
      60,
      0,
      '',
      false,
      undefined,
    );
  });
});
