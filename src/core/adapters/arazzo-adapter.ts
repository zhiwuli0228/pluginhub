/**
 * Arazzo Workflow → Canonical Capability adapter.
 *
 * Compiles an entire Arazzo 1.0 workflow into a single
 * {@link CanonicalCapability} of kind `'workflow'`. Individual steps are
 * **not** promoted to separate tools; they remain embedded in
 * `provenance.native` so that downstream executors can replay the full
 * deterministic sequence.
 *
 * @see https://spec.openapis.org/arazzo/v1.0.0
 * @module
 */

import type {
  AdapterContext,
  CanonicalCapability,
} from '../capability/types.js';

// ---------------------------------------------------------------------------
// Minimal Arazzo workflow descriptor (subset of Arazzo 1.0)
// ---------------------------------------------------------------------------

/** Describes a single step inside an Arazzo workflow. */
export interface ArazzoStep {
  /** Unique step identifier within the workflow. */
  stepId: string;
  /** Optional reference to an OpenAPI operation. */
  operationId?: string;
  /** Human-readable description of what this step does. */
  description?: string;
  /** Parameters forwarded to the referenced operation. */
  parameters?: Record<string, unknown>;
}

/** JSON-Schema-like input definition for an Arazzo workflow. */
export interface ArazzoInputs {
  type: 'object';
  properties?: Record<
    string,
    { type?: string; description?: string; required?: boolean }
  >;
  required?: string[];
}

/**
 * Minimal Arazzo workflow descriptor (subset of Arazzo 1.0).
 *
 * Only the fields relevant to capability adaptation are modelled here.
 * The full workflow object is preserved verbatim in
 * `CanonicalCapability.provenance.native`.
 */
export interface ArazzoWorkflow {
  /** Unique workflow identifier. */
  workflowId: string;
  /** Short summary shown in tool listings. */
  summary?: string;
  /** Longer description of the workflow purpose. */
  description?: string;
  /** Input schema accepted by the workflow. */
  inputs?: ArazzoInputs;
  /** Output schema produced by the workflow. */
  outputs?: Record<string, unknown>;
  /** Ordered list of steps that compose the workflow. */
  steps: ArazzoStep[];
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

/** Semantic version of this adapter. */
const ADAPTER_VERSION = '1.0.0';

/**
 * Arazzo Workflow → Canonical Capability adapter.
 *
 * Compiles an entire workflow into a single {@link CanonicalCapability} of
 * kind `'workflow'`. The workflow's input schema becomes the tool's
 * `inputSchema`. Individual steps are **NOT** exposed as separate tools —
 * doing so would produce many near-duplicate tools that differ only in
 * parameter bindings (see architecture §4.1).
 */
export class ArazzoAdapter {
  /**
   * Convert a single Arazzo workflow to a {@link CanonicalCapability}.
   *
   * @param workflow - The Arazzo workflow descriptor.
   * @param ctx      - Adapter context providing plugin/component identity and trust.
   * @returns A canonical capability representing the whole workflow.
   */
  static adapt(
    workflow: ArazzoWorkflow,
    ctx: AdapterContext,
  ): CanonicalCapability {
    return {
      id: `${ctx.pluginId}/${ctx.componentId}/${workflow.workflowId}`,
      kind: 'workflow',

      display: {
        name: workflow.workflowId,
        summary: workflow.summary || workflow.description || '',
      },

      io: {
        // ArazzoInputs is structurally compatible with Record<string, unknown>;
        // the cast satisfies the canonical type without altering runtime shape.
        inputSchema: (workflow.inputs as unknown as Record<string, unknown>) ?? null,
        outputSchema: workflow.outputs ?? null,
      },

      semantics: {
        // Multi-step workflows may mutate state across several operations.
        readOnly: false,
        // Conservative: assume any multi-step workflow could be destructive.
        destructive: true,
        // Workflows with side effects are generally not idempotent.
        idempotent: false,
        // API workflows interact with external services.
        openWorld: true,
        // Always require approval for multi-step mutating workflows.
        requiresApproval: true,
      },

      execution: {
        // Multi-step workflows execute asynchronously as a task.
        mode: 'task',
        // Concurrent runs of the same workflow may conflict on shared state.
        concurrencySafe: false,
      },

      provenance: {
        protocol: 'arazzo',
        // Preserve the full workflow descriptor (including all steps) as-is.
        native: workflow,
        adapterVersion: ADAPTER_VERSION,
      },

      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }

  /**
   * Convert multiple Arazzo workflows to canonical capabilities.
   *
   * Each workflow produces exactly one {@link CanonicalCapability}. Steps
   * within each workflow stay embedded in `provenance.native` and are never
   * lifted to independent capabilities.
   *
   * @param workflows - Array of Arazzo workflow descriptors.
   * @param ctx       - Shared adapter context.
   * @returns Array of canonical capabilities, one per workflow.
   */
  static adaptAll(
    workflows: ArazzoWorkflow[],
    ctx: AdapterContext,
  ): CanonicalCapability[] {
    return workflows.map((wf) => ArazzoAdapter.adapt(wf, ctx));
  }
}
