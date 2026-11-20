/**
 * Agent Skills progressive loader.
 *
 * Provides two-phase loading: lightweight summary for discovery,
 * full content on demand when a skill matches a task.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { SkillSummary, SkillFull, SkillFrontmatter } from './types.js'

/** Name validation pattern: lowercase alphanumeric + hyphens, 1-64 chars */
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*[a-z0-9]$/

/** Maximum allowed skill name length */
const MAX_NAME_LENGTH = 64

/** SKILL.md filename constant */
const SKILL_FILENAME = 'SKILL.md'

/**
 * Parse YAML frontmatter and body from SKILL.md content.
 *
 * Frontmatter is delimited by `---` markers at the start of the file.
 * Everything after the closing `---` is the Markdown body.
 *
 * @param content - Raw SKILL.md file content
 * @returns Parsed frontmatter object and body string
 * @throws Error if frontmatter delimiters are missing or malformed
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const trimmed = content.trimStart()

  if (!trimmed.startsWith('---')) {
    throw new Error('SKILL.md must start with --- frontmatter delimiter')
  }

  // Find the closing delimiter (skip the opening one)
  const endIndex = trimmed.indexOf('---', 3)
  if (endIndex === -1) {
    throw new Error('SKILL.md missing closing --- frontmatter delimiter')
  }

  const yamlContent = trimmed.slice(3, endIndex).trim()
  const body = trimmed.slice(endIndex + 3).trimStart()

  let parsed: unknown
  try {
    parsed = parseYaml(yamlContent)
  } catch (err) {
    throw new Error(`Failed to parse SKILL.md frontmatter YAML: ${(err as Error).message}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('SKILL.md frontmatter must be a YAML mapping')
  }

  const fm = parsed as Record<string, unknown>

  // Validate required fields
  if (typeof fm.name !== 'string' || fm.name.length === 0) {
    throw new Error('SKILL.md frontmatter missing required "name" field')
  }
  if (typeof fm.description !== 'string' || fm.description.length === 0) {
    throw new Error('SKILL.md frontmatter missing required "description" field')
  }

  return {
    frontmatter: {
      name: fm.name,
      description: fm.description,
      license: typeof fm.license === 'string' ? fm.license : undefined,
      compatibility: typeof fm.compatibility === 'string' ? fm.compatibility : undefined,
      metadata: fm.metadata && typeof fm.metadata === 'object'
        ? fm.metadata as Record<string, string>
        : undefined,
      'allowed-tools': typeof fm['allowed-tools'] === 'string' ? fm['allowed-tools'] : undefined,
    },
    body,
  }
}

/**
 * Parse space-separated allowed-tools string into an array.
 *
 * @param raw - Space-separated tool names from frontmatter
 * @returns Array of trimmed, non-empty tool names
 */
function parseAllowedTools(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const tools = raw.split(/\s+/).filter(Boolean)
  return tools.length > 0 ? tools : undefined
}

/**
 * Progressive skill loader with two-phase loading strategy.
 *
 * - Phase 1 (loadSummary): Read only frontmatter for discovery (~100 tokens)
 * - Phase 2 (loadFull): Read complete content when skill matches a task
 */
export class SkillLoader {
  /**
   * Load only name + description from a skill directory.
   *
   * Reads SKILL.md frontmatter only, does NOT read the body.
   * This keeps startup memory and I/O minimal.
   *
   * @param skillDir - Absolute path to the skill directory
   * @returns Minimal skill summary for catalog display
   * @throws Error if SKILL.md is missing or frontmatter is invalid
   */
  static async loadSummary(skillDir: string): Promise<SkillSummary> {
    const skillPath = join(skillDir, SKILL_FILENAME)

    let content: string
    try {
      content = await readFile(skillPath, 'utf-8')
    } catch (err) {
      throw new Error(`Cannot read ${skillPath}: ${(err as Error).message}`)
    }

    const { frontmatter } = parseFrontmatter(content)
    const dirName = basename(skillDir)

    const validation = SkillLoader.validateSkillName(frontmatter.name, dirName)
    if (!validation.valid) {
      throw new Error(`Invalid skill in ${skillDir}: ${validation.error}`)
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      directoryPath: skillDir,
    }
  }

