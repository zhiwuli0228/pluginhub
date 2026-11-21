/**
 * OASF Taxonomy Classifier.
 *
 * Classifies capabilities against the OASF taxonomy for enhanced routing.
 * Uses keyword matching against skill/domain descriptions and tags.
 *
 * @module
 */

import type {
  ClassificationResult,
  OasfDomain,
  OasfModule,
  OasfSkill,
  OasfTaxonomy,
} from './types.js'

/** Search result entry returned by {@link OasfClassifier.search} */
export interface SearchResult {
  type: 'skill' | 'domain' | 'module'
  id: string
  name: string
  score: number
}

/** Input capability to classify */
export interface ClassifyInput {
  name: string
  description?: string
  examples?: string[]
  tags?: string[]
}

/**
 * Build a minimal built-in taxonomy covering common AI agent capabilities.
 *
 * Domains: software-engineering, data-analysis, communication, devops, security
 * Skills: code-generation, code-review, testing, documentation, deployment,
 *         monitoring, chat, email, search, translation
 * Modules: 2-3 typical modules per skill
 */
function buildBuiltinTaxonomy(): OasfTaxonomy {
  const domains: OasfDomain[] = [
    {
      id: 'software-engineering',
      name: 'Software Engineering',
      description: 'Skills related to writing, reviewing, testing, and documenting software code',
      skills: ['code-generation', 'code-review', 'testing', 'documentation'],
    },
    {
      id: 'data-analysis',
      name: 'Data Analysis',
      description: 'Skills for searching, transforming, and analyzing structured and unstructured data',
      skills: ['search'],
    },
    {
      id: 'communication',
      name: 'Communication',
      description: 'Skills for conversational interaction, messaging, and language translation',
      skills: ['chat', 'email', 'translation'],
    },
    {
      id: 'devops',
      name: 'DevOps',
      description: 'Skills for deploying, monitoring, and operating software systems',
      skills: ['deployment', 'monitoring'],
    },
    {
      id: 'security',
      name: 'Security',
      description: 'Skills for auditing, scanning, and enforcing security policies',
      skills: [],
    },
  ]

  const skills: OasfSkill[] = [
    {
      id: 'code-generation',
      name: 'Code Generation',
      description: 'Generate source code from natural language descriptions, templates, or specifications',
      domainId: 'software-engineering',
      modules: ['boilerplate-gen', 'api-stub-gen', 'refactor-suggest'],
      tags: ['code', 'generate', 'programming', 'source', 'template', 'boilerplate'],
    },
    {
      id: 'code-review',
      name: 'Code Review',
      description: 'Review source code for quality, style, bugs, and best practices',
      domainId: 'software-engineering',
      modules: ['lint-check', 'style-enforce', 'bug-detect'],
      tags: ['review', 'quality', 'lint', 'style', 'best-practices'],
    },
    {
      id: 'testing',
      name: 'Testing',
      description: 'Create and run unit tests, integration tests, and test plans',
      domainId: 'software-engineering',
      modules: ['unit-test-gen', 'integration-test', 'coverage-report'],
      tags: ['test', 'unittest', 'integration', 'coverage', 'qa'],
    },
    {
      id: 'documentation',
      name: 'Documentation',
      description: 'Generate API docs, README files, inline comments, and technical guides',
      domainId: 'software-engineering',
      modules: ['api-doc-gen', 'readme-gen', 'changelog-gen'],
      tags: ['docs', 'documentation', 'readme', 'api-docs', 'changelog'],
    },
    {
      id: 'deployment',
      name: 'Deployment',
      description: 'Deploy applications to cloud, containers, or serverless environments',
      domainId: 'devops',
      modules: ['container-deploy', 'ci-cd-pipeline', 'infra-provision'],
      tags: ['deploy', 'ci-cd', 'docker', 'kubernetes', 'cloud', 'serverless'],
    },
    {
      id: 'monitoring',
      name: 'Monitoring',
      description: 'Monitor system health, logs, metrics, and alerting',
      domainId: 'devops',
      modules: ['log-analysis', 'metric-dashboard', 'alert-config'],
      tags: ['monitor', 'observability', 'logs', 'metrics', 'alerting', 'health'],
    },
    {
      id: 'chat',
      name: 'Chat',
      description: 'Conversational AI for user-facing dialogue and assistance',
      domainId: 'communication',
      modules: ['intent-detect', 'response-gen', 'context-track'],
      tags: ['chat', 'conversation', 'dialogue', 'assistant', 'nlp'],
    },
    {
      id: 'email',
      name: 'Email',
      description: 'Compose, summarize, classify, and manage email messages',
      domainId: 'communication',
      modules: ['email-compose', 'email-summarize', 'email-classify'],
      tags: ['email', 'compose', 'inbox', 'message', 'summarize'],
    },
    {
      id: 'search',
      name: 'Search',
      description: 'Search across documents, databases, knowledge bases, and the web',
      domainId: 'data-analysis',
      modules: ['semantic-search', 'keyword-search', 'rag-retrieval'],
      tags: ['search', 'query', 'retrieval', 'rag', 'knowledge-base'],
    },
    {
      id: 'translation',
      name: 'Translation',
      description: 'Translate text between natural languages with context awareness',
      domainId: 'communication',
      modules: ['text-translate', 'localization', 'terminology-manage'],
      tags: ['translate', 'i18n', 'localization', 'language', 'multilingual'],
    },
  ]

  const modules: OasfModule[] = [
    // code-generation
    { id: 'boilerplate-gen', name: 'Boilerplate Generation', description: 'Generate project scaffolding and boilerplate code', skillId: 'code-generation', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'api-stub-gen', name: 'API Stub Generation', description: 'Generate API endpoint stubs from OpenAPI or protobuf specs', skillId: 'code-generation', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'refactor-suggest', name: 'Refactor Suggestion', description: 'Suggest code refactoring improvements', skillId: 'code-generation', inputTypes: ['string'], outputTypes: ['string'] },
    // code-review
    { id: 'lint-check', name: 'Lint Check', description: 'Run linting rules against source code', skillId: 'code-review', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'style-enforce', name: 'Style Enforcement', description: 'Enforce coding style conventions', skillId: 'code-review', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'bug-detect', name: 'Bug Detection', description: 'Detect potential bugs and anti-patterns', skillId: 'code-review', inputTypes: ['string'], outputTypes: ['string'] },
    // testing
    { id: 'unit-test-gen', name: 'Unit Test Generation', description: 'Generate unit tests for functions and methods', skillId: 'testing', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'integration-test', name: 'Integration Test', description: 'Create integration test suites', skillId: 'testing', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'coverage-report', name: 'Coverage Report', description: 'Analyze and report test coverage metrics', skillId: 'testing', inputTypes: ['string'], outputTypes: ['string'] },
    // documentation
    { id: 'api-doc-gen', name: 'API Doc Generation', description: 'Generate API reference documentation', skillId: 'documentation', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'readme-gen', name: 'README Generation', description: 'Generate project README files', skillId: 'documentation', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'changelog-gen', name: 'Changelog Generation', description: 'Generate changelogs from commit history', skillId: 'documentation', inputTypes: ['string'], outputTypes: ['string'] },
    // deployment
    { id: 'container-deploy', name: 'Container Deployment', description: 'Build and deploy containerized applications', skillId: 'deployment', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'ci-cd-pipeline', name: 'CI/CD Pipeline', description: 'Configure continuous integration and delivery pipelines', skillId: 'deployment', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'infra-provision', name: 'Infrastructure Provisioning', description: 'Provision cloud infrastructure via IaC', skillId: 'deployment', inputTypes: ['string'], outputTypes: ['string'] },
    // monitoring
    { id: 'log-analysis', name: 'Log Analysis', description: 'Parse and analyze application logs', skillId: 'monitoring', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'metric-dashboard', name: 'Metric Dashboard', description: 'Build dashboards from system metrics', skillId: 'monitoring', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'alert-config', name: 'Alert Configuration', description: 'Configure alerting rules and thresholds', skillId: 'monitoring', inputTypes: ['string'], outputTypes: ['string'] },
    // chat
    { id: 'intent-detect', name: 'Intent Detection', description: 'Detect user intent from natural language input', skillId: 'chat', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'response-gen', name: 'Response Generation', description: 'Generate contextual responses in conversations', skillId: 'chat', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'context-track', name: 'Context Tracking', description: 'Track conversation context across turns', skillId: 'chat', inputTypes: ['string'], outputTypes: ['string'] },
    // email
    { id: 'email-compose', name: 'Email Composition', description: 'Draft emails from prompts or templates', skillId: 'email', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'email-summarize', name: 'Email Summarization', description: 'Summarize email threads and content', skillId: 'email', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'email-classify', name: 'Email Classification', description: 'Classify emails by priority, category, or action needed', skillId: 'email', inputTypes: ['string'], outputTypes: ['string'] },
    // search
    { id: 'semantic-search', name: 'Semantic Search', description: 'Vector-based semantic similarity search', skillId: 'search', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'keyword-search', name: 'Keyword Search', description: 'Traditional keyword-based full-text search', skillId: 'search', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'rag-retrieval', name: 'RAG Retrieval', description: 'Retrieval-augmented generation context retrieval', skillId: 'search', inputTypes: ['string'], outputTypes: ['string'] },
    // translation
    { id: 'text-translate', name: 'Text Translation', description: 'Translate text between language pairs', skillId: 'translation', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'localization', name: 'Localization', description: 'Localize content for specific regions and cultures', skillId: 'translation', inputTypes: ['string'], outputTypes: ['string'] },
    { id: 'terminology-manage', name: 'Terminology Management', description: 'Manage glossaries and terminology databases', skillId: 'translation', inputTypes: ['string'], outputTypes: ['string'] },
  ]

  return { version: '1.0.0-builtin', domains, skills, modules }
}

