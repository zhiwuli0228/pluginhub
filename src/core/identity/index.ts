/**
 * Identity provider plugin interface.
 *
 * Provides a pluggable identity verification system supporting
 * DID, JWKS, OIDC, SPIFFE, and manual trust backends.
 *
 * @module identity
 */

// Types
export type {
  IdentityProviderType,
  ResolvedIdentity,
  VerifyRequest,
  VerifyResult,
  IdentityProvider,
  IdentityServiceConfig,
} from './types.js';

// Service
export { IdentityService } from './identity-service.js';

// Providers
export { JwksProvider } from './providers/jwks-provider.js';
export type { JwksProviderOptions } from './providers/jwks-provider.js';

export { DidProvider } from './providers/did-provider.js';
export type { DidProviderOptions } from './providers/did-provider.js';

export { ManualProvider } from './providers/manual-provider.js';
