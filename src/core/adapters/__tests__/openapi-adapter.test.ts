import { describe, it, expect } from 'vitest';
import { OpenApiAdapter } from '../openapi-adapter.js';
import type { OpenApiOperation } from '../openapi-adapter.js';
import type { AdapterContext } from '../../capability/types.js';

const baseCtx: AdapterContext = {
  pluginId: 'com.acme.petstore',
  componentId: 'api',
  trustStatus: 'trusted',
  publisherDomain: 'acme.com',
};

const sampleOperations: OpenApiOperation[] = [
  {
    operationId: 'listUsers',
    method: 'GET',
    path: '/users',
    summary: 'List all users',
    tags: ['users'],
    parameters: [
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } },
    ],
  },
  {
    operationId: 'getUser',
    method: 'GET',
    path: '/users/{id}',
    summary: 'Get a user by ID',
    tags: ['users'],
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ],
  },
  {
    operationId: 'createUser',
    method: 'POST',
    path: '/users',
    summary: 'Create a new user',
    tags: ['users'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
            required: ['name'],
          },
        },
      },
    },
  },
  {
    operationId: 'deleteUser',
    method: 'DELETE',
    path: '/users/{id}',
    summary: 'Delete a user',
    tags: ['admin'],
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ],
  },
];

describe('OpenApiAdapter', () => {
  const adapter = new OpenApiAdapter({
    baseUrl: 'https://api.example.com/v1',
    allowedOperations: ['listUsers', 'getUser', 'createUser'],
  });

  describe('adapt()', () => {
    it('returns exactly 3 CanonicalCapability records', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      expect(caps).toHaveLength(3);
    });

    it('produces list_endpoints, get_schema, and invoke tools', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      const names = caps.map((c) => c.display.name);
      expect(names).toContain('list_endpoints');
      expect(names).toContain('get_schema');
      expect(names).toContain('invoke');
    });
  });

  describe('list_endpoints tool', () => {
    it('has readOnly=true and concurrencySafe=true', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      const listEndpoints = caps.find((c) => c.display.name === 'list_endpoints')!;
      expect(listEndpoints.semantics.readOnly).toBe(true);
      expect(listEndpoints.execution.concurrencySafe).toBe(true);
    });
  });

  describe('get_schema tool', () => {
    it('has readOnly=true', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      const getSchema = caps.find((c) => c.display.name === 'get_schema')!;
      expect(getSchema.semantics.readOnly).toBe(true);
    });
  });

  describe('invoke tool', () => {
    it('has destructive=true and requiresApproval=true', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      const invoke = caps.find((c) => c.display.name === 'invoke')!;
      expect(invoke.semantics.destructive).toBe(true);
      expect(invoke.semantics.requiresApproval).toBe(true);
    });
  });

  describe('whitelist filtering', () => {
    it('only includes operations from allowedOperations in provenance.native', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      // All three tools share the same filtered native array
      for (const cap of caps) {
        const nativeOps = cap.provenance.native as OpenApiOperation[];
        const ids = nativeOps.map((op) => op.operationId);
        expect(ids).toEqual(['listUsers', 'getUser', 'createUser']);
        expect(ids).not.toContain('deleteUser');
      }
    });

    it('empty whitelist produces empty provenance.native arrays', () => {
      const emptyAdapter = new OpenApiAdapter({
        baseUrl: 'https://api.example.com',
        allowedOperations: [],
      });
      const caps = emptyAdapter.adapt(sampleOperations, baseCtx);
      for (const cap of caps) {
        expect(cap.provenance.native).toEqual([]);
      }
    });
  });

  describe('resolveInputSchema', () => {
    it('merges parameters and requestBody into a single schema', () => {
      const op: OpenApiOperation = {
        operationId: 'mixed',
        method: 'POST',
        path: '/items/{id}',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'verbose', in: 'query', schema: { type: 'boolean' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                },
                required: ['title'],
              },
            },
          },
        },
      };

      const schema = OpenApiAdapter.resolveInputSchema(op);
      expect(schema.type).toBe('object');
      const props = schema.properties as Record<string, unknown>;
      expect(props['id']).toBeDefined();
      expect(props['verbose']).toBeDefined();
      expect(props['title']).toBeDefined();
      expect((schema.required as string[])).toContain('id');
      expect((schema.required as string[])).toContain('title');
    });

    it('handles operation with no parameters or body', () => {
      const op: OpenApiOperation = {
        operationId: 'noop',
        method: 'GET',
        path: '/health',
      };
      const schema = OpenApiAdapter.resolveInputSchema(op);
      expect(schema.type).toBe('object');
      expect(schema.properties).toEqual({});
    });

    it('prefixes body properties to avoid collision with parameter names', () => {
      const op: OpenApiOperation = {
        operationId: 'collision',
        method: 'POST',
        path: '/items/{name}',
        parameters: [
          { name: 'name', in: 'path', required: true, schema: { type: 'string' } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                },
              },
            },
          },
        },
      };
      const schema = OpenApiAdapter.resolveInputSchema(op);
      const props = schema.properties as Record<string, unknown>;
      expect(props['name']).toBeDefined();       // from path param
      expect(props['body_name']).toBeDefined();   // from body, prefixed
    });
  });

  describe('buildUrl', () => {
    it('replaces path parameters correctly', () => {
      const url = OpenApiAdapter.buildUrl(
        'https://api.example.com',
        '/users/{id}',
        { id: '42' },
      );
      expect(url).toBe('https://api.example.com/users/42');
    });

    it('appends remaining params as query string', () => {
      const url = OpenApiAdapter.buildUrl(
        'https://api.example.com',
        '/users/{id}',
        { id: '42', limit: '10', offset: '5' },
      );
      expect(url).toContain('/users/42');
      expect(url).toContain('limit=10');
      expect(url).toContain('offset=5');
      expect(url).toMatch(/\?/);
    });

    it('encodes special characters in values', () => {
      const url = OpenApiAdapter.buildUrl(
        'https://api.example.com',
        '/search',
        { q: 'hello world' },
      );
      expect(url).toBe('https://api.example.com/search?q=hello%20world');
    });

    it('returns clean URL when no params are provided', () => {
      const url = OpenApiAdapter.buildUrl(
        'https://api.example.com',
        '/health',
        {},
      );
      expect(url).toBe('https://api.example.com/health');
    });
  });

  describe('provenance', () => {
    it('protocol is "openapi"', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      for (const cap of caps) {
        expect(cap.provenance.protocol).toBe('openapi');
      }
    });

    it('native contains the filtered operation list', () => {
      const caps = adapter.adapt(sampleOperations, baseCtx);
      const listEndpoints = caps.find((c) => c.display.name === 'list_endpoints')!;
      const native = listEndpoints.provenance.native as OpenApiOperation[];
      expect(native).toHaveLength(3);
      expect(native.map((o) => o.operationId)).toEqual(['listUsers', 'getUser', 'createUser']);
    });
  });
});
