/**
 * OpenAPI → Canonical Capability adapter using the three-meta-tool pattern.
 *
 * Instead of exposing every OpenAPI operation as a separate tool (which causes
 * context explosion), this adapter produces exactly **three** meta-tools:
 *
 * 1. `list_endpoints` — returns available operations (filtered by whitelist)
 * 2. `get_schema`     — returns the JSON Schema for a specific operationId
 * 3. `invoke`         — executes an operation by operationId with arguments
 *
 * This lets an Agent discover and invoke API operations on-demand without
 * pre-loading the entire spec into context.
 *
 * @module
 */

import type {
  CanonicalCapability,
  AdapterContext,
} from '../capability/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Minimal OpenAPI operation descriptor (subset of OpenAPI 3.x). */
export interface OpenApiOperation {
  /** Unique operation identifier from the OpenAPI spec. */
  operationId: string;
  /** HTTP method (uppercase). */
  method: string; // GET | POST | PUT | DELETE | PATCH
  /** URL path template, e.g. `/users/{id}`. */
  path: string;
  /** Short summary of the operation. */
  summary?: string;
  /** Longer description of the operation. */
  description?: string;
  /** Tags used for grouping / filtering. */
  tags?: string[];
  /** Parameter descriptors (path, query, header, body). */
  parameters?: Array<{
    name: string;
    in: 'query' | 'path' | 'header' | 'body';
    required?: boolean;
    schema?: Record<string, unknown>;
    description?: string;
  }>;
  /** Request body descriptor. */
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown> }>;
    required?: boolean;
  };
  /** Response descriptors keyed by status code or range. */
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
}

/** Configuration options for the OpenAPI adapter. */
export interface OpenApiAdapterOptions {
  /** Base URL for the target API (e.g. `https://api.example.com/v1`). */
  baseUrl: string;
  /** Whitelist of operationIds to expose. Empty array = none exposed. */
  allowedOperations: string[];
  /** Default timeout for invocations in milliseconds. Defaults to 30 000. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Semantic version of this adapter implementation. */
const ADAPTER_VERSION = '1.0.0';

/** Protocol identifier carried in provenance. */
const PROTOCOL = 'openapi' as const;

// ---------------------------------------------------------------------------
// Helper – stable capability ID builder
// ---------------------------------------------------------------------------

/**
 * Build a globally unique, stable capability ID following the convention
 * `<pluginId>/<componentId>/<member>`.
 */
function buildId(ctx: AdapterContext, member: string): string {
  return `${ctx.pluginId}/${ctx.componentId}/${member}`;
}

// ---------------------------------------------------------------------------
// OpenApiAdapter
// ---------------------------------------------------------------------------

/**
 * OpenAPI → Canonical Capability adapter using the three-meta-tool pattern.
 *
 * Usage:
 * ```ts
 * const adapter = new OpenApiAdapter({
 *   baseUrl: 'https://api.example.com',
 *   allowedOperations: ['listUsers', 'getUser'],
 * });
 * const tools = adapter.adapt(operations, context);
 * // tools.length === 3
 * ```
 */
export class OpenApiAdapter {
  private readonly _options: Required<Pick<OpenApiAdapterOptions, 'baseUrl' | 'allowedOperations'>> &
    Pick<OpenApiAdapterOptions, 'timeoutMs'>;

