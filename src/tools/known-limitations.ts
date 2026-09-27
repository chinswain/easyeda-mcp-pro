/**
 * Known limitations surfaced by `easyeda_get_capabilities`. Each entry pairs the gap with the
 * workaround an agent should use today. Keep entries short; remove them when the gap closes.
 */
export const KNOWN_LIMITATIONS: Array<{ area: string; limitation: string; workaround: string }> = [
  {
    area: 'bridge',
    limitation:
      'Only one MCP server process holds the EasyEDA plugin socket. Others attach through it over loopback and share its transaction guard.',
    workaround:
      'Nothing to do: attached clients relay automatically. Check easyeda_bridge_status.role to see which process is the owner.',
  },
  {
    area: 'bridge',
    limitation:
      'A crashed MCP client can leave an orphaned server process listening on 49620, which delays the next owner.',
    workaround: 'Run "npx easyeda-mcp-pro --doctor --fix"; easyeda_health_check lists stale_listeners.',
  },
  {
    area: 'pcb-write',
    limitation:
      'PCB_PrimitiveArc.create (EasyEDA Pro 3.2.149) returns an id but the arc never persists: getAll/get are empty and modify throws.',
    workaround:
      'easyeda_pcb_add_arc draws the arc as chord segments (PCB_PrimitiveLine) on the Board Outline layer; DRC treats them as an outline.',
  },
  {
    area: 'pcb-write',
    limitation:
      'PCB_PrimitiveVia.modify updates the readback but not the DRC/connectivity index for position changes.',
    workaround:
      'easyeda_pcb_modify_via deletes and recreates the via when x/y change and returns the new primitiveId (recreated: true).',
  },
  {
    area: 'bridge',
    limitation:
      'Schematic and PCB APIs act on the focused tab. The server switches to the same board\'s schematic page or PCB before each call; it cannot pick a board you have not opened.',
    workaround:
      'Open any document of the target board first, or DMT_EditorControl.openDocument("<pageOrPcbUuid>"); DMT_Board.getAllBoardsInfo lists them. DMT_SelectControl.getCurrentDocumentInfo: documentType 1 = schematic page, 3 = PCB.',
  },
  {
    area: 'profile',
    limitation: 'The default TOOL_PROFILE is "core"; PCB write and export tools need "full".',
    workaround:
      'Run "npx easyeda-mcp-pro setup <client>" (writes TOOL_PROFILE=full and BRIDGE_PORT) or set the env on the MCP server entry. easyeda_get_capabilities.unlocked_by_profile lists what each profile adds.',
  },
  {
    area: 'pcb-write',
    limitation:
      'Keep-out (PCB_PrimitiveRegion) and copper pour (PCB_PrimitivePour) creation could not be probed live: the polygon argument shape is validated at runtime (polygon object first, plain array fallback).',
    workaround:
      'Check the `signature` field of easyeda_pcb_add_keepout / easyeda_pcb_add_copper_pour and the verified flag; run the native "Rebuild all copper" after pours.',
  },
  {
    area: 'pcb-write',
    limitation:
      'EasyEDA has no height-limited keep-outs. Net classes need a nets[] array and rule keys in native units (PCB_Drc.overwriteNetRules).',
    workaround:
      'max_height_mm rules live in <artifactDir>/keepouts.json and are enforced by easyeda_pcb_check_placement; take rule keys from easyeda_pcb_get_design_rules.',
  },
  {
    area: 'pcb-write',
    limitation:
      'Stackup: only the copper layer count is writable; PCB_Drc.getStackup can return null. No pour rebuild API; no unrouted-ratline count.',
    workaround:
      'Use easyeda_pcb_connectivity_check for pads-without-copper and easyeda_drc_run (per-violation) for opens.',
  },
  {
    area: 'visual',
    limitation: 'Canvas capture has no per-layer filter: easyeda_canvas_capture_board_region reports layers_applied: false.',
    workaround: 'Toggle layer visibility manually before capturing, or read geometry with easyeda_pcb_tracks / easyeda_pcb_vias.',
  },
  {
    area: 'export',
    limitation:
      'Drill files are only emitted inside the Gerber zip (no separate Excellon API). No .epro project-archive export API exists.',
    workaround:
      'easyeda_export_drill returns the zip + sha256; extract the *.drl entries. Export .epro via File > Export in the editor.',
  },
  {
    area: 'bridge',
    limitation:
      'The agentic PCB bridge methods (pcb.moveComponent, pcb.routeNet, pcb.addKeepout, ...) ship in the extension source and are unit-tested only; a running editor needs the rebuilt .eext.',
    workaround:
      'pnpm build:extension, re-import easyeda-bridge-extension.eext in EasyEDA Pro, restart the MCP server; easyeda_bridge_status reports a build-hash mismatch otherwise.',
  },
];
