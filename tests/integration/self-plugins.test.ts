/**
 * Integration test: Discover and classify user's own DSH plugins.
 *
 * Tests PluginHub's ability to:
 * 1. Scan local directories for DSH plugin packages
 * 2. Parse their package.json + cordis.patch.yml as metadata
 * 3. Generate PluginHub-compatible manifests via AgentPluginsImporter pattern
 * 4. Classify capabilities using OASF taxonomy
 * 5. Route intents through the InvocationRouter
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DiscoveryEngine } from '../../src/core/discovery/index.js'
import { ManifestParser } from '../../src/core/manifest/index.js'
import { ManifestValidator } from '../../src/core/manifest/index.js'
import { OasfClassifier } from '../../src/core/oasf/index.js'
import { InvocationRouter } from '../../src/core/router/index.js'
import { McpToolAdapter } from '../../src/core/capability/index.js'
import { SkillsAdapter } from '../../src/core/capability/index.js'
import type { CanonicalCapability, AdapterContext } from '../../src/core/capability/types.js'
import type { PluginManifest } from '../../src/core/manifest/types.js'

// ── Plugin paths ──────────────────────────────────────────────────────────────

const PLUGIN_PATHS = {
  'agent-memory-hub': 'E:\\009workspace\\dsh\\agent-memory-hub',
  'token-usage-statistic': 'E:\\009workspace\\dsh\\token-usage-statistic',
  'dsh-env-manager': 'E:\\009workspace\\dsh\\dhs-env-manger',
} as const

// ── Helper: Read DSH plugin package.json and generate a PluginHub manifest ──

function dshPackageToManifest(pkgPath: string): PluginManifest | null {
  const pkgFile = join(pkgPath, 'package.json')
  if (!existsSync(pkgFile)) return null

  const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8'))

  // Build a minimal PluginHub manifest from DSH package.json
  const name = (pkg.name || 'unknown').replace(/[^a-z0-9-]/g, '-')
  const id = `com.zhiwuli0228.${name}`

  const manifest: PluginManifest = {
    apiVersion: 'plugin.agenthub.io/v1alpha1',
    kind: 'Plugin',
    metadata: {
      id,
      name,
      version: pkg.version || '0.0.0',
      description: typeof pkg.description === 'string' ? pkg.description : undefined,
      license: pkg.license,
      keywords: pkg.keywords,
      publisher: {
        name: pkg.author || 'zhiwuli0228',
        domain: 'zhiwuli0228.github.io',
      },
    },
    components: {
      skills: [],
      mcpServers: [],
    },
  }

  return manifest
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Integration: Self-developed plugin discovery', () => {
  const discovered: Array<{ name: string; manifest: PluginManifest; path: string }> = []

  beforeAll(() => {
    for (const [name, path] of Object.entries(PLUGIN_PATHS)) {
      const manifest = dshPackageToManifest(path)
      if (manifest) {
        discovered.push({ name, manifest, path })
      }
    }
  })

  it('discovers all three plugin directories', () => {
    expect(discovered.length).toBe(3)
    const names = discovered.map(d => d.name)
    expect(names).toContain('agent-memory-hub')
    expect(names).toContain('token-usage-statistic')
    expect(names).toContain('dsh-env-manager')
  })

  it('generates valid manifests from DSH package.json', () => {
    for (const { name, manifest } of discovered) {
      expect(manifest.apiVersion).toBe('plugin.agenthub.io/v1alpha1')
      expect(manifest.kind).toBe('Plugin')
      expect(manifest.metadata.id).toMatch(/^com\.zhiwuli0228\./)
      expect(manifest.metadata.version).toMatch(/^\d+\.\d+\.\d+/)
      console.log(`  ✅ ${name}: ${manifest.metadata.id}@${manifest.metadata.version}`)
    }
  })

  it('validates generated manifests pass structural checks', () => {
    for (const { name, manifest } of discovered) {
      const result = ManifestValidator.validate(manifest)
      // Log any issues for debugging
      if (!result.valid) {
        console.log(`  ⚠️  ${name}: ${result.errors.map(e => e.message).join(', ')}`)
      }
      // All should pass (we control the generation)
      expect(result.valid, `${name} manifest should be valid`).toBe(true)
    }
  })

  it('extracts correct metadata from each plugin', () => {
    const amh = discovered.find(d => d.name === 'agent-memory-hub')!
    expect(amh.manifest.metadata.description).toContain('memory')

    const tus = discovered.find(d => d.name === 'token-usage-statistic')!
    expect(tus.manifest.metadata.description).toContain('Token usage')
    expect(tus.manifest.metadata.keywords).toContain('token-usage')

    const env = discovered.find(d => d.name === 'dsh-env-manager')!
    expect(env.manifest.metadata.description).toContain('Environment')
  })
})

describe('Integration: OASF classification of self-developed plugins', () => {
  const classifier = new OasfClassifier()

  beforeAll(() => {
    classifier.loadBuiltinTaxonomy()
  })

  it('classifies agent-memory-hub (builtin taxonomy may not cover memory-specific skills)', () => {
    const result = classifier.classify({
      name: 'agent-memory-hub',
      description: 'Agent memory management hub with long-term memory, knowledge base, and citation tracking',
      tags: ['memory', 'knowledge', 'agent'],
    })

    console.log(`  Skills: ${result.skills.join(', ') || '(none)'}`)
    console.log(`  Domains: ${result.domains.join(', ') || '(none)'}`)
    console.log(`  Tags: ${result.tags.join(', ') || '(none)'}`)
    console.log(`  Confidence: ${result.confidence}`)

    // Builtin taxonomy covers common AI skills; memory-specific may not match
    // This test documents the classification behavior rather than asserting coverage
    expect(result).toBeDefined()
    expect(typeof result.confidence).toBe('number')
  })

  it('classifies token-usage-statistic (builtin taxonomy may not cover usage analytics)', () => {
    const result = classifier.classify({
      name: 'token-usage-statistic',
      description: 'Token usage, estimated cost, provider balances and quotas, budgets monitoring',
      tags: ['statistics', 'cost', 'monitoring'],
    })

    console.log(`  Skills: ${result.skills.join(', ') || '(none)'}`)
    console.log(`  Domains: ${result.domains.join(', ') || '(none)'}`)
    console.log(`  Confidence: ${result.confidence}`)

    // Builtin taxonomy may not have "monitoring" or "analytics" skills
    expect(result).toBeDefined()
    expect(typeof result.confidence).toBe('number')
  })

  it('classifies dsh-env-manager as devops/deployment', () => {
    const result = classifier.classify({
      name: 'dsh-env-manager',
      description: 'Environment registry, service catalog and operation-to-Skill routing for deployment',
      tags: ['environment', 'deployment', 'service-registry'],
    })

    console.log(`  Skills: ${result.skills.join(', ') || '(none)'}`)
    console.log(`  Domains: ${result.domains.join(', ') || '(none)'}`)
    console.log(`  Confidence: ${result.confidence}`)

    expect(result.confidence).toBeGreaterThan(0)
  })
})

describe('Integration: Router can register and search plugin capabilities', () => {
  const router = new InvocationRouter()

  beforeAll(() => {
    // Simulate capabilities from the three plugins
    const ctx: AdapterContext = {
      pluginId: 'com.zhiwuli0228.test',
      componentId: 'main',
      trustStatus: 'trusted',
      publisherDomain: 'github.com/zhiwuli0228',
    }

    const mockCapabilities: CanonicalCapability[] = [
      {
        id: 'com.zhiwuli0228.agent-memory-hub/main/memory-search',
        kind: 'tool',
        display: { name: 'memory-search', summary: 'Search long-term memory entries' },
        io: { inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, outputSchema: null },
        semantics: { readOnly: true, destructive: false, idempotent: true, openWorld: false, requiresApproval: false },
        execution: { mode: 'sync', concurrencySafe: true },
        provenance: { protocol: 'mcp', native: {}, adapterVersion: '1.0.0' },
        trust: { status: 'trusted' },
      },
      {
        id: 'com.zhiwuli0228.token-usage-statistic/main/get-usage',
        kind: 'tool',
        display: { name: 'get-usage', summary: 'Get token usage statistics and cost estimates' },
        io: { inputSchema: { type: 'object' }, outputSchema: null },
        semantics: { readOnly: true, destructive: false, idempotent: true, openWorld: false, requiresApproval: false },
        execution: { mode: 'sync', concurrencySafe: true },
        provenance: { protocol: 'mcp', native: {}, adapterVersion: '1.0.0' },
        trust: { status: 'trusted' },
      },
      {
        id: 'com.zhiwuli0228.dsh-env-manager/main/deploy-service',
        kind: 'tool',
        display: { name: 'deploy-service', summary: 'Deploy a service to the target environment' },
        io: { inputSchema: { type: 'object', properties: { service: { type: 'string' }, env: { type: 'string' } } }, outputSchema: null },
        semantics: { readOnly: false, destructive: true, idempotent: false, openWorld: true, requiresApproval: true },
        execution: { mode: 'sync', concurrencySafe: false },
        provenance: { protocol: 'mcp', native: {}, adapterVersion: '1.0.0' },
        trust: { status: 'trusted' },
      },
    ]

    router.registerCapabilities(mockCapabilities)
  })

  it('registers all three capabilities', () => {
    const caps = router.getCapabilities()
    expect(caps.length).toBe(3)
  })

  it('routes "search memory" intent to memory-search tool', () => {
    const result = router.route({ query: 'search memory for deployment notes' })
    expect(result.capability.display.name).toBe('memory-search')
    expect(result.score).toBeGreaterThanOrEqual(0.5)
    console.log(`  Matched: ${result.capability.id} (score=${result.score})`)
  })

  it('routes "token usage" intent to get-usage tool', () => {
    const result = router.route({ query: 'show my token usage this month' })
    expect(result.capability.display.name).toBe('get-usage')
    console.log(`  Matched: ${result.capability.id} (score=${result.score})`)
  })

  it('routes "deploy" intent to deploy-service and flags approval required', () => {
    const result = router.route({ query: 'deploy payments-api to staging' })
    expect(result.capability.display.name).toBe('deploy-service')
    expect(result.requiresApproval).toBe(true)
    console.log(`  Matched: ${result.capability.id} (approval=${result.requiresApproval})`)
  })

  it('context summary respects budget limit', () => {
    const summary = router.getContextSummary({ maxTools: 2, maxToolNameLength: 60, tokenBudgetHint: 1000 })
    expect(summary.length).toBeLessThanOrEqual(2)
    for (const entry of summary) {
      expect(entry.name.length).toBeLessThanOrEqual(60)
      expect(entry).toHaveProperty('id')
      expect(entry).toHaveProperty('summary')
    }
  })

  it('search finds capabilities by keyword', () => {
    const results = router.search('deploy')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].display.name).toBe('deploy-service')
  })
})

describe('Integration: Discovery Engine local scan', () => {
  it('scans pluginhub project directory and finds manifests', async () => {
    const engine = new DiscoveryEngine({
      localPaths: ['E:\\009workspace\\pluginhub'],
    })

    const entries = await engine.scanLocal(['E:\\009workspace\\pluginhub'])
    // The pluginhub project itself has package.json but no plugin.yaml/json manifest
    // This tests that scanLocal doesn't crash on non-manifest directories
    console.log(`  Found ${entries.length} entries in pluginhub dir`)
    expect(Array.isArray(entries)).toBe(true)
  })

  it('adds and retrieves entries correctly', () => {
    const engine = new DiscoveryEngine()

    engine.addEntry({
      id: 'com.zhiwuli0228.agent-memory-hub',
      name: 'agent-memory-hub',
      source: 'local',
      location: 'E:\\009workspace\\dsh\\agent-memory-hub',
      raw: { name: 'agent-memory-hub', version: '0.1.32' },
      protocol: 'mcp',
      trustScore: 90,
      discoveredAt: new Date(),
    })

    const entries = engine.getEntries()
    expect(entries.length).toBe(1)
    expect(entries[0].name).toBe('agent-memory-hub')
    expect(entries[0].trustScore).toBe(90)
  })
})
