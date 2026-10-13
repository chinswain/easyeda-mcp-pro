/**
 * Net validation — wire-name and topology validation rules.
 *
 * Implements 17 validation rules that operate on {@link NetValidationInput}
 * and produce structured {@link NetValidationIssue}s.
 *
 * Rules:
 *  1. Floating net (zero nodes)
 *  2. Duplicate net names
 *  3. Accidental short (same device pin on different nets)
 *  4. Missing power net
 *  5. Missing ground net
 *  6. Missing hierarchical port
 *  7. Unconnected required pin
 *  8. Inconsistent cross-sheet interface pins
 *  9. Naming convention violation (domain mismatch)
 * 10. Protected AC/high-voltage domain naming
 *
 * @module
 */

import { NetValidationCode, NetValidationResult, netError, netWarning } from './errors.js';
import {
  NET_DOMAIN_PATTERNS,
  NET_TYPE_EXPECTED_DOMAIN,
  REQUIRED_GROUND_NETS,
  REQUIRED_POWER_NETS,
  RESERVED_NET_NAMES,
  NetDomain,
} from './schema.js';
import type {
  DeviceValidationEntry,
  InterfaceValidationEntry,
  NetValidationInput,
  NetValidationEntry,
  NetValidationNode,
  PinElectricalType,
  PinValidationMetadata,
} from './schema.js';
import type { NetValidationIssue } from './errors.js';

// ── Semantic ERC helpers ───────────────────────────────────────────────────

type ResolvedSemanticNode = NetValidationNode & {
  device?: DeviceValidationEntry;
  pinMetadata?: PinValidationMetadata;
  electricalType?: PinElectricalType;
  displayRef: string;
};

function normalizeKey(value: string): string {
  return value.trim().toUpperCase();
}

function buildDeviceLookup(input: NetValidationInput): Map<string, DeviceValidationEntry> {
  const devices = new Map<string, DeviceValidationEntry>();
  for (const device of input.devices ?? []) {
    devices.set(normalizeKey(device.id), device);
    devices.set(normalizeKey(device.ref), device);
  }
  return devices;
}

function resolvePinMetadata(
  device: DeviceValidationEntry | undefined,
  node: NetValidationNode,
): PinValidationMetadata | undefined {
  if (!device?.pins) return undefined;
  const pinKey = normalizeKey(node.pin);
  return device.pins.find(
    (pin) => normalizeKey(pin.pin) === pinKey || normalizeKey(pin.name ?? '') === pinKey,
  );
}

function resolveSemanticNodes(
  input: NetValidationInput,
  net: NetValidationEntry,
): ResolvedSemanticNode[] {
  const devices = buildDeviceLookup(input);
  return net.nodes.map((node) => {
    const device = devices.get(normalizeKey(node.deviceRef));
    const pinMetadata = resolvePinMetadata(device, node);
    return {
      ...node,
      device,
      pinMetadata,
      electricalType: pinMetadata?.electricalType ?? node.electricalType,
      expectedVoltage: pinMetadata?.expectedVoltage ?? node.expectedVoltage,
      pinName: pinMetadata?.name ?? node.pinName,
      displayRef: device?.ref ?? node.deviceRef,
    };
  });
}

function hasSemanticMetadata(input: NetValidationInput): boolean {
  return (
    input.nets.some(
      (net) =>
        net.voltage !== undefined ||
        net.nodes.some(
          (node) => node.electricalType !== undefined || node.expectedVoltage !== undefined,
        ),
    ) ||
    (input.devices ?? []).some((device) =>
      Boolean(device.pins?.length || device.requiresDecoupling),
    )
  );
}

function isActiveDriver(type: PinElectricalType | undefined): boolean {
  return (
    type === 'output' ||
    type === 'bidirectional' ||
    type === 'power_output' ||
    type === 'power_source'
  );
}

function isPowerSource(type: PinElectricalType | undefined): boolean {
  return type === 'power_source' || type === 'power_output';
}

function isPassiveLike(type: PinElectricalType | undefined): boolean {
  return type === 'passive';
}

