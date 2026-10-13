import { z } from 'zod';

/**
 * Forgiving input layer applied before a tool's schema validates.
 *
 * Transcript mining showed most failed calls were near-misses that the strict
 * schemas rejected: `pin_number` for `pinNumber`, `designator` for
 * `reference`, `"8"` for `8`, a JSON string for an array, `[[x, y]]` for
 * `[{x, y}]`, or a missing `projectId`. Each is mapped here only when the
 * intended field is unambiguous; everything else still fails validation.
 */

/** When omitted, `projectId` means the project focused in EasyEDA. */
export const CURRENT_PROJECT = 'current';

// Semantic synonyms. Case/underscore variants (pin_number → pinNumber) need no entry.
const SYNONYMS: Record<string, string[]> = {
  reference: ['designator', 'ref', 'refdes', 'references', 'designators'],
  designator: ['reference', 'ref', 'refdes', 'references', 'designators'],
  references: ['designators', 'refs', 'reference', 'designator', 'ref'],
  designators: ['references', 'refs', 'designator', 'reference', 'ref'],
  primitiveIds: ['primitiveId', 'ids', 'id'],
  netName: ['net', 'net_name', 'name'],
  net: ['netName', 'net_name'],
  pinNumber: ['pin', 'pin_number', 'pinNo'],
  key: ['keyword', 'query', 'search', 'q', 'lcsc', 'lcscId'],
  query: ['keyword', 'key', 'search', 'q'],
  lcscId: ['lcsc', 'lcscPartNumber', 'lcsc_id', 'partNumber', 'supplierId'],
  points: ['polygon', 'polygon_mm', 'vertices'],
  polygon_mm: ['polygon', 'points', 'vertices'],
  primitiveId: ['id', 'primitive_id'],
};

const squash = (k: string) => k.replace(/[_\s-]/g, '').toLowerCase();
// Keyed by squashed name so `pin_number` shares `pinNumber`'s aliases.
const ALIASES = new Map(Object.entries(SYNONYMS).map(([k, v]) => [squash(k), v.map(squash)]));

type Def = {
  type: string;
  catchall?: z.ZodType;
  innerType?: z.ZodType;
  in?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
};
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

/** Strip optional/default/nullable/readonly/pipe wrappers down to the value type. */
function core(schema: z.ZodType): z.ZodType {
  let s = schema;
  for (let i = 0; i < 10; i++) {
    const d = defOf(s);
    if (d.innerType) s = d.innerType;
    else if (d.type === 'pipe' && d.in) s = d.in;
    else break;
  }
  return s;
}

const isRequired = (schema: z.ZodType) => !schema.safeParse(undefined).success;

function coerceString(value: string, schema: z.ZodType, target: z.ZodType, t: string): unknown {
  const s = value.trim();
  const bool = s === 'true' || s === 'false';
  if (t === 'number' && s !== '' && Number.isFinite(Number(s))) return Number(s);
  if (t === 'boolean' && bool) return s === 'true';
  if (t === 'literal' && bool && target.safeParse(s === 'true').success) return s === 'true';
  if ((t === 'array' || t === 'object') && /^[[{]/.test(s)) {
    try {
      return coerce(JSON.parse(s), schema);
    } catch {
      return value;
    }
  }
  return t === 'array' ? coerce([value], schema) : value;
}

function coerceObject(value: unknown, shape: Record<string, z.ZodType>): unknown {
  // [x, y] → {x, y} for point-shaped objects.
  const pair =
    Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number');
  if (pair && 'x' in shape && 'y' in shape) return { x: value[0], y: value[1] };
  if (value && typeof value === 'object' && !Array.isArray(value))
    return normalizeObject(value as Record<string, unknown>, shape);
  return value;
}

function coerce(value: unknown, schema: z.ZodType): unknown {
  const target = core(schema);
  const def = defOf(target);
  const t = def.type;
  if (typeof value === 'string') return coerceString(value, schema, target, t);
  if (t === 'string' && typeof value === 'number') return String(value);
  if (t === 'string' && Array.isArray(value) && value.length === 1) return coerce(value[0], schema);
  if (t === 'object') return coerceObject(value, def.shape ?? {});
  if (t !== 'array' || value === undefined || value === null) return value;
  if (!Array.isArray(value)) return typeof value === 'object' ? value : [value];
  const element = def.element;
  return element ? value.map((v) => coerce(v, element)) : value;
}

function normalizeObject(
  input: Record<string, unknown>,
  shape: Record<string, z.ZodType>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  const keys = Object.keys(shape);
  const bySquash = new Map(keys.map((k) => [squash(k), k]));
  for (const k of Object.keys(input)) {
    if (k in shape) continue;
    const target =
      bySquash.get(squash(k)) ??
      keys.find((want) => ALIASES.get(squash(want))?.includes(squash(k)));
    if (target && out[target] === undefined) {
      out[target] = input[k];
      delete out[k];
    }
  }
  for (const [k, s] of Object.entries(shape)) {
    if (out[k] !== undefined) out[k] = coerce(out[k], s);
  }
  return out;
}

const shapeOf = (schema: z.ZodType): Record<string, z.ZodType> | undefined =>
  schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodType>) : undefined;

/** Returns normalized input; unknown shapes (unions etc.) pass through untouched. */
export function normalizeToolInput(schema: z.ZodType, input: unknown): unknown {
  const shape = shapeOf(schema);
  if (!shape || typeof input !== 'object' || input === null || Array.isArray(input)) {
    return shape && (input === undefined || input === null)
      ? normalizeToolInput(schema, {})
      : input;
  }
  const out = normalizeObject(input as Record<string, unknown>, shape);
  if (shape.projectId && out.projectId === undefined && isRequired(shape.projectId)) {
    out.projectId = CURRENT_PROJECT;
  }
  return out;
}

/**
 * The schema published to MCP clients: same JSON Schema except a required
 * `projectId` becomes optional, and validation runs on normalized input.
 */
export function lenientInputSchema(schema: z.ZodType): z.ZodType {
  const shape = shapeOf(schema);
  const published =
    shape?.projectId && isRequired(shape.projectId)
      ? (schema as z.ZodObject).safeExtend({
          projectId: shape.projectId
            .optional()
            .describe('Project uuid. Omit to use the project focused in EasyEDA.'),
        })
      : schema;
  const std = published['~standard'];
  const wrapped = Object.create(published) as z.ZodType;
  Object.defineProperty(wrapped, '~standard', {
    value: {
      ...std,
      validate: (value: unknown) => {
        const input = normalizeToolInput(schema, value);
        const unknown = unknownKeys(schema, input);
        return unknown.length
          ? {
              issues: unknown.map((k) => ({
                message: `Unknown parameter "${k}". Accepted: ${Object.keys(shape ?? {}).join(', ')}.`,
                path: [k],
              })),
            }
          : schema['~standard'].validate(input);
      },
    },
  });
  return wrapped;
}

/** Keys zod would silently strip; an ignored filter makes a tool answer the wrong question. */
function unknownKeys(schema: z.ZodType, input: unknown): string[] {
  const shape = shapeOf(schema);
  if (!shape || defOf(schema).catchall || typeof input !== 'object' || input === null) return [];
  return Object.keys(input).filter((k) => !(k in shape));
}
