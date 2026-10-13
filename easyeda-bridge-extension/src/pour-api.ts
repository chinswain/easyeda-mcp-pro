import { readMember } from './api-introspection.js';
import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import { isRecord } from './utils.js';

// Bridge adapters for documented instance methods, not arbitrary method chains.
export function isPourInstancePath(path: string): boolean {
  return /^PCB_PrimitivePour\.(getCopperRegion|rebuildCopperRegion)$/i.test(path);
}

export async function callPourInstance(
  path: string,
  args: readonly unknown[],
  callFirst: ApiRuntime['callFirst'],
  createBridgeError: BridgeErrorFactory,
): Promise<unknown> {
  const [target] = args;
  if (
    args.length !== 1 ||
    !isRecord(target) ||
    typeof target.primitiveId !== 'string' ||
    !target.primitiveId.trim() ||
    typeof target.pcbUuid !== 'string' ||
    !target.pcbUuid.trim()
  ) {
    throw createBridgeError(
      'INVALID_PARAMS',
      'Expected one { primitiveId, pcbUuid } argument.',
      'Identify the target pour and PCB before calling this adapter.',
    );
  }
  const assertPcb = async () => {
    const current = await callFirst(['DMT_Pcb.getCurrentPcbInfo']);
    if (!isRecord(current) || current.uuid !== target.pcbUuid) {
      throw createBridgeError(
        'INVALID_STATE',
        'The active PCB does not match pcbUuid.',
        'Open the intended PCB and read back its UUID before retrying.',
      );
    }
  };
  await assertPcb();
  const pour = await callFirst(['PCB_PrimitivePour.get'], target.primitiveId);
  const method = path.toLowerCase().endsWith('.rebuildcopperregion')
    ? 'rebuildCopperRegion'
    : 'getCopperRegion';
  const fn = readMember(pour, method);
  if (typeof fn !== 'function') {
    throw createBridgeError(
      'METHOD_NOT_FOUND',
      `Pour or instance method unavailable: ${method}`,
      'Verify the pour ID and installed EasyEDA API version.',
    );
  }
  await assertPcb();
  return await fn.call(pour);
}
