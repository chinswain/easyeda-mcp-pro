import { z } from 'zod';
import { type BridgeDiagnosticsSnapshot, type ToolDefinition, type ToolContext } from './types.js';
import { type EnvConfig } from '../config/env.js';
import { getFeatureMaturity } from '../config/feature-maturity.js';
import {
  buildCapabilityFeatureFlags,
  buildDetailedFeatureFlags,
  buildServerConfigFeatureFlags,
} from './diagnostics-feature-report.js';
import { EasyedaApiMethodSchema } from '../bridge/types.js';
import { findStaleBridgeListeners } from '../bridge/stale-listeners.js';
import { parsePortScanSpec } from '../bridge/manager.js';
import { PROFILE_DEFINITIONS, getEnabledProfiles, type ToolProfile } from '../config/profiles.js';
import { KNOWN_LIMITATIONS } from './known-limitations.js';
import { SERVER_VERSION } from '../config/version.js';
import { STARTER_DEVICE_CATALOG } from '../catalog/index.js';
import {
  DEFAULT_LATENCY_BUDGETS,
  DEFAULT_RETENTION_POLICY,
  describeRetentionPolicy,
  getGlobalMetricsCollector,
} from '../observability/index.js';

const apiInventoryInputSchema = z.object({
  filter: z.string().optional(),
});

const featureMaturityEntrySchema = z.object({
  maturity: z.enum(['implemented', 'experimental', 'reserved']),
  configured: z.boolean(),
  effective: z.boolean(),
  note: z.string(),
});

const featureMaturitySchema = z.record(z.string(), featureMaturityEntrySchema);

const bridgeDiagnosticsSchema = z.object({
  manager_uptime_ms: z.number().optional(),
  active_port: z.number().optional(),
  last_heartbeat_ms: z.number().optional(),
  heartbeat_silence_ms: z.number().optional(),
  method_registry_hash: z.string().optional(),
  reconnect: z.unknown().optional(),
  blocked_by_other_instance: z.boolean().optional(),
  owner_pid: z.number().int().positive().optional(),
  owner_port: z.number().int().min(1).max(65535).optional(),
  role: z.enum(['owner', 'attached', 'none']).optional(),
  attached_clients: z.number().int().nonnegative().optional(),
  reconnect_attempts: z.number().int().nonnegative().optional(),
  last_disconnect_ms: z.number().optional(),
  extension_build_id: z.string().optional(),
  expected_extension_build_id: z.string().optional(),
  extension_build_mismatch: z.boolean().optional(),
});

function extensionBuildMismatch(ctx: ToolContext): boolean | undefined {
  const { extensionBuildId, expectedExtensionBuildId } = ctx.bridge;
  if (!extensionBuildId || !expectedExtensionBuildId) return undefined;
  return extensionBuildId !== expectedExtensionBuildId;
}

function getBridgeDiagnostics(ctx: ToolContext): BridgeDiagnosticsSnapshot {
  const lastHeartbeat = ctx.bridge.lastHeartbeatMs;
  const ownershipConflict = ctx.bridge.ownershipConflict;
  return {
    role: ctx.bridge.role,
    attached_clients: ctx.bridge.attachedClients,
    reconnect_attempts: ctx.bridge.reconnectAttempts,
    last_disconnect_ms: ctx.bridge.lastDisconnectMs || undefined,
    extension_build_id: ctx.bridge.extensionBuildId,
    expected_extension_build_id: ctx.bridge.expectedExtensionBuildId,
    extension_build_mismatch: extensionBuildMismatch(ctx),
    manager_uptime_ms: ctx.bridge.uptimeMs,
    active_port: ctx.bridge.activePort,
    last_heartbeat_ms: lastHeartbeat,
    heartbeat_silence_ms:
      lastHeartbeat && lastHeartbeat > 0 ? Date.now() - lastHeartbeat : undefined,
    method_registry_hash: ctx.bridge.methodRegistryHash,
    reconnect: ctx.bridge.telemetry,
    blocked_by_other_instance:
      ownershipConflict?.blockedByOtherInstance && ctx.bridge.role !== 'attached',
    owner_pid: ctx.bridge.ownerPid ?? ownershipConflict?.ownerPid,
    owner_port: ownershipConflict?.ownerPort ?? ctx.bridge.activePort,
  };
}

