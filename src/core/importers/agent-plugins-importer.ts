/**
 * Agent Plugins 1.0 Importer
 * 
 * Converts Agent Plugins 1.0 format (plugin.json + skills/ + mcp.json)
 * into PluginHub Manifest format. This is the cross-client packaging
 * standard adopted by Amazon, Cursor, Microsoft, OpenAI, Vercel, and Google TSC.
 * 
 * @module agent-plugins-importer
 */

import { readdir, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  PluginManifest,
  SkillComponent,
  McpServerComponent,
} from '../manifest/types.js'

/**
 * Result of importing an Agent Plugins 1.0 package.
 */
export interface AgentPluginsImportResult {
  /** The converted PluginHub manifest */
  manifest: PluginManifest
  /** Number of skill directories discovered */
  skillsFound: number
  /** Number of MCP server configurations found (0 or 1) */
  mcpServersFound: number
  /** Non-fatal warnings encountered during import */
  warnings: string[]
}

/** Known top-level fields in Agent Plugins 1.0 plugin.json */
const KNOWN_PLUGIN_JSON_FIELDS = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'license',
  'keywords',
  'extensions',
])

/**
 * Importer for Agent Plugins 1.0 packages.
 * 
 * Provides static methods to detect, parse, and fully import
 * Agent Plugins 1.0 directories into PluginHub Manifest format.
 * 
 * @example
 * ```typescript
 * const result = await AgentPluginsImporter.import('/path/to/plugin')
 * console.log(result.manifest.metadata.name)
 * console.log(`Found ${result.skillsFound} skills`)
 * ```
 */
