// ── Permissions ──

/**
 * Supported permission kinds in PluginHub security model.
 * Each kind maps to a distinct capability boundary.
 */
export type PermissionKind =
  | 'fs.read'
  | 'fs.write'
  | 'net.egress'
  | 'exec'
  | 'secrets.read'
  | 'artifact.write';

/**
 * A single permission request or declaration.
 * Fields beyond `id` and `kind` are contextual to the permission kind.
 */
export interface Permission {
  /** Unique identifier for this permission instance */
  id: string;
  /** Category of capability being requested */
  kind?: PermissionKind;
  /** Free-form scope qualifier (e.g. path prefix, namespace) */
  scope?: string;
  /** Allowed target hosts (net.egress only) */
  hosts?: string[];
  /** Allowed HTTP methods (net.egress only) */
  methods?: string[];
  /** Allowed executable commands (exec only) */
  commands?: string[];
  /** Secret reference identifiers (secrets.read only) */
  refs?: string[];
  /** Human-readable justification for the request */
  reason?: string;
}

/**
 * Record of a granted permission with provenance and optional expiry.
 */
export interface PermissionGrant {
  /** References Permission.id */
  permissionId: string;
  /** When the grant was issued */
  grantedAt: Date;
  /** Who or what issued the grant */
  grantedBy: 'user' | 'policy';
  /** Optional expiration; undefined means no expiry */
  expiresAt?: Date;
}

/**
 * Result of solving a set of permission requests against current grants.
 * Default-deny: any permission not explicitly granted lands in `denied`.
 */
export interface PermissionSolverResult {
  /** Permissions that matched an active, non-expired grant */
  granted: Permission[];
  /** Permissions with no matching grant (default deny) */
  denied: Permission[];
  /** Permissions that require interactive user approval */
  unresolved: Permission[];
}

// ── Trust ──

/**
 * Three-state trust classification for plugin provenance.
 * - self-asserted: no signature or provenance evidence
 * - verified-untrusted: signature present but issuer not in trust store
 * - trusted: signature valid AND issuer trusted (key or domain pinning)
 */
export type TrustStatus = 'self-asserted' | 'verified-untrusted' | 'trusted';

/**
 * Evaluated trust information for a plugin manifest.
 */
export interface TrustInfo {
  /** The resolved trust level */
  status: TrustStatus;
  /** Signing algorithm identifier (if signed) */
  signingAlgorithm?: string;
  /** Key identifier used for signing (if signed) */
  keyId?: string;
  /** Whether cryptographic verification passed (P2+ will compute this) */
  signatureValid?: boolean;
  /** Whether the publisher identity has been independently verified */
  publisherVerified?: boolean;
  /** URI pointing to build provenance metadata */
  provenanceUri?: string;
}

/**
 * Configuration for the trust evaluator's trust anchors.
 */
export interface TrustConfig {
  /** Trusted JWKS endpoints or DID documents keyed by keyId */
  trustedKeys?: Array<{ keyId: string; uri: string }>;
  /** Publisher domains that are auto-trusted via domain pinning */
  trustedDomains?: string[];
}
