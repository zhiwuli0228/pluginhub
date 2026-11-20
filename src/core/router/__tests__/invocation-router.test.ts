import { describe, it, expect, beforeEach } from 'vitest';
import { InvocationRouter } from '../invocation-router.js';
import type { CanonicalCapability } from '../../capability/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCapability(overrides: Partial<CanonicalCapability> & { id: string }): CanonicalCapability {
  return {
    kind: 'tool',
    display: {
      name: overrides.id.split('/').pop() ?? overrides.id,
      summary: '',
      examples: [],
      ...(overrides.display ?? {}),
    },
    io: {
      inputSchema: null,
      outputSchema: null,
      ...(overrides.io ?? {}),
    },
    semantics: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      openWorld: false,
      requiresApproval: false,
      ...(overrides.semantics ?? {}),
    },
    execution: {
      mode: 'sync',
      concurrencySafe: true,
      ...(overrides.execution ?? {}),
    },
    provenance: {
      protocol: 'mcp',
      native: {},
      adapterVersion: '1.0.0',
      ...(overrides.provenance ?? {}),
    },
    trust: {
      status: 'trusted',
      ...(overrides.trust ?? {}),
    },
    ...overrides,
  };
}

const capListUsers = makeCapability({
  id: 'plugin-a/api/listUsers',
  display: {
    name: 'listUsers',
    summary: 'List all users in the system',
    examples: ['listUsers()', 'listUsers(limit: 10)'],
  },
});

const capGetUser = makeCapability({
  id: 'plugin-a/api/getUser',
  display: {
    name: 'getUser',
    summary: 'Get a specific user by ID',
    examples: ['getUser(id: "123")'],
  },
});

const capDeleteUser = makeCapability({
  id: 'plugin-b/admin/deleteUser',
  display: {
    name: 'deleteUser',
    summary: 'Permanently delete a user account',
    examples: ['deleteUser(id: "456")'],
  },
  semantics: {
    readOnly: false,
    destructive: true,
    idempotent: false,
    openWorld: false,
    requiresApproval: true,
  },
  trust: { status: 'verified-untrusted' },
});

