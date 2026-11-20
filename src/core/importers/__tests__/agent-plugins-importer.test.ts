/**
 * AgentPluginsImporter unit tests.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentPluginsImporter } from '../agent-plugins-importer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temporary directory with a valid plugin.json. */
async function createValidPluginDir(overrides: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-test-'));
  const pluginJson = {
    $schema: 'https://example.com/plugin.schema.json',
    name: 'test-plugin',
    version: '1.2.3',
    description: 'A test plugin',
    ...overrides,
  };
  await writeFile(join(dir, 'plugin.json'), JSON.stringify(pluginJson), 'utf-8');
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentPluginsImporter', () => {
  // -----------------------------------------------------------------------
  // isAgentPluginsDir
  // -----------------------------------------------------------------------

  describe('isAgentPluginsDir', () => {
    it('should return true for a valid Agent Plugins directory', async () => {
      const dir = await createValidPluginDir();
      expect(await AgentPluginsImporter.isAgentPluginsDir(dir)).toBe(true);
    });

    it('should return false when plugin.json is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-empty-'));
      expect(await AgentPluginsImporter.isAgentPluginsDir(dir)).toBe(false);
    });

    it('should return false when $schema is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-noschema-'));
      await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ name: 'no-schema' }),
        'utf-8',
      );
      expect(await AgentPluginsImporter.isAgentPluginsDir(dir)).toBe(false);
    });

    it('should return false when name is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-noname-'));
      await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ $schema: 'https://example.com/schema.json' }),
        'utf-8',
      );
      expect(await AgentPluginsImporter.isAgentPluginsDir(dir)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // parsePluginJson
  // -----------------------------------------------------------------------

  describe('parsePluginJson', () => {
    it('should parse valid JSON', async () => {
      const dir = await createValidPluginDir();
      const result = await AgentPluginsImporter.parsePluginJson(join(dir, 'plugin.json'));
      expect(result.name).toBe('test-plugin');
      expect(result.$schema).toBe('https://example.com/plugin.schema.json');
    });

    it('should throw on invalid JSON', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-badjson-'));
      await writeFile(join(dir, 'plugin.json'), '{invalid json}', 'utf-8');
      await expect(
        AgentPluginsImporter.parsePluginJson(join(dir, 'plugin.json')),
      ).rejects.toThrow(/Invalid JSON/);
    });

    it('should throw on non-existent file', async () => {
      await expect(
        AgentPluginsImporter.parsePluginJson('/nonexistent/plugin.json'),
      ).rejects.toThrow(/Failed to read/);
    });
  });

  // -----------------------------------------------------------------------
  // import (full)
  // -----------------------------------------------------------------------

  describe('import', () => {
    it('should produce a valid manifest with correct apiVersion and kind', async () => {
      const dir = await createValidPluginDir();
      const result = await AgentPluginsImporter.import(dir);

      expect(result.manifest.apiVersion).toBe('plugin.agenthub.io/v1alpha1');
      expect(result.manifest.kind).toBe('Plugin');
      expect(result.manifest.metadata.name).toBe('test-plugin');
      expect(result.manifest.metadata.version).toBe('1.2.3');
    });

    it('should discover skills in skills/ subdirectory', async () => {
      const dir = await createValidPluginDir();
      // Create skills/my-skill/SKILL.md
      const skillDir = join(dir, 'skills', 'my-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# My Skill\n\nDescription.', 'utf-8');

      const result = await AgentPluginsImporter.import(dir);
      expect(result.skillsFound).toBe(1);
      expect(result.manifest.components?.skills).toHaveLength(1);
      expect(result.manifest.components?.skills?.[0].id).toBe('my-skill');
      expect(result.manifest.components?.skills?.[0].format).toBe('agent-skills/1.0');
    });

    it('should detect mcp.json', async () => {
      const dir = await createValidPluginDir();
      await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {} }), 'utf-8');

      const result = await AgentPluginsImporter.import(dir);
      expect(result.mcpServersFound).toBe(1);
      expect(result.manifest.components?.mcpServers).toHaveLength(1);
      expect(result.manifest.components?.mcpServers?.[0].config).toBe('mcp.json');
    });

    it('should throw when $schema is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-noschema-'));
      await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ name: 'no-schema' }),
        'utf-8',
      );
      await expect(AgentPluginsImporter.import(dir)).rejects.toThrow(/missing required "\$schema"/);
    });

    it('should throw when name is missing', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agent-plugins-noname-'));
      await writeFile(
        join(dir, 'plugin.json'),
        JSON.stringify({ $schema: 'https://example.com/schema.json' }),
        'utf-8',
      );
      await expect(AgentPluginsImporter.import(dir)).rejects.toThrow(/missing required "name"/);
    });

    it('should warn about missing version', async () => {
      const dir = await createValidPluginDir({ version: undefined });
      // Remove the version key entirely
      const pluginJson = {
        $schema: 'https://example.com/plugin.schema.json',
        name: 'no-version',
      };
      await writeFile(join(dir, 'plugin.json'), JSON.stringify(pluginJson), 'utf-8');

      const result = await AgentPluginsImporter.import(dir);
      expect(result.warnings.some((w) => w.includes('version'))).toBe(true);
      expect(result.manifest.metadata.version).toBe('0.0.0');
    });

    it('should generate correct metadata id from name', async () => {
      const dir = await createValidPluginDir({ name: 'my-cool-plugin' });
      const result = await AgentPluginsImporter.import(dir);
      expect(result.manifest.metadata.id).toBe('com.agent-plugins.my-cool-plugin');
    });
  });
});
