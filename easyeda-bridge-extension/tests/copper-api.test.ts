import { describe, expect, it, vi } from 'vitest';
import { normalizeApiResult } from '../src/api-result.js';
import { createApiRuntime } from '../src/api-runtime.js';

const polygon = {
  complexPolygon: [
    {
      polygon: {
        points: [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
      },
    },
  ],
};

function fixture() {
  const copper = { getState_PourFills: () => [{ path: polygon }] };
  const pour = {
    copper,
    getCopperRegion() {
      return Promise.resolve(this.copper);
    },
    rebuildCopperRegion: vi.fn(function (this: { copper: unknown }) {
      return Promise.resolve(this.copper);
    }),
  };
  const current = vi.fn().mockResolvedValue({ uuid: 'copy' });
  const get = vi.fn().mockResolvedValue(pour);
  const runtime = createApiRuntime(
    {
      getEda: () => ({ dmt_Pcb: { getCurrentPcbInfo: current }, pcb_PrimitivePour: { get } }),
      getEDA: () => undefined,
      getApi: () => undefined,
    },
    (code, message) => Object.assign(new Error(message), { code }),
    {},
  );
  return { runtime, pour, current, get };
}

describe('copper API results and instance adapters', () => {
  it('retains numeric vertices from nested copper state and DRC leaves', () => {
    const result = normalizeApiResult([{ getState_PourFills: () => [{ path: polygon }] }]);
    expect(result.serialization.incomplete).toBe(false);
    expect(JSON.stringify(result.result)).toContain('[[1,2],[3,4],[5,6]]');
    const drc = {
      categories: [
        { rules: [{ nets: [{ errors: [{ primitives: [{ id: 'pad-1', position: [5, 6] }] }] }] }] },
      ],
    };
    expect(normalizeApiResult(drc).result).toEqual(drc);
  });

  it('reports depth limits, cycles and failed getters without losing successful call status', () => {
    let deep: unknown = {};
    for (let i = 0; i < 25; i++) deep = { nested: deep };
    expect(normalizeApiResult(deep).serialization.incomplete).toBe(true);
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(normalizeApiResult(cycle).serialization.incomplete).toBe(true);
    expect(
      normalizeApiResult({
        getState_Path() {
          throw new Error('unavailable');
        },
      }).serialization.incomplete,
    ).toBe(true);
    const shared = { vertex: [1, 2] };
    expect(normalizeApiResult([shared, shared]).serialization.incomplete).toBe(false);
  });

  it.each(['getCopperRegion', 'rebuildCopperRegion'])(
    'calls %s with the native receiver on the intended PCB',
    async (method) => {
      const { runtime, current, get } = fixture();
      const response = await runtime.callAllowedApi(`PCB_PrimitivePour.${method}`, [
        { primitiveId: 'pour-1', pcbUuid: 'copy' },
      ]);
      expect(response).toMatchObject({
        serialization: { incomplete: false },
        result: { state: { PourFills: [{ path: polygon }] } },
      });
      expect(get).toHaveBeenCalledWith('pour-1');
      expect(current).toHaveBeenCalledTimes(2);
    },
  );

  it('refuses a different PCB and a focus change during lookup before rebuilding', async () => {
    const { runtime, current, pour } = fixture();
    current.mockResolvedValueOnce({ uuid: 'original' });
    const invoke = () =>
      runtime.callAllowedApi('PCB_PrimitivePour.rebuildCopperRegion', [
        { primitiveId: 'pour-1', pcbUuid: 'copy' },
      ]);
    await expect(invoke()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    current.mockResolvedValueOnce({ uuid: 'copy' }).mockResolvedValueOnce({ uuid: 'original' });
    await expect(invoke()).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(pour.rebuildCopperRegion).not.toHaveBeenCalled();
  });

  it('rejects missing targets, absent primitives and arbitrary instance chains', async () => {
    const { runtime, get } = fixture();
    await expect(
      runtime.callAllowedApi('PCB_PrimitivePour.rebuildCopperRegion', []),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    get.mockResolvedValue(undefined);
    await expect(
      runtime.callAllowedApi('PCB_PrimitivePour.rebuildCopperRegion', [
        { primitiveId: 'gone', pcbUuid: 'copy' },
      ]),
    ).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
    await expect(
      runtime.callAllowedApi('PCB_PrimitivePour.get.constructor', []),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
