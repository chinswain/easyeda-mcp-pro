/**
 * Schematic and PCB bridge methods act on whichever EasyEDA tab is focused. With the wrong
 * tab focused they fail obscurely ("获取器件关联的所有引脚失败") or read empty data. Before
 * such a call, switch to the sibling document of the same board.
 */

type Call = (method: string, params?: unknown) => Promise<unknown>;

const SCHEMATIC_PAGE = 1;
const PCB = 3;

// Methods that work regardless of the focused tab, or manage focus themselves.
const FOCUS_FREE = new Set(['schematic.searchDevice', 'schematic.syncToPcb']);

export function wantedDocumentType(method: string, params?: unknown): number | undefined {
  if (FOCUS_FREE.has(method)) return undefined;
  if (method === 'api.call') {
    const path = String((params as { path?: unknown } | undefined)?.path ?? '').replace(/^eda\./, '');
    if (/^sch_/i.test(path)) return SCHEMATIC_PAGE;
    if (/^pcb_/i.test(path)) return PCB;
    return undefined;
  }
  if (method.startsWith('schematic.') || method === 'design.erc') return SCHEMATIC_PAGE;
  if (method.startsWith('pcb.') || method.startsWith('board.') || method === 'design.drc') return PCB;
  return undefined;
}

type Board = { pcb?: { uuid?: string }; schematic?: { page?: Array<{ uuid?: string }> } };

export function siblingDocument(boards: Board[], currentUuid: string, want: number): string | undefined {
  const board = boards.find(
    (b) => b.pcb?.uuid === currentUuid || b.schematic?.page?.some((p) => p.uuid === currentUuid),
  );
  return want === PCB ? board?.pcb?.uuid : board?.schematic?.page?.[0]?.uuid;
}

const api = async (call: Call, path: string, args: unknown[] = []) =>
  ((await call('api.call', { path, args })) as { result?: unknown } | undefined)?.result;

/** Best effort: any failure leaves focus alone and the real call reports its own error. */
export async function ensureDocumentFocus(call: Call, method: string, params?: unknown): Promise<void> {
  const want = wantedDocumentType(method, params);
  if (want === undefined) return;
  try {
    const doc = (await api(call, 'DMT_SelectControl.getCurrentDocumentInfo')) as
      | { documentType?: number; uuid?: string }
      | undefined;
    if (!doc?.uuid || doc.documentType === want) return;
    const boards = (await api(call, 'DMT_Board.getAllBoardsInfo')) as Board[] | undefined;
    const target = siblingDocument(boards ?? [], doc.uuid, want);
    if (target) await api(call, 'DMT_EditorControl.openDocument', [target]);
  } catch {
    // ponytail: silent fallback; the tool's own call surfaces the focus error.
  }
}
