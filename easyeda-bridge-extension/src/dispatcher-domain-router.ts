import type { BoardInspectionOperations } from './board-inspection.js';
import type { CanvasOperations } from './canvas-operations.js';
import type { DesignRuleCheckOperations } from './design-rule-check-operations.js';
import type { ExportOperations } from './export-operations.js';
import type { PcbAgenticOperations } from './pcb-agentic-operations.js';
import type { PcbMutationOperations } from './pcb-mutation-operations.js';
import type { PcbReadOperations } from './pcb-read-operations.js';
import type { PcbWriteOperations } from './pcb-write-operations.js';
import type { ProjectOperations } from './project-operations.js';
import type { ReadOnlyOperations } from './read-only-operations.js';
import type { SchematicTransactionOperations } from './schematic-transaction-operations.js';
import { assertSchematicReadOperationScope } from './schematic-read-scope.js';
import type { SystemApiOperations } from './system-api-operations.js';

export interface DispatcherDomainRouterDependencies {
  projectOperations: ProjectOperations;
  readOnlyOperations: ReadOnlyOperations;
  schematicTransactionOperations: SchematicTransactionOperations;
  systemApiOperations: SystemApiOperations;
  boardInspection: BoardInspectionOperations;
  exportOperations: ExportOperations;
  designRuleCheckOperations: DesignRuleCheckOperations;
  canvasOperations: CanvasOperations;
  pcbWriteOperations: PcbWriteOperations;
  pcbMutationOperations: PcbMutationOperations;
  pcbReadOperations: PcbReadOperations;
  pcbAgenticOperations: PcbAgenticOperations;
}

export type DispatcherDomainRouteResult = { handled: false } | { handled: true; value: unknown };