/**
 * Normalize a string to lowercase tokens for matching.
 * Splits on non-alphanumeric characters and filters empty tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0)
}

/**
 * Compute how many tokens from `queryTokens` appear in `targetTokens`.
 * Returns a ratio 0-1 of matched query tokens.
 */
function tokenOverlap(queryTokens: string[], targetTokens: string[]): number {
  if (queryTokens.length === 0) return 0
  const targetSet = new Set(targetTokens)
  let matched = 0
  for (const t of queryTokens) {
    if (targetSet.has(t)) matched++
  }
  return matched / queryTokens.length
}

/**
 * OASF Taxonomy Classifier.
 *
 * Classifies capabilities against the OASF taxonomy for enhanced semantic
 * routing and capability retrieval. Uses keyword matching against
 * skill/domain descriptions and tags.
 */
export class OasfClassifier {
  private taxonomy: OasfTaxonomy | null = null

  /** Load taxonomy from a JSON object */
  loadTaxonomy(taxonomy: OasfTaxonomy): void {
    this.taxonomy = taxonomy
  }

  /** Load a minimal built-in taxonomy covering common AI agent skills */
  loadBuiltinTaxonomy(): void {
    this.taxonomy = buildBuiltinTaxonomy()
  }

  /**
   * Classify a capability by its name, description, examples, and tags.
   *
   * Matching strategy (highest confidence wins per entity):
   * - Exact tag match → confidence 1.0
   * - Name contains skill/module/domain name → confidence 0.8
   * - Description contains keywords → confidence 0.6
   * - Example matches → confidence 0.5
   *
   * Returns all matches with confidence > 0.3.
   */
  classify(capability: ClassifyInput): ClassificationResult {
    if (!this.taxonomy) {
      return { skills: [], domains: [], modules: [], confidence: 0, tags: [] }
    }

    const capNameTokens = tokenize(capability.name)
    const capDescTokens = capability.description ? tokenize(capability.description) : []
    const capExampleTokens = (capability.examples ?? []).flatMap((e) => tokenize(e))
    const capTags = (capability.tags ?? []).map((t) => t.toLowerCase())

    const matchedSkills = new Map<string, number>()
    const matchedDomains = new Map<string, number>()
    const matchedModules = new Map<string, number>()
    const collectedTags = new Set<string>()

    // --- Match against skills ---
    for (const skill of this.taxonomy.skills) {
      let bestScore = 0
      const skillNameTokens = tokenize(skill.name)
      const skillIdTokens = tokenize(skill.id)
      const skillTagSet = new Set((skill.tags ?? []).map((t) => t.toLowerCase()))

      // Tag exact match → 1.0
      for (const ct of capTags) {
        if (skillTagSet.has(ct)) {
          bestScore = Math.max(bestScore, 1.0)
          break
        }
      }

      // Name contains skill name → 0.8
      if (bestScore < 0.8) {
        const nameLower = capability.name.toLowerCase()
        if (nameLower.includes(skill.id) || nameLower.includes(skill.name.toLowerCase())) {
          bestScore = Math.max(bestScore, 0.8)
        } else {
          const overlap = tokenOverlap(capNameTokens, [...skillNameTokens, ...skillIdTokens])
          if (overlap >= 0.5) bestScore = Math.max(bestScore, 0.8 * overlap)
        }
      }

      // Description keyword match → 0.6
      if (bestScore < 0.6 && capDescTokens.length > 0 && skill.description) {
        const skillDescTokens = tokenize(skill.description)
        const overlap = tokenOverlap(capDescTokens, skillDescTokens)
        if (overlap > 0) bestScore = Math.max(bestScore, 0.6 * overlap)
      }

      // Example match → 0.5
      if (bestScore < 0.5 && capExampleTokens.length > 0) {
        const allSkillTokens = [
          ...skillNameTokens,
          ...skillIdTokens,
          ...(skill.description ? tokenize(skill.description) : []),
          ...(skill.tags ?? []).map((t) => t.toLowerCase()),
        ]
        const overlap = tokenOverlap(capExampleTokens, allSkillTokens)
        if (overlap > 0) bestScore = Math.max(bestScore, 0.5 * overlap)
      }

      if (bestScore > 0.3) {
        matchedSkills.set(skill.id, bestScore)
        for (const t of skill.tags ?? []) collectedTags.add(t)
      }
    }

    // --- Match against domains ---
    for (const domain of this.taxonomy.domains) {
      let bestScore = 0
      const domainNameTokens = tokenize(domain.name)
      const domainIdTokens = tokenize(domain.id)

      // Tag exact match → 1.0
      for (const ct of capTags) {
        if (ct === domain.id || domain.name.toLowerCase().includes(ct)) {
          bestScore = Math.max(bestScore, 1.0)
          break
        }
      }

      // Name contains domain name → 0.8
      if (bestScore < 0.8) {
        const nameLower = capability.name.toLowerCase()
        if (nameLower.includes(domain.id) || nameLower.includes(domain.name.toLowerCase())) {
          bestScore = Math.max(bestScore, 0.8)
        } else {
          const overlap = tokenOverlap(capNameTokens, [...domainNameTokens, ...domainIdTokens])
          if (overlap >= 0.5) bestScore = Math.max(bestScore, 0.8 * overlap)
        }
      }

      // Description keyword match → 0.6
      if (bestScore < 0.6 && capDescTokens.length > 0 && domain.description) {
        const domainDescTokens = tokenize(domain.description)
        const overlap = tokenOverlap(capDescTokens, domainDescTokens)
        if (overlap > 0) bestScore = Math.max(bestScore, 0.6 * overlap)
      }

      if (bestScore > 0.3) {
        matchedDomains.set(domain.id, bestScore)
      }
    }

    // --- Match against modules ---
    for (const mod of this.taxonomy.modules) {
      let bestScore = 0
      const modNameTokens = tokenize(mod.name)
      const modIdTokens = tokenize(mod.id)

      // Tag exact match → 1.0
      for (const ct of capTags) {
        if (ct === mod.id || mod.name.toLowerCase().includes(ct)) {
          bestScore = Math.max(bestScore, 1.0)
          break
        }
      }

      // Name contains module name → 0.8
      if (bestScore < 0.8) {
        const nameLower = capability.name.toLowerCase()
        if (nameLower.includes(mod.id) || nameLower.includes(mod.name.toLowerCase())) {
          bestScore = Math.max(bestScore, 0.8)
        } else {
          const overlap = tokenOverlap(capNameTokens, [...modNameTokens, ...modIdTokens])
          if (overlap >= 0.5) bestScore = Math.max(bestScore, 0.8 * overlap)
        }
      }

      // Description keyword match → 0.6
      if (bestScore < 0.6 && capDescTokens.length > 0 && mod.description) {
        const modDescTokens = tokenize(mod.description)
        const overlap = tokenOverlap(capDescTokens, modDescTokens)
        if (overlap > 0) bestScore = Math.max(bestScore, 0.6 * overlap)
      }

      // Example match → 0.5
      if (bestScore < 0.5 && capExampleTokens.length > 0) {
        const allModTokens = [
          ...modNameTokens,
          ...modIdTokens,
          ...(mod.description ? tokenize(mod.description) : []),
        ]
        const overlap = tokenOverlap(capExampleTokens, allModTokens)
        if (overlap > 0) bestScore = Math.max(bestScore, 0.5 * overlap)
      }

      if (bestScore > 0.3) {
        matchedModules.set(mod.id, bestScore)
      }
    }

    // Compute overall confidence as max across all matches
    const allScores = [
      ...matchedSkills.values(),
      ...matchedDomains.values(),
      ...matchedModules.values(),
    ]
    const confidence = allScores.length > 0 ? Math.max(...allScores) : 0

    return {
      skills: [...matchedSkills.keys()],
      domains: [...matchedDomains.keys()],
      modules: [...matchedModules.keys()],
      confidence,
      tags: [...collectedTags],
    }
  }

