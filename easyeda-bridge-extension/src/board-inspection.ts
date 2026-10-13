import type { ApiRuntime, BridgeErrorFactory } from './api-runtime.js';
import type { DispatcherToolkit } from './toolkit.js';
import {
  isBoardOutlineLayer,
  primitiveIsOnBoardOutline,
  readFiniteNumber,
  readPrimitiveState,
} from './pcb-primitive-state.js';
import { isRecord, logRecoverableError, readPath } from './utils.js';

export interface BoardInspectionDependencies {
  readFirstPath: ApiRuntime['readFirstPath'];
  getGlobal: DispatcherToolkit['getGlobal'];
  createBridgeError: BridgeErrorFactory;
  // Optional: enables the document-source stackup fallback (see readDocumentStackup).
  callFirst?: ApiRuntime['callFirst'];
}

export interface BoardInspectionOperations {
  requireActivePcbContext(): Promise<void>;
  listLayers(): Promise<unknown>;
  getStackup(): Promise<unknown>;
  getDimensions(): Promise<unknown>;
  getFeatures(): Promise<unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PCB_MIL_TO_MM = 0.0254;

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

function pcbMilToMm(value: number): number {
  return roundMetric(value * PCB_MIL_TO_MM);
}

function isActivePcbLayerName(name: string, copperLayerCount: number): boolean {
  const inner = /^Inner(\d+)$/i.exec(name);
  if (inner) return Number(inner[1]) <= Math.max(0, copperLayerCount - 2);
  // EasyEDA returns its entire layer catalogue (200 Custom slots and all 32
  // possible inner layers) from getAllLayers(). Those catalogue placeholders
  // are not layers in the active board. A renamed custom layer no longer
  // matches this placeholder pattern and is retained.
  if (/^Custom\d+$/i.test(name) || /^Dielectric\d+$/i.test(name)) return false;
  return true;
}

async function readCopperLayerCount(pcbLayerClass: any): Promise<number> {
  if (typeof pcbLayerClass?.getTheNumberOfCopperLayers !== 'function') return 0;
  try {
    const value = Number(await pcbLayerClass.getTheNumberOfCopperLayers());
    return Number.isInteger(value) && value >= 2 ? value : 0;
  } catch (error) {
    logRecoverableError('failed to read copper layer count', error);
    return 0;
  }
}

// IPCB_PhysicalStackingConfiguration.list items use the Layer Manager export keys
// ("Layer", "Layer Type", "Type", "Material", "Thickness", "Permittivity",
// "Loss Tangent"); camelCase aliases are accepted for older/newer shapes.
function selectPhysicalStackupLayers(physicalStacking: any): any[] {
  if (Array.isArray(physicalStacking?.list)) return physicalStacking.list;
  if (Array.isArray(physicalStacking?.layers)) return physicalStacking.layers;
  if (Array.isArray(physicalStacking?.stackup)) return physicalStacking.stackup;
  return [];
}

function readBoardThickness(physicalStacking: any): number | undefined {
  if (typeof physicalStacking?.thicknessMm === 'number') return physicalStacking.thicknessMm;
  if (typeof physicalStacking?.thickness === 'number') return physicalStacking.thickness;
  return undefined;
}

export interface StackupLayer {
  name: string;
  type: string;
  thicknessMm: number | undefined;
  material: string;
  dielectricConstant: number | undefined;
  lossTangent: number | undefined;
  copperWeightOz: number | undefined;
}

const STANDARD_1OZ_COPPER_MM = 0.035;

function stackupLayerType(layerType: string, typeLabel: string): string {
  const key = `${layerType} ${typeLabel}`.toUpperCase();
  if (/SUBSTRATE|DIELECTRIC|CORE|PREPREG/.test(key)) return 'dielectric';
  if (/SILK/.test(key)) return 'silkscreen';
  if (/SOLDER_?MASK/.test(key)) return 'soldermask';
  if (/PASTE/.test(key)) return 'paste';
  if (/COPPER|^TOP |^BOTTOM |SIGNAL|INNER|PLANE/.test(key)) return 'copper';
  return layerType || typeLabel || '';
}

// Copper weight: explicit "1oz" in the material label wins; otherwise derive from
// the copper thickness (1 oz/ft2 = 35 um). Returns undefined for non-copper layers.
function deriveCopperWeightOz(
  type: string,
  material: string,
  thicknessMm: number | undefined,
): number | undefined {
  if (type !== 'copper') return undefined;
  const labelled = /(\d+(?:\.\d+)?)\s*oz/i.exec(material);
  if (labelled) return Number(labelled[1]);
  if (typeof thicknessMm !== 'number' || !Number.isFinite(thicknessMm)) return undefined;
  return Math.round((thicknessMm / STANDARD_1OZ_COPPER_MM) * 100) / 100;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value) return value;
  }
  return '';
}

