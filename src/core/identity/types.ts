/**
 * Identity provider plugin interface types.
 *
 * Defines the contract for pluggable identity verification backends.
 * Supports DID, JWKS, OIDC, SPIFFE, and manual trust providers.
 *
 * @module identity/types
 */

/** Supported identity provider types */
export type IdentityProviderType = 'did' | 'jwks' | 'oidc' | 'spiffe' | 'manual';

/** Resolved identity information */
export interface ResolvedIdentity {
  /** The identity identifier (DID, subject, SPIFFE ID, etc.) */
  id: string;
  /** Provider type that resolved this identity */
  providerType: IdentityProviderType;
  /** Whether the identity was cryptographically verified */
  verified: boolean;
  /** Verification timestamp */
  verifiedAt?: Date;
  /** Additional claims/attributes */
  claims?: Record<string, unknown>;
  /** Public key material (if available) */
  publicKey?: {
    algorithm: string;
    keyId: string;
    pem?: string;
    jwk?: Record<string, unknown>;
  };
}

/** Identity verification request */
export interface VerifyRequest {
  /** What to verify (DID document URL, JWKS URI, OIDC token, SPIFFE ID) */
  target: string;
  /** Optional additional context */
  context?: Record<string, unknown>;
}

/** Identity verification result */
export interface VerifyResult {
  success: boolean;
  identity?: ResolvedIdentity;
  error?: string;
}

/** Abstract identity provider interface */
export interface IdentityProvider {
  /** Provider type identifier */
  readonly type: IdentityProviderType;

  /** Verify an identity target */
  verify(request: VerifyRequest): Promise<VerifyResult>;

  /** Check if this provider can handle the given target format */
  canHandle(target: string): boolean;

  /** Provider-specific configuration */
  readonly config: Record<string, unknown>;
}

/** Identity service configuration */
export interface IdentityServiceConfig {
  /** Registered providers (in priority order) */
  providers: IdentityProvider[];
  /** Cache TTL for verified identities (ms), default 3600000 */
  cacheTtlMs?: number;
}
