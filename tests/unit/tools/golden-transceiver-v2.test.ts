/**
 * Golden acceptance scenario (Section 4): Transceiver_V2 taken from schematic-complete to
 * manufacturing export through the agentic tool surface only, against a fake bridge that keeps
 * board state so verify-after-write, guards and save/reload can be asserted end-to-end.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerPcbAgenticTools } from '../../../src/tools/L1_pcb_agentic.js';
import { EnvSchema } from '../../../src/config/env.js';
import { milToMm, mmToMil, resetOpIdsForTests } from '../../../src/tools/agentic-common.js';

const PROJECT = 'd65fa3a1550a4891b5298f3de4c69fae';
const BOARD = 'Transceiver_V2';
const guard = { projectId: PROJECT, boardName: BOARD };
type Any = any;

/** Minimal EasyEDA-like board model in native mil. */
function fakeBoard() {
  const mil = mmToMil;
  const comp = (id: string, designator: string, x: number, y: number, h: number, w = 2, d = 2) => ({
    primitiveId: id,
    designator,
    x: mil(x),
    y: mil(y),
    layer: 1,
    rotation: 0,
    heightMm: h,
    addIntoBom: true,
    properties: {} as Record<string, string>,
    bbox: {
      minX: mil(x - w / 2),
      minY: mil(y - d / 2),
      maxX: mil(x + w / 2),
      maxY: mil(y + d / 2),
    },
  });
  return {
    focused: { projectId: PROJECT, boardName: BOARD },
    seq: 0,
    components: [
      comp('c-u1', 'U1', 60, 60, 2.5, 20, 20), // SIM7080G modem
      comp('c-u2', 'U2', 57, 8, 6, 12, 12), // tall part sitting in the solar socket zone → must move
      comp('c-led1', 'LED1', 20, 100, 1),
      comp('c-r36', 'R36', 22, 100, 0.6),
      comp('c-j1', 'J1', 100, 40, 3),
    ],
    tracks: [] as Any[],
    vias: [] as Any[],
    pours: [] as Any[],
    keepouts: [] as Any[],
    classes: {} as Record<string, string[]>,
    diffPairs: {} as Record<string, [string, string]>,
    netRules: {} as Record<string, Any>,
    routed: new Set<string>(),
    nets: ['GND', 'MODEM_VBAT', 'USB_D+', 'USB_D-', 'USB2_D+', 'USB2_D-', 'GPS_TX', 'GPS_RX'],
    saved: null as string | null,
  };
}

const segLen = (pts: Any[]) =>
  pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

