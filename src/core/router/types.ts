/**
 * Invocation Router — type definitions.
 *
 * Defines the intent, routing result, approval decision, and context budget
 * types used by the {@link InvocationRouter} to match agent/user intents
 * against registered capabilities.
 *
 * @module
 */

import type { CanonicalCapability } from '../capability/types.js';

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/** An intent to be matched against capabilities. */
export interface InvocationIntent {
  /** Natural language query or command. */
  query: string;

  /** Optional explicit capability ID (bypasses matching). */
  capabilityId?: string;

  /** Context for routing decisions. */
  context?: {
    /** Maximum number of tools allowed in context window. Default 40. */
    maxTools?: number;
    /** Preferred protocol when multiple candidates tie. */
    preferredProtocol?: string;
    /** Token budget hint for the current session. */
    sessionTokenBudget?: number;
  };
}

// ---------------------------------------------------------------------------
// Routing Result
// ---------------------------------------------------------------------------

/** Result of routing an intent to a capability. */
export interface RoutingResult {
  /** The matched capability. */
  capability: CanonicalCapability;

  /** Match score in the range [0, 1]. */
  score: number;

  /** Whether approval is required before execution. */
  requiresApproval: boolean;

  /** Human-readable reason for the approval requirement. */
  approvalReason?: string;

  /** All candidates considered during routing (useful for debugging). */
  candidates: Array<{ capability: CanonicalCapability; score: number }>;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/** A recorded approval decision for a capability. */
export interface ApprovalDecision {
  /** Whether the invocation was approved. */
  approved: boolean;

  /** Optional human-readable reason for the decision. */
  reason?: string;

  /** Who or what made the decision. */
  decidedBy: 'user' | 'policy' | 'auto';
}

// ---------------------------------------------------------------------------
// Context Budget
// ---------------------------------------------------------------------------

/** Constraints applied when building LLM context summaries. */
export interface ContextBudget {
  /** Maximum number of tool entries to include. */
  maxTools: number;

  /** Maximum character length for individual tool names. */
  maxToolNameLength: number;

  /** Approximate token budget hint for the summary block. */
  tokenBudgetHint: number;
}
