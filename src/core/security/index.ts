/**
 * PluginHub Security Module — P1 Minimal Implementation
 *
 * Provides:
 * - Permission types and default-deny solver
 * - Three-state trust evaluator (self-asserted / verified-untrusted / trusted)
 *
 * @module core/security
 */

export type {
  PermissionKind,
  Permission,
  PermissionGrant,
  PermissionSolverResult,
  TrustStatus,
  TrustInfo,
  TrustConfig,
} from './types.js';

export { PermissionSolver } from './permission-solver.js';
export { TrustEvaluator } from './trust-evaluator.js';
