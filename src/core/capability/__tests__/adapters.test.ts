import { describe, it, expect } from 'vitest'
import { McpToolAdapter } from '../mcp-adapter.js'
import { SkillsAdapter } from '../skills-adapter.js'
import type { AdapterContext } from '../types.js'
import type { McpTool } from '../../mcp/types.js'
import type { SkillSummary } from '../../skills/types.js'

const baseCtx: AdapterContext = {
  pluginId: 'com.acme.test-plugin',
  componentId: 'main',
  trustStatus: 'trusted',
  publisherDomain: 'acme.com',
}

describe('McpToolAdapter', () => {
  const adapter = new McpToolAdapter()

  it('correctly maps a basic MCP tool to CanonicalCapability', () => {
    const tool: McpTool = {
      name: 'get-status',
      title: 'Get Status',
      description: 'Returns the current service status',
      inputSchema: { type: 'object', properties: { service: { type: 'string' } } },
    }

    const cap = adapter.adapt(tool, baseCtx)

    expect(cap.id).toBe('com.acme.test-plugin/main/get-status')
    expect(cap.kind).toBe('tool')
    expect(cap.display.name).toBe('Get Status')
    expect(cap.display.summary).toBe('Returns the current service status')
    expect(cap.io.inputSchema).toEqual(tool.inputSchema)
    expect(cap.io.outputSchema).toBeNull()
    expect(cap.execution.mode).toBe('sync')
    expect(cap.provenance.protocol).toBe('mcp')
    expect(cap.provenance.native).toBe(tool) // same reference
    expect(cap.trust.status).toBe('trusted')
    expect(cap.trust.publisher).toBe('acme.com')
  })

  it('maps ToolAnnotations to semantics correctly', () => {
    const tool: McpTool = {
      name: 'read-log',
      description: 'Read a log file',
      inputSchema: { type: 'object' },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }

    const cap = adapter.adapt(tool, baseCtx)

    expect(cap.semantics.readOnly).toBe(true)
    expect(cap.semantics.destructive).toBe(false)
    expect(cap.semantics.idempotent).toBe(true)
    expect(cap.semantics.openWorld).toBe(false)
    expect(cap.semantics.requiresApproval).toBe(false)
    expect(cap.execution.concurrencySafe).toBe(true) // readOnly → concurrencySafe
  })

  it('forces requiresApproval when destructive', () => {
    const tool: McpTool = {
      name: 'delete-resource',
      description: 'Delete a resource',
      inputSchema: { type: 'object' },
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
      },
    }

    const cap = adapter.adapt(tool, baseCtx)

    expect(cap.semantics.destructive).toBe(true)
    expect(cap.semantics.requiresApproval).toBe(true) // forced
    expect(cap.execution.concurrencySafe).toBe(false) // not readOnly
  })

  it('defaults all annotations to false when absent', () => {
    const tool: McpTool = {
      name: 'simple-tool',
      inputSchema: { type: 'object' },
    }

    const cap = adapter.adapt(tool, baseCtx)

    expect(cap.semantics.readOnly).toBe(false)
    expect(cap.semantics.destructive).toBe(false)
    expect(cap.semantics.idempotent).toBe(false)
    expect(cap.semantics.openWorld).toBe(false)
    expect(cap.semantics.requiresApproval).toBe(false)
    expect(cap.execution.concurrencySafe).toBe(false)
  })

  it('uses tool.name as display.name when title is absent', () => {
    const tool: McpTool = {
      name: 'my-tool',
      inputSchema: { type: 'object' },
    }

    const cap = adapter.adapt(tool, baseCtx)
    expect(cap.display.name).toBe('my-tool')
  })

  it('preserves outputSchema when present', () => {
    const tool: McpTool = {
      name: 'structured-tool',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
    }

    const cap = adapter.adapt(tool, baseCtx)
    expect(cap.io.outputSchema).toEqual(tool.outputSchema)
  })
})

describe('SkillsAdapter', () => {
  const adapter = new SkillsAdapter()

  it('correctly maps a SkillSummary to CanonicalCapability', () => {
    const skill: SkillSummary = {
      name: 'deploy-service',
      description: 'Deploy a service to staging or production',
      directoryPath: '/tmp/skills/deploy-service',
    }

    const cap = adapter.adapt(skill, baseCtx)

    expect(cap.id).toBe('com.acme.test-plugin/main/deploy-service')
    expect(cap.kind).toBe('skill')
    expect(cap.display.name).toBe('deploy-service')
    expect(cap.display.summary).toBe('Deploy a service to staging or production')
    expect(cap.provenance.protocol).toBe('skills')
    expect(cap.provenance.native).toBe(skill) // same reference
    expect(cap.trust.status).toBe('trusted')
  })

  it('sets io schemas to null for skills', () => {
    const skill: SkillSummary = {
      name: 'test-skill',
      description: 'A test skill',
      directoryPath: '/tmp/skills/test-skill',
    }

    const cap = adapter.adapt(skill, baseCtx)

    expect(cap.io.inputSchema).toBeNull()
    expect(cap.io.outputSchema).toBeNull()
  })

  it('sets all semantics to false and concurrencySafe to true', () => {
    const skill: SkillSummary = {
      name: 'knowledge-skill',
      description: 'Pure knowledge',
      directoryPath: '/tmp/skills/knowledge-skill',
    }

    const cap = adapter.adapt(skill, baseCtx)

    expect(cap.semantics.readOnly).toBe(false)
    expect(cap.semantics.destructive).toBe(false)
    expect(cap.semantics.idempotent).toBe(false)
    expect(cap.semantics.openWorld).toBe(false)
    expect(cap.semantics.requiresApproval).toBe(false)
    expect(cap.execution.concurrencySafe).toBe(true)
    expect(cap.execution.mode).toBe('sync')
  })

  it('carries trust context correctly', () => {
    const skill: SkillSummary = {
      name: 'untrusted-skill',
      description: 'From unknown source',
      directoryPath: '/tmp/skills/untrusted-skill',
    }

    const ctx: AdapterContext = {
      pluginId: 'com.unknown.plugin',
      componentId: 'ext',
      trustStatus: 'self-asserted',
    }

    const cap = adapter.adapt(skill, ctx)

    expect(cap.trust.status).toBe('self-asserted')
    expect(cap.trust.publisher).toBeUndefined()
  })
})