  constructor(options: OpenApiAdapterOptions) {
    this._options = {
      baseUrl: options.baseUrl.replace(/\/+$/, ''), // strip trailing slash
      allowedOperations: [...options.allowedOperations],
      timeoutMs: options.timeoutMs,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Generate the three meta-tools as `CanonicalCapability` records.
   *
   * Only operations whose `operationId` appears in the configured whitelist
   * are included in the provenance payload attached to each tool.
   *
   * @param operations - Full list of parsed OpenAPI operations.
   * @param ctx        - Adapter context (plugin/component IDs, trust status).
   * @returns Exactly 3 canonical capabilities.
   */
  adapt(operations: OpenApiOperation[], ctx: AdapterContext): CanonicalCapability[] {
    const filtered = this.filterOperations(operations);

    return [
      this.buildListEndpoints(filtered, ctx),
      this.buildGetSchema(filtered, ctx),
      this.buildInvoke(filtered, ctx),
    ];
  }

  /** Return the configured whitelist of allowed operation IDs. */
  getAllowedOperations(): string[] {
    return [...this._options.allowedOperations];
  }

  // -------------------------------------------------------------------------
  // Static helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve an operation's input JSON Schema by merging its `parameters`
   * and `requestBody` descriptors into a single object schema.
   *
   * Path, query, and header parameters become top-level properties.
   * If a request body with `application/json` content is present its schema
   * is merged under a `body` property (or inlined when it is itself an
   * object schema).
   *
   * @param op - The OpenAPI operation descriptor.
   * @returns A JSON Schema object describing the combined input.
   */
  static resolveInputSchema(op: OpenApiOperation): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    // --- Parameters --------------------------------------------------------
    if (op.parameters) {
      for (const param of op.parameters) {
        properties[param.name] = {
          ...(param.schema ?? {}),
          ...(param.description ? { description: param.description } : {}),
          // Annotate where the parameter lives so the caller can route it.
          'x-in': param.in,
        };
        if (param.required) {
          required.push(param.name);
        }
      }
    }

    // --- Request body ------------------------------------------------------
    if (op.requestBody?.content) {
      const jsonContent = op.requestBody.content['application/json'];
      if (jsonContent?.schema) {
        const bodySchema = jsonContent.schema;
        if (bodySchema.type === 'object' && bodySchema.properties) {
          // Inline object properties at the top level for ergonomic access.
          const bodyProps = bodySchema.properties as Record<string, unknown>;
          for (const [key, value] of Object.entries(bodyProps)) {
            // Avoid collisions with parameter names by prefixing.
            const safeKey = key in properties ? `body_${key}` : key;
            properties[safeKey] = {
              ...(value as Record<string, unknown>),
              'x-in': 'body',
            };
          }
          if (Array.isArray(bodySchema.required)) {
            for (const req of bodySchema.required as string[]) {
              const safeKey = req in properties && !(req in (bodyProps as Record<string, unknown>))
                ? `body_${req}`
                : req;
              if (!required.includes(safeKey)) {
                required.push(safeKey);
              }
            }
          }
        } else {
          // Non-object body (array, primitive) → nest under `body`.
          properties['body'] = {
            ...bodySchema,
            'x-in': 'body',
          };
          if (op.requestBody.required) {
            required.push('body');
          }
        }
      }
    }

    return {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  /**
   * Build a concrete invocation URL by replacing `{param}` placeholders
   * in the path template with actual values.
   *
   * Remaining parameters that do not match a path placeholder are appended
   * as query-string entries.
   *
   * @param baseUrl - API base URL (no trailing slash).
   * @param path    - Path template, e.g. `/users/{id}`.
   * @param params  - Key-value map of parameter values.
   * @returns Fully resolved URL string.
   */
  static buildUrl(baseUrl: string, path: string, params: Record<string, string>): string {
    let resolvedPath = path;
    const queryParams: string[] = [];

    for (const [key, value] of Object.entries(params)) {
      const placeholder = `{${key}}`;
      if (resolvedPath.includes(placeholder)) {
        resolvedPath = resolvedPath.replaceAll(placeholder, encodeURIComponent(value));
      } else {
        queryParams.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }

    const url = `${baseUrl}${resolvedPath}`;
    return queryParams.length > 0 ? `${url}?${queryParams.join('&')}` : url;
  }

  // -------------------------------------------------------------------------
  // Private builders
  // -------------------------------------------------------------------------

  /** Filter operations to only those in the whitelist. */
  private filterOperations(operations: OpenApiOperation[]): OpenApiOperation[] {
    const allowed = new Set(this._options.allowedOperations);
    return operations.filter((op) => allowed.has(op.operationId));
  }

  /** Build the `list_endpoints` meta-tool. */
  private buildListEndpoints(
    operations: OpenApiOperation[],
    ctx: AdapterContext,
  ): CanonicalCapability {
    return {
      id: buildId(ctx, 'list_endpoints'),
      kind: 'tool',
      display: {
        name: 'list_endpoints',
        summary:
          'List available API operations. Optionally filter by tag.',
        examples: ['list_endpoints()', 'list_endpoints(tag: "users")'],
      },
      io: {
        inputSchema: {
          type: 'object',
          properties: {
            tag: {
              type: 'string',
              description: 'Filter results by tag.',
            },
          },
        },
        outputSchema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              operationId: { type: 'string' },
              method: { type: 'string' },
              path: { type: 'string' },
              summary: { type: 'string' },
            },
          },
        },
      },
      semantics: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
        requiresApproval: false,
      },
      execution: {
        mode: 'sync',
        concurrencySafe: true,
        timeoutSeconds: Math.ceil((this._options.timeoutMs ?? 30_000) / 1_000),
      },
      cost: {
        latencyHint: 'instant',
      },
      provenance: {
        protocol: PROTOCOL,
        native: operations,
        adapterVersion: ADAPTER_VERSION,
      },
      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }

  /** Build the `get_schema` meta-tool. */
  private buildGetSchema(
    operations: OpenApiOperation[],
    ctx: AdapterContext,
  ): CanonicalCapability {
    return {
      id: buildId(ctx, 'get_schema'),
      kind: 'tool',
      display: {
        name: 'get_schema',
        summary:
          'Retrieve the JSON Schema describing the input parameters of a specific API operation.',
        examples: ['get_schema(operationId: "getUser")'],
      },
      io: {
        inputSchema: {
          type: 'object',
          required: ['operationId'],
          properties: {
            operationId: {
              type: 'string',
              description: 'The operationId to look up.',
            },
          },
        },
        outputSchema: {
          type: 'object',
          description: 'JSON Schema describing the operation input.',
        },
      },
      semantics: {
        readOnly: true,
        destructive: false,
        idempotent: true,
        openWorld: false,
        requiresApproval: false,
      },
      execution: {
        mode: 'sync',
        concurrencySafe: true,
        timeoutSeconds: Math.ceil((this._options.timeoutMs ?? 30_000) / 1_000),
      },
      cost: {
        latencyHint: 'instant',
      },
      provenance: {
        protocol: PROTOCOL,
        native: operations,
        adapterVersion: ADAPTER_VERSION,
      },
      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }

  /** Build the `invoke` meta-tool. */
  private buildInvoke(
    operations: OpenApiOperation[],
    ctx: AdapterContext,
  ): CanonicalCapability {
    return {
      id: buildId(ctx, 'invoke'),
      kind: 'tool',
      display: {
        name: 'invoke',
        summary:
          'Execute an API operation by operationId with the given arguments. Requires approval.',
        examples: [
          'invoke(operationId: "createUser", arguments: { name: "Alice" })',
        ],
      },
      io: {
        inputSchema: {
          type: 'object',
          required: ['operationId', 'arguments'],
          properties: {
            operationId: {
              type: 'string',
              description: 'The operationId to invoke.',
            },
            arguments: {
              type: 'object',
              description: 'Arguments matching the operation input schema.',
            },
          },
        },
        // Output is dynamic — depends on the invoked operation.
        outputSchema: null,
      },
      semantics: {
        readOnly: false,
        destructive: true, // conservative default
        idempotent: false,
        openWorld: true,
        requiresApproval: true,
      },
      execution: {
        mode: 'sync',
        concurrencySafe: false,
        timeoutSeconds: Math.ceil((this._options.timeoutMs ?? 30_000) / 1_000),
      },
      cost: {
        latencyHint: 'seconds',
      },
      provenance: {
        protocol: PROTOCOL,
        native: operations,
        adapterVersion: ADAPTER_VERSION,
      },
      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }
}
