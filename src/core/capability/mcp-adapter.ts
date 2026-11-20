/**
 * MCP Tool → Canonical Capability adapter.
 *
 * Converts an {@link McpTool} description into the unified
 * {@link CanonicalCapability} model following the P1 mapping rules.
 *
 * @module
 */

import type { McpTool } from '../mcp/types.js';
import type {
  AdapterContext,
  CanonicalCapability,
  CapabilityAdapter,
} from './types.js';

/**
 * Adapts MCP Tool descriptions to the Canonical Capability model.
 *
 * Mapping highlights:
 * - `semantics.requiresApproval` is forced `true` when the tool is destructive.
 * - `execution.concurrencySafe` mirrors `readOnly` (only read-only tools are
 *   safe to invoke concurrently).
 * - The original {@link McpTool} is preserved verbatim in `provenance.native`.
 */
export class McpToolAdapter implements CapabilityAdapter<McpTool> {
  readonly protocol = 'mcp' as const;
  readonly adapterVersion = '1.0.0';

  /** @inheritdoc */
  adapt(tool: McpTool, ctx: AdapterContext): CanonicalCapability {
    const readOnly = tool.annotations?.readOnlyHint ?? false;
    const destructive = tool.annotations?.destructiveHint ?? false;
    const idempotent = tool.annotations?.idempotentHint ?? false;
    const openWorld = tool.annotations?.openWorldHint ?? false;

    return {
      id: `${ctx.pluginId}/${ctx.componentId}/${tool.name}`,
      kind: 'tool',

      display: {
        name: tool.title || tool.name,
        summary: tool.description || '',
      },

      io: {
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
      },

      semantics: {
        readOnly,
        destructive,
        idempotent,
        openWorld,
        // Destructive operations mandate approval regardless of other hints.
        requiresApproval: destructive,
      },

      execution: {
        mode: 'sync',
        // Only read-only tools are safe to run concurrently.
        concurrencySafe: readOnly,
      },

      provenance: {
        protocol: 'mcp',
        native: tool,
        adapterVersion: this.adapterVersion,
      },

      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }
}