function normalizePhysicalStackupLayer(layer: any): StackupLayer {
  const type = stackupLayerType(
    pickString(layer?.['Layer Type'], layer?.layerType),
    pickString(layer?.Type, layer?.type),
  );
  const material = pickString(layer?.Material, layer?.material);
  const thicknessMm = pickNumber(layer?.thicknessMm, layer?.Thickness, layer?.thickness);
  return {
    name: pickString(layer?.Layer, layer?.layerName, layer?.name),
    type,
    thicknessMm,
    material,
    dielectricConstant: pickNumber(
      layer?.dielectricConstant,
      layer?.Permittivity,
      layer?.permittivity,
      layer?.dielectric,
    ),
    lossTangent: pickNumber(layer?.lossTangent, layer?.['Loss Tangent']),
    copperWeightOz:
      pickNumber(layer?.copperWeightOz, layer?.copperWeight) ??
      deriveCopperWeightOz(type, material, thicknessMm),
  };
}

// ponytail: EasyEDA Pro 3.2.206 returns null from every PCB_Layer physical-stacking
// getter, so fall back to the saved document source. The DOCHEAD segment holds one
// `{"type":"LAYER",...,"id":"[\"LAYER\",361]"}||{...}|` line per layer and one
// `LAYER_PHYS` line per stack member (thickness in mil, ordered by zIndex).
// Drop this once getCurrentPhysicalStackingConfiguration() returns data.
export function parseDocumentStackup(source: string): StackupLayer[] {
  const layers = new Map<string, Record<string, unknown>>();
  const phys = new Map<string, Record<string, unknown>>();
  // Line shape: `{"type":"LAYER","ticket":2,"id":"[\"LAYER\",1]"}||{...}|`
  // (the optional ticket field appears in the live document, not in .epru exports).
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{"type":"LAYER')) continue;
    const sep = line.indexOf('||');
    if (sep < 0) continue;
    let header: unknown;
    let body: unknown;
    let idTuple: unknown;
    try {
      header = JSON.parse(line.slice(0, sep));
      body = JSON.parse(line.slice(sep + 2).replace(/\|$/, ''));
      idTuple = isRecord(header) && typeof header.id === 'string' ? JSON.parse(header.id) : null;
    } catch {
      continue;
    }
    if (!isRecord(header) || !isRecord(body) || !Array.isArray(idTuple)) continue;
    const id = String(idTuple[1]);
    if (header.type === 'LAYER') layers.set(id, body);
    else if (header.type === 'LAYER_PHYS') phys.set(id, body);
  }
  return [...phys.entries()]
    .sort(([, a], [, b]) => (pickNumber(a.zIndex) ?? 0) - (pickNumber(b.zIndex) ?? 0))
    .map(([id, p]) => {
      const layer = layers.get(id) ?? {};
      const type = stackupLayerType(pickString(layer.layerType), '');
      const material = pickString(p.material);
      const thicknessMil = pickNumber(p.thickness);
      const thicknessMm =
        thicknessMil === undefined
          ? undefined
          : Math.round(thicknessMil * PCB_MIL_TO_MM * 10000) / 10000;
      return {
        name: pickString(layer.layerName, `layer-${id}`),
        type,
        thicknessMm,
        material,
        dielectricConstant: pickNumber(p.permittivity),
        lossTangent: pickNumber(p.lossTangent),
        copperWeightOz: deriveCopperWeightOz(type, material, thicknessMm),
      };
    });
}

