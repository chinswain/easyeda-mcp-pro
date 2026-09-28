/**
 * Net validation — schema types and naming convention definitions.
 *
 * Defines the input contract for net validation functions and the
 * convention sets used to classify net names into analog, digital,
 * power, ground, and high-voltage domains.
 *
 * @module
 */

// ── Naming convention categories ──────────────────────────────────────────

/**
 * Electrical domain inferred from a net name.
 *
 * Used by naming-convention rules to detect misclassifications
 * (e.g. an analog signal connected to a digital rail).
 */
export enum NetDomain {
  /** General-purpose analogue signal (e.g. "SENSE", "FB", "VREF"). */
  Analog = 'analog',
  /** Digital signal, bus, or protocol (e.g. "I2C_SCL", "UART_TXD"). */
  Digital = 'digital',
  /** Power rail or voltage supply (e.g. "3V3", "VIN", "VCC"). */
  Power = 'power',
  /** Ground or return (e.g. "GND", "AGND", "DGND", "PGND"). */
  Ground = 'ground',
  /** AC mains or high-voltage domain (e.g. "L", "N", "HV_BULK"). */
  HighVoltage = 'high-voltage',
  /** Clock or timing signal (e.g. "CLK_32K", "MCO"). */
  Clock = 'clock',
  /** Reset or control signal (e.g. "nRST", "EN", "PWR_ON"). */
  Control = 'control',
  /** Unclassified or custom. */
  Other = 'other',
}

/**
 * Naming convention pattern sets used to classify a net name into a domain.
 *
 * Each entry is a list of **case-insensitive** substrings / regex patterns
 * that, when matched against a net name, assign it to the corresponding
 * {@link NetDomain}.
 */
export const NET_DOMAIN_PATTERNS: Record<Exclude<NetDomain, NetDomain.Other>, RegExp[]> = {
  [NetDomain.Power]: [
    /^[0-9]+V[0-9]*/, // 3V3, 5V, 12V, 1V8
    /^V(CC|DD|EE|SS|IN|OUT|BAT|REF|PP|DRV|SYS|BUS)/i, // VCC, VDD, VIN, VOUT, VBAT, VSYS, VBUS
    /_V(CC|DD|EE|SS|IN|OUT)\b/i, // AVCC, DVDD
    /PWR/i,
    /POWER/i,
    /VSUPPLY/i,
  ],
  [NetDomain.Ground]: [
    /^GND$/i,
    /GND\b/i, // AGND, DGND, PGND, GNDD, GNDA
    /^VSS$/i,
    /GROUND/i,
    /^RETURN$/i,
  ],
  [NetDomain.Analog]: [
    /SENSE/i,
    /FB\b/i, // feedback
    /VREF/i,
    /REFIN/i,
    /REFOUT/i,
    /COMP/i, // comparator output
    /OSC/i,
    /FILTER/i,
    /AGND\b/i, // analog ground reference
  ],
  [NetDomain.Digital]: [
    /^(I2C|SPI|UART|CAN|USB|ETH|MII|RMII|SDIO|I2S|PCM)_/i,
    /_(SCL|SDA|MOSI|MISO|CS|SCK|TXD|RXD|RTS|CTS|TX|RX)\b/i,
    /^[A-Z]+_[A-Z]+(_[A-Z]+)*$/, // SHOUTING_CASE signals like DATA_READY, INT_OUT
  ],
  [NetDomain.Clock]: [/CLK/i, /_MCO\b/i, /XTAL/i, /OSC/i, /TIM/i, /PWM/i],
  [NetDomain.Control]: [
    /^n?(RST|RESET|EN|ENABLE|CS|CE|SHDN|PWR_UP|PWR_DN|WAKE|SLEEP)\b/i,
    /_EN\b/i,
    /_nRST\b/i,
    /_OE\b/i,
  ],
  [NetDomain.HighVoltage]: [
    /^HV/i,
    /^AC_/i,
    /^L\b/i, // Live (mains)
    /^N\b/i, // Neutral (mains)
    /_HV\b/i,
    /MAINS/i,
    /BULK/i,
    /RECT/i,
  ],
};

// ── Reserved net names ────────────────────────────────────────────────────

/**
 * Net names that are reserved for specific purposes and should not be
 * reassigned to other signal types.
 */
export const RESERVED_NET_NAMES = new Set([
  'GND',
  'VSS',
  'VCC',
  'VDD',
  'VEE',
  'VSSA',
  'VDDA',
  'AGND',
  'DGND',
  'PGND',
  'GNDA',
  'GNDD',
  'GNDP',
]);

