/**
 * Invocation Router — matches intents to capabilities, enforces approval
 * gates, and produces context-window-safe summaries for LLM injection.
 *
 * Matching is keyword-based (P3); embedding-based semantic search is deferred
 * to a future phase.
 *
 * @module
 */

import { EventEmitter } from 'node:events';

import type { CanonicalCapability } from '../capability/types.js';
import type {
  ApprovalDecision,
  ContextBudget,
  InvocationIntent,
  RoutingResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default maximum number of tools exposed in context summaries. */
const DEFAULT_MAX_TOOLS = 40;

/** Match-score weights by strategy. */
const SCORE_EXACT = 1.0;
const SCORE_NAME = 0.8;
const SCORE_EXAMPLE = 0.7;
const SCORE_SUMMARY = 0.5;

/** Trust-level ordering (higher index = higher priority). */
const TRUST_ORDER: Record<string, number> = {
  'self-asserted': 0,
  'verified-untrusted': 1,
  trusted: 2,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tokenise a query string into lowercase keywords suitable for substring
 * matching.  Splits on whitespace and common punctuation, discards tokens
 * shorter than two characters.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,;.!?()\[\]{}"'`]+/)
    .filter((t) => t.length >= 2);
}

/**
 * Extract the plugin ID prefix from a canonical capability ID.
 * IDs follow the pattern `<pluginId>/<componentId>/<member>`.
 */
function pluginIdOf(capabilityId: string): string {
  const slash = capabilityId.indexOf('/');
  return slash === -1 ? capabilityId : capabilityId.slice(0, slash);
}

// ---------------------------------------------------------------------------
// InvocationRouter
// ---------------------------------------------------------------------------

/**
 * Routes invocation intents to the best-matching registered capability,
 * enforces approval gates, and provides two-phase context injection helpers.
 *
 * ## Events
 *
 * | Event              | Payload                                           |
 * |--------------------|---------------------------------------------------|
 * | `approvalRequired` | `{ capabilityId: string; reason: string }`        |
 * | `approvalGranted`  | `{ capabilityId: string; decision: ApprovalDecision }` |
 * | `approvalDenied`   | `{ capabilityId: string; decision: ApprovalDecision }` |
 */
export class InvocationRouter extends EventEmitter {
  /** Registered capabilities keyed by ID for O(1) lookup. */
  private readonly _capabilities = new Map<string, CanonicalCapability>();

  /** Recorded approval decisions keyed by capability ID. */
  private readonly _approvals = new Map<string, ApprovalDecision>();

  /** Default max-tools value used when no budget is supplied. */
  private readonly _defaultMaxTools: number;

  /**
   * Create a new InvocationRouter.
   *
   * @param options - Optional configuration overrides.
   * @param options.defaultMaxTools - Default tool cap for context summaries.
   */
  constructor(options?: { defaultMaxTools?: number }) {
    super();
    this._defaultMaxTools = options?.defaultMaxTools ?? DEFAULT_MAX_TOOLS;
  }

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  /**
   * Register one or more capabilities for routing.
   * Existing entries with the same ID are overwritten.
   */
  registerCapabilities(capabilities: CanonicalCapability[]): void {
    for (const cap of capabilities) {
      this._capabilities.set(cap.id, cap);
    }
  }

  /**
   * Unregister every capability belonging to the given plugin.
   *
   * @param pluginId - The plugin whose capabilities should be removed.
   */
  unregisterPlugin(pluginId: string): void {
    for (const [id] of this._capabilities) {
      if (pluginIdOf(id) === pluginId) {
        this._capabilities.delete(id);
        this._approvals.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  /**
   * Route an intent to the best-matching capability.
   *
   * Matching strategies (in priority order):
   * 1. **Exact** — `intent.capabilityId` directly resolves a registration.
   * 2. **Name** — any keyword appears in `display.name`.
   * 3. **Example** — any keyword appears in a `display.examples` entry.
   * 4. **Summary** — any keyword appears in `display.summary`.
   *
   * When multiple candidates share the same score the tie-break order is:
   * trust status (descending) → alphabetical by ID.
   *
   * @param intent - The invocation intent to route.
   * @returns A {@link RoutingResult} describing the match.
   * @throws If no capabilities are registered.
   */
  route(intent: InvocationIntent): RoutingResult {
    if (this._capabilities.size === 0) {
      throw new Error('InvocationRouter: no capabilities registered');
    }

    // --- Phase 1: score every candidate -----------------------------------
    const candidates = this._scoreAll(intent);

    // Sort: score desc → trust desc → id asc
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const trustDiff =
        (TRUST_ORDER[b.capability.trust.status] ?? 0) -
        (TRUST_ORDER[a.capability.trust.status] ?? 0);
      if (trustDiff !== 0) return trustDiff;
      return a.capability.id.localeCompare(b.capability.id);
    });

    const best = candidates[0];

    // --- Phase 2: approval gate -------------------------------------------
    const approval = this.checkApproval(best.capability.id);

    const result: RoutingResult = {
      capability: best.capability,
      score: best.score,
      requiresApproval: approval.required,
      approvalReason: approval.reason,
      candidates,
    };

    if (approval.required) {
      this.emit('approvalRequired', {
        capabilityId: best.capability.id,
        reason: approval.reason,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Context Injection (two-phase)
  // -------------------------------------------------------------------------

  /**
   * Build a lightweight summary array suitable for LLM system-prompt
   * injection (phase 1 of two-phase context loading).
   *
   * Entries are sorted by trust status (desc), then alphabetically by ID,
   * and truncated to `budget.maxTools`.
   *
   * @param budget - Optional budget constraints.
   * @returns An array of `{ id, name, summary }` objects (~20 tokens each).
   */
  getContextSummary(
    budget?: ContextBudget,
  ): Array<{ id: string; name: string; summary: string }> {
    const maxTools = budget?.maxTools ?? this._defaultMaxTools;
    const maxNameLen = budget?.maxToolNameLength ?? 64;

    const caps = [...this._capabilities.values()];

    // Sort: trust desc → id asc
    caps.sort((a, b) => {
      const trustDiff =
        (TRUST_ORDER[b.trust.status] ?? 0) -
        (TRUST_ORDER[a.trust.status] ?? 0);
      if (trustDiff !== 0) return trustDiff;
      return a.id.localeCompare(b.id);
    });

    return caps.slice(0, maxTools).map((c) => ({
      id: c.id,
      name: c.display.name.slice(0, maxNameLen),
      summary: c.display.summary,
    }));
  }

  /**
   * Retrieve the full schema for a specific capability (phase 2 of
   * two-phase context loading).
   *
   * @param capabilityId - Exact capability ID.
   * @returns The capability record, or `null` if not found.
   */
  getFullSchema(capabilityId: string): CanonicalCapability | null {
    return this._capabilities.get(capabilityId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Approval
  // -------------------------------------------------------------------------

  /**
   * Determine whether a capability currently requires approval.
   *
   * Rules (evaluated in order):
   * 1. A previously recorded `approved` decision skips the gate.
   * 2. `semantics.destructive === true` → forced approval.
   * 3. `semantics.requiresApproval === true` → approval required.
   * 4. Otherwise → no approval needed.
   *
   * @param capabilityId - The capability to check.
   * @returns An object indicating whether approval is required and why.
   */
  checkApproval(
    capabilityId: string,
  ): { required: boolean; reason?: string } {
    // Already approved?
    const existing = this._approvals.get(capabilityId);
    if (existing?.approved) {
      return { required: false };
    }

    const cap = this._capabilities.get(capabilityId);
    if (!cap) {
      return { required: false };
    }

    if (cap.semantics.destructive) {
      return {
        required: true,
        reason: 'Capability is marked as destructive',
      };
    }

    if (cap.semantics.requiresApproval) {
      return {
        required: true,
        reason: 'Capability requires explicit approval',
      };
    }

    return { required: false };
  }

  /**
   * Record an approval decision for a capability and emit the appropriate
   * event (`approvalGranted` or `approvalDenied`).
   *
   * @param capabilityId - The capability the decision applies to.
   * @param decision - The approval decision record.
   */
  recordApproval(capabilityId: string, decision: ApprovalDecision): void {
    this._approvals.set(capabilityId, decision);

    if (decision.approved) {
      this.emit('approvalGranted', { capabilityId, decision });
    } else {
      this.emit('approvalDenied', { capabilityId, decision });
    }
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Return all currently registered capabilities.
   */
  getCapabilities(): CanonicalCapability[] {
    return [...this._capabilities.values()];
  }

  /**
   * Search registered capabilities by free-text query.
   *
   * Uses the same keyword-matching strategy as {@link route} but returns
   * only the capability records (no scores or approval info).
   *
   * @param query - Free-text search string.
   * @param limit - Maximum results to return. Defaults to 10.
   * @returns Matched capabilities sorted by relevance.
   */
  search(query: string, limit: number = 10): CanonicalCapability[] {
    const intent: InvocationIntent = { query };
    const scored = this._scoreAll(intent);

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.capability.id.localeCompare(b.capability.id);
    });

    return scored
      .filter((s) => s.score > 0)
      .slice(0, limit)
      .map((s) => s.capability);
  }

  // -------------------------------------------------------------------------
  // Internal scoring
  // -------------------------------------------------------------------------

  /**
   * Score every registered capability against the given intent.
   *
   * @private
   */
  private _scoreAll(
    intent: InvocationIntent,
  ): Array<{ capability: CanonicalCapability; score: number }> {
    // Exact match shortcut
    if (intent.capabilityId) {
      const exact = this._capabilities.get(intent.capabilityId);
      if (exact) {
        return [{ capability: exact, score: SCORE_EXACT }];
      }
      // Fall through to keyword matching when explicit ID not found
    }

    const tokens = tokenize(intent.query);
    const results: Array<{ capability: CanonicalCapability; score: number }> =
      [];

    for (const cap of this._capabilities.values()) {
      let score = 0;

      if (tokens.length > 0) {
        const nameLower = cap.display.name.toLowerCase();
        const summaryLower = cap.display.summary.toLowerCase();

        // Name match
        if (tokens.some((t) => nameLower.includes(t))) {
          score = Math.max(score, SCORE_NAME);
        }

        // Example match
        if (cap.display.examples) {
          for (const example of cap.display.examples) {
            const exLower = example.toLowerCase();
            if (tokens.some((t) => exLower.includes(t))) {
              score = Math.max(score, SCORE_EXAMPLE);
              break;
            }
          }
        }

        // Summary match
        if (tokens.some((t) => summaryLower.includes(t))) {
          score = Math.max(score, SCORE_SUMMARY);
        }
      }

      results.push({ capability: cap, score });
    }

    return results;
  }
}
