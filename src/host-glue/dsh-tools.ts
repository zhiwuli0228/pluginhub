/**
 * DSH Tool definitions for PluginHub.
 *
 * These tools allow DSH agents to discover, manage, and invoke plugins
 * through the PluginHub facade. Each tool is described as a self-contained
 * definition with a JSON-Schema input contract and an async handler.
 *
 * This module does **not** import any `@deepseek-ai/*` packages — it only
 * depends on the {@link PluginHubFacade} from the same host-glue layer.
 *
 * @module
 */

import type { PluginHubFacade } from './facade.js';

// ---------------------------------------------------------------------------
// Tool definition interface
// ---------------------------------------------------------------------------

/**
 * A single DSH tool definition that can be registered with the host runtime.
 */
export interface DshToolDefinition {
  /** Unique tool name (should be namespaced, e.g. `pluginhub_*`). */
  name: string;

  /** Human-readable description shown to agents and in documentation. */
  description: string;

  /** JSON Schema describing the tool's input parameters. */
  inputSchema: Record<string, unknown>;

  /**
   * Async handler invoked when an agent calls this tool.
   *
   * @param args - Validated input arguments matching `inputSchema`.
   * @returns The tool result (serializable to JSON).
   */
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

/**
 * Create the set of DSH tools that expose PluginHub functionality.
 *
 * Tools produced:
 *
 * | Name                              | Purpose                                  |
 * | --------------------------------- | ---------------------------------------- |
 * | `pluginhub_list_plugins`          | List all discovered/installed plugins    |
 * | `pluginhub_search_capabilities`   | Search capabilities by natural-language query |
 * | `pluginhub_get_capability_schema` | Get full schema for a capability         |
 * | `pluginhub_start_plugin`          | Start a plugin process                   |
 * | `pluginhub_stop_plugin`           | Stop a plugin process                    |
 * | `pluginhub_plugin_status`         | Get plugin health/status                 |
 * | `pluginhub_invoke`                | Invoke a capability by ID                |
 *
 * @param hub - The PluginHub facade instance to bind handlers against.
 * @returns Array of tool definitions ready for registration.
 */
export function createDshTools(hub: PluginHubFacade): DshToolDefinition[] {
  return [
    // -----------------------------------------------------------------------
    // pluginhub_list_plugins
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_list_plugins',
      description:
        'List all discovered and installed plugins known to PluginHub. ' +
        'Returns an array of plugin entries with their id, name, protocol, trust score, and source.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const entries = hub.listDiscoveredPlugins();
        return entries.map((e) => ({
          id: e.id,
          name: e.name,
          protocol: e.protocol,
          source: e.source,
          trustScore: e.trustScore,
          location: e.location,
          discoveredAt: e.discoveredAt.toISOString(),
        }));
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_search_capabilities
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_search_capabilities',
      description:
        'Search available capabilities by a natural-language query. ' +
        'Returns matching capabilities with their id, kind, display name, summary, and match relevance.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language search query.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const query = String(args['query'] ?? '');
        const results = await hub.searchCapabilities(query);
        return results.map((cap) => ({
          id: cap.id,
          kind: cap.kind,
          name: cap.display.name,
          summary: cap.display.summary,
          protocol: cap.provenance.protocol,
        }));
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_get_capability_schema
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_get_capability_schema',
      description:
        'Get the full canonical schema for a specific capability by its ID. ' +
        'Includes input/output schemas, execution mode, semantics, and provenance.',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityId: {
            type: 'string',
            description: 'Fully qualified capability ID (e.g. "publisher/plugin/component/member").',
          },
        },
        required: ['capabilityId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const capabilityId = String(args['capabilityId'] ?? '');
        const capability = await hub.getCapabilitySchema(capabilityId);
        if (!capability) {
          return { error: `Capability "${capabilityId}" not found.` };
        }
        return capability;
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_start_plugin
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_start_plugin',
      description:
        'Start a plugin process managed by PluginHub. ' +
        'Requires the executable command and optional arguments. ' +
        'Returns the running plugin instance snapshot including PID and allocated port.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Unique identifier for the plugin instance.',
          },
          command: {
            type: 'string',
            description: 'Executable path or command name.',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'Command-line arguments passed to the executable.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory for the child process.',
          },
        },
        required: ['id', 'command'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const id = String(args['id']);
        const command = String(args['command']);
        const spawnArgs = Array.isArray(args['args'])
          ? (args['args'] as string[])
          : undefined;
        const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : undefined;

        const instance = await hub.startPlugin(id, {
          command,
          args: spawnArgs,
          cwd,
        });

        return {
          id: instance.id,
          pid: instance.pid,
          port: instance.port,
          processState: instance.processState,
          healthStatus: instance.healthStatus,
          startedAt: instance.startedAt.toISOString(),
        };
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_stop_plugin
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_stop_plugin',
      description:
        'Stop a running plugin process managed by PluginHub. ' +
        'Performs graceful shutdown with health-check teardown and port release.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Plugin identifier previously used to start the plugin.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const id = String(args['id']);
        await hub.stopPlugin(id);
        return { success: true, id };
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_plugin_status
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_plugin_status',
      description:
        'Get the current health and status of a specific plugin instance. ' +
        'Returns null if the plugin is not currently tracked.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Plugin identifier.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const id = String(args['id']);
        const status = hub.getPluginStatus(id);
        if (!status) {
          return { error: `Plugin "${id}" is not currently tracked.` };
        }
        return {
          id: status.id,
          pid: status.pid,
          port: status.port,
          processState: status.processState,
          healthStatus: status.healthStatus,
          logEntryCount: status.logEntryCount,
          startedAt: status.startedAt.toISOString(),
        };
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_invoke
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_invoke',
      description:
        'Invoke a capability by its fully qualified ID. ' +
        'Routes the invocation through the PluginHub router and returns the result.',
      inputSchema: {
        type: 'object',
        properties: {
          capabilityId: {
            type: 'string',
            description: 'Fully qualified capability ID to invoke.',
          },
          arguments: {
            type: 'object',
            description: 'Input arguments for the capability invocation.',
            additionalProperties: true,
          },
        },
        required: ['capabilityId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const capabilityId = String(args['capabilityId']);
        const callArgs = (args['arguments'] as Record<string, unknown>) ?? {};
        const result = await hub.invokeCapability(capabilityId, callArgs);
        return result;
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_events
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_events',
      description:
        'Query runtime events collected by the PluginHub observer bus. ' +
        'Supports filtering by event types and limiting the number of results.',
      inputSchema: {
        type: 'object',
        properties: {
          types: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter events to only these types.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of events to return.',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const types = Array.isArray(args['types'])
          ? (args['types'] as string[])
          : undefined;
        const limit = typeof args['limit'] === 'number' ? args['limit'] : undefined;

        const events = hub.getEvents({
          ...(types !== undefined && { types: types as import('../core/observer/types.js').EventType[] }),
          ...(limit !== undefined && { limit }),
        });

        return events.map((e) => ({
          id: e.id,
          timestamp: e.timestamp,
          type: e.type,
          payload: e.payload,
        }));
      },
    },

    // -----------------------------------------------------------------------
    // pluginhub_serve_ui
    // -----------------------------------------------------------------------
    {
      name: 'pluginhub_serve_ui',
      description:
        'Start the PluginHub Control UI HTTP server. ' +
        'Serves a web dashboard for managing plugins, viewing capabilities, and streaming events.',
      inputSchema: {
        type: 'object',
        properties: {
          port: {
            type: 'number',
            description: 'Port to listen on (default: 7890).',
          },
        },
        additionalProperties: false,
      },
      handler: async (args) => {
        const port = typeof args['port'] === 'number' ? args['port'] : undefined;

        // Dynamically import UIServer to avoid hard dependency at module level.
        const { UIServer: UIServerClass } = await import('../client-ui/server.js');
        const uiServer = new UIServerClass({
          port,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          facade: hub as any,
          observerBus: hub.observer,
        });

        const result = await uiServer.start();
        return {
          url: result.url,
          port: result.port,
          message: `PluginHub Control UI is running at ${result.url}`,
        };
      },
    },
  ];
}
