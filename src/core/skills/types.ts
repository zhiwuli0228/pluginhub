/**
 * Type definitions for Agent Skills progressive loader.
 *
 * Skills are directories containing a SKILL.md file with YAML frontmatter
 * and Markdown body. Progressive disclosure loads only summary info at
 * startup (~100 tokens), deferring full content until task match.
 */

/** Minimal skill info loaded during discovery (~100 tokens) */
export interface SkillSummary {
  /** Unique skill identifier, must match parent directory name */
  name: string
  /** Short description for task matching */
  description: string
  /** Absolute path to the skill directory */
  directoryPath: string
}

/** Full skill content loaded on demand when matched to a task */
export interface SkillFull extends SkillSummary {
  /** Markdown body after frontmatter */
  body: string
  /** License identifier (e.g., MIT, Apache-2.0) */
  license?: string
  /** Runtime requirements or compatibility notes */
  compatibility?: string
  /** Arbitrary key-value metadata */
  metadata?: Record<string, string>
  /** Tool names allowed for this skill (parsed from space-separated string) */
  allowedTools?: string[]
}

/**
 * Parsed YAML frontmatter from SKILL.md.
 * Field names use kebab-case as they appear in YAML.
 */
export interface SkillFrontmatter {
  name: string
  description: string
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  'allowed-tools'?: string
}
