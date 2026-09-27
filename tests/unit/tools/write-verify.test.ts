import { describe, expect, it, vi } from 'vitest';
import { registerBuiltinTools } from '../../../src/tools/register.js';
import { EnvSchema } from '../../../src/config/env.js';
import { ToolRegistry } from '../../../src/tools/registry.js';
import { type ToolContext } from '../../../src/tools/types.js';
import { verifyPropertyWrite } from '../../../src/tools/write-verify.js';

function createDevContext(bridgeCall = vi.fn()): ToolContext {
  const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });

  return {
    profile: 'dev',
    bridge: {
      connected: true,
      call: bridgeCall,
    },
    config,
  } as unknown as ToolContext;
}

function createDevRegistry(): ToolRegistry {
  const config = EnvSchema.parse({ NODE_ENV: 'test', TOOL_PROFILE: 'dev' });
  const registry = new ToolRegistry();
  registry.setProfile('dev');
  registerBuiltinTools(registry, config);
  return registry;
}

/**
 * Drives `SCH_PrimitiveComponent.get` from a mutable state bag so the read-back
 * reflects whatever the fake modify decided to apply.
 */
function createModifyBridge(state: Record<string, unknown>, apply: () => void) {
  return vi.fn(async (_method: string, params: unknown) => {
    const { path } = params as { path: string };
    if (path.endsWith('.get')) {
      return { path, result: { __class: 'SCH_PrimitiveComponent', state: { ...state } } };
    }
    apply();
    return { path, result: { __class: 'SCH_PrimitiveComponent', state: { ...state } } };
  });
}

describe('verifyPropertyWrite', () => {
  it('reports a wrong-case key as unapplied', () => {
    const verification = verifyPropertyWrite(
      { SupplierId: 'C25741' },
      { supplierId: 'PTFR0402B100KN9.1' },
      { supplierId: 'PTFR0402B100KN9.1' },
    );

    expect(verification.verified).toBe(false);
    expect(verification.unapplied).toEqual([
      {
        key: 'SupplierId',
        requested: 'C25741',
        before: 'PTFR0402B100KN9.1',
        after: 'PTFR0402B100KN9.1',
      },
    ]);
  });

  it('reports a key outside the property bag as unapplied', () => {
    const verification = verifyPropertyWrite(
      { Component: { uuid: 'd27c70b8' } },
      { supplierId: 'C1' },
      { supplierId: 'C1' },
    );

    expect(verification.verified).toBe(false);
    expect(verification.unapplied.map((mismatch) => mismatch.key)).toEqual(['Component']);
  });

  it('accepts a correctly spelled key', () => {
    const verification = verifyPropertyWrite(
      { supplierId: 'C25741' },
      { supplierId: 'PTFR0402B100KN9.1' },
      { supplierId: 'C25741' },
    );

    expect(verification).toMatchObject({
      verified: true,
      applied_keys: ['supplierId'],
      unapplied: [],
    });
  });

  it('matches the PascalCase state bag returned by api.call', () => {
    const verification = verifyPropertyWrite(
      { supplierId: 'C25741' },
      { SupplierId: 'old' },
      { SupplierId: 'C25741' },
    );

    expect(verification.verified).toBe(true);
  });

  it('treats a runtime-normalized value as applied but reports it', () => {
    const verification = verifyPropertyWrite({ x: 101 }, { x: 0 }, { x: 100 });

    expect(verification.verified).toBe(true);
    expect(verification.normalized).toEqual([{ key: 'x', requested: 101, before: 0, after: 100 }]);
  });

  it('merges nested otherProperty bags by subset', () => {
    const verification = verifyPropertyWrite(
      { otherProperty: { Tolerance: '1%' } },
      { otherProperty: { Value: '100k' } },
      { otherProperty: { Value: '100k', Tolerance: '1%' } },
    );

    expect(verification.verified).toBe(true);
  });

  it('never reports a sentinel read-back as unapplied', () => {
    const verification = verifyPropertyWrite(
      { otherProperty: { Tolerance: '1%' } },
      { otherProperty: '[MaxDepth]' },
      { otherProperty: '[MaxDepth]' },
    );

    expect(verification.verified).toBe(true);
    expect(verification.normalized.map((mismatch) => mismatch.key)).toEqual(['otherProperty']);
  });

  it('stays unverifiable without a read-back on both sides', () => {
    const verification = verifyPropertyWrite({ supplierId: 'C1' }, { supplierId: 'C0' }, undefined);

    expect(verification.unapplied).toEqual([]);
    expect(verification.unverifiable_reason).toBe('post-write read-back returned no state');
  });
});

