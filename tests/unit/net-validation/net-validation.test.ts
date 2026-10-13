/**
 * Net validation — unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import { validateNets } from '../../../src/net-validation/validation.js';
import { NetValidationCode } from '../../../src/net-validation/errors.js';
import {
  VALID_INPUT,
  FLOATING_INPUT,
  DUPLICATE_NAME_INPUT,
  SHORT_INPUT,
  NO_POWER_INPUT,
  NO_GROUND_INPUT,
  MISSING_PORT_INPUT,
  UNCONNECTED_DEVICE_INPUT,
  CROSS_SHEET_INPUT,
  MISMATCHED_CROSS_SHEET_INPUT,
  BAD_POWER_NAME_INPUT,
  BAD_GROUND_NAME_INPUT,
  HV_GENERIC_NAME_INPUT,
  HV_MIXED_DOMAIN_INPUT,
} from '../../../src/net-validation/fixtures.js';

// ── Validation result shape ────────────────────────────────────────────────

describe('validateNets', () => {
  it('returns valid=true for a well-formed design', () => {
    const result = validateNets(VALID_INPUT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid result with valid, errors, and warnings fields', () => {
    const result = validateNets(VALID_INPUT);
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});

// ── Structural errors ──────────────────────────────────────────────────────

describe('structural errors', () => {
  it('detects floating nets (zero nodes)', () => {
    const result = validateNets(FLOATING_INPUT);
    expect(result.valid).toBe(false);
    const floatingIssues = result.errors.filter((e) => e.code === NetValidationCode.NetFloating);
    expect(floatingIssues).toHaveLength(1);
    expect(floatingIssues[0].netName).toBe('FLOAT');
    expect(floatingIssues[0].remediationHint).toBeTruthy();
  });

  it('detects duplicate net names', () => {
    const result = validateNets(DUPLICATE_NAME_INPUT);
    expect(result.valid).toBe(false);
    const dupIssues = result.errors.filter((e) => e.code === NetValidationCode.NetDuplicateName);
    expect(dupIssues).toHaveLength(1);
    expect(dupIssues[0].netName).toBe('3V3');
  });

  it('detects accidental shorts (one pin on multiple nets)', () => {
    const result = validateNets(SHORT_INPUT);
    expect(result.valid).toBe(false);
    const shortIssues = result.errors.filter(
      (e) => e.code === NetValidationCode.NetAccidentalShort,
    );
    expect(shortIssues).toHaveLength(1);
    expect(shortIssues[0].componentRef).toBe('U1');
    expect(shortIssues[0].pin).toBe('1');
  });
});

// ── Missing topology ───────────────────────────────────────────────────────

describe('missing topology', () => {
  it('detects missing power net (no net with type=power)', () => {
    const result = validateNets(NO_POWER_INPUT);
    expect(result.valid).toBe(false);
    const powerIssues = result.errors.filter((e) => e.code === NetValidationCode.NetMissingPower);
    expect(powerIssues.length).toBeGreaterThanOrEqual(1);
    // Should have the "no power net found" error (not just the warning)
    const noPowerError = powerIssues.find((e) => e.message.includes('No power net found'));
    expect(noPowerError).toBeDefined();
  });

  it('detects missing ground net (no net with type=ground)', () => {
    const result = validateNets(NO_GROUND_INPUT);
    expect(result.valid).toBe(false);
    const groundIssues = result.errors.filter((e) => e.code === NetValidationCode.NetMissingGround);
    expect(groundIssues.length).toBeGreaterThanOrEqual(1);
    const noGroundError = groundIssues.find((e) => e.message.includes('No ground net found'));
    expect(noGroundError).toBeDefined();
  });

  it('detects missing hierarchical port (interface references unknown net)', () => {
    const result = validateNets(MISSING_PORT_INPUT);
    expect(result.valid).toBe(false);
    const portIssues = result.errors.filter(
      (e) => e.code === NetValidationCode.NetMissingHierarchicalPort,
    );
    expect(portIssues.length).toBeGreaterThanOrEqual(1);
    expect(portIssues[0].netName).toBe('EXT_CLK');
  });
});

// ── Unconnected pins ───────────────────────────────────────────────────────

describe('unconnected pins', () => {
  it('warns when a device has zero pin connections', () => {
    const result = validateNets(UNCONNECTED_DEVICE_INPUT);
    const unconnectedWarnings = result.warnings.filter(
      (e) => e.code === NetValidationCode.NetUnconnectedRequiredPin,
    );
    expect(unconnectedWarnings.length).toBeGreaterThanOrEqual(1);
    expect(unconnectedWarnings[0].componentRef).toBe('U1');
  });
});

// ── Cross-sheet consistency ────────────────────────────────────────────────

describe('cross-sheet consistency', () => {
  it('passes when matching interfaces are consistent', () => {
    const result = validateNets(CROSS_SHEET_INPUT);
    const crossIssues = [
      ...result.errors.filter((e) => e.code === NetValidationCode.NetInconsistentCrossSheet),
      ...result.warnings.filter((e) => e.code === NetValidationCode.NetInconsistentCrossSheet),
    ];
    expect(crossIssues).toHaveLength(0);
  });

  it('detects mismatched cross-sheet interface pins', () => {
    const result = validateNets(MISMATCHED_CROSS_SHEET_INPUT);
    const mismatchedIssues = result.errors.filter(
      (e) => e.code === NetValidationCode.NetInconsistentCrossSheet,
    );
    expect(mismatchedIssues.length).toBeGreaterThanOrEqual(1);
    expect(mismatchedIssues[0].details).toBeDefined();
    expect(mismatchedIssues[0].details!.interfaceName).toBe('BUS_A');
  });
});

// ── Naming conventions ─────────────────────────────────────────────────────

describe('naming conventions', () => {
  it('warns when a power net name does not follow conventions', () => {
    const result = validateNets(BAD_POWER_NAME_INPUT);
    const namingIssues = result.warnings.filter(
      (e) => e.code === NetValidationCode.NetNamingConvention,
    );
    // "MY_RAIL" as power should trigger a naming warning
    const powerNamingIssues = namingIssues.filter((e) => e.netName === 'MY_RAIL');
    expect(powerNamingIssues).toHaveLength(1);
  });

  it('warns when a ground net name does not follow conventions', () => {
    const result = validateNets(BAD_GROUND_NAME_INPUT);
    const namingIssues = result.warnings.filter(
      (e) => e.code === NetValidationCode.NetNamingConvention,
    );
    const groundNamingIssues = namingIssues.filter((e) => e.netName === 'RET');
    expect(groundNamingIssues).toHaveLength(1);
  });
});

// ── Protected domain ───────────────────────────────────────────────────────

describe('protected domain', () => {
  it('detects generic high-voltage net names', () => {
    const result = validateNets(HV_GENERIC_NAME_INPUT);
    const hvIssues = result.errors.filter((e) => e.code === NetValidationCode.NetProtectedDomain);
    expect(hvIssues.length).toBeGreaterThanOrEqual(1);
    expect(hvIssues[0].netName).toBe('L');
  });

  it('detects mixed HV+digital domain (safety hazard)', () => {
    const result = validateNets(HV_MIXED_DOMAIN_INPUT);
    const hvIssues = result.errors.filter((e) => e.code === NetValidationCode.NetProtectedDomain);
    expect(hvIssues.length).toBeGreaterThanOrEqual(1);
    expect(hvIssues[0].netName).toBe('HV_CLK');
  });
});

// ── Error shape ────────────────────────────────────────────────────────────

describe('error shape', () => {
  it('includes remediationHint in all errors', () => {
    const result = validateNets(FLOATING_INPUT);
    for (const err of result.errors) {
      expect(err.remediationHint).toBeTruthy();
    }
  });

  it('includes netName in net-related issues', () => {
    const result = validateNets(DUPLICATE_NAME_INPUT);
    const dupIssues = result.errors.filter((e) => e.code === NetValidationCode.NetDuplicateName);
    expect(dupIssues[0].netName).toBeDefined();
  });

  it('includes componentRef and pin in pin-related issues', () => {
    const result = validateNets(SHORT_INPUT);
    const shortIssues = result.errors.filter(
      (e) => e.code === NetValidationCode.NetAccidentalShort,
    );
    expect(shortIssues[0].componentRef).toBeDefined();
    expect(shortIssues[0].pin).toBeDefined();
  });

  it('includes path field for positional issues', () => {
    const result = validateNets(FLOATING_INPUT);
    const floatingIssues = result.errors.filter((e) => e.code === NetValidationCode.NetFloating);
    expect(floatingIssues[0].path).toMatch(/^nets\[\d+\]$/);
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles empty net list without error', () => {
    const result = validateNets({ nets: [] });
    expect(result.valid).toBe(false); // Will fail because no power/ground
    expect(result.errors).toBeDefined();
  });

  it('handles undefined devices and interfaces', () => {
    const result = validateNets({ nets: [] });
    expect(result).toBeDefined();
    expect(result.errors.length).toBeGreaterThanOrEqual(0);
  });

  it('handles single-net design gracefully', () => {
    const result = validateNets({
      nets: [{ id: 'n1', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'X1', pin: '1' }] }],
    });
    expect(result.valid).toBe(false); // No power net
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ── Semantic ERC ───────────────────────────────────────────────────────────

describe('semantic ERC', () => {
  it('detects active output contention on a signal net', () => {
    const result = validateNets({
      nets: [
        { id: 'pwr', name: '3V3', type: 'power', nodes: [{ deviceRef: 'U1', pin: 'VDD' }] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
        {
          id: 'sig',
          name: 'BUS_DRV',
          type: 'signal',
          nodes: [
            { deviceRef: 'U1', pin: 'OUT' },
            { deviceRef: 'U2', pin: 'OUT' },
          ],
        },
      ],
      devices: [
        { id: 'U1', ref: 'U1', pins: [{ pin: 'OUT', electricalType: 'output' }] },
        { id: 'U2', ref: 'U2', pins: [{ pin: 'OUT', electricalType: 'output' }] },
      ],
    });

    const issues = result.errors.filter((e) => e.code === NetValidationCode.NetOutputContention);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('error');
    expect(issues[0].netName).toBe('BUS_DRV');
    expect(issues[0].remediationHint).toContain('push-pull outputs');
  });

  it('treats same-named pins of one device as one driver and accepts +3V3', () => {
    const result = validateNets({
      nets: [
        { id: 'vin', name: 'VIN', type: 'power', nodes: [{ deviceRef: 'U2', pin: '1' }] },
        { id: 'pwr', name: '+3V3', type: 'power', nodes: [{ deviceRef: 'U2', pin: '12' }] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U2', pin: '2' }] },
        {
          id: 'sig',
          name: 'SYS_OUT',
          type: 'signal',
          nodes: [
            { deviceRef: 'U2', pin: '10' },
            { deviceRef: 'U2', pin: '11' },
          ],
        },
      ],
      devices: [
        {
          id: 'U2',
          ref: 'U2',
          pins: [
            { pin: '10', name: 'OUT', electricalType: 'output' },
            { pin: '11', name: 'OUT', electricalType: 'output' },
          ],
        },
      ],
    });
    expect(result.errors.filter((e) => e.code === NetValidationCode.NetOutputContention)).toEqual(
      [],
    );
    expect(result.warnings.filter((e) => e.netName === '3V3')).toEqual([]);
  });

  it('warns on floating input nets that have no driver or pull resistor', () => {
    const result = validateNets({
      nets: [
        { id: 'pwr', name: '3V3', type: 'power', nodes: [{ deviceRef: 'U1', pin: 'VDD' }] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
        { id: 'sig', name: 'ENABLE', type: 'signal', nodes: [{ deviceRef: 'U1', pin: 'EN' }] },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          pins: [
            { pin: 'VDD', electricalType: 'power_input', expectedNetType: 'power' },
            { pin: 'GND', electricalType: 'power_input', expectedNetType: 'ground' },
            { pin: 'EN', electricalType: 'input' },
          ],
        },
      ],
    });

    const issues = result.warnings.filter((e) => e.code === NetValidationCode.NetFloatingInput);
    expect(issues).toHaveLength(1);
    expect(issues[0].componentRef).toBe('U1');
    expect(issues[0].pin).toBe('EN');
  });

  it('does not warn for an input held by a pull-up resistor', () => {
    const result = validateNets({
      nets: [
        {
          id: 'pwr',
          name: '3V3',
          type: 'power',
          nodes: [
            { deviceRef: 'U1', pin: 'VDD' },
            { deviceRef: 'R1', pin: '1' },
          ],
        },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
        {
          id: 'sig',
          name: 'I2C_SDA',
          type: 'signal',
          nodes: [
            { deviceRef: 'U1', pin: 'SDA' },
            { deviceRef: 'R1', pin: '2' },
          ],
        },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          pins: [
            { pin: 'VDD', electricalType: 'power_input', expectedNetType: 'power' },
            { pin: 'GND', electricalType: 'power_input', expectedNetType: 'ground' },
            { pin: 'SDA', electricalType: 'input' },
          ],
        },
        {
          id: 'R1',
          ref: 'R1',
          category: 'resistor',
          pins: [
            { pin: '1', electricalType: 'passive' },
            { pin: '2', electricalType: 'passive' },
          ],
        },
      ],
    });

    expect(
      [...result.errors, ...result.warnings].filter(
        (e) => e.code === NetValidationCode.NetFloatingInput,
      ),
    ).toHaveLength(0);
  });

  it('detects multiple power sources on the same power rail', () => {
    const result = validateNets({
      nets: [
        {
          id: 'pwr',
          name: '3V3',
          type: 'power',
          nodes: [
            { deviceRef: 'U1', pin: 'OUT' },
            { deviceRef: 'U2', pin: 'OUT' },
            { deviceRef: 'U3', pin: 'VDD' },
          ],
        },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U3', pin: 'GND' }] },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          category: 'regulator',
          pins: [{ pin: 'OUT', electricalType: 'power_output' }],
        },
        {
          id: 'U2',
          ref: 'U2',
          category: 'regulator',
          pins: [{ pin: 'OUT', electricalType: 'power_output' }],
        },
        { id: 'U3', ref: 'U3', pins: [{ pin: 'VDD', electricalType: 'power_input' }] },
      ],
    });

    const issues = result.errors.filter((e) => e.code === NetValidationCode.NetPowerConflict);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('power sources');
  });

  it('warns for passive-only signal nets', () => {
    const result = validateNets({
      nets: [
        { id: 'pwr', name: '3V3', type: 'power', nodes: [{ deviceRef: 'U1', pin: 'VDD' }] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
        {
          id: 'sig',
          name: 'RC_NODE',
          type: 'signal',
          nodes: [
            { deviceRef: 'R1', pin: '1' },
            { deviceRef: 'C1', pin: '1' },
          ],
        },
      ],
      devices: [
        { id: 'U1', ref: 'U1', pins: [{ pin: 'VDD', electricalType: 'power_input' }] },
        {
          id: 'R1',
          ref: 'R1',
          category: 'resistor',
          pins: [{ pin: '1', electricalType: 'passive' }],
        },
        {
          id: 'C1',
          ref: 'C1',
          category: 'capacitor',
          pins: [{ pin: '1', electricalType: 'passive' }],
        },
      ],
    });

    const issues = result.warnings.filter((e) => e.code === NetValidationCode.NetPassiveOnly);
    expect(issues).toHaveLength(1);
    expect(issues[0].netName).toBe('RC_NODE');
  });

  it('detects missing required power pins', () => {
    const result = validateNets({
      nets: [
        { id: 'pwr', name: '3V3', type: 'power', nodes: [] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          category: 'microcontroller',
          pins: [
            {
              pin: 'VDD',
              name: 'VDD',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'power',
            },
            {
              pin: 'GND',
              name: 'GND',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'ground',
            },
          ],
        },
      ],
    });

    const issues = result.errors.filter((e) => e.code === NetValidationCode.NetUnpoweredDevice);
    expect(issues).toHaveLength(1);
    expect(issues[0].componentRef).toBe('U1');
    expect(issues[0].pin).toBe('VDD');
  });

  it('detects required power pins connected to the wrong net class', () => {
    const result = validateNets({
      nets: [
        { id: 'pwr', name: '3V3', type: 'power', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'VDD' }] },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          pins: [
            { pin: 'VDD', electricalType: 'power_input', required: true, expectedNetType: 'power' },
            {
              pin: 'GND',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'ground',
            },
          ],
        },
      ],
    });

    const issues = result.errors.filter((e) => e.code === NetValidationCode.NetUnpoweredDevice);
    expect(issues).toHaveLength(2);
  });

  it('warns when a device requiring decoupling has no capacitor across power and ground', () => {
    const result = validateNets({
      nets: [
        { id: 'pwr', name: '3V3', type: 'power', nodes: [{ deviceRef: 'U1', pin: 'VDD' }] },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          category: 'microcontroller',
          requiresDecoupling: true,
          pins: [
            { pin: 'VDD', electricalType: 'power_input', required: true, expectedNetType: 'power' },
            {
              pin: 'GND',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'ground',
            },
          ],
        },
      ],
    });

    const issues = result.warnings.filter((e) => e.code === NetValidationCode.NetMissingDecoupling);
    expect(issues).toHaveLength(1);
    expect(issues[0].remediationHint).toContain('decoupling capacitor');
  });

  it('does not warn for required decoupling when a capacitor bridges power and ground', () => {
    const result = validateNets({
      nets: [
        {
          id: 'pwr',
          name: '3V3',
          type: 'power',
          nodes: [
            { deviceRef: 'U1', pin: 'VDD' },
            { deviceRef: 'C1', pin: '1' },
          ],
        },
        {
          id: 'gnd',
          name: 'GND',
          type: 'ground',
          nodes: [
            { deviceRef: 'U1', pin: 'GND' },
            { deviceRef: 'C1', pin: '2' },
          ],
        },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          category: 'microcontroller',
          requiresDecoupling: true,
          pins: [
            { pin: 'VDD', electricalType: 'power_input', required: true, expectedNetType: 'power' },
            {
              pin: 'GND',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'ground',
            },
          ],
        },
        {
          id: 'C1',
          ref: 'C1',
          category: 'capacitor',
          pins: [
            { pin: '1', electricalType: 'passive' },
            { pin: '2', electricalType: 'passive' },
          ],
        },
      ],
    });

    expect(
      [...result.errors, ...result.warnings].filter(
        (e) => e.code === NetValidationCode.NetMissingDecoupling,
      ),
    ).toHaveLength(0);
  });

  it('detects voltage-domain mismatches', () => {
    const result = validateNets({
      nets: [
        {
          id: 'pwr',
          name: '5V',
          type: 'power',
          nodes: [{ deviceRef: 'U1', pin: 'VDD' }],
        },
        { id: 'gnd', name: 'GND', type: 'ground', nodes: [{ deviceRef: 'U1', pin: 'GND' }] },
      ],
      devices: [
        {
          id: 'U1',
          ref: 'U1',
          pins: [
            {
              pin: 'VDD',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'power',
              expectedVoltage: 3.3,
            },
            {
              pin: 'GND',
              electricalType: 'power_input',
              required: true,
              expectedNetType: 'ground',
            },
          ],
        },
      ],
    });

    const issues = result.errors.filter((e) => e.code === NetValidationCode.NetVoltageMismatch);
    expect(issues).toHaveLength(1);
    expect(issues[0].details?.expectedVoltage).toBe(3.3);
    expect(issues[0].details?.actualVoltage).toBe(5);
  });
});