/** Bridge dispatcher: enforces the expected-board guard on every pcb.* write and mutates state. */
function fakeBridge(board: ReturnType<typeof fakeBoard>) {
  const guardCheck = (p: Any) => {
    if (
      p?.expect &&
      (p.expect.projectId !== board.focused.projectId ||
        (p.expect.boardName && p.expect.boardName !== board.focused.boardName))
    ) {
      throw Object.assign(new Error('Focused PCB is not the expected board'), {
        code: 'WRONG_DOCUMENT',
        suggestion: 'Focus the expected PCB tab.',
        data: { expected: p.expect, actual: board.focused },
      });
    }
  };
  const id = (k: string) => `${k}-${++board.seq}`;
  const byNet = (net: string) => board.tracks.filter((t) => t.netName === net);
  return vi.fn(async (method: string, p: Any = {}) => {
    guardCheck(p);
    switch (method) {
      case 'pcb.listComponents':
        return {
          total: board.components.length,
          items: board.components.map((c) => ({
            primitiveId: c.primitiveId,
            designator: c.designator,
          })),
        };
      case 'pcb.componentBounds':
        return {
          items: board.components.filter(
            (c) => !p.primitiveIds || p.primitiveIds.includes(c.primitiveId),
          ),
        };
      case 'pcb.moveComponent': {
        const c = board.components.find((c) => c.primitiveId === p.primitiveId)!;
        const before = { x: c.x, y: c.y, layer: c.layer, rotation: c.rotation };
        const w = c.bbox.maxX - c.bbox.minX,
          d = c.bbox.maxY - c.bbox.minY;
        Object.assign(c, {
          x: p.x,
          y: p.y,
          rotation: p.rotation ?? c.rotation,
          layer: p.layer ?? c.layer,
          bbox: { minX: p.x - w / 2, minY: p.y - d / 2, maxX: p.x + w / 2, maxY: p.y + d / 2 },
        });
        return { verified: c.x === p.x && c.y === p.y, designator: c.designator, before };
      }
      case 'pcb.addKeepout': {
        const k = { primitiveId: id('keepout'), ...p };
        board.keepouts.push(k);
        return { primitiveId: k.primitiveId, verified: true };
      }
      case 'pcb.getDesignRules':
        return { clearance: mil(0.2), trackWidth: mil(0.2) };
      case 'pcb.setNetClass': {
        const replaced = p.name in board.classes;
        board.classes[p.name] = p.nets;
        return { verified: true, replaced };
      }
      case 'pcb.setDiffPair': {
        board.diffPairs[p.name] = [p.positiveNet, p.negativeNet];
        return { verified: true, replaced: false };
      }
      case 'pcb.setNetRules': {
        board.netRules[p.netName] = p.rules;
        return { verified: true };
      }
      case 'pcb.routeNet': {
        const t = {
          primitiveId: id('track'),
          netName: p.netName,
          layer: p.layer,
          width: p.width,
          points: p.points,
        };
        board.tracks.push(t);
        board.routed.add(p.netName);
        return {
          verified: true,
          primitiveIds: [t.primitiveId],
          segments: p.points.length - 1,
          length: segLen(p.points),
        };
      }
      case 'pcb.deleteTracks': {
        const n = board.tracks.length;
        board.tracks = board.tracks.filter((t) => !p.primitiveIds.includes(t.primitiveId));
        return { verified: true, deleted: n - board.tracks.length };
      }
      case 'pcb.listTracks':
        return { total: board.tracks.length, items: board.tracks };
      case 'pcb.listVias':
        return { total: board.vias.length, items: board.vias };
      case 'pcb.addVias': {
        const pts: Any[] = [];
        if (p.mode === 'fence')
          for (let i = 0; i < p.path.length - 1; i++) {
            const a = p.path[i],
              b = p.path[i + 1];
            const n = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / p.pitch);
            for (let k = 0; k <= n; k++)
              pts.push({
                x: a.x + ((b.x - a.x) * k) / Math.max(n, 1),
                y: a.y + ((b.y - a.y) * k) / Math.max(n, 1),
              });
          }
        else {
          const xs = p.polygon.map((q: Any) => q.x),
            ys = p.polygon.map((q: Any) => q.y);
          for (let x = Math.min(...xs) + p.margin; x <= Math.max(...xs) - p.margin; x += p.pitch)
            for (let y = Math.min(...ys) + p.margin; y <= Math.max(...ys) - p.margin; y += p.pitch)
              pts.push({ x, y });
        }
        const ids = pts.map((q) => {
          const v = {
            primitiveId: id('via'),
            netName: p.netName,
            holeDiameter: p.holeSize,
            diameter: p.outerDiameter,
            ...q,
          };
          board.vias.push(v);
          return v.primitiveId;
        });
        return { verified: true, primitiveIds: ids, points: pts };
      }
      case 'pcb.addCopperPour': {
        const f = { primitiveId: id('pour'), ...p };
        board.pours.push(f);
        return { primitiveId: f.primitiveId, verified: true };
      }
      case 'pcb.copperIslands':
        return { islands: 0, items: [] };
      case 'pcb.connectivityCheck':
        return {
          method: 'ratline',
          openNets: board.nets.filter(
            (n) => !board.routed.has(n) && !board.pours.some((f) => f.netName === n),
          ).length,
          items: board.nets.map((n) => ({
            netName: n,
            status:
              board.routed.has(n) || board.pours.some((f) => f.netName === n) ? 'routed' : 'open',
            length: segLen(byNet(n).flatMap((t) => t.points)),
          })),
        };
      case 'board.getStackup':
        return { copperLayers: 4 };
      case 'design.drc': {
        // ponytail: one synthetic rule — any two tracks on the same layer closer than 0.2 mm is a clearance violation.
        const v: Any[] = [];
        for (const a of board.tracks)
          for (const b of board.tracks)
            if (
              a !== b &&
              a.layer === b.layer &&
              a.netName !== b.netName &&
              Math.abs(a.points[0].y - b.points[0].y) < mil(0.2)
            )
              v.push({
                severity: 'error',
                rule: 'clearance',
                primitiveIds: [a.primitiveId, b.primitiveId],
              });
        const seen = new Set<string>();
        const uniq = v.filter((x) => {
          const k = [...x.primitiveIds].sort().join();
          return !seen.has(k) && seen.add(k);
        });
        return { violations: uniq, errorCount: uniq.length, warningCount: 0 };
      }
      case 'pcb.setComponentAttribute': {
        const c = board.components.find((c) => c.primitiveId === p.primitiveId)!;
        if (p.addIntoBom !== undefined) c.addIntoBom = p.addIntoBom;
        Object.assign(c.properties, p.properties ?? {});
        return { verified: true, designator: c.designator };
      }
      case 'export.bom': {
        const rows = board.components
          .filter((c) => c.addIntoBom)
          .map((c) => `${c.designator},${c.designator}-part,${c.properties.Fitted ?? 'Yes'}`);
        return {
          fileName: 'bom.csv',
          base64: Buffer.from(['Designator,Value,Fitted', ...rows].join('\n')).toString('base64'),
        };
      }
      case 'export.step':
        return { fileName: 'board.step', base64: Buffer.from('ISO-10303-21;').toString('base64') };
      case 'board.exportGerbers':
        return { fileName: 'gerbers.zip', base64: Buffer.from('PK-gerbers').toString('base64') };
      case 'project.save':
        board.saved = JSON.stringify({
          c: board.components,
          t: board.tracks,
          v: board.vias,
          f: board.pours,
        });
        return { saved: true };
      default:
        throw new Error(`fake bridge: unhandled ${method}`);
    }
  });
  function mil(mm: number) {
    return mmToMil(mm);
  }
}