describe('easyeda_api_call write verification', () => {
  it('fails a modify whose property keys were silently ignored', async () => {
    const state = { SupplierId: 'PTFR0402B100KN9.1' };
    const bridgeCall = createModifyBridge(state, () => {
      // EasyEDA ignores the unknown key: nothing changes.
    });
    const tool = createDevRegistry().get('easyeda_api_call');

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      path: 'SCH_PrimitiveComponent.modify',
      args: ['e22621', { SupplierId: 'C25741' }],
      confirmWrite: true,
    })) as { ok: boolean; error_code?: string; verification?: { unapplied: unknown[] } };

    expect(result.ok).toBe(false);
    expect(result.error_code).toBe('WRITE_NOT_PERSISTED');
    expect(result.verification?.unapplied).toHaveLength(1);
  });

  it('passes a modify that persists', async () => {
    const state: Record<string, unknown> = { SupplierId: 'PTFR0402B100KN9.1' };
    const bridgeCall = createModifyBridge(state, () => {
      state.SupplierId = 'C25741';
    });
    const tool = createDevRegistry().get('easyeda_api_call');

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      path: 'SCH_PrimitiveComponent.modify',
      args: ['e22621', { supplierId: 'C25741' }],
      confirmWrite: true,
    })) as { ok: boolean; verification?: { verified: boolean } };

    expect(result.ok).toBe(true);
    expect(result.verification?.verified).toBe(true);
  });

  it('still succeeds when the primitive cannot be read back', async () => {
    const bridgeCall = vi.fn(async (_method: string, params: unknown) => {
      const { path } = params as { path: string };
      if (path.endsWith('.get')) throw new Error('METHOD_NOT_FOUND');
      return { path, result: {} };
    });
    const tool = createDevRegistry().get('easyeda_api_call');

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      path: 'SCH_PrimitiveComponent.modify',
      args: ['e22621', { supplierId: 'C25741' }],
      confirmWrite: true,
    })) as { ok: boolean; verification?: { unverifiable_reason?: string } };

    expect(result.ok).toBe(true);
    expect(result.verification?.unverifiable_reason).toContain('pre-write read-back failed');
  });

  it('leaves non-modify paths unverified', async () => {
    const bridgeCall = vi.fn().mockResolvedValue({ path: 'SCH_PrimitiveWire.getAll', result: [] });
    const tool = createDevRegistry().get('easyeda_api_call');

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      path: 'SCH_PrimitiveWire.getAll',
      args: [],
    })) as { ok: boolean; verification?: unknown };

    expect(result.ok).toBe(true);
    expect(result.verification).toBeUndefined();
    expect(bridgeCall).toHaveBeenCalledTimes(1);
  });
});

describe('easyeda_schematic_modify_primitive write verification', () => {
  it('fails when the snapshot still shows the pre-write value', async () => {
    const bridgeCall = vi.fn(async (method: string) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        return { primitiveId: 'e22621', property: { designator: 'R1' } };
      }
      return { primitiveId: 'e22621' };
    });
    const tool = createDevRegistry().get('easyeda_schematic_modify_primitive');

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      primitiveId: 'e22621',
      property: { Designator: 'R9' },
      confirmWrite: true,
    })) as { success: boolean; error_code?: string };

    expect(result.success).toBe(false);
    expect(result.error_code).toBe('WRITE_NOT_PERSISTED');
  });

  it('succeeds when the snapshot shows the new value', async () => {
    let designator = 'R1';
    const bridgeCall = vi.fn(async (method: string, params: unknown) => {
      if (method === 'schematic.getPrimitiveSnapshot') {
        return { primitiveId: 'e22621', property: { designator } };
      }
      designator = (params as { property: { designator: string } }).property.designator;
      return { primitiveId: 'e22621' };
    });
    const tool = createDevRegistry().get('easyeda_schematic_modify_primitive');

    const result = (await tool?.handler(createDevContext(bridgeCall), {
      primitiveId: 'e22621',
      property: { designator: 'R9' },
      confirmWrite: true,
    })) as { success: boolean; verification?: { verified: boolean } };

    expect(result.success).toBe(true);
    expect(result.verification?.verified).toBe(true);
  });
});
