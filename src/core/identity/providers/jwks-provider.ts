/**
 * JWKS (JSON Web Key Set) identity provider.
 *
 * Verifies identities by fetching JWKS from a well-known endpoint
 * and checking key presence. P5 does NOT implement actual JWT signature
 * verification (that requires crypto libraries); it only validates
 * that the JWKS endpoint is reachable and contains the expected key.
 *
 * @module identity/providers/jwks-provider
 */

import type {
  IdentityProvider,
  VerifyRequest,
  VerifyResult,
} from '../types.js';

/** Default fetch timeout: 10 seconds */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Options for JwksProvider construction */
export interface JwksProviderOptions {
  /** Fetch timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * JWKS identity provider.
 *
 * Handles targets that are URLs ending in `/.well-known/jwks.json`
 * or containing `/jwks`. Validates that the endpoint returns valid JSON
 * with a `keys` array.
 */
export class JwksProvider implements IdentityProvider {
  readonly type = 'jwks' as const;
  readonly config: Record<string, unknown>;

  private readonly timeoutMs: number;

  constructor(options?: JwksProviderOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.config = { timeoutMs: this.timeoutMs };
  }

  /**
   * Check if this provider can handle the given target format.
   *
   * Handles URLs ending in `/.well-known/jwks.json` or containing `/jwks`.
   *
   * @param target - The identity target to check
   * @returns True if this provider can handle the target
   */
  canHandle(target: string): boolean {
    try {
      const url = new URL(target);
      const pathname = url.pathname.toLowerCase();
      return pathname.endsWith('/.well-known/jwks.json') || pathname.includes('/jwks');
    } catch {
      return false;
    }
  }

  /**
   * Verify an identity by fetching the JWKS endpoint.
   *
   * Validates that:
   * 1. The URL is reachable within the configured timeout
   * 2. The response is valid JSON
   * 3. The JSON contains a `keys` array with at least one entry
   *
   * @param request - The verification request
   * @returns Verification result
   */
  async verify(request: VerifyRequest): Promise<VerifyResult> {
    const { target } = request;

    if (!this.canHandle(target)) {
      return { success: false, error: `Target is not a valid JWKS URL: ${target}` };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(target, { signal: controller.signal });

      if (!response.ok) {
        return {
          success: false,
          error: `JWKS endpoint returned HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        return {
          success: false,
          error: `JWKS endpoint returned non-JSON content type: ${contentType}`,
        };
      }

      const body = (await response.json()) as Record<string, unknown>;

      if (!Array.isArray(body.keys)) {
        return {
          success: false,
          error: 'JWKS response does not contain a "keys" array',
        };
      }

      if (body.keys.length === 0) {
        return {
          success: false,
          error: 'JWKS response contains an empty "keys" array',
        };
      }

      // Extract first key info if available
      const firstKey = body.keys[0] as Record<string, unknown>;
      const keyId = typeof firstKey.kid === 'string' ? firstKey.kid : 'unknown';
      const algorithm = typeof firstKey.alg === 'string' ? firstKey.alg : 'unknown';

      return {
        success: true,
        identity: {
          id: target,
          providerType: 'jwks',
          verified: true,
          verifiedAt: new Date(),
          claims: {
            keyCount: body.keys.length,
            keys: body.keys.map((k: Record<string, unknown>) => ({
              kid: k.kid,
              kty: k.kty,
              alg: k.alg,
              use: k.use,
            })),
          },
          publicKey: {
            algorithm,
            keyId,
            jwk: firstKey,
          },
        },
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          success: false,
          error: `JWKS fetch timed out after ${this.timeoutMs}ms`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `JWKS verification failed: ${message}` };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