  /**
   * Load full skill content including Markdown body.
   *
   * Called on demand when the skill is matched to a task.
   * Parses all frontmatter fields and returns the complete body.
   *
   * @param skillDir - Absolute path to the skill directory
   * @returns Complete skill data with body and all metadata
   * @throws Error if SKILL.md is missing or frontmatter is invalid
   */
  static async loadFull(skillDir: string): Promise<SkillFull> {
    const skillPath = join(skillDir, SKILL_FILENAME)

    let content: string
    try {
      content = await readFile(skillPath, 'utf-8')
    } catch (err) {
      throw new Error(`Cannot read ${skillPath}: ${(err as Error).message}`)
    }

    const { frontmatter, body } = parseFrontmatter(content)
    const dirName = basename(skillDir)

    const validation = SkillLoader.validateSkillName(frontmatter.name, dirName)
    if (!validation.valid) {
      throw new Error(`Invalid skill in ${skillDir}: ${validation.error}`)
    }

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      directoryPath: skillDir,
      body,
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      metadata: frontmatter.metadata,
      allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
    }
  }

  /**
   * Scan a directory for skill subdirectories.
   *
   * Each direct child directory containing a SKILL.md file is treated
   * as a skill. Returns summaries sorted alphabetically by name.
   *
   * @param parentDir - Directory to scan for skill subdirectories
   * @returns Array of skill summaries found in the directory
   * @throws Error if parentDir cannot be read
   */
  static async scanSkillsDirectory(parentDir: string): Promise<SkillSummary[]> {
    let entries: string[]
    try {
      entries = await readdir(parentDir)
    } catch (err) {
      throw new Error(`Cannot read skills directory ${parentDir}: ${(err as Error).message}`)
    }

    const summaries: SkillSummary[] = []
    const errors: string[] = []

    for (const entry of entries) {
      const childPath = join(parentDir, entry)

      // Check if it's a directory
      let stats: import('node:fs').Stats
      try {
        stats = await stat(childPath)
      } catch {
        continue // Skip entries we can't stat
      }

      if (!stats.isDirectory()) continue

      // Check for SKILL.md
      const skillPath = join(childPath, SKILL_FILENAME)
      try {
        await stat(skillPath)
      } catch {
        continue // No SKILL.md, not a skill directory
      }

      try {
        const summary = await SkillLoader.loadSummary(childPath)
        summaries.push(summary)
      } catch (err) {
        errors.push(`${entry}: ${(err as Error).message}`)
      }
    }

    if (errors.length > 0) {
      console.warn(`Skill scan warnings in ${parentDir}:\n${errors.join('\n')}`)
    }

    // Sort by name for deterministic ordering
    summaries.sort((a, b) => a.name.localeCompare(b.name))

    return summaries
  }

  /**
   * Validate skill name format against directory name.
   *
   * Rules:
   * - 1-64 characters
   * - Lowercase alphanumeric and hyphens only
   * - Must start with a letter
   * - Must end with a letter or digit
   * - Must exactly match the parent directory name
   *
   * @param name - Skill name from frontmatter
   * @param dirName - Parent directory basename
   * @returns Validation result with optional error message
   */
  static validateSkillName(name: string, dirName: string): { valid: boolean; error?: string } {
    if (!name || name.length === 0) {
      return { valid: false, error: 'Skill name cannot be empty' }
    }

    if (name.length > MAX_NAME_LENGTH) {
      return { valid: false, error: `Skill name exceeds ${MAX_NAME_LENGTH} characters (got ${name.length})` }
    }

    if (!SKILL_NAME_PATTERN.test(name)) {
      return {
        valid: false,
        error: `Skill name "${name}" must be lowercase alphanumeric with hyphens, start with a letter, and end with a letter or digit`,
      }
    }

    if (name !== dirName) {
      return {
        valid: false,
        error: `Skill name "${name}" does not match directory name "${dirName}"`,
      }
    }

    return { valid: true }
  }
}
