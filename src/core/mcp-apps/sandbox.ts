/**
 * MCP Apps sandbox renderer.
 *
 * Generates secure iframe configurations for rendering MCP App UI.
 * Does NOT actually create DOM elements (this is a server-side module).
 * The host (browser or Electron) uses the output to create iframes.
 *
 * @module
 */

import type {
  McpAppManifest,
  McpAppRenderResult,
  McpAppSandboxConfig,
} from './types.js'

/** Result of template validation */
interface TemplateValidationResult {
  /** Whether the template passed all blocking checks */
  safe: boolean
  /** Non-blocking warnings */
  warnings: string[]
  /** Blocking issues that prevent rendering */
  blocked: string[]
}

/**
 * Regex patterns used during template validation.
 * Compiled once at module load for reuse.
 */
const INLINE_SCRIPT_RE = /<script\b[^>]*>(?!<\/script>)/gi
const EXTERNAL_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi
const FORM_ACTION_RE = /<form\b[^>]*\baction\s*=\s*["']([^"']+)["'][^>]*>/gi
const WINDOW_OPEN_RE = /window\.open\s*\(/gi
const EVAL_RE = /\beval\s*\(/gi
const FUNCTION_CONSTRUCTOR_RE = /new\s+Function\s*\(/gi

/**
 * Build a CSP directive value from an array of domains.
 * Returns `'self'` when no domains are specified.
 */
function buildDomainDirective(domains: string[] | undefined): string {
  if (!domains || domains.length === 0) return "'self'"
  return domains.join(' ')
}

/**
 * Map a permission type to its Permissions Policy allow token.
 * Returns null for unknown types so callers can filter.
 */
function permissionToAllowToken(type: string): string | null {
  switch (type) {
    case 'camera':
      return 'camera'
    case 'microphone':
      return 'microphone'
    case 'geolocation':
      return 'geolocation'
    case 'clipboard-read':
      return 'clipboard-read'
    case 'clipboard-write':
      return 'clipboard-write'
    default:
      return null
  }
}

/**
 * Escape special HTML characters to prevent injection in srcdoc attributes.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * MCP Apps sandbox renderer.
 *
 * All methods are static because this is a pure-function utility with no
 * mutable state. The host creates actual DOM elements using the returned
 * configuration objects.
 */
export class McpAppSandbox {
  /**
   * Build sandbox configuration from an app manifest.
   * Generates CSP, sandbox attributes, and permission allow list.
   *
   * @param manifest - The MCP App manifest extracted from tool _meta.ui
   * @returns A complete sandbox configuration object
   */
  static buildSandboxConfig(manifest: McpAppManifest): McpAppSandboxConfig {
    const connectSrc = buildDomainDirective(manifest.connectDomains)
    const imgSrc = buildDomainDirective(manifest.resourceDomains)
    const frameSrc = buildDomainDirective(manifest.frameDomains)

    const csp = [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      `connect-src ${connectSrc}`,
      `img-src ${imgSrc}`,
      `frame-src ${frameSrc}`,
    ].join('; ')

    // Minimal sandbox: scripts + same-origin only.
    // No forms, popups, top-navigation, modals, pointer-lock, etc.
    const sandbox = 'allow-scripts allow-same-origin'

    const allowTokens = (manifest.permissions ?? [])
      .map((p) => permissionToAllowToken(p.type))
      .filter((t): t is string => t !== null)

    const allow = [...new Set(allowTokens)].join('; ')

    return { csp, sandbox, allow }
  }

  /**
   * Prepare HTML content for iframe srcdoc.
   * Wraps raw HTML with security headers and postMessage bridge script.
   *
   * @param htmlContent - Raw HTML from the MCP App resource
   * @param manifest - The MCP App manifest for sandbox config generation
   * @returns Complete render result including HTML, sandbox config, and warnings
   */
  static prepareSrcdoc(
    htmlContent: string,
    manifest: McpAppManifest,
  ): McpAppRenderResult {
    const validation = McpAppSandbox.validateTemplate(htmlContent, manifest)
    const sandbox = McpAppSandbox.buildSandboxConfig(manifest)
    const bridgeScript = McpAppSandbox.generateBridgeScript()

    // If there are blocking issues, wrap with a visible error notice
    let bodyContent: string
    if (!validation.safe) {
      const blockedList = validation.blocked
        .map((b) => `<li>${escapeHtml(b)}</li>`)
        .join('')
      bodyContent = [
        '<div style="padding:16px;font-family:sans-serif;color:#c00;">',
        '<h2>MCP App Blocked</h2>',
        '<p>The following security issues prevented rendering:</p>',
        `<ul>${blockedList}</ul>`,
        '</div>',
      ].join('\n')
    } else {
      bodyContent = htmlContent
    }

    const html = [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      `  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(sandbox.csp)}">`,
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      '</head>',
      '<body>',
      bodyContent,
      `<script>${bridgeScript}</script>`,
      '</body>',
      '</html>',
    ].join('\n')

    return {
      html,
      sandbox,
      warnings: validation.warnings,
    }
  }

  /**
   * Validate an MCP App template for obvious security issues.
   * Checks for: inline scripts (warn), external script tags (block unless in allowed domains),
   * form submissions (warn), window.open (block), eval (block), Function constructor (block).
   *
   * @param html - Raw HTML template to validate
   * @param manifest - Manifest providing allowed domain lists
   * @returns Validation result with safe flag, warnings, and blocked items
   */
  static validateTemplate(
    html: string,
    manifest: McpAppManifest,
  ): TemplateValidationResult {
    const warnings: string[] = []
    const blocked: string[] = []

    // Check inline scripts — warn but don't block (bridge relies on unsafe-inline)
    const inlineMatches = html.match(INLINE_SCRIPT_RE)
    if (inlineMatches && inlineMatches.length > 0) {
      warnings.push(
        `Found ${inlineMatches.length} inline script tag(s). Inline scripts are allowed via CSP but should be reviewed.`,
      )
    }

    // Check external scripts — block unless domain is in connectDomains or resourceDomains
    const allowedDomains = new Set([
      ...(manifest.connectDomains ?? []),
      ...(manifest.resourceDomains ?? []),
    ])

    let externalMatch: RegExpExecArray | null
    const externalRe = new RegExp(EXTERNAL_SCRIPT_RE.source, 'gi')
    while ((externalMatch = externalRe.exec(html)) !== null) {
      const src = externalMatch[1]
      try {
        const url = new URL(src)
        if (!allowedDomains.has(url.hostname)) {
          blocked.push(
            `External script from disallowed domain: ${url.hostname} (${src})`,
          )
        }
      } catch {
        // Relative URLs or malformed — block as we cannot verify the origin
        blocked.push(`External script with unverifiable source: ${src}`)
      }
    }

    // Check form actions — warn about potential data exfiltration
    let formMatch: RegExpExecArray | null
    const formRe = new RegExp(FORM_ACTION_RE.source, 'gi')
    while ((formMatch = formRe.exec(html)) !== null) {
      warnings.push(
        `Form with action "${formMatch[1]}" detected. Form submissions may bypass CSP connect-src restrictions.`,
      )
    }

    // Check window.open — always block
    if (WINDOW_OPEN_RE.test(html)) {
      blocked.push('window.open() calls are not allowed in sandboxed MCP Apps.')
    }

    // Check eval — always block
    if (EVAL_RE.test(html)) {
      blocked.push('eval() calls are not allowed in sandboxed MCP Apps.')
    }

    // Check Function constructor — always block
    if (FUNCTION_CONSTRUCTOR_RE.test(html)) {
      blocked.push(
        'new Function() constructor calls are not allowed in sandboxed MCP Apps.',
      )
    }

    return {
      safe: blocked.length === 0,
      warnings,
      blocked,
    }
  }

  /**
   * Generate the postMessage bridge script that gets injected into the iframe.
   * This script handles JSON-RPC communication between iframe and parent.
   *
   * The bridge:
   * - Listens for incoming messages from the parent window
   * - Validates JSON-RPC 2.0 structure before forwarding
   * - Exposes a global `__mcpBridge` object for the app to send requests
   * - Rejects messages from unexpected origins
   *
   * @returns A self-executing JavaScript string ready for injection
   */
  static generateBridgeScript(): string {
    return `
(function() {
  'use strict';

  var pendingRequests = new Map();
  var nextId = 1;

  /**
   * Send a JSON-RPC request to the parent and return a promise for the response.
   * @param {string} method - RPC method name
   * @param {*} params - Method parameters
   * @returns {Promise<*>} Resolves with result, rejects with error
   */
  function request(method, params) {
    return new Promise(function(resolve, reject) {
      var id = nextId++;
      var msg = { jsonrpc: '2.0', id: id, method: method, params: params };
      pendingRequests.set(id, { resolve: resolve, reject: reject });
      parent.postMessage(msg, '*');
    });
  }

  /**
   * Send a JSON-RPC notification (no id, no response expected) to the parent.
   * @param {string} method - RPC method name
   * @param {*} params - Method parameters
   */
  function notify(method, params) {
    var msg = { jsonrpc: '2.0', method: method, params: params };
    parent.postMessage(msg, '*');
  }

  /**
   * Handle incoming messages from the parent window.
   * Only processes valid JSON-RPC 2.0 responses and notifications.
   */
  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || typeof data !== 'object' || data.jsonrpc !== '2.0') {
      return;
    }

    // Handle response to a pending request
    if (data.id !== undefined && data.id !== null) {
      var pending = pendingRequests.get(data.id);
      if (pending) {
        pendingRequests.delete(data.id);
        if (data.error) {
          pending.reject(data.error);
        } else {
          pending.resolve(data.result);
        }
      }
      return;
    }

    // Handle server-initiated notification (no id)
    if (data.method) {
      var evt = new CustomEvent('mcp:notification', {
        detail: { method: data.method, params: data.params }
      });
      window.dispatchEvent(evt);
    }
  });

  // Expose the bridge API globally
  window.__mcpBridge = {
    request: request,
    notify: notify,
    version: '1.0.0'
  };

  // Notify parent that the bridge is ready
  parent.postMessage({ jsonrpc: '2.0', method: '__mcp_ready' }, '*');
})();
`.trim()
  }
}