function sumThickness(layers: StackupLayer[]): number | undefined {
  const values = layers.map((l) => l.thicknessMm).filter((v): v is number => v !== undefined);
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((a, b) => a + b, 0) * 10000) / 10000;
}

interface BoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function createEmptyBoundingBox(): BoundingBox {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  };
}

function updateBoundingBox(bounds: BoundingBox, x: unknown, y: unknown): void {
  const finiteX = readFiniteNumber(x);
  const finiteY = readFiniteNumber(y);
  if (finiteX === undefined || finiteY === undefined) return;
  if (finiteX < bounds.minX) bounds.minX = finiteX;
  if (finiteX > bounds.maxX) bounds.maxX = finiteX;
  if (finiteY < bounds.minY) bounds.minY = finiteY;
  if (finiteY > bounds.maxY) bounds.maxY = finiteY;
}

async function readPrimitiveStateResolved(value: unknown, key: string): Promise<unknown> {
  try {
    return await readPrimitiveState(value, key);
  } catch (error) {
    logRecoverableError(`failed to read primitive state ${key}`, error);
    return undefined;
  }
}

async function primitiveIsOnBoardOutlineResolved(value: unknown): Promise<boolean> {
  if (primitiveIsOnBoardOutline(value)) return true;
  if (isBoardOutlineLayer(await readPrimitiveStateResolved(value, 'Layer'))) return true;

  for (const key of ['LayerName', 'PrimitiveType', 'Type', 'ObjectType']) {
    if (isBoardOutlineLayer(await readPrimitiveStateResolved(value, key))) return true;
  }
  return false;
}

async function readPointCoordinate(point: unknown, key: 'X' | 'Y'): Promise<unknown> {
  const state = await readPrimitiveStateResolved(point, key);
  if (state !== undefined) return state;
  if (!isRecord(point)) return undefined;
  return await point[key.toLowerCase()];
}

async function addPoint(bounds: BoundingBox, point: unknown): Promise<void> {
  if (Array.isArray(point)) {
    updateBoundingBox(bounds, point[0], point[1]);
    return;
  }
  updateBoundingBox(
    bounds,
    await readPointCoordinate(point, 'X'),
    await readPointCoordinate(point, 'Y'),
  );
}

async function addPoints(bounds: BoundingBox, points: unknown): Promise<boolean> {
  if (!Array.isArray(points)) return false;
  for (const point of points) await addPoint(bounds, point);
  return points.length > 0;
}

async function readPolygonSource(polygon: Record<string, unknown>): Promise<unknown[] | undefined> {
  if (typeof polygon.getSource === 'function') {
    try {
      const source = await polygon.getSource();
      if (Array.isArray(source)) return source;
    } catch (error) {
      logRecoverableError('failed to read board outline polygon source', error);
    }
  }

  const direct = await polygon.polygon;
  return Array.isArray(direct) ? direct : undefined;
}

function readFiniteSourceNumbers(
  source: readonly unknown[],
  startIndex: number,
  count: number,
): number[] | undefined {
  const values = source.slice(startIndex, startIndex + count).map(readFiniteNumber);
  return values.every((value): value is number => value !== undefined) ? values : undefined;
}

function addRectangleSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  if (source.length !== 7) return false;
  const values = readFiniteSourceNumbers(source, 1, 6);
  if (!values) return false;

  const [x, y, width, height, rotation, round] = values;
  if (width < 0 || height < 0 || round < 0 || rotation % 360 !== 0) return false;

  updateBoundingBox(bounds, x, y);
  updateBoundingBox(bounds, x + width, y + height);
  return true;
}

function addCircleSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  if (source.length !== 4) return false;
  const values = readFiniteSourceNumbers(source, 1, 3);
  if (!values) return false;

  const [centerX, centerY, radius] = values;
  if (radius < 0) return false;

  updateBoundingBox(bounds, centerX - radius, centerY - radius);
  updateBoundingBox(bounds, centerX + radius, centerY + radius);
  return true;
}

function addLinePolylineSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  const start = readFiniteSourceNumbers(source, 0, 2);
  if (!start || source[2] !== 'L') return false;

  const coordinates = readFiniteSourceNumbers(source, 3, source.length - 3);
  if (!coordinates || coordinates.length < 2 || coordinates.length % 2 !== 0) return false;

  updateBoundingBox(bounds, start[0], start[1]);
  for (let index = 0; index < coordinates.length; index += 2) {
    updateBoundingBox(bounds, coordinates[index], coordinates[index + 1]);
  }
  return true;
}

function addRawPolygonSourceBounds(bounds: BoundingBox, source: readonly unknown[]): boolean {
  if (source[0] === 'R') return addRectangleSourceBounds(bounds, source);
  if (source[0] === 'CIRCLE') return addCircleSourceBounds(bounds, source);
  if (readFiniteNumber(source[0]) !== undefined) return addLinePolylineSourceBounds(bounds, source);
  return false;
}

interface DiscretizationAttempt {
  added: boolean;
  error?: unknown;
}

async function tryDiscretize(
  bounds: BoundingBox,
  discretize: (() => unknown) | undefined,
): Promise<DiscretizationAttempt> {
  if (!discretize) return { added: false };
  try {
    return { added: await addPoints(bounds, await discretize()) };
  } catch (error) {
    return { added: false, error };
  }
}

function logPolygonFallbackFailures(
  instanceError: unknown,
  staticError: unknown,
  source: readonly unknown[] | undefined,
): void {
  if (instanceError !== undefined) {
    logRecoverableError('failed to discretize board outline polygon', instanceError);
  }
  if (staticError !== undefined) {
    logRecoverableError(
      'failed to discretize board outline polygon with PCB_MathPolygon',
      staticError,
    );
  }
  if (source) {
    logRecoverableError(
      'unsupported board outline polygon source',
      new Error(`Unsupported or malformed polygon source mode: ${String(source[0])}`),
    );
  }
}

async function addPolygonPoints(
  bounds: BoundingBox,
  polygonValue: unknown,
  pcbMathPolygonClass: any,
): Promise<void> {
  const polygon = await polygonValue;
  if (!isRecord(polygon)) return;

  const instanceDiscretize = polygon.discretize;
  const instance = await tryDiscretize(
    bounds,
    typeof instanceDiscretize === 'function' ? () => instanceDiscretize.call(polygon) : undefined,
  );
  if (instance.added) return;

  const source = await readPolygonSource(polygon);
  const staticDiscretize = pcbMathPolygonClass?.discretize;
  const staticAttempt = await tryDiscretize(
    bounds,
    typeof staticDiscretize === 'function'
      ? () => staticDiscretize.call(pcbMathPolygonClass, source ?? polygon)
      : undefined,
  );
  if (staticAttempt.added) return;
  if (source && addRawPolygonSourceBounds(bounds, source)) return;

  logPolygonFallbackFailures(instance.error, staticAttempt.error, source);
}

async function addPrimitivePoints(
  bounds: BoundingBox,
  primitive: unknown,
  pcbMathPolygonClass: any,
): Promise<void> {
  await addPoints(bounds, await readPrimitiveStateResolved(primitive, 'Points'));
  await addPolygonPoints(
    bounds,
    readPrimitiveStateResolved(primitive, 'Polygon'),
    pcbMathPolygonClass,
  );

  updateBoundingBox(
    bounds,
    await readPrimitiveStateResolved(primitive, 'StartX'),
    await readPrimitiveStateResolved(primitive, 'StartY'),
  );
  updateBoundingBox(
    bounds,
    await readPrimitiveStateResolved(primitive, 'EndX'),
    await readPrimitiveStateResolved(primitive, 'EndY'),
  );
}

async function addOutlinePrimitiveBounds(
  primitiveClass: any,
  bounds: BoundingBox,
  description: string,
  pcbMathPolygonClass: any,
): Promise<void> {
  if (!primitiveClass || typeof primitiveClass.getAll !== 'function') return;
  try {
    const primitives = await primitiveClass.getAll();
    for (const primitive of primitives || []) {
      if (!(await primitiveIsOnBoardOutlineResolved(primitive))) continue;
      await addPrimitivePoints(bounds, primitive, pcbMathPolygonClass);
    }
  } catch (error) {
    logRecoverableError(`failed to read board outline ${description}`, error);
  }
}