function isNoConnect(type: PinElectricalType | undefined): boolean {
  return type === 'no_connect';
}

function inferVoltageFromNetName(name: string): number | undefined {
  const upper = name.toUpperCase();
  const match = upper.match(/(^|[^0-9])([0-9]+)V([0-9]*)/);
  if (match) {
    const whole = Number(match[2]);
    const fractional = match[3] ? Number(`0.${match[3]}`) : 0;
    return whole + fractional;
  }
  if (/^VCC$|^VDD$/.test(upper)) return undefined;
  if (/^GND$|GND\b|^VSS$/.test(upper)) return 0;
  return undefined;
}

function netVoltage(net: NetValidationEntry): number | undefined {
  return net.voltage ?? inferVoltageFromNetName(net.name);
}

function deviceHasOtherPinOnNetType(
  input: NetValidationInput,
  deviceRef: string,
  excludedPin: string,
  expectedType: 'power' | 'ground',
): boolean {
  const wantedRef = normalizeKey(deviceRef);
  const excluded = normalizeKey(excludedPin);
  return input.nets.some(
    (net) =>
      net.type === expectedType &&
      net.nodes.some(
        (node) => normalizeKey(node.deviceRef) === wantedRef && normalizeKey(node.pin) !== excluded,
      ),
  );
}

function passivePullExists(input: NetValidationInput, net: NetValidationEntry): boolean {
  const semanticNodes = resolveSemanticNodes(input, net);
  return semanticNodes.some((node) => {
    if (!isPassiveLike(node.electricalType)) return false;
    return (
      deviceHasOtherPinOnNetType(input, node.deviceRef, node.pin, 'power') ||
      deviceHasOtherPinOnNetType(input, node.deviceRef, node.pin, 'ground')
    );
  });
}

function connectedNetsByDevicePin(input: NetValidationInput): Map<string, NetValidationEntry[]> {
  const map = new Map<string, NetValidationEntry[]>();
  for (const net of input.nets) {
    for (const node of net.nodes) {
      const key = `${normalizeKey(node.deviceRef)}:${normalizeKey(node.pin)}`;
      const existing = map.get(key) ?? [];
      existing.push(net);
      map.set(key, existing);
    }
  }
  return map;
}

function connectedNetsForPin(
  pinToNets: Map<string, NetValidationEntry[]>,
  device: DeviceValidationEntry,
  pin: string,
): NetValidationEntry[] {
  const matches = [
    ...(pinToNets.get(`${normalizeKey(device.id)}:${normalizeKey(pin)}`) ?? []),
    ...(pinToNets.get(`${normalizeKey(device.ref)}:${normalizeKey(pin)}`) ?? []),
  ];
  return [...new Map(matches.map((net) => [net.id, net])).values()];
}

function capacitorRefs(input: NetValidationInput): Set<string> {
  const refs = new Set<string>();
  for (const device of input.devices ?? []) {
    const category = (device.category ?? '').toLowerCase();
    if (
      category === 'capacitor' ||
      category === 'decoupling' ||
      /^C[0-9A-Z_-]*/i.test(device.ref)
    ) {
      refs.add(normalizeKey(device.id));
      refs.add(normalizeKey(device.ref));
    }
  }
  return refs;
}

function hasDecouplingCapacitor(
  input: NetValidationInput,
  powerNet: NetValidationEntry,
  groundNets: NetValidationEntry[],
): boolean {
  const capacitors = capacitorRefs(input);
  if (capacitors.size === 0) return false;
  const powerRefs = new Set(
    powerNet.nodes.map((node) => normalizeKey(node.deviceRef)).filter((ref) => capacitors.has(ref)),
  );
  if (powerRefs.size === 0) return false;
  return groundNets.some((groundNet) =>
    groundNet.nodes.some((node) => powerRefs.has(normalizeKey(node.deviceRef))),
  );
}

// ── Rule: floating nets ────────────────────────────────────────────────────

