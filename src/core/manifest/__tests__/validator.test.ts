import { describe, it, expect } from 'vitest'
import { ManifestValidator } from '../validator.js'
import type { PluginManifest } from '../types.js'

/** Helper: build a minimal valid manifest for testing. */
function validManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    apiVersion: 'plugin.agenthub.io/v1alpha1',
    kind: 'Plugin',
    metadata: {
      id: 'com.example.test-plugin',
      name: 'test-plugin',
      version: '1.0.0',
    },
    ...overrides,
  }
}

describe('ManifestValidator', () => {
  // ── Structural validation ──

  describe('validate (structural)', () => {
    it('passes for a valid minimal manifest', () => {
      const result = ManifestValidator.validate(validManifest())
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('reports error when apiVersion is missing', () => {
      const manifest = validManifest()
      delete (manifest as Record<string, unknown>).apiVersion
      const result = ManifestValidator.validate(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'MISSING_REQUIRED' && e.path.includes('apiVersion'))).toBe(true)
    })

    it('reports error when metadata.id is missing', () => {
      const manifest = validManifest()
      delete (manifest.metadata as Record<string, unknown>).id
      const result = ManifestValidator.validate(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.path === 'metadata.id' && e.code === 'MISSING_REQUIRED')).toBe(true)
    })

    it('reports error for invalid semver version', () => {
      const manifest = validManifest()
      manifest.metadata.version = 'not-a-semver'
      const result = ManifestValidator.validate(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.path === 'metadata.version' && e.code === 'INVALID_PATTERN')).toBe(true)
    })

    it('reports error for invalid metadata.id pattern (not reverse domain)', () => {
      const manifest = validManifest()
      manifest.metadata.id = 'INVALID'
      const result = ManifestValidator.validate(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.path === 'metadata.id' && e.code === 'INVALID_PATTERN')).toBe(true)
    })

    it('rejects extensions key not matching reverse-domain pattern', () => {
      const manifest = validManifest({
        extensions: {
          'invalid_key': { some: 'data' },
        },
      })
      const result = ManifestValidator.validate(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.path.includes('extensions') && e.code === 'INVALID_PATTERN')).toBe(true)
    })

    it('accepts valid reverse-domain extension keys', () => {
      const manifest = validManifest({
        extensions: {
          'com.example.custom': { some: 'data' },
        },
      })
      const result = ManifestValidator.validate(manifest)
      expect(result.valid).toBe(true)
    })
  })

  // ── Semantic validation ──

  describe('validateSemantics', () => {
    it('rejects HS256 signing algorithm', () => {
      const manifest = validManifest({
        trust: {
          signing: {
            algorithm: 'HS256' as any,
            keyId: 'key-1',
            signatureRef: './sig.pem',
          },
        },
      })
      const result = ManifestValidator.validateSemantics(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'FORBIDDEN_ALGORITHM')).toBe(true)
    })

    it('rejects destructive intent without requiresApproval', () => {
      const manifest = validManifest({
        components: {
          skills: [
            { id: 'my-skill', format: 'agent-skills/1.0', path: './skills/my-skill/SKILL.md' },
          ],
        },
        routing: {
          intents: [
            {
              id: 'delete-data',
              examples: ['delete all data', 'remove everything'],
              capabilityRefs: ['skill:my-skill'],
              mode: 'skill',
              destructive: true,
              requiresApproval: false,
            },
          ],
        },
      })
      const result = ManifestValidator.validateSemantics(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'DESTRUCTIVE_REQUIRES_APPROVAL')).toBe(true)
    })

    it('allows destructive intent with requiresApproval=true', () => {
      const manifest = validManifest({
        components: {
          skills: [
            { id: 'my-skill', format: 'agent-skills/1.0', path: './skills/my-skill/SKILL.md' },
          ],
        },
        routing: {
          intents: [
            {
              id: 'delete-data',
              examples: ['delete all data', 'remove everything'],
              capabilityRefs: ['skill:my-skill'],
              mode: 'skill',
              destructive: true,
              requiresApproval: true,
            },
          ],
        },
      })
      const result = ManifestValidator.validateSemantics(manifest)
      expect(result.valid).toBe(true)
    })

    it('detects dangling capabilityRefs in intents', () => {
      const manifest = validManifest({
        components: {
          skills: [
            { id: 'existing-skill', format: 'agent-skills/1.0', path: './skills/existing-skill/SKILL.md' },
          ],
        },
        routing: {
          intents: [
            {
              id: 'some-intent',
              examples: ['do something', 'run task'],
              capabilityRefs: ['skill:nonexistent-skill'],
              mode: 'skill',
            },
          ],
        },
      })
      const result = ManifestValidator.validateSemantics(manifest)
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'UNRESOLVABLE_CAPABILITY_REF')).toBe(true)
    })

    it('passes when capabilityRefs resolve correctly', () => {
      const manifest = validManifest({
        components: {
          skills: [
            { id: 'my-skill', format: 'agent-skills/1.0', path: './skills/my-skill/SKILL.md' },
          ],
        },
        routing: {
          intents: [
            {
              id: 'use-skill',
              examples: ['use my skill', 'invoke skill'],
              capabilityRefs: ['skill:my-skill'],
              mode: 'skill',
            },
          ],
        },
      })
      const result = ManifestValidator.validateSemantics(manifest)
      expect(result.valid).toBe(true)
    })
  })
})