async function countPrimitiveCollection(pcbClass: any, description: string): Promise<number> {
  if (!pcbClass || typeof pcbClass.getAll !== 'function') return 0;
  try {
    return (await pcbClass.getAll())?.length || 0;
  } catch (error) {
    logRecoverableError(`failed to count ${description}`, error);
    return 0;
  }
}

async function countMountingHoles(pcbPadClass: any): Promise<number> {
  if (!pcbPadClass || typeof pcbPadClass.getAll !== 'function') return 0;
  try {
    let mountingHoles = 0;
    const pads = await pcbPadClass.getAll();
    for (const pad of pads || []) {
      // Live pads carry Hole: ['ROUND', diameterMil] (no HoleType key). A
      // mounting hole is any through-hole pad with no net; >2 mm (79 mil) plated
      // pads with no net count as well.
      const hole = (await readPrimitiveStateResolved(pad, 'Hole')) as unknown[] | null;
      const holeSize = Array.isArray(hole) ? (readFiniteNumber(hole[1]) ?? 0) : 0;
      const net = await readPrimitiveStateResolved(pad, 'Net');
      if (holeSize > 0 && !net) mountingHoles++;
    }
    return mountingHoles;
  } catch (error) {
    logRecoverableError('failed to read mounting-hole pads', error);
    return 0;
  }
}