function checkFloatingNets(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    if (net.nodes.length === 0) {
      issues.push(
        netError(
          NetValidationCode.NetFloating,
          `Net "${net.name}" (${net.id}) has no node connections — it is floating`,
          {
            path: `nets[${input.nets.indexOf(net)}]`,
            netName: net.name,
            remediationHint: 'Connect this net to at least one device pin or remove it',
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: duplicate net names ──────────────────────────────────────────────

function checkDuplicateNetNames(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];
  const nameMap = new Map<string, NetValidationEntry[]>();

  for (const net of input.nets) {
    const normalised = net.name.toUpperCase();
    const existing = nameMap.get(normalised) ?? [];
    existing.push(net);
    nameMap.set(normalised, existing);
  }

  for (const [name, nets] of nameMap) {
    if (nets.length > 1) {
      const ids = nets.map((n) => n.id).join(', ');
      issues.push(
        netError(
          NetValidationCode.NetDuplicateName,
          `Net name "${name}" is used by ${nets.length} nets: ${ids}`,
          {
            netName: name,
            remediationHint:
              'Rename conflicting nets or merge them if they are intended to be the same electrical node',
            details: { matchingNetIds: nets.map((n) => n.id) },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: accidental shorts ────────────────────────────────────────────────

function checkAccidentalShorts(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];
  const pinToNets = new Map<string, NetValidationEntry[]>();

  for (const net of input.nets) {
    for (const node of net.nodes) {
      const key = `${node.deviceRef}:${node.pin}`;
      const existing = pinToNets.get(key) ?? [];
      existing.push(net);
      pinToNets.set(key, existing);
    }
  }

  for (const [key, nets] of pinToNets) {
    if (nets.length > 1) {
      const parts = key.split(':');
      issues.push(
        netError(
          NetValidationCode.NetAccidentalShort,
          `Device pin "${key}" is connected to ${nets.length} different nets: ${nets.map((n) => n.name).join(', ')}`,
          {
            componentRef: parts[0],
            pin: parts[1],
            remediationHint:
              'Ensure only one net connects to each device pin, or use a net junction if intentional',
            details: {
              conflictingNets: nets.map((n) => ({ id: n.id, name: n.name })),
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: missing power net ────────────────────────────────────────────────

function checkMissingPowerNet(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  // Check that at least one net has type=power
  const powerNets = input.nets.filter((n) => n.type === 'power');
  if (powerNets.length === 0) {
    issues.push(
      netError(
        NetValidationCode.NetMissingPower,
        'No power net found — the design must have at least one net of type=power',
        {
          remediationHint: 'Add a power net (e.g. "3V3", "VIN", "VCC") with type="power"',
        },
      ),
    );
  }

  // Also check for required specific power net names
  for (const required of REQUIRED_POWER_NETS) {
    // "+3V3" and "3.3V" name the same rail as "3V3".
    const canonical = (name: string) =>
      name
        .toUpperCase()
        .replace(/^\+/, '')
        .replace(/^(\d+)\.(\d+)V$/, '$1V$2');
    const found = input.nets.some((n) => canonical(n.name) === canonical(required));
    if (!found) {
      issues.push(
        netWarning(
          NetValidationCode.NetMissingPower,
          `Required power net "${required}" not found in the design`,
          {
            netName: required,
            remediationHint: `Add a "${required}" power rail or ensure your power source is properly named`,
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: missing ground net ───────────────────────────────────────────────

function checkMissingGroundNet(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  const groundNets = input.nets.filter((n) => n.type === 'ground');
  if (groundNets.length === 0) {
    issues.push(
      netError(
        NetValidationCode.NetMissingGround,
        'No ground net found — the design must have at least one net of type=ground',
        {
          remediationHint: 'Add a ground net (e.g. "GND") with type="ground"',
        },
      ),
    );
  }

  // Also check for required specific ground net names
  for (const required of REQUIRED_GROUND_NETS) {
    const found = input.nets.some((n) => n.name.toUpperCase() === required.toUpperCase());
    if (!found) {
      issues.push(
        netWarning(
          NetValidationCode.NetMissingGround,
          `Required ground net "${required}" not found in the design`,
          {
            netName: required,
            remediationHint: `Add a "${required}" net with type="ground"`,
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: missing hierarchical port ────────────────────────────────────────

function checkMissingHierarchicalPorts(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  if (!input.interfaces || input.interfaces.length === 0) {
    return issues; // No interfaces defined — skip
  }

  const netNames = new Set(input.nets.map((n) => n.name.toUpperCase()));

  for (const intf of input.interfaces) {
    for (const pinEntry of intf.pinout) {
      if (!netNames.has(pinEntry.signal.toUpperCase())) {
        issues.push(
          netError(
            NetValidationCode.NetMissingHierarchicalPort,
            `Interface "${intf.name}" references signal "${pinEntry.signal}" (pin ${pinEntry.pin}) but no matching net was found`,
            {
              netName: pinEntry.signal,
              pin: pinEntry.pin,
              remediationHint: `Add a net named "${pinEntry.signal}" or update the interface pinout`,
              details: { interfaceName: intf.name },
            },
          ),
        );
      }
    }
  }

  return issues;
}

// ── Rule: unconnected required pins ────────────────────────────────────────

function checkUnconnectedPins(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  if (!input.devices || input.devices.length === 0) {
    return issues;
  }

  // Build set of connected pins
  const connectedPins = new Set<string>();
  for (const net of input.nets) {
    for (const node of net.nodes) {
      connectedPins.add(`${node.deviceRef}:${node.pin}`);
    }
  }

  // Check each device for unconnected pins
  // For now, only flag devices with no connections at all (not individual pins,
  // since we don't have a comprehensive required-pin list per device category)
  for (const device of input.devices) {
    const devicePins = [...connectedPins].filter((p) => p.startsWith(`${device.id}:`));
    if (devicePins.length === 0) {
      issues.push(
        netWarning(
          NetValidationCode.NetUnconnectedRequiredPin,
          `Device "${device.ref}" (${device.id}) has no pin connections`,
          {
            componentRef: device.ref,
            remediationHint:
              'Connect at least one pin of this device to a net, or remove it if unused',
          },
        ),
      );
    }
  }

  return issues;
}

// ── Rule: inconsistent cross-sheet interfaces ──────────────────────────────

function checkCrossSheetConsistency(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  if (!input.interfaces || input.interfaces.length < 2) {
    return issues; // Need at least 2 interfaces to compare
  }

  // For cross-sheet validation, interfaces with the same name on different
  // sheets should have matching pinout lists
  const byName = new Map<string, typeof input.interfaces>();
  for (const intf of input.interfaces) {
    const key = intf.name.toUpperCase();
    const existing = byName.get(key) ?? [];
    existing.push(intf);
    byName.set(key, existing);
  }

  for (const [name, group] of byName) {
    if (group.length < 2) continue;

    // Compare all interfaces with the same name (group.length >= 2 here)
    const [reference, ...others] = group as [
      InterfaceValidationEntry,
      ...InterfaceValidationEntry[],
    ];

    for (const [index, other] of others.entries()) {
      const instanceNumber = index + 2;

      // Check pin count matches
      if (reference.pinout.length !== other.pinout.length) {
        issues.push(
          netError(
            NetValidationCode.NetInconsistentCrossSheet,
            `Interface "${name}" has inconsistent pin counts: sheet 1 has ${reference.pinout.length} pins, sheet ${instanceNumber} has ${other.pinout.length} pins`,
            {
              remediationHint: 'Ensure all instances of this interface have the same pinout',
              details: {
                interfaceName: name,
                firstInstanceId: reference.id,
                otherInstanceId: other.id,
              },
            },
          ),
        );
        continue;
      }

      // Check individual pin names match
      for (const [j, refPin] of reference.pinout.entries()) {
        const otherPin = other.pinout[j];
        if (otherPin === undefined) continue;
        if (refPin.signal.toUpperCase() !== otherPin.signal.toUpperCase()) {
          issues.push(
            netError(
              NetValidationCode.NetInconsistentCrossSheet,
              `Interface "${name}" has mismatched signals at index ${j}: "${refPin.signal}" vs "${otherPin.signal}"`,
              {
                pin: refPin.pin,
                remediationHint: 'Update the interface pinout to match across all sheets',
                details: {
                  interfaceName: name,
                  expectedSignal: refPin.signal,
                  actualSignal: otherPin.signal,
                },
              },
            ),
          );
        }
      }
    }
  }

  return issues;
}

// ── Rule: naming convention violations ─────────────────────────────────────

/**
 * Classify a net name into one or more {@link NetDomain}s.
 */
function classifyNetDomain(name: string): Set<NetDomain> {
  const domains = new Set<NetDomain>();

  for (const [domain, patterns] of Object.entries(NET_DOMAIN_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(name)) {
        domains.add(domain as NetDomain);
        break; // One match per domain is enough
      }
    }
  }

  return domains;
}

function checkNamingConventions(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    const name = net.name;

    // Skip reserved names (GND, VCC, etc.) — these are convention by definition
    if (RESERVED_NET_NAMES.has(name.toUpperCase())) continue;

    // Get expected domain for this net's type
    const expectedDomains = NET_TYPE_EXPECTED_DOMAIN[net.type];
    if (!expectedDomains) continue;

    // Classify the net name
    const actualDomains = classifyNetDomain(name);

    // If the net type is power, the name should look like a power rail
    if (net.type === 'power' && !actualDomains.has(NetDomain.Power)) {
      issues.push(
        netWarning(
          NetValidationCode.NetNamingConvention,
          `Power net "${name}" does not follow power rail naming conventions (e.g. "3V3", "VCC", "VIN")`,
          {
            netName: name,
            remediationHint:
              'Rename to a conventional power rail name like "VCC", "3V3", or "VIN_5V"',
          },
        ),
      );
    }

    // If the net type is ground, the name should look like a ground
    if (net.type === 'ground' && !actualDomains.has(NetDomain.Ground)) {
      issues.push(
        netWarning(
          NetValidationCode.NetNamingConvention,
          `Ground net "${name}" does not follow ground naming conventions (e.g. "GND", "AGND", "PGND")`,
          {
            netName: name,
            remediationHint: 'Rename to a conventional ground name like "GND", "AGND", or "PGND"',
          },
        ),
      );
    }

    // Check for AC/high-voltage naming without protection (next rule handles this more specifically)
  }

  return issues;
}

// ── Rule: protected AC/high-voltage domain ─────────────────────────────────

function checkProtectedDomain(input: NetValidationInput): NetValidationIssue[] {
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    const actualDomains = classifyNetDomain(net.name);

    // If the net name suggests high-voltage domain, it should have clear
    // protective labeling
    if (actualDomains.has(NetDomain.HighVoltage)) {
      // High-voltage nets should not be named generically
      if (/^[A-Z]?[0-9]?$/.test(net.name.trim())) {
        issues.push(
          netError(
            NetValidationCode.NetProtectedDomain,
            `Net "${net.name}" appears to be in the high-voltage domain but has a generic name — use protective naming like "HV_*" or "AC_*"`,
            {
              netName: net.name,
              remediationHint:
                'Prefix the net name with "HV_" or "AC_" to clearly indicate high-voltage domain (e.g. "HV_BULK", "AC_L")',
            },
          ),
        );
      }

      // High-voltage nets should not be mixed with low-voltage signal naming
      if (actualDomains.has(NetDomain.Digital) || actualDomains.has(NetDomain.Clock)) {
        issues.push(
          netError(
            NetValidationCode.NetProtectedDomain,
            `Net "${net.name}" is classified as both high-voltage and digital/clock — this is a safety hazard`,
            {
              netName: net.name,
              remediationHint:
                'Separate high-voltage and low-voltage domains; use isolated net names with "HV_" prefix',
              details: { detectedDomains: [...actualDomains] },
            },
          ),
        );
      }
    }
  }

  return issues;
}

// ── Semantic ERC: output contention ────────────────────────────────────────

function checkOutputContention(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    const semanticNodes = resolveSemanticNodes(input, net).filter(
      (node) => !isNoConnect(node.electricalType),
    );
    // Same-named pins of one device (e.g. two "OUT" pins) are one driver, not contention.
    const activeDrivers = semanticNodes
      .filter((node) => isActiveDriver(node.electricalType))
      .filter(
        (node, i, all) =>
          node.pinName === undefined ||
          all.findIndex((o) => o.displayRef === node.displayRef && o.pinName === node.pinName) ===
            i,
      );

    if (net.type === 'signal' && activeDrivers.length > 1) {
      issues.push(
        netError(
          NetValidationCode.NetOutputContention,
          `Signal net "${net.name}" has ${activeDrivers.length} active drivers: ${activeDrivers.map((node) => `${node.displayRef}:${node.pinName ?? node.pin}`).join(', ')}`,
          {
            netName: net.name,
            componentRef: activeDrivers[0]?.displayRef,
            pin: activeDrivers[0]?.pin,
            remediationHint:
              'Do not tie push-pull outputs together. Add arbitration, tri-state control, open-drain wiring with pull-up, or separate the nets.',
            details: {
              drivers: activeDrivers.map((node) => ({
                componentRef: node.displayRef,
                pin: node.pin,
                pinName: node.pinName,
                electricalType: node.electricalType,
              })),
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Semantic ERC: floating inputs ──────────────────────────────────────────

function checkFloatingInputs(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    if (net.type !== 'signal' || net.nodes.length === 0) continue;
    const semanticNodes = resolveSemanticNodes(input, net).filter(
      (node) => !isNoConnect(node.electricalType),
    );
    const inputNodes = semanticNodes.filter((node) => node.electricalType === 'input');
    if (inputNodes.length === 0) continue;

    const hasDriver = semanticNodes.some((node) => isActiveDriver(node.electricalType));
    const hasPull = passivePullExists(input, net);
    const hasOpenDrainBus =
      semanticNodes.some((node) => node.electricalType === 'open_drain') && hasPull;

    if (!hasDriver && !hasPull && !hasOpenDrainBus) {
      issues.push(
        netWarning(
          NetValidationCode.NetFloatingInput,
          `Signal net "${net.name}" connects input pins but has no active driver or pull resistor`,
          {
            netName: net.name,
            componentRef: inputNodes[0]?.displayRef,
            pin: inputNodes[0]?.pin,
            remediationHint:
              'Connect this input to a valid driver, add a pull-up/pull-down resistor, or explicitly mark it as no-connect if allowed.',
            details: {
              inputs: inputNodes.map((node) => ({
                componentRef: node.displayRef,
                pin: node.pin,
                pinName: node.pinName,
              })),
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Semantic ERC: power rail conflicts ─────────────────────────────────────

function checkPowerConflicts(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    if (net.type !== 'power') continue;
    const powerSources = resolveSemanticNodes(input, net).filter((node) =>
      isPowerSource(node.electricalType),
    );
    if (powerSources.length > 1) {
      issues.push(
        netError(
          NetValidationCode.NetPowerConflict,
          `Power net "${net.name}" has ${powerSources.length} power sources tied together: ${powerSources.map((node) => `${node.displayRef}:${node.pinName ?? node.pin}`).join(', ')}`,
          {
            netName: net.name,
            componentRef: powerSources[0]?.displayRef,
            pin: powerSources[0]?.pin,
            remediationHint:
              'Verify that only one regulator/source drives this rail, or add ideal-diode/load-share circuitry before tying sources together.',
            details: {
              powerSources: powerSources.map((node) => ({
                componentRef: node.displayRef,
                pin: node.pin,
                pinName: node.pinName,
                electricalType: node.electricalType,
              })),
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Semantic ERC: passive-only signal nets ─────────────────────────────────

function checkPassiveOnlySignalNets(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    if (net.type !== 'signal' || net.nodes.length < 2) continue;
    const semanticNodes = resolveSemanticNodes(input, net);
    // An unclassified pin could be the active source; don't guess.
    if (semanticNodes.some((node) => node.electricalType === undefined)) continue;
    if (semanticNodes.every((node) => isPassiveLike(node.electricalType))) {
      issues.push(
        netWarning(
          NetValidationCode.NetPassiveOnly,
          `Signal net "${net.name}" only connects passive pins and has no active source or input`,
          {
            netName: net.name,
            remediationHint:
              'Confirm this is an intentional passive network node; otherwise connect it to an input/output pin or power/ground as appropriate.',
            details: {
              passiveNodes: semanticNodes.map((node) => ({
                componentRef: node.displayRef,
                pin: node.pin,
              })),
            },
          },
        ),
      );
    }
  }

  return issues;
}

// ── Semantic ERC: required device power/ground pins ────────────────────────

function checkRequiredPowerPins(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];
  const pinToNets = connectedNetsByDevicePin(input);

  for (const device of input.devices ?? []) {
    for (const pin of device.pins ?? []) {
      if (!pin.required || pin.noConnectAllowed) continue;
      const connectedNets = connectedNetsForPin(pinToNets, device, pin.pin);

      if (connectedNets.length === 0) {
        issues.push(
          netError(
            NetValidationCode.NetUnpoweredDevice,
            `Required pin ${device.ref}:${pin.name ?? pin.pin} is not connected`,
            {
              componentRef: device.ref,
              pin: pin.pin,
              remediationHint:
                pin.expectedNetType === 'power'
                  ? 'Connect this required supply pin to the correct power rail.'
                  : pin.expectedNetType === 'ground'
                    ? 'Connect this required ground/reference pin to the correct ground net.'
                    : 'Connect this required pin to the intended net or mark it noConnectAllowed when intentional.',
              details: { expectedNetType: pin.expectedNetType, electricalType: pin.electricalType },
            },
          ),
        );
        continue;
      }

      if (pin.expectedNetType) {
        for (const net of connectedNets) {
          if (net.type !== pin.expectedNetType) {
            issues.push(
              netError(
                NetValidationCode.NetUnpoweredDevice,
                `Pin ${device.ref}:${pin.name ?? pin.pin} expects a ${pin.expectedNetType} net but is connected to ${net.type} net "${net.name}"`,
                {
                  netName: net.name,
                  componentRef: device.ref,
                  pin: pin.pin,
                  remediationHint: `Move ${device.ref}:${pin.name ?? pin.pin} to a ${pin.expectedNetType} net or correct the pin metadata if the symbol is wrong.`,
                  details: {
                    expectedNetType: pin.expectedNetType,
                    actualNetType: net.type,
                    electricalType: pin.electricalType,
                  },
                },
              ),
            );
          }
        }
      }
    }
  }

  return issues;
}

// ── Semantic ERC: decoupling ───────────────────────────────────────────────

function checkMissingDecoupling(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];
  const pinToNets = connectedNetsByDevicePin(input);
  const groundNets = input.nets.filter((net) => net.type === 'ground');

  for (const device of input.devices ?? []) {
    if (!device.requiresDecoupling) continue;
    const powerPins = (device.pins ?? []).filter(
      (pin) =>
        pin.expectedNetType === 'power' ||
        (pin.electricalType === 'power_input' && pin.expectedNetType !== 'ground'),
    );

    for (const pin of powerPins) {
      const connectedPowerNets = connectedNetsForPin(pinToNets, device, pin.pin).filter(
        (net) => net.type === 'power',
      );

      for (const powerNet of connectedPowerNets) {
        if (!hasDecouplingCapacitor(input, powerNet, groundNets)) {
          issues.push(
            netWarning(
              NetValidationCode.NetMissingDecoupling,
              `Device ${device.ref} power pin ${pin.name ?? pin.pin} on net "${powerNet.name}" has no detected local decoupling capacitor`,
              {
                netName: powerNet.name,
                componentRef: device.ref,
                pin: pin.pin,
                remediationHint:
                  'Add a local decoupling capacitor from this rail to ground near the IC/regulator supply pin, or mark the device as not requiring decoupling if intentional.',
                details: { powerNet: powerNet.name, groundNets: groundNets.map((net) => net.name) },
              },
            ),
          );
        }
      }
    }
  }

  return issues;
}

// ── Semantic ERC: voltage mismatch ─────────────────────────────────────────

function checkVoltageMismatches(input: NetValidationInput): NetValidationIssue[] {
  if (!hasSemanticMetadata(input)) return [];
  const issues: NetValidationIssue[] = [];

  for (const net of input.nets) {
    const voltage = netVoltage(net);
    if (voltage === undefined) continue;

    for (const node of resolveSemanticNodes(input, net)) {
      const expectedVoltage = node.expectedVoltage;
      if (expectedVoltage === undefined) continue;
      if (Math.abs(expectedVoltage - voltage) > 0.15) {
        issues.push(
          netError(
            NetValidationCode.NetVoltageMismatch,
            `Pin ${node.displayRef}:${node.pinName ?? node.pin} expects ${expectedVoltage}V but net "${net.name}" is ${voltage}V`,
            {
              netName: net.name,
              componentRef: node.displayRef,
              pin: node.pin,
              remediationHint:
                'Connect this pin to the correct voltage domain or insert level shifting/regulation if the voltage mismatch is intentional.',
              details: {
                expectedVoltage,
                actualVoltage: voltage,
                electricalType: node.electricalType,
              },
            },
          ),
        );
      }
    }
  }

  return issues;
}

// ── Combine helper ─────────────────────────────────────────────────────────

type RuleFn = (input: NetValidationInput) => NetValidationIssue[];

const RULES: RuleFn[] = [
  checkFloatingNets,
  checkDuplicateNetNames,
  checkAccidentalShorts,
  checkMissingPowerNet,
  checkMissingGroundNet,
  checkMissingHierarchicalPorts,
  checkUnconnectedPins,
  checkCrossSheetConsistency,
  checkNamingConventions,
  checkProtectedDomain,
  checkOutputContention,
  checkFloatingInputs,
  checkPowerConflicts,
  checkPassiveOnlySignalNets,
  checkRequiredPowerPins,
  checkMissingDecoupling,
  checkVoltageMismatches,
];

// ── Main entry point ───────────────────────────────────────────────────────

/**
 * Run all net validation rules against an input net list.
 *
 * Orchestrates 10 rules:
 *  1. Floating nets            — error if net has zero nodes
 *  2. Duplicate names          — error if multiple nets share a name
 *  3. Accidental shorts        — error if one device pin belongs to multiple nets
 *  4. Missing power            — error if no type=power net + warnings for specific names
 *  5. Missing ground           — error if no type=ground net + warnings for specific names
 *  6. Missing hierarchical port — error if interface references an unknown net
 *  7. Unconnected required pins — warning if a device has zero connections
 *  8. Cross-sheet consistency   — error if same-name interfaces have different pinouts
 *  9. Naming convention         — warning if power/ground nets have non-standard names
 * 10. Protected domain          — error if high-voltage net lacks protective naming
 * 11. Output contention        — error if multiple active outputs drive one signal
 * 12. Floating input           — warning if input net has no driver or pull
 * 13. Power conflict           — error if multiple sources drive one rail
 * 14. Passive-only signal      — warning if a signal net has only passive nodes
 * 15. Required power pins      — error if required pins are missing/miswired
 * 16. Decoupling expectation   — warning if required local decoupling is absent
 * 17. Voltage mismatch         — error if expected pin voltage conflicts with net voltage
 */
export function validateNets(input: NetValidationInput): NetValidationResult {
  const errors: NetValidationIssue[] = [];
  const warnings: NetValidationIssue[] = [];

  for (const rule of RULES) {
    const issues = rule(input);
    for (const issue of issues) {
      if (issue.severity === 'error') {
        errors.push(issue);
      } else {
        warnings.push(issue);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate nets and throw on the first error.
 *
 * Returns the full result on success. Throws the first `NetValidationIssue`
 * found (as an error) if validation fails.
 */
export function validateNetsOrThrow(input: NetValidationInput): NetValidationResult {
  const result = validateNets(input);
  if (!result.valid) {
    throw result.errors[0];
  }
  return result;
}