const capReadOnly = makeCapability({
  id: 'plugin-c/tools/healthCheck',
  display: {
    name: 'healthCheck',
    summary: 'Check service health status',
    examples: ['healthCheck()'],
  },
  semantics: {
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    requiresApproval: false,
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InvocationRouter', () => {
  let router: InvocationRouter;

  beforeEach(() => {
    router = new InvocationRouter();
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe('registerCapabilities + getCapabilities', () => {
    it('registers and retrieves capabilities', () => {
      router.registerCapabilities([capListUsers, capGetUser]);
      const caps = router.getCapabilities();
      expect(caps).toHaveLength(2);
      const ids = caps.map((c) => c.id);
      expect(ids).toContain('plugin-a/api/listUsers');
      expect(ids).toContain('plugin-a/api/getUser');
    });

    it('overwrites capability with same ID', () => {
      router.registerCapabilities([capListUsers]);
      const updated = makeCapability({
        ...capListUsers,
        display: { name: 'listUsersV2', summary: 'Updated', examples: [] },
      });
      router.registerCapabilities([updated]);
      const caps = router.getCapabilities();
      expect(caps).toHaveLength(1);
      expect(caps[0].display.name).toBe('listUsersV2');
    });
  });

  // -----------------------------------------------------------------------
  // Routing — score matching
  // -----------------------------------------------------------------------

  describe('route()', () => {
    beforeEach(() => {
      router.registerCapabilities([capListUsers, capGetUser, capDeleteUser, capReadOnly]);
    });

    it('exact match (capabilityId) returns score=1.0', () => {
      const result = router.route({ query: '', capabilityId: 'plugin-a/api/listUsers' });
      expect(result.score).toBe(1.0);
      expect(result.capability.id).toBe('plugin-a/api/listUsers');
    });

    it('name match returns score≈0.8', () => {
      const result = router.route({ query: 'listusers' });
      expect(result.score).toBeCloseTo(0.8, 1);
      expect(result.capability.id).toBe('plugin-a/api/listUsers');
    });

    it('example match returns score≈0.7', () => {
      // Query matches an example but not the name directly
      const result = router.route({ query: 'limit: 10' });
      // Should match listUsers via its example "listUsers(limit: 10)"
      expect(result.score).toBeGreaterThanOrEqual(0.7);
    });

    it('summary match returns score≈0.5', () => {
      // "permanently" only appears in deleteUser's summary
      const result = router.route({ query: 'permanently' });
      expect(result.score).toBeCloseTo(0.5, 1);
      expect(result.capability.id).toBe('plugin-b/admin/deleteUser');
    });

    it('throws when no capabilities are registered', () => {
      const emptyRouter = new InvocationRouter();
      expect(() => emptyRouter.route({ query: 'anything' })).toThrow(
        /no capabilities registered/,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Approval
  // -----------------------------------------------------------------------

  describe('checkApproval', () => {
    beforeEach(() => {
      router.registerCapabilities([capListUsers, capDeleteUser, capReadOnly]);
    });

    it('destructive capability forces approval', () => {
      const result = router.checkApproval('plugin-b/admin/deleteUser');
      expect(result.required).toBe(true);
      expect(result.reason).toMatch(/destructive/i);
    });

    it('requiresApproval capability needs approval', () => {
      // deleteUser has both destructive=true and requiresApproval=true
      const result = router.checkApproval('plugin-b/admin/deleteUser');
      expect(result.required).toBe(true);
    });

    it('non-destructive, non-approval capability does not require approval', () => {
      const result = router.checkApproval('plugin-a/api/listUsers');
      expect(result.required).toBe(false);
    });

    it('unknown capability does not require approval', () => {
      const result = router.checkApproval('nonexistent/cap/id');
      expect(result.required).toBe(false);
    });

    it('after recordApproval(approved), checkApproval returns not required', () => {
      router.recordApproval('plugin-b/admin/deleteUser', {
        approved: true,
        decidedBy: 'user',
      });
      const result = router.checkApproval('plugin-b/admin/deleteUser');
      expect(result.required).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Context Summary
  // -----------------------------------------------------------------------

  describe('getContextSummary', () => {
    beforeEach(() => {
      router.registerCapabilities([capListUsers, capGetUser, capDeleteUser, capReadOnly]);
    });

    it('returns ≤ maxTools entries', () => {
      const summary = router.getContextSummary({ maxTools: 2, maxToolNameLength: 64, tokenBudgetHint: 1000 });
      expect(summary.length).toBeLessThanOrEqual(2);
    });

    it('each entry contains only id, name, and summary', () => {
      const summary = router.getContextSummary();
      for (const entry of summary) {
        expect(entry).toHaveProperty('id');
        expect(entry).toHaveProperty('name');
        expect(entry).toHaveProperty('summary');
        // Should NOT have extra properties like semantics or io
        expect(Object.keys(entry).sort()).toEqual(['id', 'name', 'summary']);
      }
    });

    it('uses defaultMaxTools from constructor options', () => {
      const smallRouter = new InvocationRouter({ defaultMaxTools: 1 });
      smallRouter.registerCapabilities([capListUsers, capGetUser, capDeleteUser]);
      const summary = smallRouter.getContextSummary();
      expect(summary).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Full Schema
  // -----------------------------------------------------------------------

  describe('getFullSchema', () => {
    it('returns the full capability for a known ID', () => {
      router.registerCapabilities([capListUsers]);
      const schema = router.getFullSchema('plugin-a/api/listUsers');
      expect(schema).not.toBeNull();
      expect(schema!.id).toBe('plugin-a/api/listUsers');
      expect(schema!.semantics).toBeDefined();
      expect(schema!.io).toBeDefined();
    });

    it('returns null for unknown ID', () => {
      router.registerCapabilities([capListUsers]);
      const schema = router.getFullSchema('nonexistent');
      expect(schema).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Search
  // -----------------------------------------------------------------------

  describe('search', () => {
    beforeEach(() => {
      router.registerCapabilities([capListUsers, capGetUser, capDeleteUser, capReadOnly]);
    });

    it('filters capabilities by query', () => {
      const results = router.search('user');
      expect(results.length).toBeGreaterThan(0);
      // All results should contain "user" somewhere in name/summary/examples
      for (const cap of results) {
        const text = `${cap.display.name} ${cap.display.summary} ${(cap.display.examples ?? []).join(' ')}`.toLowerCase();
        expect(text).toContain('user');
      }
    });

    it('respects limit parameter', () => {
      const results = router.search('user', 1);
      expect(results.length).toBeLessThanOrEqual(1);
    });

    it('returns empty array for non-matching query', () => {
      const results = router.search('xyznonexistent');
      expect(results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Unregister
  // -----------------------------------------------------------------------

  describe('unregisterPlugin', () => {
    it('removes all capabilities belonging to the specified plugin', () => {
      router.registerCapabilities([capListUsers, capGetUser, capDeleteUser, capReadOnly]);
      router.unregisterPlugin('plugin-a');
      const remaining = router.getCapabilities();
      expect(remaining).toHaveLength(2);
      const ids = remaining.map((c) => c.id);
      expect(ids).not.toContain('plugin-a/api/listUsers');
      expect(ids).not.toContain('plugin-a/api/getUser');
      expect(ids).toContain('plugin-b/admin/deleteUser');
      expect(ids).toContain('plugin-c/tools/healthCheck');
    });

    it('also clears approvals for removed capabilities', () => {
      router.registerCapabilities([capDeleteUser]);
      router.recordApproval('plugin-b/admin/deleteUser', {
        approved: true,
        decidedBy: 'user',
      });
      router.unregisterPlugin('plugin-b');
      // Re-register same capability — approval should be gone
      router.registerCapabilities([capDeleteUser]);
      const result = router.checkApproval('plugin-b/admin/deleteUser');
      expect(result.required).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  describe('events', () => {
    beforeEach(() => {
      router.registerCapabilities([capDeleteUser, capListUsers]);
    });

    it('emits approvalRequired when routing to a destructive capability', () => {
      let emitted = false;
      router.on('approvalRequired', () => { emitted = true; });
      router.route({ query: '', capabilityId: 'plugin-b/admin/deleteUser' });
      expect(emitted).toBe(true);
    });

    it('emits approvalGranted on recordApproval with approved=true', () => {
      let payload: unknown = null;
      router.on('approvalGranted', (p: unknown) => { payload = p; });
      router.recordApproval('plugin-b/admin/deleteUser', {
        approved: true,
        decidedBy: 'user',
      });
      expect(payload).not.toBeNull();
      expect((payload as { capabilityId: string }).capabilityId).toBe('plugin-b/admin/deleteUser');
    });

    it('emits approvalDenied on recordApproval with approved=false', () => {
      let payload: unknown = null;
      router.on('approvalDenied', (p: unknown) => { payload = p; });
      router.recordApproval('plugin-b/admin/deleteUser', {
        approved: false,
        decidedBy: 'policy',
        reason: 'Not authorized',
      });
      expect(payload).not.toBeNull();
      expect((payload as { capabilityId: string }).capabilityId).toBe('plugin-b/admin/deleteUser');
    });
  });
});