export interface DispatcherDomainRouter {
  methodList: readonly string[];
  tryDispatch(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<DispatcherDomainRouteResult>;
}

type DomainMethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

interface DomainRoute {
  method: string;
  handle: DomainMethodHandler;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function offsetNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function assertRouterSchematicScope(method: string, params: Record<string, unknown>): void {
  assertSchematicReadOperationScope(params, method);
}

export function createDispatcherDomainRouter(
  dependencies: DispatcherDomainRouterDependencies,
): DispatcherDomainRouter {
  const pcbListRoutes: DomainRoute[] = Object.entries({
    'pcb.listComponents': dependencies.pcbReadOperations.listComponents,
    'pcb.listFills': dependencies.pcbReadOperations.listFills,
    'pcb.listRegions': dependencies.pcbReadOperations.listRegions,
    'pcb.listTracks': dependencies.pcbReadOperations.listTracks,
    'pcb.listVias': dependencies.pcbReadOperations.listVias,
  }).map(([method, read]) => ({
    method,
    handle: (params) => read(optionalNumber(params.limit), offsetNumber(params.offset)),
  }));
  const routes = [
    { method: 'api.call', handle: (params) => dependencies.systemApiOperations.apiCall(params) },
    {
      method: 'api.execute',
      handle: (params) => dependencies.systemApiOperations.apiExecute(params),
    },
    {
      method: 'board.exportGerbers',
      handle: (params) => dependencies.exportOperations.exportGerbers(params),
    },
    { method: 'board.getDimensions', handle: () => dependencies.boardInspection.getDimensions() },
    { method: 'board.getFeatures', handle: () => dependencies.boardInspection.getFeatures() },
    { method: 'board.getStackup', handle: () => dependencies.boardInspection.getStackup() },
    { method: 'board.listLayers', handle: () => dependencies.boardInspection.listLayers() },
    { method: 'canvas.capture', handle: (params) => dependencies.canvasOperations.capture(params) },
    {
      method: 'canvas.captureRegion',
      handle: (params) => dependencies.canvasOperations.captureRegion(params),
    },
    { method: 'canvas.locate', handle: (params) => dependencies.canvasOperations.locate(params) },
    { method: 'design.drc', handle: () => dependencies.designRuleCheckOperations.runDrc() },
    { method: 'design.erc', handle: () => dependencies.designRuleCheckOperations.runErc() },
    {
      method: 'design.ruleCheck',
      handle: () => dependencies.designRuleCheckOperations.runRuleCheck(),
    },
    {
      method: 'export.netlist',
      handle: (params) => dependencies.exportOperations.exportNetlist(params),
    },
    { method: 'export.pdf', handle: (params) => dependencies.exportOperations.exportPdf(params) },
    {
      method: 'export.pickPlace',
      handle: (params) => dependencies.exportOperations.exportPickPlace(params),
    },
    {
      method: 'pcb.addSilkscreenLine',
      handle: (params) => dependencies.pcbWriteOperations.addSilkscreenLine(params),
    },
    { method: 'pcb.addText', handle: (params) => dependencies.pcbWriteOperations.addText(params) },
    {
      method: 'pcb.addTrack',
      handle: (params) => dependencies.pcbWriteOperations.addTrack(params),
    },
    {
      method: 'pcb.addCopperPour',
      handle: (params) => dependencies.pcbAgenticOperations.addCopperPour(params),
    },
    {
      method: 'pcb.addKeepout',
      handle: (params) => dependencies.pcbAgenticOperations.addKeepout(params),
    },
    {
      method: 'pcb.addVias',
      handle: (params) => dependencies.pcbAgenticOperations.addVias(params),
    },
    {
      method: 'pcb.componentBounds',
      handle: (params) => dependencies.pcbAgenticOperations.componentBounds(params),
    },
    {
      method: 'pcb.connectivityCheck',
      handle: () => dependencies.pcbAgenticOperations.connectivityCheck(),
    },
    {
      method: 'pcb.copperIslands',
      handle: (params) => dependencies.pcbAgenticOperations.copperIslands(params),
    },
    {
      method: 'pcb.deleteTracks',
      handle: (params) => dependencies.pcbAgenticOperations.deleteTracks(params),
    },
    {
      method: 'pcb.getDesignRules',
      handle: () => dependencies.pcbAgenticOperations.getDesignRules(),
    },
    {
      method: 'pcb.moveComponent',
      handle: (params) => dependencies.pcbAgenticOperations.moveComponent(params),
    },
    {
      method: 'pcb.moveGroup',
      handle: (params) => dependencies.pcbAgenticOperations.moveGroup(params),
    },
    {
      method: 'pcb.netStatus',
      handle: (params) => dependencies.pcbAgenticOperations.netStatus(params),
    },
    {
      method: 'pcb.ripupNet',
      handle: (params) => dependencies.pcbAgenticOperations.ripupNet(params),
    },
    {
      method: 'pcb.routeNet',
      handle: (params) => dependencies.pcbAgenticOperations.routeNet(params),
    },
    {
      method: 'pcb.setComponentAttribute',
      handle: (params) => dependencies.pcbAgenticOperations.setComponentAttribute(params),
    },
    {
      method: 'pcb.setDesignRules',
      handle: (params) => dependencies.pcbAgenticOperations.setDesignRules(params),
    },
    {
      method: 'pcb.setDiffPair',
      handle: (params) => dependencies.pcbAgenticOperations.setDiffPair(params),
    },
    {
      method: 'pcb.setNetClass',
      handle: (params) => dependencies.pcbAgenticOperations.setNetClass(params),
    },
    {
      method: 'pcb.setNetRules',
      handle: (params) => dependencies.pcbAgenticOperations.setNetRules(params),
    },
    {
      method: 'pcb.setStackup',
      handle: (params) => dependencies.pcbAgenticOperations.setStackup(params),
    },
    {
      method: 'export.bom',
      handle: (params) => dependencies.pcbAgenticOperations.exportBom(params),
    },
    {
      method: 'export.step',
      handle: (params) => dependencies.pcbAgenticOperations.exportStep(params),
    },
    {
      method: 'schematic.componentReplace',
      handle: (params) => dependencies.pcbAgenticOperations.schematicComponentReplace(params),
    },
    {
      method: 'schematic.deleteWire',
      handle: (params) => dependencies.pcbAgenticOperations.schematicDeleteWire(params),
    },
    {
      method: 'schematic.renameNet',
      handle: (params) => dependencies.pcbAgenticOperations.schematicRenameNet(params),
    },
    {
      method: 'schematic.setNetLabel',
      handle: (params) => dependencies.pcbAgenticOperations.schematicSetNetLabel(params),
    },
    {
      method: 'schematic.wiresAtPin',
      handle: (params) => dependencies.pcbAgenticOperations.schematicWiresAtPin(params),
    },
    { method: 'pcb.addVia', handle: (params) => dependencies.pcbWriteOperations.addVia(params) },
    {
      method: 'pcb.modifyVia',
      handle: (params) => dependencies.pcbWriteOperations.modifyVia(params),
    },
    { method: 'pcb.addArc', handle: (params) => dependencies.pcbWriteOperations.addArc(params) },
    { method: 'pcb.addHole', handle: (params) => dependencies.pcbWriteOperations.addHole(params) },
    {
      method: 'pcb.addZone',
      handle: (params) => dependencies.pcbMutationOperations.addZone(params),
    },
    {
      method: 'pcb.deleteComponent',
      handle: (params) => dependencies.pcbMutationOperations.deleteComponents(params),
    },
    {
      method: 'pcb.exportRouteContext',
      handle: (params) => dependencies.exportOperations.exportRouteContext(params),
    },
    ...pcbListRoutes,
    {
      method: 'pcb.modifyComponent',
      handle: (params) => dependencies.pcbMutationOperations.modifyComponent(params),
    },
    {
      method: 'pcb.rebuildCopper',
      handle: (params) => dependencies.pcbMutationOperations.rebuildCopper(params),
    },
    {
      method: 'project.export',
      handle: (params) => dependencies.projectOperations.export(params),
    },
    { method: 'project.open', handle: (params) => dependencies.projectOperations.open(params) },
    { method: 'project.save', handle: (params) => dependencies.projectOperations.save(params) },
    {
      method: 'bom.generate',
      handle: (params) => dependencies.readOnlyOperations.generateBom(params),
    },
    { method: 'bom.validate', handle: () => dependencies.readOnlyOperations.validateBom() },
    {
      method: 'inventory.getPrice',
      handle: () => dependencies.readOnlyOperations.inventoryGetPrice(),
    },
    { method: 'inventory.search', handle: () => dependencies.readOnlyOperations.inventorySearch() },
    {
      method: 'library.getDeviceByLcscId',
      handle: (params) => dependencies.readOnlyOperations.getDeviceByLcscId(params),
    },
    {
      method: 'schematic.deletePrimitive',
      handle: (params) =>
        dependencies.schematicTransactionOperations.deletePrimitives(params.primitiveIds),
    },
    {
      method: 'schematic.getNetDetail',
      handle: (params) => dependencies.readOnlyOperations.getNetDetail(params),
    },
    {
      method: 'schematic.getPinNoConnect',
      handle: (params) => dependencies.readOnlyOperations.getPinNoConnect(params),
    },
    {
      method: 'schematic.getPrimitiveSnapshot',
      handle: (params) => dependencies.readOnlyOperations.getPrimitiveSnapshot(params),
    },
    {
      method: 'schematic.getSheetInfo',
      handle: (params) => dependencies.readOnlyOperations.getSheetInfo(params),
    },
    {
      method: 'schematic.listComponents',
      handle: (params) => dependencies.readOnlyOperations.listComponents(params),
    },
    {
      method: 'schematic.listNets',
      handle: (params) => dependencies.readOnlyOperations.listNets(params),
    },
    {
      method: 'schematic.listPrimitiveIds',
      handle: (params) => dependencies.readOnlyOperations.listPrimitiveIds(params),
    },
    {
      method: 'schematic.listRectangles',
      handle: () => dependencies.readOnlyOperations.listRectangles(),
    },
    {
      method: 'schematic.modifyPrimitive',
      handle: (params) =>
        dependencies.schematicTransactionOperations.modifyPrimitive(
          params.primitiveId as string,
          (params.property as Record<string, unknown>) || {},
        ),
    },
    {
      method: 'schematic.primitiveBounds',
      handle: (params) => dependencies.readOnlyOperations.primitiveBounds(params),
    },
    {
      method: 'schematic.recreatePrimitiveSnapshot',
      handle: (params) =>
        dependencies.schematicTransactionOperations.recreatePrimitiveSnapshot(params.snapshot),
    },
    {
      method: 'schematic.restorePrimitiveSnapshot',
      handle: (params) =>
        dependencies.schematicTransactionOperations.restorePrimitiveSnapshot(params.snapshot),
    },
    {
      method: 'schematic.searchDevice',
      handle: (params) => dependencies.readOnlyOperations.searchDevice(params),
    },
    {
      method: 'schematic.validateNetlist',
      handle: (params) => dependencies.readOnlyOperations.validateNetlist(params),
    },
    {
      method: 'system.apiInventory',
      handle: (params) => dependencies.systemApiOperations.apiInventory(params),
    },
    { method: 'system.getStatus', handle: () => dependencies.systemApiOperations.getStatus() },
    {
      method: 'system.inspectComponents',
      handle: (params) => dependencies.systemApiOperations.inspectComponents(params),
    },
    {
      method: 'system.inspectWires',
      handle: (params) => dependencies.systemApiOperations.inspectWires(params),
    },
  ] satisfies DomainRoute[];
  const methodList = Object.freeze(
    routes.map((route) => route.method).sort((left, right) => left.localeCompare(right)),
  );

  return {
    methodList,
    async tryDispatch(method, params = {}) {
      const route = routes.find((candidate) => candidate.method === method);
      if (!route) return { handled: false };
      assertRouterSchematicScope(method, params);
      // Section 3 guard: any pcb.* call carrying `expect` must match the focused board.
      if (method.startsWith('pcb.') && params.expect) {
        await dependencies.pcbAgenticOperations.requireExpectedBoard(params);
      }
      return { handled: true, value: await route.handle(params) };
    },
  };
}
