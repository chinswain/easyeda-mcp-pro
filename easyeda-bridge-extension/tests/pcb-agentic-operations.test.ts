import { describe, expect, it, vi } from 'vitest';
import {
  createPcbAgenticOperations,
  gridInPolygon,
  pointInPolygon,
  samplePolyline,
} from '../src/pcb-agentic-operations.js';

type Handler = (...args: any[]) => unknown;

/** Fake EasyEDA runtime keyed by API path; `callFirst` picks the first known path. */
function createSubject(api: Record<string, Handler>) {
  const callFirst = vi.fn(async (paths: readonly string[], ...args: unknown[]) => {
    const path = paths.find((p) => p in api);
    if (!path) throw new Error(`no api for ${paths.join('|')}`);
    return api[path]!(...args);
  });
  const deletePrimitives = vi.fn(async (ids: string[]) => ({
    deleted: ids,
    notFound: [] as string[],
  }));
  const operations = createPcbAgenticOperations({
    callFirst,
    readFirstPath: vi.fn() as any,
    extractPrimitiveId: (v) => (typeof v === 'string' ? v : String((v as any)?.primitiveId ?? '')),
    createBridgeError: (code, message, suggestion, data) =>
      Object.assign(new Error(message), { code, suggestion, data }),
    deletePrimitives,
    normalizeBinaryResult: vi.fn(async (value, fileName) => ({ fileName, value })),
  });
  return { operations, callFirst, deletePrimitives };
}

const board = {
  uuid: 'doc',
  name: 'PCB3_1',
  parentProjectUuid: 'proj',
  parentBoardName: 'Transceiver_V2',
};

describe('geometry helpers', () => {
  it('ray-casts point in polygon and samples fences/grids', () => {
    const square = [0, 0, 100, 0, 100, 100, 0, 100];
    expect(pointInPolygon(50, 50, square)).toBe(true);
    expect(pointInPolygon(150, 50, square)).toBe(false);
    expect(
      samplePolyline(
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
        25,
      ),
    ).toHaveLength(5);
    expect(gridInPolygon(square, 25, 1)).toHaveLength(16);
    expect(gridInPolygon(square, 50, 10).every((p) => pointInPolygon(p.x, p.y, square))).toBe(true);
  });
});

describe('requireExpectedBoard', () => {
  it('passes on match, ignores missing expect, rejects mismatch with actual values', async () => {
    const { operations } = createSubject({ 'DMT_Pcb.getCurrentPcbInfo': () => board });
    await expect(operations.requireExpectedBoard({})).resolves.toBeUndefined();
    await expect(
      operations.requireExpectedBoard({
        expect: { projectId: 'proj', boardName: 'transceiver_v2' },
      }),
    ).resolves.toBeUndefined();
    await expect(
      operations.requireExpectedBoard({ expect: { projectId: 'other' } }),
    ).rejects.toMatchObject({
      code: 'WRONG_DOCUMENT',
      data: { actual: { projectId: 'proj', boardName: 'Transceiver_V2' } },
    });
    await expect(
      operations.requireExpectedBoard({ expect: { projectId: 'proj', boardName: 'Nope' } }),
    ).rejects.toMatchObject({ code: 'WRONG_DOCUMENT' });
  });

  it('reports CONTEXT_UNAVAILABLE when no PCB is focused', async () => {
    const { operations } = createSubject({ 'DMT_Pcb.getCurrentPcbInfo': () => null });
    await expect(
      operations.requireExpectedBoard({ expect: { projectId: 'proj' } }),
    ).rejects.toMatchObject({ code: 'CONTEXT_UNAVAILABLE' });
  });
});

