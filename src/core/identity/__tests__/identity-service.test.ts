import { describe, it, expect, beforeEach } from 'vitest'
import { IdentityService } from '../identity-service.js'
import { ManualProvider } from '../providers/manual-provider.js'
import type { IdentityProvider, VerifyResult } from '../types.js'

describe('IdentityService', () => {
  let service: IdentityService

  beforeEach(() => {
    service = new IdentityService()
  })

  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------
  describe('constructor', () => {
    it('constructs without errors (no config)', () => {
      expect(() => new IdentityService()).not.toThrow()
    })

    it('constructs with providers in config', () => {
      const provider = new ManualProvider(['alice'])
      const svc = new IdentityService({ providers: [provider] })
      expect(svc.getProviderTypes()).toContain('manual')
    })
  })

  // -----------------------------------------------------------------------
  // registerProvider / getProviderTypes
  // -----------------------------------------------------------------------
  describe('registerProvider + getProviderTypes', () => {
    it('registers a provider and lists its type', () => {
      const provider = new ManualProvider(['alice'])
      service.registerProvider(provider)
      expect(service.getProviderTypes()).toEqual(['manual'])
    })

    it('registers multiple providers preserving order', () => {
      const manual = new ManualProvider(['alice'])
      const mockDid: IdentityProvider = {
        type: 'did',
        config: {},
        canHandle: (t: string) => t.startsWith('did:'),
        verify: async () => ({ success: false, error: 'mock' }),
      }
      service.registerProvider(manual)
      service.registerProvider(mockDid)
      expect(service.getProviderTypes()).toEqual(['manual', 'did'])
    })

    it('replaces existing provider of same type', () => {
      const p1 = new ManualProvider(['alice'])
      const p2 = new ManualProvider(['bob'])
      service.registerProvider(p1)
      service.registerProvider(p2)
      // Should still have only one 'manual' entry
      expect(service.getProviderTypes().filter((t) => t === 'manual')).toHaveLength(1)
    })
  })

  // -----------------------------------------------------------------------
  // unregisterProvider
  // -----------------------------------------------------------------------
  describe('unregisterProvider', () => {
    it('removes a registered provider', () => {
      const provider = new ManualProvider(['alice'])
      service.registerProvider(provider)
      expect(service.getProviderTypes()).toContain('manual')

      service.unregisterProvider('manual')
      expect(service.getProviderTypes()).not.toContain('manual')
    })

    it('does nothing for unregistered type', () => {
      expect(() => service.unregisterProvider('did')).not.toThrow()
      expect(service.getProviderTypes()).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // verify routing
  // -----------------------------------------------------------------------
  describe('verify', () => {
    it('routes to the correct provider', async () => {
      const provider = new ManualProvider(['trusted-alice'])
      service.registerProvider(provider)

      const result = await service.verify('trusted-alice')
      expect(result.success).toBe(true)
      expect(result.identity?.id).toBe('trusted-alice')
      expect(result.identity?.providerType).toBe('manual')
    })

    it('returns error when no provider can handle target', async () => {
      const provider = new ManualProvider(['alice'])
      service.registerProvider(provider)

      const result = await service.verify('unknown-bob')
      expect(result.success).toBe(false)
      expect(result.error).toContain('No registered provider')
    })

    it('returns error when no providers registered', async () => {
      const result = await service.verify('anyone')
      expect(result.success).toBe(false)
      expect(result.error).toContain('No registered provider')
    })
  })

  // -----------------------------------------------------------------------
  // Cache behavior
  // -----------------------------------------------------------------------
  describe('cache', () => {
    it('caches successful verification results', async () => {
      const provider = new ManualProvider(['cached-user'])
      service.registerProvider(provider)

      await service.verify('cached-user')
      const cached = service.getCached('cached-user')
      expect(cached).not.toBeNull()
      expect(cached!.id).toBe('cached-user')
    })

    it('returns cached result on second verify call', async () => {
      let verifyCallCount = 0
      const countingProvider: IdentityProvider = {
        type: 'manual',
        config: {},
        canHandle: () => true,
        verify: async () => {
          verifyCallCount++
          return {
            success: true,
            identity: {
              id: 'counted-user',
              providerType: 'manual',
              verified: true,
              verifiedAt: new Date(),
            },
          }
        },
      }
      service.registerProvider(countingProvider)

      await service.verify('counted-user')
      await service.verify('counted-user')
      // Second call should use cache, so provider.verify called only once
      expect(verifyCallCount).toBe(1)
    })

    it('getCached returns null for uncached target', () => {
      expect(service.getCached('nonexistent')).toBeNull()
    })

    it('clearCache empties the cache', async () => {
      const provider = new ManualProvider(['clearme'])
      service.registerProvider(provider)

      await service.verify('clearme')
      expect(service.getCached('clearme')).not.toBeNull()

      service.clearCache()
      expect(service.getCached('clearme')).toBeNull()
    })
  })
})

describe('ManualProvider', () => {
  let provider: ManualProvider

  beforeEach(() => {
    provider = new ManualProvider(['alice', 'bob'])
  })

  // -----------------------------------------------------------------------
  // canHandle
  // -----------------------------------------------------------------------
  describe('canHandle', () => {
    it('returns true for trusted ID', () => {
      expect(provider.canHandle('alice')).toBe(true)
    })

    it('returns false for non-trusted ID', () => {
      expect(provider.canHandle('eve')).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // verify
  // -----------------------------------------------------------------------
  describe('verify', () => {
    it('returns success+verified for trusted ID', async () => {
      const result = await provider.verify({ target: 'alice' })
      expect(result.success).toBe(true)
      expect(result.identity).toBeDefined()
      expect(result.identity!.verified).toBe(true)
      expect(result.identity!.id).toBe('alice')
      expect(result.identity!.providerType).toBe('manual')
    })

    it('returns failure for non-trusted ID', async () => {
      const result = await provider.verify({ target: 'eve' })
      expect(result.success).toBe(false)
      expect(result.error).toContain('not in trusted list')
    })

    it('includes verifiedAt timestamp', async () => {
      const before = new Date()
      const result = await provider.verify({ target: 'alice' })
      const after = new Date()
      expect(result.identity!.verifiedAt).toBeInstanceOf(Date)
      expect(result.identity!.verifiedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(result.identity!.verifiedAt!.getTime()).toBeLessThanOrEqual(after.getTime())
    })

    it('includes trust claims', async () => {
      const result = await provider.verify({ target: 'bob' })
      expect(result.identity!.claims).toBeDefined()
      expect(result.identity!.claims!.trustSource).toBe('manual')
      expect(result.identity!.claims!.explicitlyTrusted).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // addTrusted / removeTrusted
  // -----------------------------------------------------------------------
  describe('addTrusted / removeTrusted', () => {
    it('addTrusted makes a new ID verifiable', async () => {
      expect(provider.canHandle('charlie')).toBe(false)
      provider.addTrusted('charlie')
      expect(provider.canHandle('charlie')).toBe(true)

      const result = await provider.verify({ target: 'charlie' })
      expect(result.success).toBe(true)
    })

    it('removeTrusted revokes trust', async () => {
      expect(provider.canHandle('alice')).toBe(true)
      provider.removeTrusted('alice')
      expect(provider.canHandle('alice')).toBe(false)

      const result = await provider.verify({ target: 'alice' })
      expect(result.success).toBe(false)
    })

    it('addTrusted is idempotent', () => {
      provider.addTrusted('alice') // already trusted
      expect(provider.canHandle('alice')).toBe(true)
    })

    it('removeTrusted on non-existent ID does not throw', () => {
      expect(() => provider.removeTrusted('nonexistent')).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // Provider metadata
  // -----------------------------------------------------------------------
  describe('metadata', () => {
    it('has type "manual"', () => {
      expect(provider.type).toBe('manual')
    })

    it('config includes initialTrustedCount', () => {
      expect(provider.config.initialTrustedCount).toBe(2)
    })
  })
})
