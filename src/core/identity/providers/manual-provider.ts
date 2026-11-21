/**
 * Manual trust identity provider.
 *
 * Always returns verified=true for pre-configured trusted identities.
 * Used for local development and explicit trust pinning.
 *
 * @module identity/providers/manual-provider
 */

import type {
  IdentityProvider,
  VerifyRequest,
  VerifyResult,
} from '../types.js';

/**
 * Manual trust identity provider.
 *
 * Maintains an in-memory set of trusted identity identifiers.
 * Any target matching a trusted ID is immediately returned as verified
 * without any network calls or cryptographic checks.
 *
 * Useful for:
 * - Local development environments
 * - Explicit trust pinning for known identities
 * - Testing and CI/CD pipelines
 */
export class ManualProvider implements IdentityProvider {
  readonly type = 'manual' as const;
  readonly config: Record<string, unknown>;

  private readonly trustedIds: Set<string>;

  /**
   * Create a manual trust provider.
   *
   * @param trustedIds - Initial list of trusted identity identifiers
   */
  constructor(trustedIds: string[]) {
    this.trustedIds = new Set(trustedIds);
    this.config = { initialTrustedCount: trustedIds.length };
  }

  /**
   * Check if this provider can handle the given target format.
   *
   * Handles any target that is in the trusted IDs list.
   *
   * @param target - The identity target to check
   * @returns True if the target is in the trusted list
   */
  canHandle(target: string): boolean {
    return this.trustedIds.has(target);
  }

  /**
   * Verify an identity by checking the trusted list.
   *
   * Returns verified=true immediately if the target is in the trusted list.
   * No network calls or cryptographic verification are performed.
   *
   * @param request - The verification request
   * @returns Verification result
   */
  async verify(request: VerifyRequest): Promise<VerifyResult> {
    const { target } = request;

    if (!this.trustedIds.has(target)) {
      return {
        success: false,
        error: `Identity not in trusted list: ${target}`,
      };
    }

    return {
      success: true,
      identity: {
        id: target,
        providerType: 'manual',
        verified: true,
        verifiedAt: new Date(),
        claims: {
          trustSource: 'manual',
          explicitlyTrusted: true,
        },
      },
    };
  }

  /**
   * Add a trusted identity at runtime.
   *
   * @param id - The identity identifier to trust
   */
  addTrusted(id: string): void {
    this.trustedIds.add(id);
  }

  /**
   * Remove a trusted identity.
   *
   * @param id - The identity identifier to remove from trust
   */
  removeTrusted(id: string): void {
    this.trustedIds.delete(id);
  }
}
