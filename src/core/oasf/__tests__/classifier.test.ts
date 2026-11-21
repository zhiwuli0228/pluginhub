import { describe, it, expect, beforeEach } from 'vitest'
import { OasfClassifier } from '../classifier.js'
import type { OasfTaxonomy } from '../types.js'

describe('OasfClassifier', () => {
  let classifier: OasfClassifier

  beforeEach(() => {
    classifier = new OasfClassifier()
  })

  // -----------------------------------------------------------------------
  // loadBuiltinTaxonomy / isLoaded
  // -----------------------------------------------------------------------
  describe('loadBuiltinTaxonomy', () => {
    it('sets isLoaded to true after loading', () => {
      expect(classifier.isLoaded).toBe(false)
      classifier.loadBuiltinTaxonomy()
      expect(classifier.isLoaded).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // getTaxonomy
  // -----------------------------------------------------------------------
  describe('getTaxonomy', () => {
    it('returns null before loading', () => {
      expect(classifier.getTaxonomy()).toBeNull()
    })

    it('returns valid taxonomy with domains, skills, and modules after loading', () => {
      classifier.loadBuiltinTaxonomy()
      const taxonomy = classifier.getTaxonomy()
      expect(taxonomy).not.toBeNull()
      expect(taxonomy!.domains.length).toBeGreaterThan(0)
      expect(taxonomy!.skills.length).toBeGreaterThan(0)
      expect(taxonomy!.modules.length).toBeGreaterThan(0)
    })

    it('taxonomy has a version string', () => {
      classifier.loadBuiltinTaxonomy()
      const taxonomy = classifier.getTaxonomy()!
      expect(typeof taxonomy.version).toBe('string')
      expect(taxonomy.version.length).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // classify
  // -----------------------------------------------------------------------
  describe('classify', () => {
    beforeEach(() => {
      classifier.loadBuiltinTaxonomy()
    })

    it('exact tag match returns confidence 1.0', () => {
      const result = classifier.classify({
        name: 'some-tool',
        tags: ['code'],
      })
      // 'code' is a tag of 'code-generation' skill → confidence should be 1.0
      expect(result.confidence).toBe(1.0)
      expect(result.skills).toContain('code-generation')
    })

    it('name match returns confidence >= 0.8', () => {
      const result = classifier.classify({
        name: 'Code Generation Tool',
      })
      expect(result.confidence).toBeGreaterThanOrEqual(0.8)
      expect(result.skills).toContain('code-generation')
    })

    it('no match returns empty skills/domains/modules and confidence 0', () => {
      const result = classifier.classify({
        name: 'xyzzy-quantum-flux',
        description: 'Something completely unrelated to any known domain',
      })
      expect(result.skills).toHaveLength(0)
      expect(result.domains).toHaveLength(0)
      expect(result.modules).toHaveLength(0)
      expect(result.confidence).toBe(0)
    })

    it('matches multiple skills for broad input', () => {
      const result = classifier.classify({
        name: 'code review and testing tool',
        tags: ['review', 'test'],
      })
      expect(result.skills.length).toBeGreaterThanOrEqual(2)
    })

    it('collects tags from matched skills', () => {
      const result = classifier.classify({
        name: 'deployment pipeline',
        tags: ['deploy'],
      })
      expect(result.tags.length).toBeGreaterThan(0)
    })

    it('classifies against domains', () => {
      const result = classifier.classify({
        name: 'Software Engineering Assistant',
      })
      expect(result.domains).toContain('software-engineering')
    })

    it('classifies against modules', () => {
      const result = classifier.classify({
        name: 'Unit Test Generation',
      })
      expect(result.modules).toContain('unit-test-gen')
    })
  })

  // -----------------------------------------------------------------------
  // classify without loaded taxonomy
  // -----------------------------------------------------------------------
  describe('classify without taxonomy', () => {
    it('returns empty results when taxonomy is not loaded', () => {
      const result = classifier.classify({
        name: 'Code Generation',
        tags: ['code'],
      })
      expect(result.skills).toHaveLength(0)
      expect(result.domains).toHaveLength(0)
      expect(result.modules).toHaveLength(0)
      expect(result.confidence).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // search
  // -----------------------------------------------------------------------
  describe('search', () => {
    beforeEach(() => {
      classifier.loadBuiltinTaxonomy()
    })

    it('returns sorted results by score descending', () => {
      const results = classifier.search('code generation')
      expect(results.length).toBeGreaterThan(0)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score)
      }
    })

    it('limit parameter restricts result count', () => {
      const results = classifier.search('code', 3)
      expect(results.length).toBeLessThanOrEqual(3)
    })

    it('returns empty array for empty query', () => {
      const results = classifier.search('')
      expect(results).toHaveLength(0)
    })

    it('returns empty array when taxonomy not loaded', () => {
      const fresh = new OasfClassifier()
      const results = fresh.search('code')
      expect(results).toHaveLength(0)
    })

    it('results have type, id, name, and score fields', () => {
      const results = classifier.search('deploy')
      expect(results.length).toBeGreaterThan(0)
      const first = results[0]
      expect(first).toHaveProperty('type')
      expect(first).toHaveProperty('id')
      expect(first).toHaveProperty('name')
      expect(first).toHaveProperty('score')
      expect(['skill', 'domain', 'module']).toContain(first.type)
    })

    it('finds skills by tag keywords', () => {
      const results = classifier.search('docker kubernetes')
      const ids = results.map((r) => r.id)
      expect(ids).toContain('deployment')
    })
  })

  // -----------------------------------------------------------------------
  // loadTaxonomy (custom)
  // -----------------------------------------------------------------------
  describe('loadTaxonomy (custom)', () => {
    it('loads a custom taxonomy and uses it for classification', () => {
      const customTaxonomy: OasfTaxonomy = {
        version: 'custom-1.0',
        domains: [
          { id: 'custom-domain', name: 'Custom Domain', description: 'A test domain', skills: ['custom-skill'] },
        ],
        skills: [
          {
            id: 'custom-skill',
            name: 'Custom Skill',
            description: 'A custom test skill',
            domainId: 'custom-domain',
            modules: ['custom-module'],
            tags: ['custom', 'test'],
          },
        ],
        modules: [
          { id: 'custom-module', name: 'Custom Module', description: 'A test module', skillId: 'custom-skill', inputTypes: ['string'], outputTypes: ['string'] },
        ],
      }

      classifier.loadTaxonomy(customTaxonomy)
      expect(classifier.isLoaded).toBe(true)

      const taxonomy = classifier.getTaxonomy()!
      expect(taxonomy.version).toBe('custom-1.0')
      expect(taxonomy.domains).toHaveLength(1)
      expect(taxonomy.skills).toHaveLength(1)
      expect(taxonomy.modules).toHaveLength(1)

      const result = classifier.classify({ name: 'Custom Skill Runner', tags: ['custom'] })
      expect(result.skills).toContain('custom-skill')
      expect(result.confidence).toBe(1.0)
    })

    it('replaces previously loaded taxonomy', () => {
      classifier.loadBuiltinTaxonomy()
      const builtinSkills = classifier.getTaxonomy()!.skills.length

      const minimal: OasfTaxonomy = {
        version: 'minimal',
        domains: [],
        skills: [{ id: 'only-skill', name: 'Only', description: 'The only skill', domainId: '', modules: [], tags: [] }],
        modules: [],
      }
      classifier.loadTaxonomy(minimal)
      expect(classifier.getTaxonomy()!.skills).toHaveLength(1)
      expect(classifier.getTaxonomy()!.skills.length).not.toBe(builtinSkills)
    })
  })
})
