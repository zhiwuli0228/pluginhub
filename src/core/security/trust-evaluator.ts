import type { TrustConfig, TrustInfo, TrustStatus } from './types.js';

/**
 * Minimal manifest shape accepted by the trust evaluator.
 * Only the fields relevant to P1 trust classification are accessed.
 */
interface PluginManifest {
  trust?: {
    signing?: { algorithm?: string; keyId?: string; signatureRef?: string };
    provenance?: { uri?: string };
    publisherVerification?: { method?: string; uri?: string };
  };
  metadata?: {
    publisher?: { domain?: string };
  };
}

/**
 * Three-state trust evaluator for plugin manifests.
 *
 * P1 implementation performs structural checks only:
 * - No signature fields → `self-asserted`
 * - Signature present but keyId not in trustedKeys → `verified-untrusted`
 * - Signature present and keyId in trustedKeys → `trusted`
 * - Publisher domain matches trustedDomains → `trusted` (domain pinning)
 *
 * Actual JWS/JWT cryptographic verification is deferred to P2+.
 */
export class TrustEvaluator {
  private trustedKeys: Map<string, string>;
  private trustedDomains: Set<string>;

  constructor(config?: TrustConfig) {
    this.trustedKeys = new Map();
    this.trustedDomains = new Set();

    if (config?.trustedKeys) {
      for (const entry of config.trustedKeys) {
        this.trustedKeys.set(entry.keyId, entry.uri);
      }
    }
    if (config?.trustedDomains) {
      for (const domain of config.trustedDomains) {
        this.trustedDomains.add(domain.toLowerCase());
      }
    }
  }

  /**
   * Evaluate trust level for a plugin manifest.
   *
   * Decision priority:
   * 1. Domain pinning: if publisher domain is in trustedDomains → trusted
   * 2. Key trust: if signing keyId is in trustedKeys → trusted
   * 3. Signature present but untrusted key → verified-untrusted
   * 4. No signature evidence → self-asserted
   *
   * @param manifest - Plugin manifest with optional trust and metadata sections
   * @returns Evaluated trust information
   */
  evaluate(manifest: PluginManifest): TrustInfo {
    const info: TrustInfo = { status: 'self-asserted' as TrustStatus };

    // Extract signing metadata regardless of trust outcome
    const signing = manifest.trust?.signing;
    const hasSignature = !!(signing && (signing.keyId || signing.signatureRef));

    if (signing?.algorithm) {
      info.signingAlgorithm = signing.algorithm;
    }
    if (signing?.keyId) {
      info.keyId = signing.keyId;
    }
    if (manifest.trust?.provenance?.uri) {
      info.provenanceUri = manifest.trust.provenance.uri;
    }
    if (manifest.trust?.publisherVerification) {
      info.publisherVerified = !!manifest.trust.publisherVerification.method;
    }

    // Priority 1: Domain pinning overrides everything
    const publisherDomain = manifest.metadata?.publisher?.domain;
    if (publisherDomain && this.trustedDomains.has(publisherDomain.toLowerCase())) {
      info.status = 'trusted';
      return info;
    }

    // Priority 2–4: Key-based trust classification
    if (!hasSignature) {
      info.status = 'self-asserted';
      return info;
    }

    if (signing?.keyId && this.trustedKeys.has(signing.keyId)) {
      info.status = 'trusted';
      // P1: we trust the key listing, not the actual signature bytes
      info.signatureValid = true;
      return info;
    }

    // Signature exists but issuer is not in our trust store
    info.status = 'verified-untrusted';
    return info;
  }

  /**
   * Register a trusted key at runtime.
   *
   * @param keyId - Identifier for the signing key
   * @param uri - JWKS endpoint or DID document URI where the key can be fetched
   */
  addTrustedKey(keyId: string, uri: string): void {
    this.trustedKeys.set(keyId, uri);
  }

  /**
   * Register a trusted publisher domain at runtime.
   * Domain matching is case-insensitive.
   *
   * @param domain - Publisher domain to trust (e.g. "example.com")
   */
  addTrustedDomain(domain: string): void {
    this.trustedDomains.add(domain.toLowerCase());
  }
}