export function createBoardInspectionOperations({
  readFirstPath,
  getGlobal,
  createBridgeError,
  callFirst,
}: BoardInspectionDependencies): BoardInspectionOperations {
  async function requireActivePcbContext(): Promise<void> {
    const dmtPcb = readFirstPath<any>(['DMT_Pcb', 'dmt_Pcb']);
    if (!dmtPcb || typeof dmtPcb.getCurrentPcbInfo !== 'function') {
      // Older EasyEDA builds may not expose DMT_Pcb. Preserve compatibility and
      // let the concrete PCB API call decide whether the context is usable.
      return;
    }

    let currentPcb: unknown;
    try {
      currentPcb = await dmtPcb.getCurrentPcbInfo();
    } catch (error) {
      throw createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'PCB data is unavailable in the current editor context.',
        'Open and focus a PCB document, then retry.',
        { cause: errorMessage(error) },
      );
    }
    if (!currentPcb) {
      throw createBridgeError(
        'CONTEXT_UNAVAILABLE',
        'No active PCB document is focused.',
        'Open and focus a PCB document, then retry.',
      );
    }
  }

  async function listLayers(): Promise<unknown> {
    await requireActivePcbContext();
    const pcbLayerClass = readFirstPath<any>(['PCB_Layer', 'pcb_Layer']);
    if (!pcbLayerClass || typeof pcbLayerClass.getAllLayers !== 'function') {
      throw new Error('pcb_Layer class or getAllLayers method not found');
    }
    const copperLayerCount = await readCopperLayerCount(pcbLayerClass);
    const rawLayers = await pcbLayerClass.getAllLayers();
    const layers = Array.isArray(rawLayers) ? rawLayers : [];
    return layers
      .filter((layer: any) => isActivePcbLayerName(String(layer?.name ?? ''), copperLayerCount))
      .map((layer: any, index: number) => ({
        name: layer?.name || '',
        type: layer?.type || '',
        color: layer?.color || '',
        visible: layer?.visible !== false,
        order:
          typeof layer?.order === 'number' && Number.isFinite(layer.order) && layer.order > 0
            ? layer.order
            : index,
      }));
  }

  async function readDocumentStackup(): Promise<StackupLayer[]> {
    if (!callFirst) return [];
    try {
      const source = await callFirst(['SYS_FileManager.getDocumentSource']);
      return typeof source === 'string' ? parseDocumentStackup(source) : [];
    } catch (error) {
      logRecoverableError('failed to read document-source stackup', error);
      return [];
    }
  }

  async function getStackup(): Promise<unknown> {
    await requireActivePcbContext();
    const pcbLayerClass = readFirstPath<any>(['PCB_Layer', 'pcb_Layer']);
    if (!pcbLayerClass) {
      throw new Error('pcb_Layer class not found');
    }

    const totalCopper = await readCopperLayerCount(pcbLayerClass);
    let physicalStacking: any = null;
    if (typeof pcbLayerClass.getCurrentPhysicalStackingConfiguration === 'function') {
      try {
        physicalStacking = await pcbLayerClass.getCurrentPhysicalStackingConfiguration();
      } catch (error) {
        logRecoverableError('failed to read physical stackup', error);
      }
    }

    let layers = selectPhysicalStackupLayers(physicalStacking).map(normalizePhysicalStackupLayer);
    let source: 'physical_stackup' | 'document_source' | 'copper_layer_count_only' =
      'physical_stackup';
    let boardThickness = readBoardThickness(physicalStacking);
    if (layers.length === 0) {
      layers = await readDocumentStackup();
      source = 'document_source';
    }
    const available = layers.length > 0;
    if (!available) source = 'copper_layer_count_only';
    if (available && boardThickness === undefined) boardThickness = sumThickness(layers);

    return {
      totalLayers: totalCopper,
      boardThicknessMm: boardThickness,
      layers,
      available,
      source,
    };
  }

  async function getDimensions(): Promise<unknown> {
    await requireActivePcbContext();
    const globalObj = getGlobal();
    const pcbLineClass = readPath<any>(globalObj, 'pcb_PrimitiveLine');
    const pcbArcClass = readPath<any>(globalObj, 'pcb_PrimitiveArc');
    const pcbPolylineClass = readPath<any>(globalObj, 'pcb_PrimitivePolyline');
    const pcbPadClass = readPath<any>(globalObj, 'pcb_PrimitivePad');
    const pcbMathPolygonClass = readFirstPath<any>(['PCB_MathPolygon', 'pcb_MathPolygon']);
    const bounds = createEmptyBoundingBox();

    await addOutlinePrimitiveBounds(pcbLineClass, bounds, 'lines', pcbMathPolygonClass);
    await addOutlinePrimitiveBounds(pcbArcClass, bounds, 'arcs', pcbMathPolygonClass);
    await addOutlinePrimitiveBounds(pcbPolylineClass, bounds, 'polylines', pcbMathPolygonClass);

    const widthMil = bounds.maxX > bounds.minX ? bounds.maxX - bounds.minX : 0;
    const heightMil = bounds.maxY > bounds.minY ? bounds.maxY - bounds.minY : 0;
    const width = pcbMilToMm(widthMil);
    const height = pcbMilToMm(heightMil);
    const mountingHoles = await countMountingHoles(pcbPadClass);
    const hasOutline = width > 0 && height > 0;

    return {
      widthMm: width,
      heightMm: height,
      shape: hasOutline ? 'custom' : undefined,
      mountingHoleCount: mountingHoles,
      areaMm2: roundMetric(width * height),
      hasOutline,
    };
  }

  async function getFeatures(): Promise<unknown> {
    await requireActivePcbContext();
    const globalObj = getGlobal();
    const counts = await Promise.all(
      [
        ['pcb_PrimitiveVia', 'vias'],
        ['pcb_PrimitiveLine', 'tracks'],
        ['pcb_PrimitivePour', 'zones'],
        ['pcb_PrimitiveFill', 'fills'],
        ['pcb_PrimitiveRegion', 'regions'],
        ['pcb_PrimitivePad', 'pads'],
        ['pcb_PrimitiveComponent', 'PCB components'],
      ].map(([path, description]) =>
        countPrimitiveCollection(readPath<any>(globalObj, path), description),
      ),
    );
    return {
      vias: counts[0],
      tracks: counts[1],
      zones: counts[2],
      fills: counts[3],
      regions: counts[4],
      pads: counts[5],
      components: counts[6],
    };
  }

  return {
    requireActivePcbContext,
    listLayers,
    getStackup,
    getDimensions,
    getFeatures,
  };
}
