import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext, type ToolDefinition } from '../../../src/tools/types.js';
import {
  CURRENT_PROJECT,
  lenientInputSchema,
  normalizeToolInput,
} from '../../../src/tools/input-normalize.js';
import { resolveApiPath } from '../../../src/tools/L0_diagnostics_api.js';
import { expectOf, guardOf, writeResult } from '../../../src/tools/agentic-common.js';

const schema = z.object({
  projectId: z.string().min(1),
  reference: z.string(),
  pin_number: z.string(),
  netName: z.string().optional(),
  limit: z.number().default(10),
  dryRun: z.boolean().optional(),
  lcscIds: z.array(z.string()).optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
});

describe('input normalization', () => {
  it('maps near-miss keys and values onto the schema', () => {
    const out = normalizeToolInput(schema, {
      designator: 'U1',
      pinNumber: 8,
      net: 'GND',
      limit: '5',
      dry_run: 'true',
      lcscIds: '["C1","C2"]',
      polygon: [
        [0, 0],
        [1, 2],
      ],
    });
    expect(out).toEqual({
      projectId: CURRENT_PROJECT,
      reference: 'U1',
      pin_number: '8',
      netName: 'GND',
      limit: 5,
      dryRun: true,
      lcscIds: ['C1', 'C2'],
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 2 },
      ],
    });
    expect(schema.safeParse(out).success).toBe(true);
  });

  it('keeps explicit keys and still rejects wrong input', () => {
    expect(normalizeToolInput(schema, { reference: 'R1', designator: 'U1' })).toMatchObject({
      reference: 'R1',
      designator: 'U1',
    });
    const r = lenientInputSchema(schema)['~standard'].validate({
      reference: 'R1',
      pin_number: 'x',
      limit: 'many',
    });
    expect(r).toHaveProperty('issues');
  });

  it('validates through the published wrapper', () => {
    const r = lenientInputSchema(schema)['~standard'].validate({ ref: 'R1', pin: 2 });
    expect(r).toEqual({
      value: expect.objectContaining({
        projectId: 'current',
        reference: 'R1',
        pin_number: '2',
        limit: 10,
      }),
    });
  });
});

describe('api_call path handling', () => {
  it('accepts eda. prefixes, lowercase class prefixes and className+method', () => {
    expect(resolveApiPath({ path: 'eda.pcb_PrimitiveRegion.get' })).toBe('PCB_PrimitiveRegion.get');
    expect(resolveApiPath({ className: 'SCH_PrimitiveWire', method: 'getAll' })).toBe(
      'SCH_PrimitiveWire.getAll',
    );
    expect(() => resolveApiPath({ path: 'getAll' })).toThrow(/Expected Class.method/);
  });

  it('runs reads without confirmWrite and still gates setters', async () => {
    const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });
    const registry = new ToolRegistry();
    registry.setProfile('dev');
    registerBuiltinTools(registry, config);
    const handlers = new Map<string, (input: unknown) => Promise<any>>();
    const bridgeCall = vi.fn().mockResolvedValue({ result: [] });
    registry.registerAllOnServer(
      {
        registerTool: (name: string, _d: unknown, h: (i: unknown) => Promise<any>) =>
          handlers.set(name, h),
      } as any,
      {
        profile: 'dev',
        bridge: { connected: true, call: bridgeCall },
        config,
      } as unknown as ToolContext,
    );
    const callApi = handlers.get('easyeda_api_call')!;

    const read = await callApi({ path: 'eda.pcb_PrimitiveRegion.getAll' });
    expect(read.isError).toBeFalsy();
    expect(bridgeCall).toHaveBeenCalledWith(
      'api.call',
      expect.objectContaining({ path: 'PCB_PrimitiveRegion.getAll' }),
    );

    bridgeCall.mockClear();
    const setter = await callApi({
      path: 'SCH_PrimitiveComponent.setState_Designator',
      args: ['c1', 'U2'],
    });
    expect(setter.structuredContent).toMatchObject({ ok: false, requires_confirmation: true });
    expect(bridgeCall).not.toHaveBeenCalled();
  });
});

