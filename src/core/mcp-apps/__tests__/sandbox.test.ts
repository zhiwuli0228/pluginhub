import { describe, it, expect } from 'vitest'
import { McpAppSandbox } from '../sandbox.js'
import type { McpAppManifest } from '../types.js'

/** Helper to build a minimal valid manifest */
function makeManifest(overrides: Partial<McpAppManifest> = {}): McpAppManifest {
  return {
    extension: 'io.modelcontextprotocol/ui',
    resourceUri: 'ui://test/index.html',
    ...overrides,
  }
}

describe('McpAppSandbox', () => {
  // -----------------------------------------------------------------------
  // buildSandboxConfig
  // -----------------------------------------------------------------------
  describe('buildSandboxConfig', () => {
    it('generates CSP containing default-src \'none\'', () => {
      const config = McpAppSandbox.buildSandboxConfig(makeManifest())
      expect(config.csp).toContain("default-src 'none'")
    })

    it('includes connectDomains in CSP connect-src directive', () => {
      const manifest = makeManifest({ connectDomains: ['api.example.com', 'cdn.example.com'] })
      const config = McpAppSandbox.buildSandboxConfig(manifest)
      expect(config.csp).toContain('connect-src api.example.com cdn.example.com')
    })

    it('uses \'self\' for connect-src when no connectDomains provided', () => {
      const config = McpAppSandbox.buildSandboxConfig(makeManifest())
      expect(config.csp).toContain("connect-src 'self'")
    })

    it('sandbox attribute contains allow-scripts', () => {
      const config = McpAppSandbox.buildSandboxConfig(makeManifest())
      expect(config.sandbox).toContain('allow-scripts')
    })

    it('sandbox attribute contains allow-same-origin', () => {
      const config = McpAppSandbox.buildSandboxConfig(makeManifest())
      expect(config.sandbox).toContain('allow-same-origin')
    })

    it('generates allow string from permissions', () => {
      const manifest = makeManifest({
        permissions: [
          { type: 'camera' },
          { type: 'microphone' },
        ],
      })
      const config = McpAppSandbox.buildSandboxConfig(manifest)
      expect(config.allow).toContain('camera')
      expect(config.allow).toContain('microphone')
    })

    it('filters unknown permission types', () => {
      const manifest = makeManifest({
        permissions: [
          { type: 'camera' },
          { type: 'unknown-perm' as any },
        ],
      })
      const config = McpAppSandbox.buildSandboxConfig(manifest)
      expect(config.allow).toContain('camera')
      expect(config.allow).not.toContain('unknown-perm')
    })

    it('deduplicates permission allow tokens', () => {
      const manifest = makeManifest({
        permissions: [
          { type: 'camera' },
          { type: 'camera' },
        ],
      })
      const config = McpAppSandbox.buildSandboxConfig(manifest)
      // Should appear only once
      expect(config.allow).toBe('camera')
    })

    it('returns empty allow string when no permissions', () => {
      const config = McpAppSandbox.buildSandboxConfig(makeManifest())
      expect(config.allow).toBe('')
    })
  })

  // -----------------------------------------------------------------------
  // prepareSrcdoc
  // -----------------------------------------------------------------------
  describe('prepareSrcdoc', () => {
    it('returns html, sandbox, and warnings fields', () => {
      const result = McpAppSandbox.prepareSrcdoc('<p>Hello</p>', makeManifest())
      expect(result).toHaveProperty('html')
      expect(result).toHaveProperty('sandbox')
      expect(result).toHaveProperty('warnings')
    })

    it('injects bridge script into the HTML', () => {
      const result = McpAppSandbox.prepareSrcdoc('<p>Hello</p>', makeManifest())
      expect(result.html).toContain('__mcpBridge')
      expect(result.html).toContain('<script>')
    })

    it('includes DOCTYPE and meta tags', () => {
      const result = McpAppSandbox.prepareSrcdoc('<p>Hello</p>', makeManifest())
      expect(result.html).toContain('<!DOCTYPE html>')
      expect(result.html).toContain('Content-Security-Policy')
      expect(result.html).toContain('charset="utf-8"')
    })

    it('includes safe content in body when validation passes', () => {
      const result = McpAppSandbox.prepareSrcdoc('<div>Safe content</div>', makeManifest())
      expect(result.html).toContain('<div>Safe content</div>')
    })

    it('replaces body with error notice when validation fails', () => {
      const badHtml = '<script src="https://evil.com/x.js"></script>'
      const result = McpAppSandbox.prepareSrcdoc(badHtml, makeManifest())
      expect(result.html).toContain('MCP App Blocked')
      // The original script tag should not appear as executable HTML;
      // the URL may still appear in the human-readable error message text.
      expect(result.html).not.toMatch(/<script\b[^>]*\bsrc\s*=\s*["']https:\/\/evil\.com/)
    })

    it('returns sandbox config matching buildSandboxConfig output', () => {
      const manifest = makeManifest({ connectDomains: ['api.test.com'] })
      const result = McpAppSandbox.prepareSrcdoc('<p>Hi</p>', manifest)
      const expected = McpAppSandbox.buildSandboxConfig(manifest)
      expect(result.sandbox).toEqual(expected)
    })
  })

  // -----------------------------------------------------------------------
  // validateTemplate
  // -----------------------------------------------------------------------
  describe('validateTemplate', () => {
    it('returns safe=true for safe HTML', () => {
      const result = McpAppSandbox.validateTemplate('<div>Hello</div>', makeManifest())
      expect(result.safe).toBe(true)
      expect(result.blocked).toHaveLength(0)
    })

    it('blocks external script tags from disallowed domains', () => {
      const html = '<script src="https://evil.com/malware.js"></script>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      expect(result.safe).toBe(false)
      expect(result.blocked.length).toBeGreaterThan(0)
      expect(result.blocked[0]).toContain('evil.com')
    })

    it('allows external scripts from allowed connectDomains', () => {
      const html = '<script src="https://trusted.com/lib.js"></script>'
      const manifest = makeManifest({ connectDomains: ['trusted.com'] })
      const result = McpAppSandbox.validateTemplate(html, manifest)
      // Should not be blocked (domain is allowed)
      const externalBlocked = result.blocked.filter((b) => b.includes('trusted.com'))
      expect(externalBlocked).toHaveLength(0)
    })

    it('blocks window.open calls', () => {
      const html = '<button onclick="window.open(\'https://evil.com\')">Click</button>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      expect(result.safe).toBe(false)
      expect(result.blocked.some((b) => b.includes('window.open'))).toBe(true)
    })

    it('blocks eval() calls', () => {
      const html = '<script>eval("alert(1)")</script>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      expect(result.safe).toBe(false)
      expect(result.blocked.some((b) => b.includes('eval'))).toBe(true)
    })

    it('blocks new Function() constructor', () => {
      const html = '<script>var f = new Function("return 1")</script>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      expect(result.safe).toBe(false)
      expect(result.blocked.some((b) => b.includes('Function'))).toBe(true)
    })

    it('warns about inline scripts but does not block', () => {
      const html = '<script>console.log("hi")</script>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      // Inline scripts produce warnings but are not blocked by themselves
      expect(result.warnings.length).toBeGreaterThan(0)
      expect(result.warnings.some((w) => w.includes('inline script'))).toBe(true)
    })

    it('warns about form actions', () => {
      const html = '<form action="https://exfil.com/steal"><input></form>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      expect(result.warnings.some((w) => w.includes('Form'))).toBe(true)
    })

    it('blocks relative external scripts as unverifiable', () => {
      const html = '<script src="./local-script.js"></script>'
      const result = McpAppSandbox.validateTemplate(html, makeManifest())
      expect(result.safe).toBe(false)
      expect(result.blocked.some((b) => b.includes('unverifiable'))).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // generateBridgeScript
  // -----------------------------------------------------------------------
  describe('generateBridgeScript', () => {
    it('returns a non-empty string', () => {
      const script = McpAppSandbox.generateBridgeScript()
      expect(typeof script).toBe('string')
      expect(script.length).toBeGreaterThan(0)
    })

    it('contains __mcpBridge global', () => {
      const script = McpAppSandbox.generateBridgeScript()
      expect(script).toContain('__mcpBridge')
    })

    it('contains request and notify methods', () => {
      const script = McpAppSandbox.generateBridgeScript()
      expect(script).toContain('request')
      expect(script).toContain('notify')
    })

    it('contains JSON-RPC 2.0 protocol markers', () => {
      const script = McpAppSandbox.generateBridgeScript()
      expect(script).toContain("jsonrpc: '2.0'")
    })

    it('contains postMessage communication', () => {
      const script = McpAppSandbox.generateBridgeScript()
      expect(script).toContain('parent.postMessage')
    })

    it('sends __mcp_ready notification on init', () => {
      const script = McpAppSandbox.generateBridgeScript()
      expect(script).toContain('__mcp_ready')
    })
  })
})
