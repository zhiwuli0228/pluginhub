import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SkillLoader } from '../loader.js'

describe('SkillLoader', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  /** Helper: create a skill directory with SKILL.md content */
  async function createSkill(dirName: string, content: string): Promise<string> {
    const skillDir = join(tempDir, dirName)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), content, 'utf-8')
    return skillDir
  }

  // ── loadSummary ──

  describe('loadSummary', () => {
    it('correctly parses frontmatter and returns summary', async () => {
      const skillDir = await createSkill('my-skill', `---
name: my-skill
description: A test skill for unit testing
---

# My Skill Body

This is the body content.
`)
      const summary = await SkillLoader.loadSummary(skillDir)
      expect(summary.name).toBe('my-skill')
      expect(summary.description).toBe('A test skill for unit testing')
      expect(summary.directoryPath).toBe(skillDir)
    })

    it('throws when SKILL.md is missing', async () => {
      const emptyDir = join(tempDir, 'empty-skill')
      await mkdir(emptyDir, { recursive: true })
      await expect(SkillLoader.loadSummary(emptyDir)).rejects.toThrow()
    })
  })

  // ── loadFull ──

  describe('loadFull', () => {
    it('returns full content including body', async () => {
      const skillDir = await createSkill('full-skill', `---
name: full-skill
description: Full skill test
license: MIT
compatibility: node >= 20
allowed-tools: read write exec
---

# Full Skill

Detailed instructions here.
`)
      const full = await SkillLoader.loadFull(skillDir)
      expect(full.name).toBe('full-skill')
      expect(full.description).toBe('Full skill test')
      expect(full.body).toContain('# Full Skill')
      expect(full.body).toContain('Detailed instructions here.')
      expect(full.license).toBe('MIT')
      expect(full.compatibility).toBe('node >= 20')
    })

    it('parses allowed-tools space-separated string into array', async () => {
      const skillDir = await createSkill('tools-skill', `---
name: tools-skill
description: Skill with allowed tools
allowed-tools: read write  exec   grep
---

Body text.
`)
      const full = await SkillLoader.loadFull(skillDir)
      expect(full.allowedTools).toEqual(['read', 'write', 'exec', 'grep'])
    })

    it('returns undefined allowedTools when not specified', async () => {
      const skillDir = await createSkill('no-tools', `---
name: no-tools
description: No tools specified
---

Body.
`)
      const full = await SkillLoader.loadFull(skillDir)
      expect(full.allowedTools).toBeUndefined()
    })
  })

  // ── scanSkillsDirectory ──

  describe('scanSkillsDirectory', () => {
    it('discovers skills in subdirectories', async () => {
      await createSkill('alpha-skill', `---
name: alpha-skill
description: Alpha skill
---
Alpha body.
`)
      await createSkill('beta-skill', `---
name: beta-skill
description: Beta skill
---
Beta body.
`)
      // Create a non-skill directory (no SKILL.md)
      await mkdir(join(tempDir, 'not-a-skill'), { recursive: true })

      const summaries = await SkillLoader.scanSkillsDirectory(tempDir)
      expect(summaries).toHaveLength(2)
      // Should be sorted alphabetically by name
      expect(summaries[0].name).toBe('alpha-skill')
      expect(summaries[1].name).toBe('beta-skill')
    })

    it('returns empty array for directory with no skills', async () => {
      const summaries = await SkillLoader.scanSkillsDirectory(tempDir)
      expect(summaries).toHaveLength(0)
    })
  })

  // ── validateSkillName ──

  describe('validateSkillName', () => {
    it('accepts valid lowercase kebab-case name matching directory', () => {
      const result = SkillLoader.validateSkillName('my-cool-skill', 'my-cool-skill')
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('rejects uppercase characters', () => {
      const result = SkillLoader.validateSkillName('MySkill', 'MySkill')
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects names exceeding max length', () => {
      const longName = 'a'.repeat(65)
      const result = SkillLoader.validateSkillName(longName, longName)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('exceeds')
    })

    it('rejects name not matching directory name', () => {
      const result = SkillLoader.validateSkillName('skill-a', 'skill-b')
      expect(result.valid).toBe(false)
      expect(result.error).toContain('does not match')
    })

    it('rejects empty name', () => {
      const result = SkillLoader.validateSkillName('', '')
      expect(result.valid).toBe(false)
    })

    it('rejects name starting with a digit', () => {
      const result = SkillLoader.validateSkillName('1skill', '1skill')
      expect(result.valid).toBe(false)
    })

    it('rejects name ending with a hyphen', () => {
      const result = SkillLoader.validateSkillName('skill-', 'skill-')
      expect(result.valid).toBe(false)
    })
  })
})