export class AgentPluginsImporter {
  /**
   * Import an Agent Plugins 1.0 directory into a PluginHub Manifest.
   * 
   * Reads plugin.json, scans the skills/ subdirectory for SKILL.md files,
   * checks for mcp.json, and produces a complete PluginManifest with
   * appropriate metadata, components, and warnings.
   * 
   * @param pluginDir - Absolute or relative path to the directory containing plugin.json
   * @returns Converted manifest plus import metadata (skills count, MCP count, warnings)
   * @throws Error if plugin.json is missing, unreadable, or lacks required fields ($schema, name)
   */
  static async import(pluginDir: string): Promise<AgentPluginsImportResult> {
    const warnings: string[] = []

    // 1. Read and validate plugin.json
    const pluginJsonPath = join(pluginDir, 'plugin.json')
    const pluginJson = await this.parsePluginJson(pluginJsonPath)

    const schema = pluginJson.$schema
    if (typeof schema !== 'string' || schema.length === 0) {
      throw new Error(
        `Invalid Agent Plugins package: plugin.json at "${pluginJsonPath}" is missing required "$schema" field.`
      )
    }

    const name = pluginJson.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `Invalid Agent Plugins package: plugin.json at "${pluginJsonPath}" is missing required "name" field.`
      )
    }

    // Warn about missing optional but expected fields
    if (!pluginJson.version) {
      warnings.push('plugin.json is missing "version" field; defaulting to "0.0.0".')
    }

    // Check for unknown top-level fields
    for (const key of Object.keys(pluginJson)) {
      if (!KNOWN_PLUGIN_JSON_FIELDS.has(key)) {
        warnings.push(`Unknown top-level field "${key}" in plugin.json; it will be ignored.`)
      }
    }

    // 2. Scan skills/ directory
    const skills = await this.scanSkillsDirectory(pluginDir, warnings)

    // 3. Check for mcp.json
    const mcpServers = await this.detectMcpConfig(pluginDir, warnings)

    // 4. Build the manifest
    const manifest: PluginManifest = {
      apiVersion: 'plugin.agenthub.io/v1alpha1',
      kind: 'Plugin',
      metadata: {
        id: `com.agent-plugins.${name}`,
        name: name,
        version: typeof pluginJson.version === 'string' ? pluginJson.version : '0.0.0',
        description: typeof pluginJson.description === 'string' ? pluginJson.description : undefined,
        license: typeof pluginJson.license === 'string' ? pluginJson.license : undefined,
        keywords: Array.isArray(pluginJson.keywords)
          ? pluginJson.keywords.filter((k): k is string => typeof k === 'string')
          : undefined,
      },
      components: {
        skills,
        mcpServers,
      },
    }

    return {
      manifest,
      skillsFound: skills.length,
      mcpServersFound: mcpServers.length,
      warnings,
    }
  }

  /**
   * Parse just the plugin.json file without scanning subdirectories.
   * 
   * Useful for quick inspection or validation without performing
   * a full import. Returns the raw parsed JSON object.
   * 
   * @param filePath - Path to the plugin.json file
   * @returns Parsed JSON content as a generic record
   * @throws Error if the file cannot be read or contains invalid JSON
   */
  static async parsePluginJson(filePath: string): Promise<Record<string, unknown>> {
    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      throw new Error(
        `Failed to read plugin.json at "${filePath}": ${err instanceof Error ? err.message : String(err)}`
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (err) {
      throw new Error(
        `Invalid JSON in plugin.json at "${filePath}": ${err instanceof Error ? err.message : String(err)}`
      )
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `plugin.json at "${filePath}" must contain a JSON object, got ${Array.isArray(parsed) ? 'array' : String(parsed)}.`
      )
    }

    return parsed as Record<string, unknown>
  }

  /**
   * Check if a directory looks like an Agent Plugins package.
   * 
   * Performs a lightweight check: verifies that plugin.json exists
   * and contains both required fields ($schema and name). Does not
   * perform full validation or scan subdirectories.
   * 
   * @param dirPath - Path to the directory to check
   * @returns true if the directory appears to be a valid Agent Plugins package
   */
  static async isAgentPluginsDir(dirPath: string): Promise<boolean> {
    const pluginJsonPath = join(dirPath, 'plugin.json')

    try {
      await access(pluginJsonPath)
    } catch {
      return false
    }

    try {
      const parsed = await this.parsePluginJson(pluginJsonPath)
      return (
        typeof parsed.$schema === 'string' &&
        parsed.$schema.length > 0 &&
        typeof parsed.name === 'string' &&
        parsed.name.length > 0
      )
    } catch {
      return false
    }
  }

  /**
   * Scan the skills/ subdirectory for skill entries.
   * 
   * Each immediate subdirectory of skills/ that contains a SKILL.md file
   * is treated as a skill component. Directories without SKILL.md are
   * skipped with a warning.
   * 
   * @param pluginDir - Root plugin directory
   * @param warnings - Mutable array to append warnings to
   * @returns Array of discovered skill components
   */
  private static async scanSkillsDirectory(
    pluginDir: string,
    warnings: string[]
  ): Promise<SkillComponent[]> {
    const skillsDir = join(pluginDir, 'skills')
    const skills: SkillComponent[] = []

    let entries: string[]
    try {
      const rawEntries = await readdir(skillsDir, { withFileTypes: true })
      entries = rawEntries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      // skills/ directory does not exist or is unreadable — not an error
      return skills
    }

    for (const entryName of entries) {
      const skillDir = join(skillsDir, entryName)
      const skillMdPath = join(skillDir, 'SKILL.md')

      let hasSkillMd = false
      try {
        await access(skillMdPath)
        hasSkillMd = true
      } catch {
        // SKILL.md not found
      }

      if (hasSkillMd) {
        skills.push({
          id: entryName,
          format: 'agent-skills/1.0',
          path: `skills/${entryName}/SKILL.md`,
        })
      } else {
        warnings.push(
          `Skill directory "skills/${entryName}" does not contain SKILL.md; skipping.`
        )
      }
    }

    // Sort skills by id for deterministic output
    skills.sort((a, b) => a.id.localeCompare(b.id))

    return skills
  }

  /**
   * Detect whether mcp.json exists in the plugin root.
   * 
   * @param pluginDir - Root plugin directory
   * @param warnings - Mutable array to append warnings to
   * @returns Array with zero or one MCP server component
   */
  private static async detectMcpConfig(
    pluginDir: string,
    warnings: string[]
  ): Promise<McpServerComponent[]> {
    const mcpJsonPath = join(pluginDir, 'mcp.json')

    try {
      await access(mcpJsonPath)
      return [
        {
          id: 'default',
          format: 'mcp/2025-06-18',
          config: 'mcp.json',
        },
      ]
    } catch {
      // mcp.json not present — perfectly valid
      return []
    }
  }
}
