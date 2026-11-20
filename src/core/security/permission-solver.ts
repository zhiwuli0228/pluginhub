import type { Permission, PermissionGrant, PermissionSolverResult } from './types.js';

/**
 * In-memory permission solver implementing default-deny semantics.
 *
 * P1 scope: pure in-memory grant store with expiry support.
 * No persistence, no policy engine — those arrive in P2+.
 *
 * Default-deny principle: any permission not explicitly granted
 * via {@link grant} is classified as denied during {@link solve}.
 */
export class PermissionSolver {
  private grants: Map<string, PermissionGrant>;

  constructor() {
    this.grants = new Map();
  }

  /**
   * Register a permission grant from user approval or automated policy.
   * Overwrites any existing grant for the same permissionId.
   *
   * @param permissionId - The permission to grant
   * @param grantedBy - Provenance of the grant decision
   * @param expiresAt - Optional expiration timestamp
   */
  grant(permissionId: string, grantedBy: 'user' | 'policy', expiresAt?: Date): void {
    this.grants.set(permissionId, {
      permissionId,
      grantedAt: new Date(),
      grantedBy,
      expiresAt,
    });
  }

  /**
   * Revoke a previously granted permission.
   * No-op if the permission was never granted.
   *
   * @param permissionId - The permission to revoke
   */
  revoke(permissionId: string): void {
    this.grants.delete(permissionId);
  }

  /**
   * Check whether a specific permission is currently granted and non-expired.
   *
   * @param permissionId - The permission to check
   * @returns true if an active, non-expired grant exists
   */
  isGranted(permissionId: string): boolean {
    const g = this.grants.get(permissionId);
    if (!g) return false;
    if (g.expiresAt && g.expiresAt.getTime() <= Date.now()) {
      // Lazily clean up expired grant on read
      this.grants.delete(permissionId);
      return false;
    }
    return true;
  }

  /**
   * Solve a set of requested permissions against current grants.
   *
   * Classification rules (P1):
   * - Active grant exists → granted
   * - No grant exists → denied (default-deny)
   * - unresolved is always empty in P1 (no interactive approval flow yet)
   *
   * @param requested - Permissions to evaluate
   * @returns Categorized result with granted, denied, and unresolved buckets
   */
  solve(requested: Permission[]): PermissionSolverResult {
    const granted: Permission[] = [];
    const denied: Permission[] = [];
    const unresolved: Permission[] = [];

    for (const perm of requested) {
      if (this.isGranted(perm.id)) {
        granted.push(perm);
      } else {
        denied.push(perm);
      }
    }

    return { granted, denied, unresolved };
  }

  /**
   * List all registered grants, including expired ones.
   * Use {@link purgeExpired} to remove stale entries first if needed.
   *
   * @returns Snapshot array of all current grants
   */
  listGrants(): PermissionGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * Remove all expired grants from the store.
   *
   * @returns Number of grants purged
   */
  purgeExpired(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, g] of this.grants) {
      if (g.expiresAt && g.expiresAt.getTime() <= now) {
        this.grants.delete(id);
        count++;
      }
    }
    return count;
  }
}
