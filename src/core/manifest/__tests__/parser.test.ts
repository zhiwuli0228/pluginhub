import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManifestParser, ManifestParseError } from '../parser.js'

describe('ManifestParser', () => {
  // ── parseYaml ──

  describe('parseYaml', () => {
    it('parses a valid YAML manifest', () => {
      const yaml = `
apiVersion: plugin.agenthub.io/v1alpha1
kind: Plugin
metadata:
  id: com.example.my-plugin
  name: my-plugin
  version: 1.0.0
`
      const result = ManifestParser.parseYaml(yaml)
      expect(result.apiVersion).toBe('plugin.agenthub.io/v1alpha1')
      expect(result.kind).toBe('Plugin')
      expect(result.metadata.id).toBe('com.example.my-plugin')
      expect(result.metadata.name).toBe('my-plugin')
      expect(result.metadata.version).toBe('1.0.0')
    })

    it('throws ManifestParseError on invalid YAML', () => {
      const badYaml = `
apiVersion: plugin.agenthub.io/v1alpha1
metadata:
  id: [invalid
    nested: broken
`
      expect(() => ManifestParser.parseYaml(badYaml)).toThrow(ManifestParseError)
    })

    it('throws ManifestParseError when YAML parses to a non-object', () => {
      expect(() => ManifestParser.parseYaml('"just a string"')).toThrow(ManifestParseError)
      expect(() => ManifestParser.parseYaml('42')).toThrow(ManifestParseError)
      expect(() => ManifestParser.parseYaml('- item1\n- item2')).toThrow(ManifestParseError)
    })
  })

  // ── parseJson ──

  describe('parseJson', () => {
    it('parses a valid JSON object as manifest', () => {
      const json = {
        apiVersion: 'plugin.agenthub.io/v1alpha1',
        kind: 'Plugin',
        metadata: {
          id: 'com.example.json-plugin',
          name: 'json-plugin',
          version: '2.0.0',
        },
      }
      const result = ManifestParser.parseJson(json)
      expect(result.apiVersion).toBe('plugin.agenthub.io/v1alpha1')
      expect(result.metadata.id).toBe('com.example.json-plugin')
    })

    it('throws ManifestParseError for non-object input', () => {
      expect(() => ManifestParser.parseJson(null)).toThrow(ManifestParseError)
      expect(() => ManifestParser.parseJson(undefined)).toThrow(ManifestParseError)
      expect(() => ManifestParser.parseJson('string')).toThrow(ManifestParseError)
      expect(() => ManifestParser.parseJson([1, 2])).toThrow(ManifestParseError)
    })
  })

  // ── loadFile ──

  describe('loadFile', () => {
    let tempDir: string

    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'parser-test-'))
    })

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true })
    })

    it('loads and parses a .yaml file', async () => {
      const content = `
apiVersion: plugin.agenthub.io/v1alpha1
kind: Plugin
metadata:
  id: com.example.file-yaml
  name: file-yaml
  version: 1.0.0
`
      const filePath = join(tempDir, 'manifest.yaml')
      await writeFile(filePath, content, 'utf-8')

      const result = await ManifestParser.loadFile(filePath)
      expect(result.metadata.id).toBe('com.example.file-yaml')
    })

    it('loads and parses a .json file', async () => {
      const content = JSON.stringify({
        apiVersion: 'plugin.agenthub.io/v1alpha1',
        kind: 'Plugin',
        metadata: {
          id: 'com.example.file-json',
          name: 'file-json',
          version: '3.0.0',
        },
      })
      const filePath = join(tempDir, 'manifest.json')
      await writeFile(filePath, content, 'utf-8')

      const result = await ManifestParser.loadFile(filePath)
      expect(result.metadata.id).toBe('com.example.file-json')
    })

    it('throws ManifestParseError for missing file', async () => {
      await expect(
        ManifestParser.loadFile(join(tempDir, 'nonexistent.yaml')),
      ).rejects.toThrow(ManifestParseError)
    })
  })

  // ── Missing required fields ──

  describe('missing required fields', () => {
    it('parse succeeds even when required fields are missing (validator is responsible)', () => {
      // Parser only does basic type coercion; validation is separate
      const yaml = `
someField: someValue
anotherField: 42
`
      const result = ManifestParser.parseYaml(yaml)
      // Should not throw — the parser doesn't enforce schema
      expect(result).toBeDefined()
      expect((result as Record<string, unknown>).someField).toBe('someValue')
    })
  })
})
