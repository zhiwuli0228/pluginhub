/**
 * DID (Decentralized Identifier) identity provider.
 *
 * Resolves did:web identifiers by fetching the DID document from
 * the corresponding HTTPS URL. P5 validates document structure only;
 * full cryptographic verification of DID documents is out of scope.
 *
 * @module identity/providers/did-provider
 */

import type {
  IdentityProvider,
  ResolvedIdentity,
  VerifyRequest,
  VerifyResult,
} from '../types.js';

/** Default fetch timeout: 10 seconds */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Options for DidProvider construction */
export interface DidProviderOptions {
  /** Fetch timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * Convert a did:web identifier to its corresponding HTTPS URL.
 *
 * Per the did:web specification:
 * - `did:web:example.com` → `https://example.com/.well-known/did.json`
 * - `did:web:example.com:path:to:resource` → `https://example.com/path/to/resource/did.json`
 *
 * Colons in the path component are replaced with slashes.
 * Percent-encoded characters are decoded.
 *
 * @param did - The did:web identifier
 * @returns The HTTPS URL for the DID document
 */
function didWebToUrl(did: string): string {
  // Remove the "did:web:" prefix
  const remainder = did.slice('did:web:'.length);

  // Split into domain and path parts
  const colonIndex = remainder.indexOf(':');
  let domain: string;
  let path: string;

  if (colonIndex === -1) {
    domain = remainder;
    path = '';
  } else {
    domain = remainder.slice(0, colonIndex);
    path = remainder.slice(colonIndex + 1);
  }

  // Decode percent-encoding and replace colons with slashes in path
  const decodedDomain = decodeURIComponent(domain);
  const decodedPath = path ? '/' + decodeURIComponent(path).replace(/:/g, '/') : '';

  if (decodedPath) {
    return `https://${decodedDomain}${decodedPath}/did.json`;
  }
  return `https://${decodedDomain}/.well-known/did.json`;
}

/**
 * DID identity provider.
 *
 * Handles `did:web:*` identifiers. Resolves them by fetching the
 * DID document from the corresponding HTTPS URL and validating
 * that it contains required fields (`id` and `verificationMethod`).
 */
export class DidProvider implements IdentityProvider {
  readonly type = 'did' as const;
  readonly config: Record<string, unknown>;

  private readonly timeoutMs: number;

  constructor(options?: DidProviderOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.config = { timeoutMs: this.timeoutMs };
  }

  /**
   * Check if this provider can handle the given target format.
   *
   * Handles `did:web:*` identifiers.
   *
   * @param target - The identity target to check
   * @returns True if this provider can handle the target
   */
  canHandle(target: string): boolean {
    return target.startsWith('did:web:');
  }

  /**
   * Verify an identity by resolving the DID document.
   *
   * Validates that:
   * 1. The target is a valid did:web identifier
   * 2. The corresponding HTTPS URL is reachable within the configured timeout
   * 3. The response is valid JSON
   * 4. The DID document contains `id` and `verificationMethod` fields
   *
   * @param request - The verification request
   * @returns Verification result
   */
  async verify(request: VerifyRequest): Promise<VerifyResult> {
    const { target } = request;

    if (!this.canHandle(target)) {
      return { success: false, error: `Target is not a did:web identifier: ${target}` };
    }

    const url = didWebToUrl(target);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (!response.ok) {
        return {
          success: false,
          error: `DID document endpoint returned HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json') && !contentType.includes('application/ld+json')) {
        return {
          success: false,
          error: `DID document endpoint returned non-JSON content type: ${contentType}`,
        };
      }

      const doc = (await response.json()) as Record<string, unknown>;

      // Validate required DID document fields
      if (typeof doc.id !== 'string') {
        return {
          success: false,
          error: 'DID document does not contain a valid "id" field',
        };
      }

      if (!Array.isArray(doc.verificationMethod) || doc.verificationMethod.length === 0) {
        return {
          success: false,
          error: 'DID document does not contain a non-empty "verificationMethod" array',
        };
      }

      // Extract first verification method info
      const firstVm = doc.verificationMethod[0] as Record<string, unknown>;
      const keyId = typeof firstVm.id === 'string' ? firstVm.id : 'unknown';
      const algorithm = typeof firstVm.type === 'string' ? firstVm.type : 'unknown';

      // Build public key info if available
      let publicKey: ResolvedIdentity['publicKey'];
      if (firstVm.publicKeyJwk && typeof firstVm.publicKeyJwk === 'object') {
        publicKey = {
          algorithm,
          keyId,
          jwk: firstVm.publicKeyJwk as Record<string, unknown>,
        };
      } else if (typeof firstVm.publicKeyPem === 'string') {
        publicKey = {
          algorithm,
          keyId,
          pem: firstVm.publicKeyPem,
        };
      }

      return {
        success: true,
        identity: {
          id: doc.id,
          providerType: 'did',
          verified: true,
          verifiedAt: new Date(),
          claims: {
            didDocumentUrl: url,
            verificationMethodCount: doc.verificationMethod.length,
            service: doc.service,
            authentication: doc.authentication,
          },
          publicKey,
        },
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return {
          success: false,
          error: `DID document fetch timed out after ${this.timeoutMs}ms`,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `DID verification failed: ${message}` };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
