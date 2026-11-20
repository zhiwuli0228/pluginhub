import { describe, it, expect } from 'vitest';
import { ArazzoAdapter } from '../arazzo-adapter.js';
import type { ArazzoWorkflow } from '../arazzo-adapter.js';
import type { AdapterContext } from '../../capability/types.js';

const baseCtx: AdapterContext = {
  pluginId: 'com.acme.workflows',
  componentId: 'main',
  trustStatus: 'verified-untrusted',
  publisherDomain: 'acme.com',
};

const sampleWorkflow: ArazzoWorkflow = {
  workflowId: 'createAndNotify',
  summary: 'Create a user and send notification',
  description: 'Multi-step workflow that creates a user then sends an email notification.',
  inputs: {
    type: 'object',
    properties: {
      username: { type: 'string', description: 'The username to create' },
      email: { type: 'string', description: 'Notification email address' },
    },
    required: ['username', 'email'],
  },
  outputs: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
    },
  },
  steps: [
    { stepId: 'createUser', operationId: 'createUser', description: 'Create the user' },
    { stepId: 'sendEmail', operationId: 'sendNotification', description: 'Send email' },
  ],
};

const noInputsWorkflow: ArazzoWorkflow = {
  workflowId: 'healthCheck',
  summary: 'Run health check',
  steps: [
    { stepId: 'ping', operationId: 'ping', description: 'Ping the service' },
  ],
};

describe('ArazzoAdapter', () => {
  describe('adapt()', () => {
    it('returns exactly 1 CanonicalCapability', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap).toBeDefined();
      expect(cap.id).toBe('com.acme.workflows/main/createAndNotify');
    });

    it('kind is "workflow"', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.kind).toBe('workflow');
    });

    it('execution.mode is "task"', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.execution.mode).toBe('task');
    });

    it('semantics.destructive=true and requiresApproval=true', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.semantics.destructive).toBe(true);
      expect(cap.semantics.requiresApproval).toBe(true);
    });

    it('io.inputSchema comes from workflow.inputs', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.io.inputSchema).not.toBeNull();
      const inputSchema = cap.io.inputSchema as Record<string, unknown>;
      expect(inputSchema.type).toBe('object');
      const props = inputSchema.properties as Record<string, unknown>;
      expect(props['username']).toBeDefined();
      expect(props['email']).toBeDefined();
    });

    it('provenance.protocol is "arazzo"', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.provenance.protocol).toBe('arazzo');
    });

    it('provenance.native preserves the complete workflow object', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.provenance.native).toBe(sampleWorkflow); // same reference
      const native = cap.provenance.native as ArazzoWorkflow;
      expect(native.workflowId).toBe('createAndNotify');
      expect(native.steps).toHaveLength(2);
    });

    it('display.name uses workflowId', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.display.name).toBe('createAndNotify');
    });

    it('display.summary uses workflow summary field', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.display.summary).toBe('Create a user and send notification');
    });

    it('trust fields come from context', () => {
      const cap = ArazzoAdapter.adapt(sampleWorkflow, baseCtx);
      expect(cap.trust.status).toBe('verified-untrusted');
      expect(cap.trust.publisher).toBe('acme.com');
    });
  });

  describe('adaptAll()', () => {
    it('converts multiple workflows to capabilities', () => {
      const caps = ArazzoAdapter.adaptAll(
        [sampleWorkflow, noInputsWorkflow],
        baseCtx,
      );
      expect(caps).toHaveLength(2);
      expect(caps[0].id).toContain('createAndNotify');
      expect(caps[1].id).toContain('healthCheck');
    });

    it('returns empty array for empty input', () => {
      const caps = ArazzoAdapter.adaptAll([], baseCtx);
      expect(caps).toEqual([]);
    });
  });

  describe('workflow without inputs', () => {
    it('inputSchema is null when workflow has no inputs', () => {
      const cap = ArazzoAdapter.adapt(noInputsWorkflow, baseCtx);
      expect(cap.io.inputSchema).toBeNull();
    });

    it('outputSchema is null when workflow has no outputs', () => {
      const cap = ArazzoAdapter.adapt(noInputsWorkflow, baseCtx);
      expect(cap.io.outputSchema).toBeNull();
    });
  });
});
