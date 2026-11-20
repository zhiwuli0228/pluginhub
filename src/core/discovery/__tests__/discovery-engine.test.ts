/**
 * DiscoveryEngine unit tests.
 *
 * @module
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DiscoveryEngine } from '../discovery-engine.js';
import type { DiscoveredEntry } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal DiscoveredEntry for testing. */
function makeEntry(overrides: Partial<DiscoveredEntry> = {}): DiscoveredEntry {
  return {
    id: 'test-entry',
    name: 'Test Entry',
    source: 'local',
    location: '/fake/path',
    raw: {},
    protocol: 'mcp',
    trustScore: 70,
    discoveredAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscoveryEngine', () => {
  let engine: DiscoveryEngine;

  beforeEach(() => {
    engine = new DiscoveryEngine();
  });

  // -----------------------------------------------------------------------
  // addEntry / getEntries
  // -----------------------------------------------------------------------

  describe('addEntry / getEntries', () => {
    it('should add and retrieve an entry', () => {
      const entry = makeEntry();
      engine.addEntry(entry);

      const entries = engine.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('test-entry');
    });

    it('should return empty array when no entries exist', () => {
      expect(engine.getEntries()).toHaveLength(0);
    });

    it('should store multiple distinct entries', () => {
      engine.addEntry(makeEntry({ id: 'a', name: 'A' }));
      engine.addEntry(makeEntry({ id: 'b', name: 'B' }));

      expect(engine.getEntries()).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // search
  // -----------------------------------------------------------------------

  describe('search', () => {
    it('should match by name substring (case-insensitive)', () => {
      engine.addEntry(makeEntry({ id: 'x', name: 'Alpha Plugin' }));
      engine.addEntry(makeEntry({ id: 'y', name: 'Beta Tool' }));

      const results = engine.search('alpha');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Alpha Plugin');
    });

    it('should match by id substring', () => {
      engine.addEntry(makeEntry({ id: 'com.example/foo', name: 'Foo' }));
      engine.addEntry(makeEntry({ id: 'com.other/bar', name: 'Bar' }));

      const results = engine.search('example');
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('com.example/foo');
    });

    it('should return empty for non-matching query', () => {
      engine.addEntry(makeEntry({ id: 'x', name: 'Alpha' }));
      expect(engine.search('zzz')).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // removeEntry
  // -----------------------------------------------------------------------

  describe('removeEntry', () => {
    it('should remove an existing entry and return true', () => {
      engine.addEntry(makeEntry({ id: 'removeme' }));
      expect(engine.removeEntry('removeme')).toBe(true);
      expect(engine.getEntries()).toHaveLength(0);
    });

    it('should return false for non-existent entry', () => {
      expect(engine.removeEntry('nope')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('should keep higher trustScore entry as primary', () => {
      const low = makeEntry({ id: 'dup', trustScore: 50, location: '/low' });
      const high = makeEntry({ id: 'dup', trustScore: 90, location: '/high' });

      engine.addEntry(low);
      engine.addEntry(high);

      const entries = engine.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].trustScore).toBe(90);
      expect(entries[0].location).toBe('/high');
    });

    it('should record lower trustScore entry as mirror', () => {
      const low = makeEntry({ id: 'dup', trustScore: 50, source: 'registry', location: '/low' });
      const high = makeEntry({ id: 'dup', trustScore: 90, source: 'local', location: '/high' });

      engine.addEntry(low);
      engine.addEntry(high);

      const entries = engine.getEntries();
      expect(entries[0].mirrors).toBeDefined();
      expect(entries[0].mirrors!.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].mirrors!.some((m) => m.location === '/low')).toBe(true);
    });

    it('should append as mirror when new entry has equal or lower score', () => {
      const first = makeEntry({ id: 'dup', trustScore: 70, location: '/first' });
      const second = makeEntry({ id: 'dup', trustScore: 60, source: 'registry', location: '/second' });

      engine.addEntry(first);
      engine.addEntry(second);

      const entries = engine.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].location).toBe('/first');
      expect(entries[0].mirrors).toBeDefined();
      expect(entries[0].mirrors!.some((m) => m.location === '/second')).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // scanLocal
  // -----------------------------------------------------------------------

  describe('scanLocal', () => {
    it('should discover plugin.yaml in a directory', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pluginhub-test-'));
      const manifestContent = JSON.stringify({
        apiVersion: 'plugin.agenthub.io/v1alpha1',
        kind: 'Plugin',
        metadata: {
          id: 'com.test.scanned',
          name: 'scanned-plugin',
          version: '1.0.0',
        },
      });
      await writeFile(join(dir, 'plugin.json'), manifestContent, 'utf-8');

      const entries = await engine.scanLocal([dir]);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries.some((e) => e.name === 'scanned-plugin')).toBe(true);
    });

    it('should return empty for non-existent directory', async () => {
      const entries = await engine.scanLocal(['/nonexistent/path/abc123']);
      expect(entries).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // clear
  // -----------------------------------------------------------------------

  describe('clear', () => {
    it('should remove all entries', () => {
      engine.addEntry(makeEntry({ id: 'a' }));
      engine.addEntry(makeEntry({ id: 'b' }));
      expect(engine.getEntries()).toHaveLength(2);

      engine.clear();
      expect(engine.getEntries()).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe('events', () => {
    it('should emit entryAdded when a new entry is added', () => {
      const received: DiscoveredEntry[] = [];
      engine.on('entryAdded', (entry) => received.push(entry));

      const entry = makeEntry({ id: 'evt-test' });
      engine.addEntry(entry);

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe('evt-test');
    });

    it('should emit entryRemoved when an entry is removed', () => {
      const received: DiscoveredEntry[] = [];
      engine.on('entryRemoved', (entry) => received.push(entry));

      engine.addEntry(makeEntry({ id: 'rm-test' }));
      engine.removeEntry('rm-test');

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe('rm-test');
    });

    it('should emit entryUpdated on dedup merge', () => {
      const received: DiscoveredEntry[] = [];
      engine.on('entryUpdated', (entry) => received.push(entry));

      engine.addEntry(makeEntry({ id: 'merge', trustScore: 50 }));
      engine.addEntry(makeEntry({ id: 'merge', trustScore: 90 }));

      expect(received).toHaveLength(1);
      expect(received[0].trustScore).toBe(90);
    });
  });
});