describe('placement', () => {
  function componentApi() {
    const state: Record<string, any> = {
      c1: {
        PrimitiveId: 'c1',
        Designator: 'U2',
        Layer: 1,
        X: 100,
        Y: 200,
        Rotation: 0,
        OtherProperty: { 'Height Above Board': '3.2mm' },
      },
      c2: {
        PrimitiveId: 'c2',
        Designator: 'C5',
        Layer: 1,
        X: 10,
        Y: 20,
        Rotation: 90,
        OtherProperty: {},
      },
    };
    const api: Record<string, Handler> = {
      'PCB_PrimitiveComponent.get': (id: string) => (state[id] ? { state: state[id] } : null),
      'PCB_PrimitiveComponent.modify': (id: string, prop: Record<string, number>) => {
        for (const [k, v] of Object.entries(prop))
          state[id][k.charAt(0).toUpperCase() + k.slice(1)] = v;
        return true;
      },
      'PCB_Primitive.getPrimitivesBBox': () => ({ minX: 0, minY: 0, maxX: 200, maxY: 400 }),
    };
    return { state, api };
  }

  it('componentBounds returns bbox, height and found=false for unknown ids', async () => {
    const { operations } = createSubject(componentApi().api);
    await expect(operations.componentBounds({ primitiveIds: ['c1', 'zz'] })).resolves.toMatchObject(
      {
        items: [
          { found: true, designator: 'U2', heightMm: 3.2, bbox: { maxX: 200 } },
          { primitiveId: 'zz', found: false },
        ],
      },
    );
  });

  it('moveComponent verifies the read-back and moveGroup shifts relative to anchor', async () => {
    const { api } = componentApi();
    const { operations } = createSubject(api);
    await expect(
      operations.moveComponent({ primitiveId: 'c1', x: 500, rotation: 180 }),
    ).resolves.toMatchObject({
      designator: 'U2',
      verified: true,
      before: { x: 100 },
      actual: { x: 500, rotation: 180 },
    });
    await expect(
      operations.moveGroup({ primitiveIds: ['c1', 'c2'], dx: 10, dy: -5 }),
    ).resolves.toMatchObject({
      verified: true,
      items: [{ actual: { x: 510, y: 195 } }, { actual: { x: 20, y: 15 } }],
    });
    await expect(operations.moveComponent({ primitiveId: 'nope', x: 1 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('moveComponent reports verified=false with both values when the board disagrees', async () => {
    const { api } = componentApi();
    api['PCB_PrimitiveComponent.modify'] = () => true; // silently ignored
    const { operations } = createSubject(api);
    await expect(operations.moveComponent({ primitiveId: 'c1', x: 500 })).resolves.toMatchObject({
      verified: false,
      expected: { x: 500 },
      actual: { x: 100 },
    });
  });

  it('addKeepout tries the polygon object first, then a plain array, then fails structured', async () => {
    const calls: unknown[] = [];
    const { operations } = createSubject({
      'PCB_MathPolygon.createPolygon': (pts: unknown) => ({ native: pts }),
      'PCB_PrimitiveRegion.create': (_layer: unknown, poly: any) => {
        calls.push(poly);
        if (poly?.native) throw new TypeError('bad polygon');
        return 'r1';
      },
      'PCB_PrimitiveRegion.get': () => ({ state: { Layer: 12 } }),
    });
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    await expect(operations.addKeepout({ layer: 12, points })).resolves.toMatchObject({
      primitiveId: 'r1',
      signature: 'plain-array',
      verified: true,
      actual: { layer: 12 },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ native: [0, 0, 'L', 10, 0, 10, 10, 0, 0] }); // closed: create() rejects open polygons

    const failing = createSubject({
      'PCB_MathPolygon.createPolygon': () => ({}),
      'PCB_PrimitiveRegion.create': () => {
        throw new Error('nope');
      },
    });
    await expect(failing.operations.addKeepout({ points })).rejects.toMatchObject({
      code: 'EASYEDA_API_ERROR',
    });
    await expect(operations.addKeepout({ points: [{ x: 0, y: 0 }] })).rejects.toThrow(/three/);
    // No native via rule: fail instead of silently dropping it.
    await expect(operations.addKeepout({ points, rules: ['Via'] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });
});

describe('rules and nets', () => {
  it('setNetClass replaces an existing class and verifies membership', async () => {
    let classes: any[] = [{ name: 'PWR', nets: ['VBUS'] }];
    const { operations } = createSubject({
      'PCB_Drc.getAllNetClasses': () => classes,
      'PCB_Drc.deleteNetClass': (n: string) => {
        classes = classes.filter((c) => c.name !== n);
        return true;
      },
      'PCB_Drc.createNetClass': (name: string, nets: string[]) => {
        classes.push({ name, nets });
        return true;
      },
    });
    await expect(
      operations.setNetClass({ name: 'PWR', nets: ['MODEM_VBAT'] }),
    ).resolves.toMatchObject({ replaced: true, verified: true, actual: { nets: ['MODEM_VBAT'] } });
    await expect(operations.setNetClass({ name: 'X' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('setDiffPair verifies the created pair', async () => {
    const pairs: any[] = [];
    const { operations } = createSubject({
      'PCB_Drc.getAllDifferentialPairs': () => pairs,
      'PCB_Drc.createDifferentialPair': (name: string, positiveNet: string, negativeNet: string) =>
        pairs.push({ name, positiveNet, negativeNet }),
    });
    await expect(
      operations.setDiffPair({ name: 'USB', positiveNet: 'USB_DP', negativeNet: 'USB_DM' }),
    ).resolves.toMatchObject({ verified: true, replaced: false });
  });

  it('netStatus counts primitives by type', async () => {
    const { operations } = createSubject({
      'PCB_Net.getAllPrimitivesByNet': () => [
        {
          pcbItemPrimitiveType: 'Pad',
          globalIndex: 'p1',
          center: { x: 1, y: 2 },
          parentId: 'c1',
          num: '1',
        },
        { pcbItemPrimitiveType: 'Pad', globalIndex: 'p2', center: { x: 3, y: 4 } },
        { pcbItemPrimitiveType: 'Line', globalIndex: 'l1' },
      ],
      'PCB_Net.getNetLength': () => 123.4,
    });
    await expect(operations.netStatus({ netName: 'GND' })).resolves.toMatchObject({
      found: true,
      padCount: 2,
      trackCount: 1,
      viaCount: 0,
      length: 123.4,
      pads: [{ primitiveId: 'p1', parentId: 'c1', x: 1, y: 2 }, { primitiveId: 'p2' }],
    });
  });

  it('setDesignRules, setNetRules and setStackup read back', async () => {
    let config: unknown = { a: 1 };
    let copper = 2;
    let netRules: Record<string, unknown> = {};
    const { operations } = createSubject({
      'PCB_Drc.getCurrentRuleConfiguration': () => ({ config, name: 'x' }),
      'PCB_Drc.overwriteCurrentRuleConfiguration': (c: any) => {
        config = c.config ?? c;
      },
      'PCB_Drc.overwriteNetRules': (_n: string, r: Record<string, unknown>) => {
        netRules = { ...r };
      },
      'PCB_Drc.getNetRules': () => netRules,
      'PCB_Layer.setTheNumberOfCopperLayers': (n: number) => {
        copper = n;
      },
      'PCB_Layer.getTheNumberOfCopperLayers': () => copper,
    });
    await expect(operations.setDesignRules({ config: { b: 2 } })).resolves.toMatchObject({
      verified: true,
    });
    await expect(
      operations.setNetRules({ netName: 'GND', rules: { Track: 0.5 } }),
    ).resolves.toMatchObject({ verified: true });
    await expect(operations.setStackup({ copperLayers: 4 })).resolves.toMatchObject({
      verified: true,
      actual: { copperLayers: 4 },
    });
    await expect(operations.setStackup({ copperLayers: 3 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });
});

describe('routing and copper', () => {
  it('routeNet creates one line per segment and verifies each', async () => {
    const lines: string[] = [];
    const { operations } = createSubject({
      'PCB_PrimitiveLine.create': () => {
        const id = `l${lines.length}`;
        lines.push(id);
        return id;
      },
      'PCB_PrimitiveLine.get': (id: string) => (lines.includes(id) ? {} : null),
    });
    await expect(
      operations.routeNet({
        netName: 'MODEM_VBAT',
        layer: 1,
        width: 40,
        points: [
          { x: 0, y: 0 },
          { x: 30, y: 40 },
          { x: 30, y: 140 },
        ],
      }),
    ).resolves.toMatchObject({
      segments: 2,
      length: 150,
      verified: true,
      primitiveIds: ['l0', 'l1'],
    });
  });

  it('ripupNet deletes copper of the net and re-checks; deleteTracks passes ids through', async () => {
    let prims: any[] = [
      { pcbItemPrimitiveType: 'Pad', globalIndex: 'p1' },
      { pcbItemPrimitiveType: 'Line', primitiveId: 'l1' },
      { pcbItemPrimitiveType: 'Via', globalIndex: 'v1' },
    ];
    const { operations, deletePrimitives } = createSubject({
      'PCB_Net.getAllPrimitivesByNet': () => prims,
    });
    deletePrimitives.mockImplementation(async (ids) => {
      prims = prims.filter((p) => !ids.includes(p.primitiveId ?? p.globalIndex ?? ''));
      return { deleted: ids, notFound: [] };
    });
    await expect(operations.ripupNet({ netName: 'X' })).resolves.toMatchObject({
      deleted: ['l1', 'v1'],
      remaining: 0,
      verified: true,
    });
    await expect(operations.deleteTracks({ primitiveIds: ['a'] })).resolves.toMatchObject({
      deleted: ['a'],
      verified: true,
    });
  });

  it('addVias places a fence along a path and a stitch grid inside a polygon', async () => {
    let n = 0;
    const { operations } = createSubject({
      'PCB_PrimitiveVia.create': () => `v${n++}`,
      'PCB_PrimitiveVia.get': () => ({}),
    });
    await expect(
      operations.addVias({
        mode: 'fence',
        netName: 'GND',
        path: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
        pitch: 50,
        holeSize: 12,
        outerDiameter: 24,
      }),
    ).resolves.toMatchObject({ verified: true, expected: { vias: 5 } });
    const stitch = (await operations.addVias({
      mode: 'stitch',
      netName: 'GND',
      polygon: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
      ],
      pitch: 40,
      margin: 10,
      holeSize: 12,
      outerDiameter: 24,
    })) as any;
    expect(stitch.points.length).toBe(9);
    await expect(
      operations.addVias({
        mode: 'fence',
        netName: 'GND',
        path: [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
        pitch: 1,
        maxVias: 10,
        holeSize: 12,
        outerDiameter: 24,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('addCopperPour reports the working signature and copperIslands flags orphan pours', async () => {
    const { operations } = createSubject({
      'PCB_MathPolygon.createPolygon': (p: unknown) => ({ native: p }),
      'PCB_PrimitivePour.create': () => 'pour1',
      'PCB_PrimitivePour.get': () => ({ state: { Net: 'GND', Layer: 1 } }),
      'PCB_PrimitivePoured.getAll': () => [
        {
          state: {
            PrimitiveId: 'q1',
            Net: 'GND',
            Layer: 1,
            Polygon: [0, 0, 100, 0, 100, 100, 0, 100],
          },
        },
        {
          state: {
            PrimitiveId: 'q2',
            Net: 'GND',
            Layer: 1,
            Polygon: [500, 500, 600, 500, 600, 600, 500, 600],
          },
        },
        {
          state: { PrimitiveId: 'q3', Net: 'GND', Layer: 2, Polygon: { getSource: () => 'weird' } },
        },
      ],
      'PCB_Net.getAllPrimitivesByNet': () => [
        { pcbItemPrimitiveType: 'Pad', center: { x: 50, y: 50 } },
      ],
    });
    await expect(
      operations.addCopperPour({
        netName: 'GND',
        layer: 1,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
      }),
    ).resolves.toMatchObject({
      signature: 'polygon-object',
      verified: true,
      rebuilt: 'not_available',
      actual: { net: 'GND' },
    });
    await expect(operations.copperIslands({ netName: 'GND' })).resolves.toMatchObject({
      islands: 1,
      items: [
        { primitiveId: 'q1', island: false },
        { primitiveId: 'q2', island: true },
        { primitiveId: 'q3', island: 'geometry_unknown' },
      ],
    });
  });

  it('connectivityCheck flags nets with pads but no copper', async () => {
    const byNet: Record<string, any[]> = {
      GND: [
        { pcbItemPrimitiveType: 'Pad' },
        { pcbItemPrimitiveType: 'Pad' },
        { pcbItemPrimitiveType: 'Pour' },
      ],
      USB_DP: [{ pcbItemPrimitiveType: 'Pad' }, { pcbItemPrimitiveType: 'Pad' }],
      NC1: [{ pcbItemPrimitiveType: 'Pad' }],
    };
    const { operations } = createSubject({
      'PCB_Net.getAllNets': () => Object.keys(byNet).map((net) => ({ net, length: 0 })),
      'PCB_Net.getAllPrimitivesByNet': (n: string) => byNet[n],
    });
    await expect(operations.connectivityCheck()).resolves.toMatchObject({
      openNets: ['USB_DP'],
      items: [{ status: 'routed_or_partial' }, { status: 'open' }, { status: 'single_pin' }],
    });
  });
});

describe('attributes, export and schematic', () => {
  it('setComponentAttribute uses instance setters and verifies', async () => {
    const state: any = {
      PrimitiveId: 'c1',
      Designator: 'LED1',
      AddIntoBom: true,
      OtherProperty: {},
    };
    const comp = {
      state,
      setState_AddIntoBom: (v: boolean) => {
        state.AddIntoBom = v;
      },
      setAttribute: (k: string, v: string) => {
        state.OtherProperty[k] = v;
      },
    };
    const { operations } = createSubject({ 'PCB_PrimitiveComponent.get': () => comp });
    await expect(
      operations.setComponentAttribute({
        primitiveId: 'c1',
        addIntoBom: false,
        properties: { Fitted: 'No' },
      }),
    ).resolves.toMatchObject({
      designator: 'LED1',
      verified: true,
      actual: { addIntoBom: false, Fitted: 'No' },
    });
    await expect(operations.setComponentAttribute({ primitiveId: 'c1' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
  });

  it('exportBom/exportStep normalise binary results with default file names', async () => {
    const { operations, callFirst } = createSubject({
      'PCB_ManufactureData.getBomFile': () => 'bom-blob',
      'PCB_ManufactureData.get3DFile': () => 'step-blob',
    });
    await expect(operations.exportBom({ projectId: 'p' })).resolves.toEqual({
      fileName: 'bom.csv',
      value: 'bom-blob',
    });
    await expect(operations.exportStep({ projectId: 'p' })).resolves.toEqual({
      fileName: 'board.step',
      value: 'step-blob',
    });
    expect(callFirst).toHaveBeenLastCalledWith(['PCB_ManufactureData.get3DFile'], 'p', 'step');
    await expect(operations.exportBom({})).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });

  it('schematic wire, label and rename ops verify by read-back', async () => {
    // Shapes as read live from EasyEDA Pro 3.2.x: `Line` flat or nested, net label = wire Net.
    let wires: any[] = [
      { state: { PrimitiveId: 'w1', Net: 'USB_DP', Line: [0, 0, 100, 0] } },
      { state: { PrimitiveId: 'w2', Net: 'GND', Line: [[500, 500, 600, 500]] } },
      { state: { PrimitiveId: 'w3', Net: '', Line: [1, 2, 50, 2] } },
      { state: { PrimitiveId: 'w4', Net: 'D+', Line: [900, 0, 950, 0] } },
    ];
    const { operations } = createSubject({
      'SCH_PrimitiveWire.getAll': () => wires,
      'SCH_PrimitiveWire.delete': (ids: string[]) => {
        wires = wires.filter((w) => !ids.includes(w.state.PrimitiveId));
      },
      'SCH_PrimitiveWire.get': (id: string) =>
        wires.find((w) => w.state.PrimitiveId === id) ?? null,
      'SCH_PrimitiveWire.modify': (id: string, p: any) => {
        wires.find((w) => w.state.PrimitiveId === id).state.Net = p.net;
      },
      'SCH_PrimitiveComponent.modify': () => true,
      'SCH_PrimitiveComponent.get': () => ({
        state: { DeviceUuid: { uuid: 'dev2', libraryUuid: 'lib' } },
      }),
    });
    await expect(operations.schematicWiresAtPin({ x: 100, y: 0 })).resolves.toMatchObject({
      items: [{ primitiveId: 'w1', net: 'USB_DP' }],
    });
    await expect(operations.schematicWiresAtPin({ x: 600, y: 500 })).resolves.toMatchObject({
      items: [{ primitiveId: 'w2' }],
    });
    await expect(operations.schematicDeleteWire({ primitiveIds: ['w1'] })).resolves.toMatchObject({
      deleted: ['w1'],
      verified: true,
    });
    await expect(
      operations.schematicSetNetLabel({ netName: 'USB_DP', x: 1, y: 2 }),
    ).resolves.toMatchObject({ primitiveId: 'w3', verified: true });
    await expect(
      operations.schematicSetNetLabel({ netName: 'X', x: 7000, y: 7000 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await expect(
      operations.schematicRenameNet({ from: 'D+', to: 'USB_DN' }),
    ).resolves.toMatchObject({ labelIds: ['w4'], verified: true });
    await expect(
      operations.schematicComponentReplace({ primitiveId: 'c1', property: { deviceUuid: 'dev2' } }),
    ).resolves.toMatchObject({ verified: true });
  });
});