const toolContractSchema = z.object({
  name: z.string(),
  group: z.string(),
  profile: z.string(),
  access: z.enum(['read', 'write', 'export']),
  contract: z.string(),
});

function toolAccess(tool: ToolDefinition): 'read' | 'write' | 'export' {
  if (tool.sideEffect === 'artifact-write') return 'export';
  return tool.confirmWrite || tool.sideEffect === 'design-mutation' ? 'write' : 'read';
}

function toolContract(tool: ToolDefinition): z.infer<typeof toolContractSchema> {
  // ponytail: first sentence of the description is the one-line contract.
  const first = tool.description.split(/(?<=\.)\s/)[0] ?? tool.description;
  return {
    name: tool.name,
    group: tool.group,
    profile: tool.profile,
    access: toolAccess(tool),
    contract: first.length > 200 ? `${first.slice(0, 197)}...` : first,
  };
}

function registerDiagnosticsCore(
  registry: { register: (def: ToolDefinition) => void; getAllTools?: () => ToolDefinition[] },
  config: EnvConfig,
) {
  registry.register({
    name: 'easyeda_health_check',
    title: 'Health check',
    description:
      'Return server health status in one call: runtime version, active profile, bridge state, EasyEDA version, keyless sourcing state, and starter catalog size. Intended as the single actionable status check after first connecting the bridge extension.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.1.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({
      status: z.enum(['ok', 'degraded', 'unavailable']),
      version: z.string(),
      node_version: z.string(),
      profile: z.string(),
      transport: z.string(),
      bridge_connected: z.boolean(),
      easyeda_version: z.string().optional(),
      extension_version: z.string().optional(),
      extension_version_mismatch: z.boolean(),
      registry_mismatch: z.boolean(),
      keyless_sourcing_enabled: z.boolean(),
      catalog_device_count: z.number().int().nonnegative(),
      blocked_by_other_instance: z.boolean().optional(),
      owner_pid: z.number().int().positive().optional(),
      owner_port: z.number().int().min(1).max(65535).optional(),
      role: z.enum(['owner', 'attached', 'none']).optional(),
      attached_clients: z.number().int().nonnegative().optional(),
      extension_build_id: z.string().optional(),
      expected_extension_build_id: z.string().optional(),
      extension_build_mismatch: z.boolean().optional(),
      stale_listeners: z
        .array(
          z.object({
            port: z.number(),
            pid: z.number(),
            ppid: z.number().optional(),
            orphan: z.boolean(),
          }),
        )
        .optional(),
      warnings: z.array(z.string()),
      status_error: z.string().optional(),
      ups: z.number(),
    }),
    handler: async (ctx: ToolContext, _params: unknown) => {
      const extensionVersionMismatch = ctx.bridge.extensionVersionMismatch ?? false;
      const registryMismatch = ctx.bridge.registryMismatch ?? false;
      const ownershipConflict = ctx.bridge.ownershipConflict;
      const buildMismatch = extensionBuildMismatch(ctx);
      const warnings: string[] = [];
      if (buildMismatch)
        warnings.push(
          `Installed plugin build ${ctx.bridge.extensionBuildId} differs from shipped build ${ctx.bridge.expectedExtensionBuildId}; re-import easyeda-bridge-extension.eext.`,
        );
      // ponytail: stale scan is one process listing, cheap enough on every health check.
      const staleListeners = await findStaleBridgeListeners({
        host: config.BRIDGE_HOST,
        ports: parsePortScanSpec(config.BRIDGE_PORT_SCAN),
      }).catch(() => []);
      const orphanPorts = staleListeners.filter((l) => l.orphan).map((l) => l.port);
      if (orphanPorts.length)
        warnings.push(
          `Orphaned bridge listener(s) on port(s) ${orphanPorts.join(', ')}; run "npx easyeda-mcp-pro --doctor --fix" to stop them.`,
        );
      if (ctx.bridge.role === 'attached' && !ctx.bridge.connected)
        warnings.push(
          `Attached to owner pid ${ctx.bridge.ownerPid}, but the owner has no plugin session.`,
        );
      return {
        status: !ctx.bridge.connected
          ? ('degraded' as const)
          : extensionVersionMismatch || registryMismatch || buildMismatch
            ? ('degraded' as const)
            : ('ok' as const),
        role: ctx.bridge.role,
        attached_clients: ctx.bridge.attachedClients,
        extension_build_id: ctx.bridge.extensionBuildId,
        expected_extension_build_id: ctx.bridge.expectedExtensionBuildId,
        extension_build_mismatch: buildMismatch,
        stale_listeners: staleListeners,
        warnings,
        version: SERVER_VERSION,
        node_version: process.version,
        profile: ctx.profile,
        transport: config.TRANSPORT,
        bridge_connected: ctx.bridge.connected,
        easyeda_version: ctx.bridge.easyedaVersion,
        extension_version: ctx.bridge.extensionVersion,
        extension_version_mismatch: extensionVersionMismatch,
        registry_mismatch: registryMismatch,
        keyless_sourcing_enabled: ctx.config.keylessSourcingEnabled ?? true,
        catalog_device_count: STARTER_DEVICE_CATALOG.length,
        blocked_by_other_instance: ownershipConflict?.blockedByOtherInstance,
        owner_pid: ownershipConflict?.ownerPid,
        owner_port: ownershipConflict?.ownerPort,
        status_error: ownershipConflict?.message,
        ups: process.uptime(),
      };
    },
  });

  registry.register({
    name: 'easyeda_bridge_status',
    title: 'Bridge status',
    description: 'Check EasyEDA Pro bridge connection status, version, and capabilities.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({
      connected: z.boolean(),
      bridge_version: z.string().optional(),
      easyeda_version: z.string().optional(),
      capabilities: z.array(z.string()).optional(),
      dev_mode: z.boolean().optional(),
      last_heartbeat_ms: z.number().optional(),
      uptime_ms: z.number().optional(),
      status_error: z.string().optional(),
      blocked_by_other_instance: z.boolean().optional(),
      owner_pid: z.number().int().positive().optional(),
      owner_port: z.number().int().min(1).max(65535).optional(),
      role: z.enum(['owner', 'attached', 'none']).optional(),
      attached_clients: z.number().int().nonnegative().optional(),
      reconnect_attempts: z.number().int().nonnegative().optional(),
      reconnecting: z.boolean().optional(),
      next_reconnect_at_ms: z.number().optional(),
      last_seen_ms: z.number().optional(),
      last_disconnect_ms: z.number().optional(),
      active_document: z.unknown().optional(),
      diagnostics: bridgeDiagnosticsSchema.optional(),
    }),
    handler: async (ctx: ToolContext) => {
      const shared = {
        role: ctx.bridge.role,
        owner_pid: ctx.bridge.ownerPid,
        attached_clients: ctx.bridge.attachedClients,
        reconnect_attempts: ctx.bridge.reconnectAttempts,
        reconnecting: ctx.bridge.reconnecting,
        next_reconnect_at_ms: ctx.bridge.nextReconnectAtMs,
        last_seen_ms: ctx.bridge.lastHeartbeatMs || undefined,
        last_disconnect_ms: ctx.bridge.lastDisconnectMs || undefined,
        uptime_ms: process.uptime() * 1000,
        diagnostics: getBridgeDiagnostics(ctx),
      };
      if (!ctx.bridge.connected) {
        const ownershipConflict = ctx.bridge.ownershipConflict;
        const attachedIdle = ctx.bridge.role === 'attached';
        return {
          ...shared,
          connected: false,
          status_error: attachedIdle
            ? `Attached to owner pid ${ctx.bridge.ownerPid}; the owner has no EasyEDA plugin session yet.`
            : (ownershipConflict?.message ??
              (ctx.bridge.reconnecting
                ? `EasyEDA plugin disconnected; reconnect attempt ${ctx.bridge.reconnectAttempts} is scheduled. Retry after it reconnects or reopen the EasyEDA plugin.`
                : undefined)),
          blocked_by_other_instance: attachedIdle
            ? false
            : ownershipConflict?.blockedByOtherInstance,
          owner_pid: ctx.bridge.ownerPid ?? ownershipConflict?.ownerPid,
          owner_port: ownershipConflict?.ownerPort,
        };
      }
      try {
        const result = await ctx.bridge.call('system.getStatus', {});
        const data = result as {
          bridgeVersion?: string;
          easyedaVersion?: string;
          capabilities?: string[];
          devMode?: boolean;
          lastHeartbeatMs?: number;
          activeDocument?: unknown;
          activeTab?: unknown;
        };
        return {
          ...shared,
          connected: true,
          bridge_version: data.bridgeVersion,
          easyeda_version: data.easyedaVersion,
          capabilities: data.capabilities,
          dev_mode: data.devMode,
          last_heartbeat_ms: data.lastHeartbeatMs,
          active_document: data.activeDocument ?? data.activeTab,
        };
      } catch (err) {
        return {
          ...shared,
          connected: true,
          status_error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  registry.register({
    name: 'easyeda_get_capabilities',
    title: 'Get capabilities',
    description:
      'Return server capabilities, including available profiles, enabled feature flags, and supported operations.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({
      server_name: z.string(),
      server_version: z.string(),
      protocol_version: z.string(),
      profiles: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          description: z.string(),
          is_default: z.boolean(),
        }),
      ),
      current_profile: z.string(),
      feature_flags: z.record(z.string(), z.boolean()),
      feature_maturity: featureMaturitySchema,
      transports: z.array(z.string()),
      /** Every tool enabled in the current profile with its one-line contract and access class. */
      tools: z.array(toolContractSchema),
      tools_in_profile: z.number().int().nonnegative(),
      /** Tool names each higher profile would add on top of the current one. */
      unlocked_by_profile: z.record(z.string(), z.array(z.string())),
      known_limitations: z.array(
        z.object({ area: z.string(), limitation: z.string(), workaround: z.string() }),
      ),
      units: z.object({
        length: z.string(),
        angle: z.string(),
        layers: z.string(),
      }),
      /** How every agentic write/read tool behaves; readable without the bridge source. */
      contract: z.object({
        guard: z.string(),
        idempotency: z.string(),
        verification: z.string(),
        pagination: z.string(),
        errors: z.string(),
        transactions: z.string(),
        reads: z.string(),
      }),
    }),
    handler: async (_ctx: ToolContext, _params: unknown) => {
      const profiles = Object.values(PROFILE_DEFINITIONS).map((p) => ({
        name: p.name,
        label: p.label,
        description: p.description,
        is_default: p.isDefault,
      }));
      const all = registry.getAllTools?.() ?? [];
      const enabled = new Set(getEnabledProfiles(config.TOOL_PROFILE));
      const tools = all.filter((t) => enabled.has(t.profile)).map(toolContract);
      const unlocked: Record<string, string[]> = {};
      for (const profile of Object.keys(PROFILE_DEFINITIONS) as ToolProfile[]) {
        if (enabled.has(profile)) continue;
        const names = all.filter((t) => t.profile === profile).map((t) => t.name);
        if (names.length) unlocked[profile] = names.sort();
      }

      return {
        server_name: 'easyeda-mcp-pro',
        server_version: SERVER_VERSION,
        protocol_version: config.MCP_PROTOCOL_VERSION,
        profiles,
        current_profile: config.TOOL_PROFILE,
        feature_flags: buildCapabilityFeatureFlags(config),
        feature_maturity: getFeatureMaturity(config),
        transports: [config.TRANSPORT],
        tools,
        tools_in_profile: tools.length,
        unlocked_by_profile: unlocked,
        known_limitations: KNOWN_LIMITATIONS,
        units: {
          length: 'mm from the board origin unless a field ends in _mil',
          angle: 'degrees, counter-clockwise',
          layers: 'layer names as strings (e.g. "Top", "Inner1", "Bottom")',
        },
        contract: {
          guard:
            'Every pcb_* write takes projectId (+ optional boardName) and fails with error_code WRONG_DOCUMENT (error_data.actual = focused doc) unless that PCB is focused. Legacy pcb writes guard only when projectId is passed.',
          idempotency:
            'Writes accept op_id; a repeat with the same op_id returns the stored result with replayed: true and performs no write.',
          verification:
            'Writes read back the primitive and return verified: true|false with expected/actual on mismatch.',
          pagination: 'List tools take limit (<=500, default 100) and offset and return total + next_offset.',
          errors: 'Failures are {success:false, error, error_code, hint, error_data?}; never a bare string.',
          transactions:
            'easyeda_project_begin_transaction / commit / rollback wrap multi-step writes; the bridge owner serialises writes from attached clients.',
          reads:
            'Failed reads return success:false with error_code, or not_available:true with a reason; never an empty list.',
        },
      };
    },
  });

  registry.register({
    name: 'easyeda_get_server_config',
    title: 'Get server config',
    description: 'Return safe (redacted) server configuration. Secrets are never exposed.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({
      include_flags: z.boolean().default(false),
    }),
    outputSchema: z.object({
      node_env: z.string(),
      log_level: z.string(),
      profile: z.string(),
      transport: z.string(),
      bridge_host: z.string(),
      bridge_port: z.number(),
      mcp_protocol_version: z.string(),
      flags: z.record(z.string(), z.boolean()).optional(),
      feature_maturity: featureMaturitySchema,
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const { include_flags: includeFlags } = z
        .object({ include_flags: z.boolean().default(false) })
        .parse(params);
      return {
        node_env: config.NODE_ENV,
        log_level: config.LOG_LEVEL,
        profile: config.TOOL_PROFILE,
        transport: config.TRANSPORT,
        bridge_host: config.BRIDGE_HOST,
        bridge_port: config.BRIDGE_PORT,
        mcp_protocol_version: config.MCP_PROTOCOL_VERSION,
        flags: includeFlags ? buildServerConfigFeatureFlags(config) : undefined,
        feature_maturity: getFeatureMaturity(config),
      };
    },
  });

  registry.register({
    name: 'easyeda_get_tool_profiles',
    title: 'Get tool profiles',
    description: 'List available tool profiles and their descriptions.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({
      current: z.string(),
      profiles: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          description: z.string(),
          approx_tool_count: z.string(),
          is_default: z.boolean(),
          is_active: z.boolean(),
        }),
      ),
    }),
    handler: async (ctx: ToolContext, _params: unknown) => {
      const profiles = Object.values(PROFILE_DEFINITIONS).map((p) => ({
        name: p.name,
        label: p.label,
        description: p.description,
        approx_tool_count: p.approxToolCount,
        is_default: p.isDefault,
        is_active: p.name === ctx.profile,
      }));

      return {
        current: ctx.profile,
        profiles,
      };
    },
  });

  registry.register({
    name: 'easyeda_get_feature_flags',
    title: 'Get feature flags',
    description: 'Return current feature flag values.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({
      flags: z.record(z.string(), z.boolean()),
      maturity: featureMaturitySchema,
    }),
    handler: async (_ctx: ToolContext, _params: unknown) => {
      return {
        flags: buildDetailedFeatureFlags(config),
        maturity: getFeatureMaturity(config),
      };
    },
  });

  registry.register({
    name: 'easyeda_observability_report',
    title: 'Observability report',
    description:
      'Return latency budgets, runtime metrics, cache/vendor timing snapshot, and storage retention policy for performance diagnostics.',
    profile: 'core',
    evidence: ['inferred'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
    inputSchema: z.object({
      includeRecentEvents: z.boolean().default(true),
    }),
    outputSchema: z.object({
      generated_at: z.string(),
      server_version: z.string(),
      budgets: z.array(
        z.object({
          category: z.string(),
          p50Ms: z.number(),
          p95Ms: z.number(),
          timeoutMs: z.number(),
          description: z.string(),
        }),
      ),
      metrics: z.object({
        generatedAt: z.string(),
        startedAt: z.string(),
        toolCalls: z.number().int().nonnegative(),
        bridgeCalls: z.number().int().nonnegative(),
        budgetWarnings: z.number().int().nonnegative(),
        budgetFailures: z.number().int().nonnegative(),
        recentEvents: z.array(z.unknown()),
        byCategory: z.record(
          z.string(),
          z.object({
            count: z.number().int().nonnegative(),
            ok: z.number().int().nonnegative(),
            errors: z.number().int().nonnegative(),
            averageDurationMs: z.number(),
            maxDurationMs: z.number(),
          }),
        ),
        cache: z.object({
          hits: z.number().int().nonnegative(),
          misses: z.number().int().nonnegative(),
          writes: z.number().int().nonnegative(),
          deletes: z.number().int().nonnegative(),
          hitRate: z.number(),
        }),
        vendors: z.record(
          z.string(),
          z.object({
            requestCount: z.number().int().nonnegative(),
            errorCount: z.number().int().nonnegative(),
            averageDurationMs: z.number(),
            lastStatusCode: z.number().optional(),
          }),
        ),
      }),
      retention: z.object({
        cacheDefaultTtlSeconds: z.number().int().nonnegative(),
        vendorCacheTtlSeconds: z.number().int().nonnegative(),
        artifactRetentionDays: z.number().int().nonnegative(),
        telemetryRetentionDays: z.number().int().nonnegative(),
        cleanupCadence: z.enum(['manual', 'startup', 'daily']),
        maxArtifactBytes: z.number().int().nonnegative(),
        notes: z.array(z.string()),
        summary: z.string(),
      }),
      timeout_policy: z.object({
        bridge_default_timeout_ms: z.number().int().nonnegative(),
        bridge_host: z.string(),
        bridge_port: z.number().int().nonnegative(),
      }),
    }),
    handler: async (_ctx: ToolContext, params: unknown) => {
      const { includeRecentEvents } = z
        .object({ includeRecentEvents: z.boolean().default(true) })
        .parse(params);
      const metrics = getGlobalMetricsCollector().snapshot();
      return {
        generated_at: new Date().toISOString(),
        server_version: SERVER_VERSION,
        budgets: DEFAULT_LATENCY_BUDGETS,
        metrics: includeRecentEvents ? metrics : { ...metrics, recentEvents: [] },
        retention: {
          ...DEFAULT_RETENTION_POLICY,
          summary: describeRetentionPolicy(DEFAULT_RETENTION_POLICY),
        },
        timeout_policy: {
          bridge_default_timeout_ms: config.BRIDGE_TIMEOUT_MS,
          bridge_host: config.BRIDGE_HOST,
          bridge_port: config.BRIDGE_PORT,
        },
      };
    },
  });

  registry.register({
    name: 'easyeda_run_self_test',
    title: 'Run self test',
    description:
      'Run internal self-test to verify server integrity, config, and bridge connectivity.',
    profile: 'core',
    evidence: ['official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: false,
      idempotentHint: false,
    },
    inputSchema: z.object({}),
    outputSchema: z.object({
      passed: z.boolean(),
      checks: z.array(
        z.object({
          name: z.string(),
          status: z.enum(['pass', 'warn', 'fail', 'skipped']),
          message: z.string(),
        }),
      ),
    }),
    handler: async (ctx: ToolContext, _params: unknown) => {
      const checks = [
        {
          name: 'config_valid',
          status: 'pass' as const,
          message: 'Config valid',
        },
        {
          name: 'bridge_connected',
          status: ctx.bridge.connected ? ('pass' as const) : ('warn' as const),
          message: ctx.bridge.connected ? 'Bridge connected' : 'Bridge not connected',
        },
        {
          name: 'easyeda_version_detected',
          status: ctx.bridge.easyedaVersion ? ('pass' as const) : ('skipped' as const),
          message: ctx.bridge.easyedaVersion
            ? `EasyEDA Pro version ${ctx.bridge.easyedaVersion}`
            : ctx.bridge.connected
              ? 'Skipped: bridge connected but did not report an EasyEDA version'
              : 'Skipped: bridge not connected',
        },
        {
          name: 'extension_version_match',
          status: !ctx.bridge.extensionVersion
            ? ('skipped' as const)
            : ctx.bridge.extensionVersionMismatch
              ? ('warn' as const)
              : ('pass' as const),
          message: !ctx.bridge.extensionVersion
            ? 'Skipped: extension did not report a version'
            : ctx.bridge.extensionVersionMismatch
              ? `Extension version ${ctx.bridge.extensionVersion} does not match server version ${SERVER_VERSION}; update the extension in EasyEDA Pro`
              : 'Extension version matches server version',
        },
        {
          // Unlike the advisory version check above, a stale dispatcher method
          // registry FAILS the self test: the extension would silently serve
          // old dispatch logic for methods the server believes exist.
          name: 'method_registry_match',
          status: !ctx.bridge.extensionMethodListHash
            ? ('skipped' as const)
            : ctx.bridge.registryMismatch
              ? ('fail' as const)
              : ('pass' as const),
          message: !ctx.bridge.extensionMethodListHash
            ? 'Skipped: extension did not report a dispatcher method-list hash (pre-0.22 build)'
            : ctx.bridge.registryMismatch
              ? `Extension dispatcher method registry (${ctx.bridge.extensionMethodListHash}) does not match the server registry (${ctx.bridge.methodRegistryHash}). Re-import the extension, or enable BRIDGE_HOT_SWAP_ENABLED to auto-push in dev.`
              : 'Extension dispatcher method registry matches the server',
        },
      ];

      return {
        passed: checks.every((c) => c.status === 'pass' || c.status === 'skipped'),
        checks,
      };
    },
  });

  registry.register({
    name: 'easyeda_bridge_probe_methods',
    title: 'Probe bridge methods',
    description:
      'Query the EasyEDA Pro bridge for available API methods. Requires bridge connection. (dev/pro only)',
    profile: 'dev',
    evidence: ['runtime-probe'],
    risk: 'medium',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: z.object({
      filter: z.string().optional(),
    }),
    outputSchema: z.object({
      methods: z.array(
        z.object({
          name: z.string(),
          available: z.boolean(),
          parameter_schema: z.unknown().optional(),
        }),
      ),
      total: z.number(),
      source: z.enum(['loader_status', 'server_registry']).optional(),
      dispatcher_build_id: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { filter } = z.object({ filter: z.string().optional() }).parse(params);
      const registryMethods = [...EasyedaApiMethodSchema.options].sort((a, b) =>
        a.localeCompare(b),
      );

      // Prefer the live method list from the extension loader (exact for the
      // active dispatcher); fall back to the server registry with availability
      // implied by the bridge connection when the loader predates loaderStatus.
      let extensionMethods: Set<string> | null = null;
      let buildId: string | undefined;
      try {
        const status = await ctx.bridge.call<
          Record<string, never>,
          { buildId?: string; methodCount?: number } & Record<string, unknown>
        >('system.loaderStatus', {});
        buildId = typeof status.buildId === 'string' ? status.buildId : undefined;
        const list = (
          await ctx.bridge.call<Record<string, never>, { capabilities?: unknown }>(
            'system.getStatus',
            {},
          )
        ).capabilities;
        if (Array.isArray(list)) {
          extensionMethods = new Set(list.filter((m): m is string => typeof m === 'string'));
        }
      } catch {
        // Loader status unavailable — old extension build or bridge down.
      }

      const normalizedFilter = filter?.toLowerCase().trim();
      const methods = registryMethods
        .filter((name) => !normalizedFilter || name.toLowerCase().includes(normalizedFilter))
        .map((name) => ({
          name,
          available: extensionMethods ? extensionMethods.has(name) : ctx.bridge.connected,
        }));
      return {
        methods,
        total: methods.length,
        source: extensionMethods ? ('loader_status' as const) : ('server_registry' as const),
        dispatcher_build_id: buildId,
      };
    },
  });

  registry.register({
    name: 'easyeda_api_inventory',
    title: 'EasyEDA API inventory',
    description:
      'Inspect the live EasyEDA extension runtime and list available documented API classes, runtime paths, and methods.',
    profile: 'core',
    evidence: ['runtime-probe', 'pro-api-types', 'official-docs'],
    risk: 'low',
    confirmWrite: false,
    group: 'diagnostics',
    version: '1.0.0',
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
    inputSchema: apiInventoryInputSchema,
    outputSchema: z.object({
      classes: z.array(
        z.object({
          className: z.string(),
          runtimePaths: z.array(z.string()),
          methods: z.array(z.string()),
        }),
      ),
      total: z.number().int().nonnegative(),
      not_available: z.boolean().optional(),
      error: z.string().optional(),
    }),
    handler: async (ctx: ToolContext, params: unknown) => {
      const { filter } = apiInventoryInputSchema.parse(params);
      try {
        return await ctx.bridge.call('system.apiInventory', { filter });
      } catch (err) {
        return {
          classes: [],
          total: 0,
          not_available: true,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });
}

export { registerDiagnosticsCore };