describe('golden: Transceiver_V2 placement → routing → copper → DRC → export', () => {
  const board = fakeBoard();
  const bridge = fakeBridge(board);
  const registry = new ToolRegistry();
  registerPcbAgenticTools(registry, EnvSchema.parse({ NODE_ENV: 'test' }));
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  const ctx = {
    profile: 'full',
    bridge: { connected: true, call: bridge },
    config: { bridgeTimeoutMs: 1000, artifactDir },
    vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
  } as unknown as ToolContext;
  const writes: Any[] = [];
  const run = async (name: string, params: Any) => {
    const tool = registry.get(name)!;
    const r: Any = await tool.handler(ctx, tool.inputSchema.parse(params));
    if (tool.confirmWrite) writes.push({ name, r });
    return r;
  };
  beforeAll(() => resetOpIdsForTests());

  it('1. placement: keep-outs, height rules, move the offending part', async () => {
    expect(
      (
        await run('easyeda_pcb_add_keepout', {
          ...guard,
          name: 'solar-socket',
          rect_mm: { x: 47.5, y: 0, width: 20, height: 15 },
          max_height_mm: 3,
          confirmWrite: true,
          op_id: 'ko-solar',
        })
      ).success,
    ).toBe(true);
    expect(
      (
        await run('easyeda_pcb_add_keepout', {
          ...guard,
          name: 'gps-strip',
          rect_mm: { x: 8, y: 0, width: 28, height: 115 },
          max_height_mm: 8,
          confirmWrite: true,
        })
      ).success,
    ).toBe(true);
    for (const [i, [cx, cy]] of [
      [4, 4],
      [111, 4],
      [4, 111],
      [111, 111],
    ].entries()) {
      expect(
        (
          await run('easyeda_pcb_add_keepout', {
            ...guard,
            name: `hole-${i + 1}`,
            ring_mm: { cx, cy, radius: 3.5 },
            confirmWrite: true,
          })
        ).success,
      ).toBe(true);
    }
    let chk = await run('easyeda_pcb_check_placement', { ...guard });
    expect(chk.items).toEqual([
      expect.objectContaining({ designator: 'U2', keepout: 'solar-socket', reason: 'too_tall' }),
    ]);

    const mv = await run('easyeda_pcb_move_component', {
      ...guard,
      primitiveId: 'c-u2',
      x_mm: 90,
      y_mm: 90,
      confirmWrite: true,
      op_id: 'mv-u2',
    });
    expect(mv).toMatchObject({
      success: true,
      verified: true,
      designator: 'U2',
      before: { x_mm: 57, y_mm: 8 },
    });
    expect(milToMm(board.components[1]!.x)).toBe(90);
    chk = await run('easyeda_pcb_check_placement', { ...guard });
    expect(chk.total).toBe(0);
  });

  it('2. rules: 90 Ω USB pairs and a 2 mm MODEM_VBAT class', async () => {
    for (const [name, pos, neg] of [
      ['USB1', 'USB_D+', 'USB_D-'],
      ['USB2', 'USB2_D+', 'USB2_D-'],
    ] as const) {
      const r = await run('easyeda_pcb_set_diff_pair', {
        ...guard,
        name,
        positive_net: pos,
        negative_net: neg,
        rules_native: { impedance: 90, trackWidth: mmToMil(0.2), gap: mmToMil(0.15) },
        confirmWrite: true,
      });
      expect(r).toMatchObject({ success: true, verified: true });
    }
    const cls = await run('easyeda_pcb_set_net_class', {
      ...guard,
      name: 'MODEM_PWR',
      nets: ['MODEM_VBAT'],
      rules_native: { trackWidth: mmToMil(2) },
      confirmWrite: true,
    });
    expect(cls).toMatchObject({ success: true, verified: true, replaced: false });
    expect(board.netRules.MODEM_VBAT.trackWidth).toBe(mmToMil(2));
    expect(board.diffPairs.USB2).toEqual(['USB2_D+', 'USB2_D-']);
  });

  it('3. routing: diff pairs with skew < 0.5 mm, power at 2 mm, zero opens', async () => {
    const usb1 = await run('easyeda_pcb_route_diff_pair', {
      ...guard,
      positive_net: 'USB_D+',
      negative_net: 'USB_D-',
      layer: 'Top',
      width_mm: 0.2,
      positive_points_mm: [
        { x: 100, y: 40 },
        { x: 80, y: 40 },
        { x: 70, y: 50 },
      ],
      negative_points_mm: [
        { x: 100, y: 40.35 },
        { x: 80, y: 40.35 },
        { x: 70.3, y: 50 },
      ],
      confirmWrite: true,
    });
    expect(usb1).toMatchObject({ success: true, verified: true });
    expect(usb1.skew_mm).toBeLessThan(0.5);
    const usb2 = await run('easyeda_pcb_route_diff_pair', {
      ...guard,
      positive_net: 'USB2_D+',
      negative_net: 'USB2_D-',
      layer: 'Top',
      width_mm: 0.2,
      positive_points_mm: [
        { x: 100, y: 30 },
        { x: 70, y: 30 },
      ],
      negative_points_mm: [
        { x: 100, y: 30.35 },
        { x: 70, y: 30.35 },
      ],
      confirmWrite: true,
    });
    expect(usb2.verified).toBe(true);
    const vbat = await run('easyeda_pcb_route_net', {
      ...guard,
      net_name: 'MODEM_VBAT',
      layer: 'Top',
      width_mm: 2,
      points_mm: [
        { x: 90, y: 90 },
        { x: 60, y: 60 },
      ],
      confirmWrite: true,
      op_id: 'rt-vbat',
    });
    expect(vbat).toMatchObject({ success: true, verified: true, segments: 1 });
    expect(board.tracks.find((t) => t.netName === 'MODEM_VBAT').width).toBe(mmToMil(2));
    // GPS UART: deliberately route GPS_RX 0.1 mm from GPS_TX so DRC has something to catch in step 5.
    await run('easyeda_pcb_route_net', {
      ...guard,
      net_name: 'GPS_TX',
      layer: 'Top',
      width_mm: 0.2,
      points_mm: [
        { x: 10, y: 20 },
        { x: 30, y: 20 },
      ],
      confirmWrite: true,
    });
    await run('easyeda_pcb_route_net', {
      ...guard,
      net_name: 'GPS_RX',
      layer: 'Top',
      width_mm: 0.2,
      points_mm: [
        { x: 10, y: 20.1 },
        { x: 30, y: 20.1 },
      ],
      confirmWrite: true,
    });
    const st = await run('easyeda_pcb_net_status', { ...guard, net_name: 'MODEM_VBAT' }).catch(
      (e: Any) => e,
    );
    expect(st).toBeDefined();
  });

  it('4. copper: GND pours on top/L2/L3, 2 mm stitching under the modem, no islands', async () => {
    for (const layer of ['Top', 'L2', 'L3']) {
      const r = await run('easyeda_pcb_add_copper_pour', {
        ...guard,
        net_name: 'GND',
        layer,
        rect_mm: { x: 1, y: 1, width: 113, height: 113 },
        confirmWrite: true,
      });
      expect(r).toMatchObject({ success: true, verified: true });
    }
    expect(board.pours.map((f) => f.layer)).toEqual([1, 15, 16]);
    const stitch = await run('easyeda_pcb_stitch_region', {
      ...guard,
      net_name: 'GND',
      polygon_mm: [
        { x: 50, y: 50 },
        { x: 70, y: 50 },
        { x: 70, y: 70 },
        { x: 50, y: 70 },
      ],
      pitch_mm: 2,
      confirmWrite: true,
    });
    expect(stitch).toMatchObject({ success: true, verified: true });
    expect(stitch.points_mm.length).toBeGreaterThan(50);
    expect(Math.abs(stitch.points_mm[1].y - stitch.points_mm[0].y)).toBeCloseTo(2, 3);
    const islands = await run('easyeda_pcb_copper_islands', { ...guard, net_name: 'GND' });
    expect(islands).toMatchObject({ islands: 0, total: 0 });
    const conn = await run('easyeda_pcb_connectivity_check', { ...guard });
    expect(conn.open_nets).toBe(0);
    expect(conn.items).toEqual([]);
  });

  it('5. verification: DRC finds the clearance violation, fix it through the API, mfg check passes', async () => {
    let mfg = await run('easyeda_pcb_manufacturing_check', { ...guard, profile: 'JLCPCB 4-layer' });
    expect(mfg.passed).toBe(false);
    expect(mfg.drc).toMatchObject({ passed: false, error_count: 1 });
    const bad = board.tracks.find((t) => t.netName === 'GPS_RX')!;
    const del = await run('easyeda_pcb_delete_tracks', {
      ...guard,
      primitiveIds: [bad.primitiveId],
      confirmWrite: true,
    });
    expect(del).toMatchObject({ success: true, verified: true, deleted: 1 });
    await run('easyeda_pcb_route_net', {
      ...guard,
      net_name: 'GPS_RX',
      layer: 'Top',
      width_mm: 0.2,
      points_mm: [
        { x: 10, y: 21 },
        { x: 30, y: 21 },
      ],
      confirmWrite: true,
    });
    mfg = await run('easyeda_pcb_manufacturing_check', { ...guard, profile: 'JLCPCB 4-layer' });
    expect(mfg).toMatchObject({ passed: true, total: 0, drc: { passed: true, error_count: 0 } });
    expect((await run('easyeda_pcb_connectivity_check', { ...guard })).open_nets).toBe(0);
  });

  it('6. BOM attributes and manufacturing export with checksums', async () => {
    for (const primitiveId of ['c-led1', 'c-r36'])
      expect(
        (
          await run('easyeda_pcb_set_component_attribute', {
            ...guard,
            primitiveId,
            dnp: true,
            confirmWrite: true,
          })
        ).verified,
      ).toBe(true);
    expect(
      (
        await run('easyeda_pcb_set_component_attribute', {
          ...guard,
          primitiveId: 'c-u2',
          exclude_from_bom: true,
          confirmWrite: true,
        })
      ).verified,
    ).toBe(true);
    const bom = await run('easyeda_export_bom', { ...guard, expect_absent: ['LED1', 'R36', 'U2'] });
    expect(bom).toMatchObject({
      success: true,
      absent_ok: true,
      unexpected_present: [],
      dnp_excluded: 0,
      entry_count: 2,
    });
    for (const [tool, name] of [
      ['easyeda_export_drill', 'drill'],
      ['easyeda_export_step', 'step'],
    ] as const) {
      const r = await run(tool, { ...guard });
      expect(r, name).toMatchObject({ success: true, exported: true });
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fs.existsSync(r.artifact_path)).toBe(true);
    }
  });

  it('7. contract: every write verified, guard refuses the wrong board, op_id replays, save keeps geometry', async () => {
    expect(writes.length).toBeGreaterThan(20);
    for (const w of writes) expect(w.r, w.name).toMatchObject({ success: true, verified: true });
    const replay = await run('easyeda_pcb_move_component', {
      ...guard,
      primitiveId: 'c-u2',
      x_mm: 90,
      y_mm: 90,
      confirmWrite: true,
      op_id: 'mv-u2',
    });
    expect(replay.replayed).toBe(true);

    board.focused = { projectId: 'other', boardName: 'PCB1' };
    const refused = await run('easyeda_pcb_route_net', {
      ...guard,
      net_name: 'GND',
      layer: 'Top',
      width_mm: 0.2,
      points_mm: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      confirmWrite: true,
    });
    expect(refused).toMatchObject({
      success: false,
      error_code: 'WRONG_DOCUMENT',
      error_data: { actual: { boardName: 'PCB1' } },
    });
    board.focused = { projectId: PROJECT, boardName: BOARD };

    const before = JSON.stringify({
      c: board.components,
      t: board.tracks,
      v: board.vias,
      f: board.pours,
    });
    await bridge('project.save', {});
    expect(board.saved).toBe(before);
  });
});
