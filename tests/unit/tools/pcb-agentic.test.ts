import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { registerPcbAgenticTools } from '../../../src/tools/L1_pcb_agentic.js';
import { registerPcbWriteTools } from '../../../src/tools/L1_pcb_write.js';
import { registerVisualTools } from '../../../src/tools/L1_visual.js';
import { EnvSchema } from '../../../src/config/env.js';
import { layerId, layerName, mmToMil, milToMm, paginate, resetOpIdsForTests } from '../../../src/tools/agentic-common.js';

const PROJECT = 'd65fa3a1550a4891b5298f3de4c69fae';
const guard = { projectId: PROJECT, boardName: 'Transceiver_V2' };

describe('agentic-common', () => {
  it('converts units both ways', () => {
    expect(mmToMil(2.54)).toBe(100);
    expect(milToMm(100)).toBe(2.54);
  });
  it('maps layer names, copper indexes and ids', () => {
    expect(layerId('Top')).toBe(1);
    expect(layerId('inner 1')).toBe(15);
    expect(layerId('L2')).toBe(15);
    expect(layerId('L4')).toBe(2);
    expect(layerId(11)).toBe(11);
    expect(layerName(16)).toBe('Inner2');
    expect(() => layerId('Nope')).toThrow(/Unknown layer/);
  });
  it('paginates', () => {
    expect(paginate([1, 2, 3], { limit: 2, offset: 0 })).toEqual({ items: [1, 2], total: 3, next_offset: 2 });
    expect(paginate([1, 2, 3], { limit: 2, offset: 2 })).toEqual({ items: [3], total: 3, next_offset: undefined });
  });
});

