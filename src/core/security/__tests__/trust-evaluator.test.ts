import { describe, it, expect } from 'vitest'
import { TrustEvaluator } from '../trust-evaluator.js'

describe('TrustEvaluator', () => {
  // ── No trust section → self-asserted ──

  it('returns self-asserted when manifest has no trust section', () => {
    const evaluator = new TrustEvaluator()
    const info = evaluator.evaluate({})
    expect(info.status).toBe('self-asserted')
  })

  it('returns self-asserted when trust section exists but no signing', () => {
    const evaluator = new TrustEvaluator()
    const info = evaluator.evaluate({
      trust: {
        provenance: { uri: 'https://example.com/provenance' },
      },
    })
    expect(info.status).toBe('self-asserted')
    expect(info.provenanceUri).toBe('https://example.com/provenance')
  })

  // ── Signature present but key not in trust list → verified-untrusted ──

  it('returns verified-untrusted when signature key is not trusted', () => {
    const evaluator = new TrustEvaluator({
      trustedKeys: [{ keyId: 'trusted-key-1', uri: 'https://example.com/jwks' }],
    })
    const info = evaluator.evaluate({
      trust: {
        signing: {
          algorithm: 'ES256',
          keyId: 'unknown-key',
          signatureRef: './sig.pem',
        },
      },
    })
    expect(info.status).toBe('verified-untrusted')
    expect(info.signingAlgorithm).toBe('ES256')
    expect(info.keyId).toBe('unknown-key')
  })

  // ── Signature present and key in trust list → trusted ──

  it('returns trusted when signing key is in trusted keys', () => {
    const evaluator = new TrustEvaluator({
      trustedKeys: [{ keyId: 'my-key', uri: 'https://example.com/jwks' }],
    })
    const info = evaluator.evaluate({
      trust: {
        signing: {
          algorithm: 'EdDSA',
          keyId: 'my-key',
          signatureRef: './sig.pem',
        },
      },
    })
    expect(info.status).toBe('trusted')
    expect(info.signatureValid).toBe(true)
    expect(info.signingAlgorithm).toBe('EdDSA')
    expect(info.keyId).toBe('my-key')
  })

  // ── Publisher domain in trustedDomains → trusted ──

  it('returns trusted when publisher domain is in trustedDomains', () => {
    const evaluator = new TrustEvaluator({
      trustedDomains: ['example.com'],
    })
    const info = evaluator.evaluate({
      metadata: {
        publisher: { domain: 'example.com' },
      },
      trust: {
        signing: {
          algorithm: 'RS256',
          keyId: 'some-key',
          signatureRef: './sig.pem',
        },
      },
    })
    expect(info.status).toBe('trusted')
  })

  it('domain matching is case-insensitive', () => {
    const evaluator = new TrustEvaluator({
      trustedDomains: ['Example.COM'],
    })
    const info = evaluator.evaluate({
      metadata: {
        publisher: { domain: 'example.com' },
      },
    })
    expect(info.status).toBe('trusted')
  })

  // ── addTrustedKey dynamic update ──

  it('addTrustedKey makes previously untrusted key become trusted', () => {
    const evaluator = new TrustEvaluator()
    const manifest = {
      trust: {
        signing: {
          algorithm: 'ES256',
          keyId: 'dynamic-key',
          signatureRef: './sig.pem',
        },
      },
    }

    // Initially untrusted
    const before = evaluator.evaluate(manifest)
    expect(before.status).toBe('verified-untrusted')

    // Add the key dynamically
    evaluator.addTrustedKey('dynamic-key', 'https://example.com/jwks')

    // Now trusted
    const after = evaluator.evaluate(manifest)
    expect(after.status).toBe('trusted')
    expect(after.signatureValid).toBe(true)
  })

  // ── addTrustedDomain dynamic update ──

  it('addTrustedDomain makes previously untrusted domain become trusted', () => {
    const evaluator = new TrustEvaluator()
    const manifest = {
      metadata: {
        publisher: { domain: 'new-publisher.io' },
      },
    }

    const before = evaluator.evaluate(manifest)
    expect(before.status).toBe('self-asserted')

    evaluator.addTrustedDomain('new-publisher.io')

    const after = evaluator.evaluate(manifest)
    expect(after.status).toBe('trusted')
  })

  // ── Priority: domain pinning overrides key trust ──

  it('domain pinning takes priority over key-based trust', () => {
    const evaluator = new TrustEvaluator({
      trustedDomains: ['trusted-domain.com'],
      trustedKeys: [{ keyId: 'other-key', uri: 'https://example.com/jwks' }],
    })
    // Manifest has an untrusted key but a trusted domain
    const info = evaluator.evaluate({
      metadata: {
        publisher: { domain: 'trusted-domain.com' },
      },
      trust: {
        signing: {
          algorithm: 'ES256',
          keyId: 'untrusted-key',
          signatureRef: './sig.pem',
        },
      },
    })
    // Domain pinning wins
    expect(info.status).toBe('trusted')
  })
})
