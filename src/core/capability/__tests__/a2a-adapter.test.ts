/**
 * A2AAdapter unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest';

import { A2AAdapter } from '../a2a-adapter.js';
import type { AgentCard } from '../../a2a/types.js';
import type { AdapterContext } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AgentCard for testing. */
function makeAgentCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'test-agent',
    description: 'A test agent for unit tests',
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: 'https://agent.example.com/rpc',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0.1',
      },
    ],
    ...overrides,
  };
}

/** Build a standard AdapterContext for testing. */
function makeContext(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    pluginId: 'com.test.plugin',
    componentId: 'agent-0',
    trustStatus: 'self-asserted',
    publisherDomain: 'example.com',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('A2AAdapter', () => {
  const adapter = new A2AAdapter();

  it('should have protocol "a2a"', () => {
    expect(adapter.protocol).toBe('a2a');
  });

  it('should have adapterVersion "1.0.0"', () => {
    expect(adapter.adapterVersion).toBe('1.0.0');
  });

  describe('adapt', () => {
    it('should set kind to "agent"', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.kind).toBe('agent');
    });

    it('should map card.name to display.name', () => {
      const card = makeAgentCard({ name: 'My Agent' });
      const result = adapter.adapt(card, makeContext());
      expect(result.display.name).toBe('My Agent');
    });

    it('should map card.description to display.summary', () => {
      const card = makeAgentCard({ description: 'Does things' });
      const result = adapter.adapt(card, makeContext());
      expect(result.display.summary).toBe('Does things');
    });

    it('should set execution.mode to "task"', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.execution.mode).toBe('task');
    });

    it('should set execution.concurrencySafe to false', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.execution.concurrencySafe).toBe(false);
    });

    it('should set io schemas to null', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.io.inputSchema).toBeNull();
      expect(result.io.outputSchema).toBeNull();
    });

    it('should preserve original card in provenance.native', () => {
      const card = makeAgentCard();
      const result = adapter.adapt(card, makeContext());
      expect(result.provenance.native).toBe(card);
    });

    it('should set provenance.protocol to "a2a"', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.provenance.protocol).toBe('a2a');
    });

    it('should set provenance.adapterVersion', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.provenance.adapterVersion).toBe('1.0.0');
    });

    it('should set all semantic flags to false', () => {
      const result = adapter.adapt(makeAgentCard(), makeContext());
      expect(result.semantics.readOnly).toBe(false);
      expect(result.semantics.destructive).toBe(false);
      expect(result.semantics.idempotent).toBe(false);
      expect(result.semantics.openWorld).toBe(false);
      expect(result.semantics.requiresApproval).toBe(false);
    });

    it('should map trust from context', () => {
      const ctx = makeContext({ trustStatus: 'trusted', publisherDomain: 'corp.io' });
      const result = adapter.adapt(makeAgentCard(), ctx);
      expect(result.trust.status).toBe('trusted');
      expect(result.trust.publisher).toBe('corp.io');
    });

    it('should collect skill examples into display.examples', () => {
      const card = makeAgentCard({
        skills: [
          { id: 's1', name: 'Skill 1', description: 'First', examples: ['Do X', 'Do Y'] },
          { id: 's2', name: 'Skill 2', description: 'Second', examples: ['Do Z'] },
        ],
      });
      const result = adapter.adapt(card, makeContext());
      expect(result.display.examples).toEqual(['Do X', 'Do Y', 'Do Z']);
    });

    it('should omit display.examples when no skills have examples', () => {
      const card = makeAgentCard({
        skills: [{ id: 's1', name: 'Skill 1', description: 'No examples' }],
      });
      const result = adapter.adapt(card, makeContext());
      expect(result.display.examples).toBeUndefined();
    });

    it('should pass through defaultInputModes and defaultOutputModes', () => {
      const card = makeAgentCard({
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['application/json'],
      });
      const result = adapter.adapt(card, makeContext());
      expect(result.io.inputModes).toEqual(['text/plain']);
      expect(result.io.outputModes).toEqual(['application/json']);
    });

    it('should build correct capability id', () => {
      const ctx = makeContext({ pluginId: 'com.test', componentId: 'comp1' });
      const card = makeAgentCard({ name: 'my-agent' });
      const result = adapter.adapt(card, ctx);
      expect(result.id).toBe('com.test/comp1/my-agent');
    });
  });
});