  /**
   * Search taxonomy by query string.
   *
   * Searches across all domains, skills, and modules. Results are sorted
   * by relevance score descending.
   *
   * @param query - Free-text search query
   * @param limit - Maximum results to return (default 10)
   */
  search(query: string, limit: number = 10): SearchResult[] {
    if (!this.taxonomy) return []

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []

    const results: SearchResult[] = []

    // Score domains
    for (const domain of this.taxonomy.domains) {
      const score = this.scoreEntity(queryTokens, domain.id, domain.name, domain.description)
      if (score > 0) results.push({ type: 'domain', id: domain.id, name: domain.name, score })
    }

    // Score skills
    for (const skill of this.taxonomy.skills) {
      const extraTokens = (skill.tags ?? []).map((t) => t.toLowerCase())
      const score = this.scoreEntity(queryTokens, skill.id, skill.name, skill.description, extraTokens)
      if (score > 0) results.push({ type: 'skill', id: skill.id, name: skill.name, score })
    }

    // Score modules
    for (const mod of this.taxonomy.modules) {
      const score = this.scoreEntity(queryTokens, mod.id, mod.name, mod.description)
      if (score > 0) results.push({ type: 'module', id: mod.id, name: mod.name, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  /** Get full taxonomy, or null if not loaded */
  getTaxonomy(): OasfTaxonomy | null {
    return this.taxonomy
  }

  /** Check if taxonomy is loaded */
  get isLoaded(): boolean {
    return this.taxonomy !== null
  }

  /**
   * Score an entity against query tokens.
   *
   * Scoring weights:
   * - ID exact match: 1.0
   * - Name exact match: 0.9
   * - Name token overlap: 0.7 * overlap_ratio
   * - Description token overlap: 0.4 * overlap_ratio
   * - Extra tokens overlap: 0.5 * overlap_ratio
   */
  private scoreEntity(
    queryTokens: string[],
    id: string,
    name: string,
    description?: string,
    extraTokens?: string[],
  ): number {
    const idLower = id.toLowerCase()
    const nameLower = name.toLowerCase()
    const queryStr = queryTokens.join(' ')

    // Exact ID match
    if (idLower === queryStr || idLower.replace(/-/g, ' ') === queryStr) return 1.0

    // Exact name match
    if (nameLower === queryStr) return 0.9

    let bestScore = 0

    // Name token overlap
    const nameTokens = tokenize(name)
    const nameOverlap = tokenOverlap(queryTokens, nameTokens)
    if (nameOverlap > 0) bestScore = Math.max(bestScore, 0.7 * nameOverlap)

    // ID token overlap
    const idTokens = tokenize(id)
    const idOverlap = tokenOverlap(queryTokens, idTokens)
    if (idOverlap > 0) bestScore = Math.max(bestScore, 0.6 * idOverlap)

    // Description token overlap
    if (description) {
      const descTokens = tokenize(description)
      const descOverlap = tokenOverlap(queryTokens, descTokens)
      if (descOverlap > 0) bestScore = Math.max(bestScore, 0.4 * descOverlap)
    }

    // Extra tokens (tags) overlap
    if (extraTokens && extraTokens.length > 0) {
      const extraOverlap = tokenOverlap(queryTokens, extraTokens)
      if (extraOverlap > 0) bestScore = Math.max(bestScore, 0.5 * extraOverlap)
    }

    return bestScore
  }
}