// ── Power / Ground expectation sets ────────────────────────────────────────

/**
 * Minimum set of power nets that a complete design should contain
 * (case-insensitive matching).
 */
export const REQUIRED_POWER_NETS = new Set(['VIN', '3V3']);

/**
 * Minimum set of ground nets that a complete design should contain.
 */
export const REQUIRED_GROUND_NETS = new Set(['GND']);

// ── Convention mappings ───────────────────────────────────────────────────

/**
 * Map from NetType to expected naming convention domain.
 * A net with a given NetType should have a name matching the
 * corresponding domain(s).
 */
export const NET_TYPE_EXPECTED_DOMAIN: Record<string, NetDomain[]> = {
  power: [NetDomain.Power],
  ground: [NetDomain.Ground],
  signal: [
    NetDomain.Digital,
    NetDomain.Analog,
    NetDomain.Clock,
    NetDomain.Control,
    NetDomain.Other,
  ],
};

// ── Input types for validation ────────────────────────────────────────────

/**
 * A minimal net representation for validation purposes.
 *
 * This is intentionally decoupled from the full CircuitIR NetSchema
 * so that validation can operate on net data from any source
 * (CircuitIR, EasyEDA bridge, hand-authored test data).
 */
export type PinElectricalType =
  | 'input'
  | 'output'
  | 'bidirectional'
  | 'passive'
  | 'power_input'
  | 'power_output'
  | 'power_source'
  | 'open_drain'
  | 'tri_state'
  | 'no_connect';

/** How a pin should be interpreted by semantic ERC. */
export interface PinValidationMetadata {
  /** Pin number or name as it appears in net nodes. */
  pin: string;
  /** Human-readable pin name, e.g. VDD, GND, EN, OUT. */
  name?: string;
  /** Electrical type used for compatibility checks. */
  electricalType: PinElectricalType;
  /** Whether this pin must be connected for the device to be valid. */
  required?: boolean;
  /** Expected net classification for required power/ground/signal pins. */
  expectedNetType?: 'power' | 'signal' | 'ground';
  /** Expected nominal voltage for voltage-domain checks. */
  expectedVoltage?: number;
  /** Whether this pin intentionally allows no-connect. */
  noConnectAllowed?: boolean;
}

/** A connected device pin, optionally carrying semantic pin metadata. */
export interface NetValidationNode {
  deviceRef: string;
  pin: string;
  /** Optional per-node electrical type; device pin metadata takes precedence when both exist. */
  electricalType?: PinElectricalType;
  /** Optional human-readable pin name. */
  pinName?: string;
  /** Optional expected nominal voltage for this pin. */
  expectedVoltage?: number;
}

export interface NetValidationEntry {
  /** Unique net identifier. */
  id: string;
  /** Human-readable net name (e.g. "3V3", "I2C_SCL", "GND"). */
  name: string;
  /** Net type classification. */
  type: 'power' | 'signal' | 'ground';
  /** Optional nominal voltage for voltage-domain checks. */
  voltage?: number;
  /** Connected device pins, may be empty for floating nets. */
  nodes: NetValidationNode[];
}

/**
 * A minimal device representation for validation.
 */
export interface DeviceValidationEntry {
  /** Device identifier (matches deviceRef in net nodes). */
  id: string;
  /** Reference designator (e.g. "U1", "R3"). */
  ref: string;
  /** Functional category for determining required pins. */
  category?: string;
  /** Semantic pin metadata used by ERC rules. */
  pins?: PinValidationMetadata[];
  /** Require at least one local capacitor between each power input rail and ground. */
  requiresDecoupling?: boolean;
}

/**
 * A hierarchical port / interface for cross-sheet validation.
 */
export interface InterfaceValidationEntry {
  /** Interface identifier. */
  id: string;
  /** Interface / port name. */
  name: string;
  /** Pins on this interface. */
  pinout: Array<{ pin: string; signal: string; type?: string }>;
}

// ── Validation input ──────────────────────────────────────────────────────

/**
 * Complete input to the net validation function.
 */
export interface NetValidationInput {
  /** Nets to validate. */
  nets: NetValidationEntry[];
  /** Optional device list for unconnected-pin checks. */
  devices?: DeviceValidationEntry[];
  /** Optional interface list for cross-sheet checks. */
  interfaces?: InterfaceValidationEntry[];
}
