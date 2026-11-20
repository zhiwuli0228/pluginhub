/**
 * A2A AgentCard → Canonical Capability adapter.
 *
 * Converts an {@link AgentCard} into the unified {@link CanonicalCapability}
 * model. A2A agents represent stateful delegation targets rather than direct
 * operations, so their semantic flags are all `false` and they carry no I/O
 * schema (the task lifecycle manages input/output).
 *
 * @module
 */

import type { AgentCard } from '../a2a/types.js';
import type {
  AdapterContext,
  CanonicalCapability,
  CapabilityAdapter,
} from './types.js';

/**
 * Adapts A2A Agent Card descriptions to the Canonical Capability model.
 *
 * Key design decisions:
 * - `kind` is `'agent'` — A2A cards describe autonomous agents, not tools.
 * - `io.inputSchema` and `io.outputSchema` are `null` because A2A skills
 *   have no parameterized contract; communication uses the task lifecycle.
 * - All semantic flags default to `false`: agent delegation is opaque and
 *   side-effect classification happens at the remote agent level.
 * - `execution.mode` is `'task'` reflecting the A2A task lifecycle.
 * - `execution.concurrencySafe` is `false` because agents are stateful.
 * - Skills advertised on the card are mapped to `display.examples`.
 * - The original {@link AgentCard} is preserved verbatim in
 *   `provenance.native`.
 */
export class A2AAdapter implements CapabilityAdapter<AgentCard> {
  readonly protocol = 'a2a' as const;
  readonly adapterVersion = '1.0.0';

  /** @inheritdoc */
  adapt(card: AgentCard, ctx: AdapterContext): CanonicalCapability {
    // Collect example prompts from all advertised skills.
    const examples: string[] = [];
    if (card.skills) {
      for (const skill of card.skills) {
        if (skill.examples) {
          examples.push(...skill.examples);
        }
      }
    }

    return {
      id: `${ctx.pluginId}/${ctx.componentId}/${card.name}`,
      kind: 'agent',

      display: {
        name: card.name,
        summary: card.description,
        examples: examples.length > 0 ? examples : undefined,
      },

      io: {
        inputSchema: null,
        outputSchema: null,
        inputModes: card.defaultInputModes,
        outputModes: card.defaultOutputModes,
      },

      semantics: {
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: false,
        requiresApproval: false,
      },

      execution: {
        mode: 'task',
        // Stateful agent — concurrent invocations are not safe.
        concurrencySafe: false,
      },

      provenance: {
        protocol: 'a2a',
        native: card,
        adapterVersion: this.adapterVersion,
      },

      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }
}
