/**
 * OASF (Open Agentic Schema Framework) taxonomy type definitions.
 *
 * OASF is AGNTCY's agent documentation schema providing a hierarchical
 * taxonomy of skills, domains, and modules for capability classification.
 *
 * @module
 */

/** OASF skill classification node */
export interface OasfSkill {
  /** Unique skill identifier (e.g., "code-generation") */
  id: string
  /** Human-readable name */
  name: string
  /** Description of what this skill encompasses */
  description?: string
  /** Parent domain ID */
  domainId?: string
  /** Child module IDs */
  modules?: string[]
  /** Tags for search/filtering */
  tags?: string[]
}

/** OASF domain (category of skills) */
export interface OasfDomain {
  /** Domain identifier (e.g., "software-engineering") */
  id: string
  /** Human-readable name */
  name: string
  /** Description */
  description?: string
  /** Skill IDs belonging to this domain */
  skills?: string[]
  /** Sub-domain IDs */
  subDomains?: string[]
}

/** OASF module (specific capability within a skill) */
export interface OasfModule {
  /** Module identifier */
  id: string
  /** Name */
  name: string
  /** Description */
  description?: string
  /** Parent skill ID */
  skillId: string
  /** Input/output types */
  inputTypes?: string[]
  outputTypes?: string[]
}

/** Complete OASF taxonomy */
export interface OasfTaxonomy {
  version: string
  domains: OasfDomain[]
  skills: OasfSkill[]
  modules: OasfModule[]
}

/** Classification result for a capability */
export interface ClassificationResult {
  /** Matched skill IDs */
  skills: string[]
  /** Matched domain IDs */
  domains: string[]
  /** Matched module IDs */
  modules: string[]
  /** Confidence score (0-1) */
  confidence: number
  /** Tags aggregated from all matches */
  tags: string[]
}
