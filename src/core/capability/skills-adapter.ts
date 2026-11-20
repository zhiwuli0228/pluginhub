/**
 * Agent Skill → Canonical Capability adapter.
 *
 * Converts a {@link SkillSummary} into the unified {@link CanonicalCapability}
 * model. Skills represent knowledge bundles rather than executable operations,
 * so their semantic flags are all `false` and they carry no I/O schema.
 *
 * @module
 */

import type { SkillSummary } from '../skills/types.js';
import type {
  AdapterContext,
  CanonicalCapability,
  CapabilityAdapter,
} from './types.js';

/**
 * Adapts Agent Skill summaries to the Canonical Capability model.
 *
 * Key design decisions:
 * - `io.inputSchema` and `io.outputSchema` are `null` because skills do not
 *   expose a parameterized contract — they are loaded as contextual knowledge.
 * - All semantic flags default to `false`: skills are pure knowledge with no
 *   side effects.
 * - `execution.concurrencySafe` is `true` since reading knowledge has no
 *   shared mutable state.
 * - The original {@link SkillSummary} is preserved verbatim in
 *   `provenance.native`.
 */
export class SkillsAdapter implements CapabilityAdapter<SkillSummary> {
  readonly protocol = 'skills' as const;
  readonly adapterVersion = '1.0.0';

  /** @inheritdoc */
  adapt(skill: SkillSummary, ctx: AdapterContext): CanonicalCapability {
    return {
      id: `${ctx.pluginId}/${ctx.componentId}/${skill.name}`,
      kind: 'skill',

      display: {
        name: skill.name,
        summary: skill.description,
      },

      io: {
        inputSchema: null,
        outputSchema: null,
      },

      semantics: {
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: false,
        requiresApproval: false,
      },

      execution: {
        mode: 'sync',
        // Pure knowledge — no shared mutable state.
        concurrencySafe: true,
      },

      provenance: {
        protocol: 'skills',
        native: skill,
        adapterVersion: this.adapterVersion,
      },

      trust: {
        status: ctx.trustStatus,
        publisher: ctx.publisherDomain,
      },
    };
  }
}
