/**
 * Pluggable identity verification service.
 *
 * Routes verification requests to the appropriate provider based on target format.
 * Caches results to avoid repeated network calls.
 *
 * @module identity/identity-service
 */

import type {
  IdentityProvider,
  IdentityProviderType,
  IdentityServiceConfig,
  ResolvedIdentity,
  VerifyResult,
} from './types.js';

/** Default cache TTL: 1 hour */
const DEFAULT_CACHE_TTL_MS = 3_600_000;

/** Cache entry with expiration */
interface CacheEntry {
  identity: ResolvedIdentity;
  expiresAt: number;
}

/**
 * Pluggable identity verification service.
 *
 * Routes verification requests to the appropriate provider based on target format.
 * Caches verified identities to avoid repeated network calls.
 */
export class IdentityService {
  private readonly providers: IdentityProvider[] = [];
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly cacheTtlMs: number;

  constructor(config?: IdentityServiceConfig) {
    this.cacheTtlMs = config?.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

    if (config?.providers) {
      for (const provider of config.providers) {
        this.registerProvider(provider);
      }
    }
  }

  /**
   * Register an identity provider.
   *
   * Providers registered later have lower priority than earlier ones
   * when multiple providers can handle the same target.
   *
   * @param provider - The identity provider to register
   */
  registerProvider(provider: IdentityProvider): void {
    // Avoid duplicate registration by type
    const existingIndex = this.providers.findIndex((p) => p.type === provider.type);
    if (existingIndex !== -1) {
      this.providers[existingIndex] = provider;
    } else {
      this.providers.push(provider);
    }
  }

  /**
   * Unregister a provider by type.
   *
   * @param type - The provider type to remove
   */
  unregisterProvider(type: IdentityProviderType): void {
    const index = this.providers.findIndex((p) => p.type === type);
    if (index !== -1) {
      this.providers.splice(index, 1);
    }
  }

  /**
   * Verify an identity, trying providers in priority order.
   *
   * Returns cached result if available and not expired.
   * Tries each registered provider in order until one can handle the target.
   *
   * @param target - The identity target to verify
   * @param context - Optional additional context for verification
   * @returns Verification result with resolved identity or error
   */
  async verify(target: string, context?: Record<string, unknown>): Promise<VerifyResult> {
    // Check cache first
    const cached = this.getCached(target);
    if (cached) {
      return { success: true, identity: cached };
    }

    // Find a provider that can handle this target
    const provider = this.providers.find((p) => p.canHandle(target));
    if (!provider) {
      return {
        success: false,
        error: `No registered provider can handle target: ${target}`,
      };
    }

    try {
      const result = await provider.verify({ target, context });

      // Cache successful verifications
      if (result.success && result.identity) {
        this.setCache(target, result.identity);
      }

      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Verification failed for ${provider.type} provider: ${message}`,
      };
    }
  }

  /**
   * Get cached identity (if any).
   *
   * Returns null if no cache entry exists or if the entry has expired.
   * Expired entries are automatically removed.
   *
   * @param target - The identity target to look up
   * @returns Cached resolved identity or null
   */
  getCached(target: string): ResolvedIdentity | null {
    const entry = this.cache.get(target);
    if (!entry) {
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(target);
      return null;
    }

    return entry.identity;
  }

  /** Clear identity cache */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * List registered provider types.
   *
   * @returns Array of registered provider type identifiers in priority order
   */
  getProviderTypes(): IdentityProviderType[] {
    return this.providers.map((p) => p.type);
  }

  /**
   * Store an identity in the cache.
   *
   * @param target - Cache key
   * @param identity - Resolved identity to cache
   */
  private setCache(target: string, identity: ResolvedIdentity): void {
    this.cache.set(target, {
      identity,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
  }
}