describe('PCB agentic tools', () => {
  let registry: ToolRegistry;
  let context: ToolContext;
  let bridgeCall: ReturnType<typeof vi.fn>;
  let artifactDir: string;

  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = registry.get(name);
    expect(tool, name).toBeDefined();
    return tool!.handler(context, tool!.inputSchema.parse(params)) as Promise<any>;
  };

  beforeEach(() => {
    registry = new ToolRegistry();
    const config = EnvSchema.parse({ NODE_ENV: 'test' });
    registerPcbAgenticTools(registry, config);
    registerPcbWriteTools(registry, config);
    registerVisualTools(registry, config);
    resetOpIdsForTests();
    artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-'));
    bridgeCall = vi.fn(async () => ({}));
    context = {
      profile: 'full',
      bridge: { connected: true, call: bridgeCall },
      config: { bridgeTimeoutMs: 1000, artifactDir },
      vendors: { lcsc: null, jlcpcb: null, mouser: null, digikey: null },
    } as unknown as ToolContext;
  });

  it('registers every agentic tool with the shared contract', () => {
    const names = [
      'easyeda_pcb_component_bounds', 'easyeda_pcb_move_component', 'easyeda_pcb_move_group', 'easyeda_pcb_add_keepout',
      'easyeda_pcb_list_keepouts', 'easyeda_pcb_check_placement', 'easyeda_pcb_get_design_rules', 'easyeda_pcb_set_design_rules',
      'easyeda_pcb_set_net_class', 'easyeda_pcb_set_diff_pair', 'easyeda_pcb_net_status', 'easyeda_pcb_set_stackup',
      'easyeda_pcb_route_net', 'easyeda_pcb_route_diff_pair', 'easyeda_pcb_delete_tracks', 'easyeda_pcb_ripup_net',
      'easyeda_pcb_add_via_fence', 'easyeda_pcb_stitch_region', 'easyeda_pcb_add_copper_pour', 'easyeda_pcb_copper_islands',
      'easyeda_pcb_connectivity_check', 'easyeda_pcb_manufacturing_check', 'easyeda_pcb_set_component_attribute',
      'easyeda_export_drill', 'easyeda_export_bom', 'easyeda_export_step', 'easyeda_project_export_epro',
      'easyeda_schematic_wires_at_pin', 'easyeda_schematic_delete_wire', 'easyeda_schematic_rename_net',
      'easyeda_schematic_set_net_label', 'easyeda_schematic_component_replace', 'easyeda_canvas_capture_board_region',
    ];
    for (const name of names) {
      const tool = registry.get(name)!;
      expect(tool, name).toBeDefined();
      if (tool.confirmWrite) {
        expect(tool.inputSchema.safeParse({ ...guard, confirmWrite: 'true' }).success, name).toBe(false);
      }
    }
    // every pcb_* write requires projectId
    for (const tool of registry.getAllTools().filter((t) => t.name.startsWith('easyeda_pcb_') && t.confirmWrite && t.group === 'pcb-write' && names.includes(t.name))) {
      expect(tool.inputSchema.safeParse({ confirmWrite: true }).success, tool.name).toBe(false);
    }
  });

  it('move_component converts mm to mil, passes expect and reports verification', async () => {
    bridgeCall.mockResolvedValueOnce({ verified: true, designator: 'U2', before: { x: 1000, y: 2000, layer: 1, rotation: 0 } });
    const r = await run('easyeda_pcb_move_component', { ...guard, primitiveId: 'c1', x_mm: 25.4, y_mm: 50.8, rotation_deg: 90, layer: 'Bottom', confirmWrite: true, op_id: 'op-1' });
    expect(bridgeCall).toHaveBeenCalledWith('pcb.moveComponent', { primitiveId: 'c1', x: 1000, y: 2000, rotation: 90, layer: 2, expect: guard });
    expect(r).toMatchObject({ success: true, verified: true, designator: 'U2', before: { x_mm: 25.4, y_mm: 50.8, layer: 'Top' }, replayed: false, op_id: 'op-1' });
    // replay: same op_id, no second bridge write
    const again = await run('easyeda_pcb_move_component', { ...guard, primitiveId: 'c1', x_mm: 25.4, y_mm: 50.8, confirmWrite: true, op_id: 'op-1' });
    expect(again.replayed).toBe(true);
    expect(bridgeCall).toHaveBeenCalledTimes(1);
  });

  it('returns structured WRONG_DOCUMENT failures from the bridge', async () => {
    bridgeCall.mockRejectedValueOnce(Object.assign(new Error('Focused PCB is not the expected board'), { code: 'WRONG_DOCUMENT', suggestion: 'Focus the tab', data: { actual: { name: 'PCB1' } } }));
    const r = await run('easyeda_pcb_ripup_net', { ...guard, net_name: 'GND', confirmWrite: true });
    expect(r).toEqual({ success: false, error: 'Focused PCB is not the expected board', error_code: 'WRONG_DOCUMENT', hint: 'Focus the tab', error_data: { actual: { name: 'PCB1' } } });
  });

  it('add_keepout stores height rules and check_placement enforces them', async () => {
    bridgeCall.mockResolvedValueOnce({ primitiveId: 'k1', verified: true, signature: 'polygon-object' });
    const k = await run('easyeda_pcb_add_keepout', { ...guard, name: 'solar', rect_mm: { x: 47.5, y: 0, width: 20, height: 15 }, max_height_mm: 3, confirmWrite: true });
    expect(k.success).toBe(true);
    // height keep-out: native rules exclude Component so parts may sit there
    expect(bridgeCall.mock.calls[0][1]).toMatchObject({ layer: 12, rules: [], expect: guard });
    expect(bridgeCall.mock.calls[0][1].points[2]).toEqual({ x: mmToMil(67.5), y: mmToMil(15) });
    bridgeCall.mockResolvedValueOnce({ primitiveId: 'k2', verified: true });
    await run('easyeda_pcb_add_keepout', { ...guard, name: 'hole1', ring_mm: { cx: 5, cy: 5, radius: 3.5 }, confirmWrite: true });
    expect(bridgeCall.mock.calls[1][1]).toMatchObject({ rules: ['Component'] });
    expect(bridgeCall.mock.calls[1][1].points).toHaveLength(32);

    const list = await run('easyeda_pcb_list_keepouts', { ...guard });
    expect(list.total).toBe(2);
    expect(list.items[0]).toMatchObject({ name: 'solar', max_height_mm: 3 });

    const mil = (mm: number) => mmToMil(mm);
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listComponents') return { total: 3, items: [{ primitiveId: 'a' }, { primitiveId: 'b' }, { primitiveId: 'c' }] };
      if (method === 'pcb.componentBounds') return { items: [
        { primitiveId: 'a', designator: 'C1', heightMm: 1, bbox: { minX: mil(50), minY: mil(2), maxX: mil(52), maxY: mil(4) } },
        { primitiveId: 'b', designator: 'U9', heightMm: 8, bbox: { minX: mil(55), minY: mil(5), maxX: mil(60), maxY: mil(10) } },
        { primitiveId: 'c', designator: 'R1', heightMm: 1, bbox: { minX: mil(4), minY: mil(4), maxX: mil(6), maxY: mil(6) } },
      ] };
      return {};
    });
    const chk = await run('easyeda_pcb_check_placement', { ...guard });
    expect(chk.components_checked).toBe(3);
    expect(chk.items).toEqual([
      expect.objectContaining({ designator: 'U9', keepout: 'solar', reason: 'too_tall', height_mm: 8, max_height_mm: 3 }),
      expect.objectContaining({ designator: 'R1', keepout: 'hole1', reason: 'component_forbidden' }),
    ]);
  });

  it('set_net_class applies native rules per net and aggregates verified', async () => {
    bridgeCall.mockImplementation(async (method: string) => (method === 'pcb.setNetClass' ? { verified: true, replaced: false } : { verified: true }));
    const r = await run('easyeda_pcb_set_net_class', { ...guard, name: 'PWR', nets: ['MODEM_VBAT'], rules_native: { trackWidth: 78.74 }, confirmWrite: true });
    expect(bridgeCall).toHaveBeenCalledWith('pcb.setNetRules', { netName: 'MODEM_VBAT', rules: { trackWidth: 78.74 } });
    expect(r).toMatchObject({ success: true, verified: true, replaced: false });
  });

  it('route_diff_pair refuses skewed paths before writing', async () => {
    const r = await run('easyeda_pcb_route_diff_pair', { ...guard, positive_net: 'D+', negative_net: 'D-', layer: 'Top', width_mm: 0.2, positive_points_mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }], negative_points_mm: [{ x: 0, y: 1 }, { x: 12, y: 1 }], confirmWrite: true });
    expect(r).toMatchObject({ success: false, error_code: 'SKEW_EXCEEDED', error_data: { skew_mm: 2 } });
    expect(bridgeCall).not.toHaveBeenCalled();
    bridgeCall.mockResolvedValue({ verified: true, primitiveIds: ['t'], segments: 1, length: 1000 });
    const ok = await run('easyeda_pcb_route_diff_pair', { ...guard, positive_net: 'D+', negative_net: 'D-', layer: 'Top', width_mm: 0.2, positive_points_mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }], negative_points_mm: [{ x: 0, y: 1 }, { x: 10.2, y: 1 }], confirmWrite: true });
    expect(ok).toMatchObject({ success: true, verified: true, skew_mm: 0.2, positive: { length_mm: 25.4 } });
    expect(bridgeCall.mock.calls[0][1]).toMatchObject({ netName: 'D+', layer: 1, width: mmToMil(0.2), expect: guard });
  });

  it('via fence and stitching convert geometry to mil', async () => {
    bridgeCall.mockResolvedValue({ verified: true, primitiveIds: ['v1'], points: [{ x: 100, y: 100 }] });
    const f = await run('easyeda_pcb_add_via_fence', { ...guard, net_name: 'GND', path_mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }], pitch_mm: 2, confirmWrite: true });
    expect(bridgeCall.mock.calls[0][1]).toMatchObject({ mode: 'fence', pitch: mmToMil(2), holeSize: mmToMil(0.3), outerDiameter: mmToMil(0.6) });
    expect(f.points_mm).toEqual([{ x: 2.54, y: 2.54 }]);
    await run('easyeda_pcb_stitch_region', { ...guard, net_name: 'GND', polygon_mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], pitch_mm: 2, confirmWrite: true });
    expect(bridgeCall.mock.calls[1][1]).toMatchObject({ mode: 'stitch', margin: mmToMil(0.5) });
  });

  it('manufacturing_check flags sub-limit tracks and vias and folds in DRC', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'pcb.listTracks') return { total: 2, items: [{ primitiveId: 't1', width: mmToMil(0.05) }, { primitiveId: 't2', width: mmToMil(0.2) }] };
      if (method === 'pcb.listVias') return { total: 1, items: [{ primitiveId: 'v1', holeDiameter: mmToMil(0.1), diameter: mmToMil(0.3) }] };
      if (method === 'board.getStackup') return { copperLayers: 4 };
      if (method === 'design.drc') return { violations: [{ severity: 'error' }], errorCount: 1, warningCount: 0 };
      return {};
    });
    const r = await run('easyeda_pcb_manufacturing_check', { ...guard });
    expect(r.passed).toBe(false);
    expect(r.items.map((i: any) => i.kind)).toEqual(['track_width', 'via_hole']);
    expect(r.drc).toMatchObject({ passed: false, error_count: 1 });
    const bad = await run('easyeda_pcb_manufacturing_check', { ...guard, profile: 'Nope' });
    expect(bad).toMatchObject({ success: false, error_code: 'UNKNOWN_PROFILE' });
  });

  it('set_component_attribute maps dnp / exclude_from_bom', async () => {
    bridgeCall.mockResolvedValue({ verified: true, designator: 'LED1' });
    await run('easyeda_pcb_set_component_attribute', { ...guard, primitiveId: 'c1', dnp: true, confirmWrite: true });
    expect(bridgeCall).toHaveBeenLastCalledWith('pcb.setComponentAttribute', { primitiveId: 'c1', addIntoBom: false, properties: { Fitted: 'No', DNP: 'Yes' }, expect: guard });
    await run('easyeda_pcb_set_component_attribute', { ...guard, primitiveId: 'c2', exclude_from_bom: true, confirmWrite: true });
    expect(bridgeCall).toHaveBeenLastCalledWith('pcb.setComponentAttribute', { primitiveId: 'c2', addIntoBom: false, properties: undefined, expect: guard });
  });

  it('export_bom drops Fitted=No rows, confirms absences and checksums the file', async () => {
    const csv = 'Designator,Value,Fitted\nR1,10k,Yes\nLED1,RED,No\n"R36,R37",1k,No\nU2,SIM7080G,Yes\n';
    bridgeCall.mockResolvedValue({ base64: Buffer.from(csv).toString('base64'), fileName: 'bom.csv' });
    const r = await run('easyeda_export_bom', { ...guard, expect_absent: ['LED1', 'R36', 'U2'] });
    expect(r).toMatchObject({ success: true, exported: true, entry_count: 2, dnp_excluded: 2, unexpected_present: ['U2'], absent_ok: false });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(r.artifact_path, 'utf-8')).toBe('Designator,Value,Fitted\nR1,10k,Yes\nU2,SIM7080G,Yes');
  });

  it('export_step / export_drill write artifacts with sha256; epro fails closed', async () => {
    bridgeCall.mockResolvedValue({ base64: Buffer.from('STEP').toString('base64'), fileName: 'x.step' });
    const s = await run('easyeda_export_step', { ...guard });
    expect(s).toMatchObject({ success: true, exported: true, byte_length: 4 });
    expect(path.dirname(s.artifact_path)).toBe(artifactDir);
    const d = await run('easyeda_export_drill', { ...guard });
    expect(bridgeCall).toHaveBeenLastCalledWith('board.exportGerbers', { projectId: PROJECT, drillFormat: 'excellon', note: 'Drill files are inside the Gerber zip.' });
    expect(d.note).toMatch(/inside the Gerber zip/);
    const outside = await run('easyeda_export_step', { ...guard, filePath: path.join(os.tmpdir(), '..', 'evil.step') });
    expect(outside).toMatchObject({ success: false, error_code: 'PATH_OUTSIDE_ARTIFACT_DIR' });
    const e = await run('easyeda_project_export_epro', { projectId: PROJECT });
    expect(e).toMatchObject({ success: false, not_available: true, error_code: 'NOT_SUPPORTED' });
  });

  it('schematic wires_at_pin resolves reference + pin via component pins', async () => {
    bridgeCall.mockImplementation(async (method: string) => {
      if (method === 'schematic.listComponents') return { total: 1, items: [{ primitiveId: 's1', reference: 'U2' }] };
      if (method === 'api.call') return { result: [{ pinNumber: '3', pinName: 'VBAT', x: 100, y: 200 }] };
      if (method === 'schematic.wiresAtPin') return { items: [{ primitiveId: 'w1' }] };
      return {};
    });
    const r = await run('easyeda_schematic_wires_at_pin', { projectId: PROJECT, reference: 'U2', pin_number: '3' });
    expect(r).toMatchObject({ success: true, total: 1, items: [{ primitiveId: 'w1' }] });
    expect(bridgeCall).toHaveBeenLastCalledWith('schematic.wiresAtPin', { x: 100, y: 200, tolerance: 1 });
  });

  it('schematic writes take op_id and map fields', async () => {
    bridgeCall.mockResolvedValue({ verified: true, primitiveId: 'n1' });
    const r = await run('easyeda_schematic_set_net_label', { net_name: 'MODEM_VBAT', x: 10, y: 20, confirmWrite: true, op_id: 'lbl' });
    expect(bridgeCall).toHaveBeenCalledWith('schematic.setNetLabel', { netName: 'MODEM_VBAT', x: 10, y: 20, rotation: 0 });
    expect(r).toMatchObject({ success: true, verified: true, op_id: 'lbl', replayed: false });
  });

  it('legacy pcb writes pass expect only when projectId is given', async () => {
    bridgeCall.mockResolvedValue({ primitiveId: 'v1' });
    await run('easyeda_pcb_add_via', { x: 1, y: 2, outerDiameter: 24, holeSize: 12, confirmWrite: true });
    expect(bridgeCall).toHaveBeenLastCalledWith('pcb.addVia', { x: 1, y: 2, outerDiameter: 24, holeSize: 12, netName: undefined });
    await run('easyeda_pcb_add_via', { ...guard, x: 1, y: 2, outerDiameter: 24, holeSize: 12, confirmWrite: true });
    expect(bridgeCall).toHaveBeenLastCalledWith('pcb.addVia', { x: 1, y: 2, outerDiameter: 24, holeSize: 12, netName: undefined, expect: guard });
    await run('easyeda_pcb_modify_via', { ...guard, primitiveId: 'v1', x: 5, confirmWrite: true });
    expect(bridgeCall).toHaveBeenLastCalledWith('pcb.modifyVia', { primitiveId: 'v1', x: 5, expect: guard });
  });

  it('canvas_capture_board_region converts mm to native and reports layers_applied=false', async () => {
    bridgeCall.mockResolvedValue({ imageBase64: 'AAAA', width: 10, height: 10 });
    const r = await run('easyeda_canvas_capture_board_region', { x_mm: 2.54, y_mm: 0, width_mm: 2.54, height_mm: 5.08, layers: ['Top'] });
    expect(bridgeCall.mock.calls[0][1]).toMatchObject({ left: 100, right: 200, top: 200, bottom: 0 });
    expect(r).toMatchObject({ layers_requested: ['Top'], layers_applied: false, region_mm: { x: 2.54, y: 0, width: 2.54, height: 5.08 } });
  });
});
