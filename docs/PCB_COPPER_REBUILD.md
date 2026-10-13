# PCB Copper Rebuild

`easyeda_pcb_rebuild_copper` rebuilds **existing** EasyEDA Pro copper pours after routing or via changes. It does not create a new pour and does not implement negative inner-layer `PlaneZone` objects.

## Safety contract

- Profile: `full`
- Risk: `high`
- `confirmWrite: true` is mandatory.
- Optional selectors are `pourIds`, exact `net`, and copper `layer` (TOP `1`, BOTTOM `2`, INNER_1..INNER_30 `15..44`).
- Every explicit `pourIds` target is resolved before the first mutation. If any requested id is missing, the operation fails before rebuilding anything.
- The extension calls the documented instance method `IPCB_PrimitivePour.rebuildCopperRegion()`.
- Success is accepted only after `PCB_PrimitivePoured` read-back (`getAllPrimitiveId()` + `get(id)`) links exactly one derived primitive to the source pour through `getState_PourPrimitiveId()`.
- With no `pourIds`, the extension enumerates pours with `PCB_PrimitivePour.getAllPrimitiveId()` + `get(id)`. It does not call `getAll()`. In EasyEDA Pro 3.2.149, `PCB_PrimitivePour.getAll()` and `PCB_PrimitivePoured.getAll()` throw `Cannot read properties of null` when called without a filter.
- A native `undefined` result is reported as `no-copper`; it is **not** counted as a successful rebuild.
- PCB rebuild writes are not covered by the server transaction manager. If the bridge times out, the native outcome is unknown; inspect the active PCB before retrying.

## Compatibility boundary

The repository's current live desktop compatibility baseline is EasyEDA Pro `3.2.149.88089769`. The rebuild implementation was validated against the `@jlceda/pro-api-types` `0.4.25` instance-rebuild surface and the official EasyEDA API skill/docs. Upstream `0.4.26` retains that instance contract and also declares an `@alpha` class-level `PCB_PrimitivePour.rebuildCopperRegions()` method, but that class-level method is absent from the verified 3.2.149 runtime and is not used by this tool.

At runtime the tool fails closed unless the focused PCB exposes all of these capabilities:

- `PCB_PrimitivePour.get()`
- `PCB_PrimitivePour.getAllPrimitiveId()`
- `IPCB_PrimitivePour.rebuildCopperRegion()`
- `PCB_PrimitivePoured.get()`
- `PCB_PrimitivePoured.getAllPrimitiveId()`
- `IPCB_PrimitivePoured.getState_PourPrimitiveId()`
- `IPCB_PrimitivePoured.getState_PrimitiveId()`

Other EasyEDA Pro versions are therefore capability-gated rather than assumed compatible.

The tool verifies each pour against the persisted `PCB_PrimitivePoured` read-back only. It does not compare the id on the `rebuildCopperRegion()` return value. On EasyEDA Pro `3.2.206` that return value names a different pour, and the same id repeats across pours. The read-back is the source of truth. Live run on 3.2.206: 29 of 29 pours rebuilt and verified.

## Plane-zone boundary

This tool intentionally excludes EasyEDA inner `PlaneZone` objects. The verified public API surface exposes normal `PCB_PrimitivePour` rebuilds but no equivalent writable PlaneZone class contract. Plane-zone creation/rebuild remains tracked separately by issue #480 and the [upstream EasyEDA API request #43](https://github.com/easyeda/pro-api-sdk/issues/43) referenced from issue #596.

Do not substitute `easyeda_pcb_add_zone`: the nine-argument native `PCB_PrimitivePour.create()` signature is known, but creation remains fail-closed until a supported EasyEDA runtime has a live-verified deterministic create → rebuild → associated `PCB_PrimitivePoured` read-back and recovery contract.