describe('registry failure reporting', () => {
  it('passes a tool failure through instead of masking it as output-invalid', async () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'strict_tool',
      title: 't',
      description: 'd',
      profile: 'core',
      evidence: ['inferred'],
      risk: 'low',
      confirmWrite: false,
      group: 'test',
      version: '1.0.0',
      annotations: {},
      inputSchema: z.object({}),
      outputSchema: z.object({ success: z.boolean(), items: z.array(z.string()) }),
      handler: async () =>
        ({ success: false, error: 'No PCB focused', error_code: 'CONTEXT_UNAVAILABLE' }) as any,
    };
    registry.register(tool);
    const handlers = new Map<string, (input: unknown) => Promise<any>>();
    registry.registerAllOnServer(
      {
        registerTool: (name: string, _d: unknown, h: (i: unknown) => Promise<any>) =>
          handlers.set(name, h),
      } as any,
      {
        profile: 'core',
        bridge: { connected: true, call: vi.fn() },
        config: {},
        vendors: {},
      } as unknown as ToolContext,
    );
    const res = await handlers.get('strict_tool')!({});
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ error_code: 'CONTEXT_UNAVAILABLE' });
  });
});

describe('agentic write results', () => {
  it('turns verified:false into a failure', () => {
    expect(writeResult({ verified: true })).toMatchObject({ success: true });
    expect(writeResult({ verified: false, expected: 1, actual: 2 })).toMatchObject({
      success: false,
      error_code: 'WRITE_NOT_VERIFIED',
      expected: 1,
      actual: 2,
    });
  });

  it('drops the project guard for projectId "current"', () => {
    expect(expectOf({ projectId: 'current' })).toEqual({
      projectId: undefined,
      boardName: undefined,
    });
    expect(guardOf({ projectId: 'current' })).toEqual({});
    expect(guardOf({ projectId: 'current', boardName: 'B' })).toEqual({
      expect: { projectId: undefined, boardName: 'B' },
    });
  });
});

describe('unknown parameters and document focus', () => {
  it('rejects keys the schema would silently strip, and maps singular designators', async () => {
    const s = lenientInputSchema(
      z.object({ projectId: z.string(), primitiveIds: z.array(z.string()).optional() }),
    );
    const bad = await s['~standard'].validate({ designator: 'U2' });
    expect(bad.issues?.[0]?.message).toContain('Unknown parameter "designator"');
    const refs = lenientInputSchema(z.object({ references: z.array(z.string()) }));
    expect(await refs['~standard'].validate({ designator: 'U1' })).toEqual({
      value: { references: ['U1'] },
    });
  });

  it('focuses the sibling document before schematic/PCB calls', async () => {
    const { ensureDocumentFocus, wantedDocumentType } =
      await import('../../../src/server/auto-focus.js');
    expect(wantedDocumentType('schematic.searchDevice')).toBeUndefined();
    expect(wantedDocumentType('board.getDimensions')).toBe(3);
    expect(wantedDocumentType('api.call', { path: 'eda.sch_PrimitiveComponent.get' })).toBe(1);
    expect(wantedDocumentType('api.call', { path: 'DMT_Board.getAllBoardsInfo' })).toBeUndefined();
    const boards = [{ pcb: { uuid: 'pcb1' }, schematic: { page: [{ uuid: 'page1' }] } }];
    const call = vi.fn(async (_m: string, p?: unknown) => {
      const path = (p as { path: string }).path;
      if (path.endsWith('getCurrentDocumentInfo'))
        return { result: { documentType: 3, uuid: 'pcb1' } };
      if (path.endsWith('getAllBoardsInfo')) return { result: boards };
      return { result: 'ok' };
    });
    await ensureDocumentFocus(call, 'schematic.listNets');
    expect(call).toHaveBeenLastCalledWith('api.call', {
      path: 'DMT_EditorControl.openDocument',
      args: ['page1'],
    });
    call.mockClear();
    await ensureDocumentFocus(call, 'pcb.listTracks');
    expect(call).toHaveBeenCalledTimes(1);
  });
});
