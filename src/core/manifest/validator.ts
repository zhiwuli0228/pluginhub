/**
 * Plugin Manifest v1alpha1 validator.
 *
 * Provides two layers of validation:
 *
 * 1. **Structural** (`validate`) — checks required fields, types, patterns,
 *    enums, and array constraints against the JSON Schema specification
 *    without loading the schema file at runtime.
 *
 * 2. **Semantic** (`validateSemantics`) — cross-field constraints that cannot
 *    be expressed in JSON Schema alone (e.g. destructive intents must require
 *    approval, capability refs must resolve to declared components).
 *
 * @module
 */

import type {
  PluginManifest,
  Metadata,
  Components,
  Runtime,
  Permission,
  Trust,
  Routing,
  Intent,
  Entrypoint,
  Discovery,
  Compatibility,
} from './types.js';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** A single validation error with a JSON path, message, and machine-readable code. */
export interface ValidationError {
  /** Dot-separated JSON path to the offending field (e.g. "metadata.id"). */
  path: string;
  /** Human-readable description of the problem. */
  message: string;
  /** Machine-readable error code (e.g. "MISSING_REQUIRED", "INVALID_PATTERN"). */
  code: string;
}

/** A non-fatal warning that does not prevent loading but should be reviewed. */
export interface ValidationWarning {
  /** Dot-separated JSON path related to the warning. */
  path: string;
  /** Human-readable description. */
  message: string;
  /** Machine-readable warning code. */
  code: string;
}

/** Aggregated validation result. */
export interface ValidationResult {
  /** `true` when there are zero errors (warnings are allowed). */
  valid: boolean;
  /** All errors found during validation. */
  errors: ValidationError[];
  /** Non-fatal warnings. */
  warnings: ValidationWarning[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REVERSE_DOMAIN_RE = /^[a-z][a-z0-9]*(\.[a-z0-9][a-z0-9-]*)+$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const KEBAB_ID_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const COMPONENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const REL_PATH_RE = /^\.\//;
const URI_RE = /^[a-z][a-z0-9+.-]*:/i;
const DID_RE = /^did:[a-z0-9]+:.+$/;
const PUBLISHER_DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const CAPABILITY_REF_RE = /^(skill|tool|agent|workflow|app):.+$/;
const TOOL_NAME_PREFIX_RE = /^[a-z][a-z0-9_]{1,19}$/;
const I18N_LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const HEX_DIGEST_RE = /^[0-9a-f]{64,128}$/;

/** Accumulator for building validation results. */
class ResultBuilder {
  readonly errors: ValidationError[] = [];
  readonly warnings: ValidationWarning[] = [];

  error(path: string, message: string, code: string): void {
    this.errors.push({ path, message, code });
  }

  warn(path: string, message: string, code: string): void {
    this.warnings.push({ path, message, code });
  }

  build(): ValidationResult {
    return {
      valid: this.errors.length === 0,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isInteger(v: unknown): v is number {
  return isNumber(v) && Number.isInteger(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function checkPattern(r: ResultBuilder, path: string, value: unknown, re: RegExp, label: string): boolean {
  if (!isString(value)) return false;
  if (!re.test(value)) {
    r.error(path, `Expected ${label}, got "${value}".`, 'INVALID_PATTERN');
    return false;
  }
  return true;
}

function checkEnum(r: ResultBuilder, path: string, value: unknown, allowed: readonly string[]): boolean {
  if (!isString(value)) return false;
  if (!(allowed as readonly string[]).includes(value)) {
    r.error(path, `Expected one of [${allowed.join(', ')}], got "${value}".`, 'INVALID_ENUM');
    return false;
  }
  return true;
}

function checkRequired(r: ResultBuilder, path: string, obj: Record<string, unknown>, key: string): boolean {
  if (!(key in obj) || obj[key] === undefined || obj[key] === null) {
    r.error(`${path}.${key}`, `Missing required field "${key}".`, 'MISSING_REQUIRED');
    return false;
  }
  return true;
}

function checkMinLength(r: ResultBuilder, path: string, value: unknown, min: number): void {
  if (isString(value) && value.length < min) {
    r.error(path, `String must be at least ${min} characters, got ${value.length}.`, 'MIN_LENGTH');
  }
}

function checkMaxLength(r: ResultBuilder, path: string, value: unknown, max: number): void {
  if (isString(value) && value.length > max) {
    r.error(path, `String must be at most ${max} characters, got ${value.length}.`, 'MAX_LENGTH');
  }
}

function checkMinItems(r: ResultBuilder, path: string, arr: unknown, min: number): void {
  if (Array.isArray(arr) && arr.length < min) {
    r.error(path, `Array must have at least ${min} items, got ${arr.length}.`, 'MIN_ITEMS');
  }
}

function checkMaxItems(r: ResultBuilder, path: string, arr: unknown, max: number): void {
  if (Array.isArray(arr) && arr.length > max) {
    r.error(path, `Array must have at most ${max} items, got ${arr.length}.`, 'MAX_ITEMS');
  }
}

function checkMinValue(r: ResultBuilder, path: string, value: unknown, min: number): void {
  if (isNumber(value) && value < min) {
    r.error(path, `Value must be >= ${min}, got ${value}.`, 'MIN_VALUE');
  }
}

// ---------------------------------------------------------------------------
// Structural validators (per-section)
// ---------------------------------------------------------------------------

function validateMetadata(r: ResultBuilder, raw: unknown): void {
  const path = 'metadata';
  if (!isPlainObject(raw)) {
    r.error(path, '"metadata" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  // Required fields
  if (checkRequired(r, path, obj, 'id')) {
    checkPattern(r, `${path}.id`, obj.id, REVERSE_DOMAIN_RE, 'a reverse-domain identifier');
    checkMaxLength(r, `${path}.id`, obj.id, 200);
  }
  if (checkRequired(r, path, obj, 'name')) {
    checkPattern(r, `${path}.name`, obj.name, KEBAB_ID_RE, 'a kebab-case name');
    checkMinLength(r, `${path}.name`, obj.name, 1);
    checkMaxLength(r, `${path}.name`, obj.name, 64);
  }
  if (checkRequired(r, path, obj, 'version')) {
    checkPattern(r, `${path}.version`, obj.version, SEMVER_RE, 'a semver version string');
  }

  // Optional fields
  if ('displayName' in obj && obj.displayName !== undefined) {
    validateI18nString(r, `${path}.displayName`, obj.displayName);
  }
  if ('description' in obj && obj.description !== undefined) {
    if (!isString(obj.description)) {
      r.error(`${path}.description`, '"description" must be a string.', 'INVALID_TYPE');
    } else {
      checkMinLength(r, `${path}.description`, obj.description, 1);
      checkMaxLength(r, `${path}.description`, obj.description, 4000);
    }
  }
  if ('publisher' in obj && obj.publisher !== undefined) {
    validatePublisher(r, `${path}.publisher`, obj.publisher);
  }
  if ('license' in obj && obj.license !== undefined && !isString(obj.license)) {
    r.error(`${path}.license`, '"license" must be a string.', 'INVALID_TYPE');
  }
  if ('homepage' in obj && obj.homepage !== undefined) {
    if (!isString(obj.homepage) || !URI_RE.test(obj.homepage)) {
      r.error(`${path}.homepage`, '"homepage" must be a valid URI.', 'INVALID_FORMAT');
    }
  }
  if ('repository' in obj && obj.repository !== undefined) {
    if (!isString(obj.repository) || !URI_RE.test(obj.repository)) {
      r.error(`${path}.repository`, '"repository" must be a valid URI.', 'INVALID_FORMAT');
    }
  }
  if ('keywords' in obj && obj.keywords !== undefined) {
    if (!Array.isArray(obj.keywords)) {
      r.error(`${path}.keywords`, '"keywords" must be an array.', 'INVALID_TYPE');
    } else {
      checkMaxItems(r, `${path}.keywords`, obj.keywords, 32);
      for (let i = 0; i < obj.keywords.length; i++) {
        if (!isString(obj.keywords[i])) {
          r.error(`${path}.keywords[${i}]`, 'Each keyword must be a string.', 'INVALID_TYPE');
        } else {
          checkMaxLength(r, `${path}.keywords[${i}]`, obj.keywords[i], 40);
        }
      }
    }
  }
  if ('icon' in obj && obj.icon !== undefined) {
    checkPattern(r, `${path}.icon`, obj.icon, REL_PATH_RE, 'a relative path starting with "./"');
  }
}

function validateI18nString(r: ResultBuilder, path: string, value: unknown): void {
  if (isString(value)) {
    checkMaxLength(r, path, value, 4000);
    return;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      r.error(path, 'i18n object must have at least one locale entry.', 'MIN_PROPERTIES');
      return;
    }
    for (const key of keys) {
      if (!I18N_LOCALE_RE.test(key)) {
        r.error(`${path}.${key}`, `Invalid locale key "${key}". Expected pattern like "en" or "en-US".`, 'INVALID_PATTERN');
      }
      if (!isString(value[key])) {
        r.error(`${path}.${key}`, 'Each i18n value must be a string.', 'INVALID_TYPE');
      } else {
        checkMaxLength(r, `${path}.${key}`, value[key], 4000);
      }
    }
    return;
  }
  r.error(path, 'Expected a string or i18n object.', 'INVALID_TYPE');
}

function validatePublisher(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) {
    r.error(path, '"publisher" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (checkRequired(r, path, obj, 'name')) {
    checkMaxLength(r, `${path}.name`, obj.name, 200);
  }
  if (checkRequired(r, path, obj, 'domain')) {
    checkPattern(r, `${path}.domain`, obj.domain, PUBLISHER_DOMAIN_RE, 'a valid domain');
  }
  if ('did' in obj && obj.did !== undefined) {
    checkPattern(r, `${path}.did`, obj.did, DID_RE, 'a DID identifier');
  }
  if ('contact' in obj && obj.contact !== undefined && !isString(obj.contact)) {
    r.error(`${path}.contact`, '"contact" must be a string.', 'INVALID_TYPE');
  }
}

function validateDiscovery(r: ResultBuilder, raw: unknown): void {
  const path = 'discovery';
  if (!isPlainObject(raw)) {
    r.error(path, '"discovery" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  if ('wellKnown' in obj && obj.wellKnown !== undefined) {
    if (!Array.isArray(obj.wellKnown)) {
      r.error(`${path}.wellKnown`, '"wellKnown" must be an array.', 'INVALID_TYPE');
    } else {
      checkMaxItems(r, `${path}.wellKnown`, obj.wellKnown, 8);
      for (let i = 0; i < obj.wellKnown.length; i++) {
        const item = obj.wellKnown[i];
        const ip = `${path}.wellKnown[${i}]`;
        if (!isPlainObject(item)) {
          r.error(ip, 'Each wellKnown entry must be an object.', 'INVALID_TYPE');
          continue;
        }
        const e = item as Record<string, unknown>;
        if (checkRequired(r, ip, e, 'path')) {
          if (!isString(e.path) || !/^\/\.well-known\//.test(e.path)) {
            r.error(`${ip}.path`, 'Path must start with "/.well-known/".', 'INVALID_PATTERN');
          }
        }
      }
    }
  }

  if ('registries' in obj && obj.registries !== undefined) {
    if (!Array.isArray(obj.registries)) {
      r.error(`${path}.registries`, '"registries" must be an array.', 'INVALID_TYPE');
    } else {
      checkMaxItems(r, `${path}.registries`, obj.registries, 16);
      const registryTypes = ['mcp-registry', 'agntcy-dir', 'ai-catalog', 'marketplace', 'oci'] as const;
      for (let i = 0; i < obj.registries.length; i++) {
        const item = obj.registries[i];
        const ip = `${path}.registries[${i}]`;
        if (!isPlainObject(item)) {
          r.error(ip, 'Each registry entry must be an object.', 'INVALID_TYPE');
          continue;
        }
        const e = item as Record<string, unknown>;
        if (checkRequired(r, ip, e, 'type')) {
          checkEnum(r, `${ip}.type`, e.type, registryTypes);
        }
        // At least one of name, cid, url must be present
        const hasName = 'name' in e && e.name !== undefined;
        const hasCid = 'cid' in e && e.cid !== undefined;
        const hasUrl = 'url' in e && e.url !== undefined;
        if (!hasName && !hasCid && !hasUrl) {
          r.error(ip, 'Registry entry must have at least one of "name", "cid", or "url".', 'MISSING_REQUIRED');
        }
      }
    }
  }

  if ('mediaTypes' in obj && obj.mediaTypes !== undefined) {
    if (!Array.isArray(obj.mediaTypes)) {
      r.error(`${path}.mediaTypes`, '"mediaTypes" must be an array.', 'INVALID_TYPE');
    } else {
      const allowed = [
        'application/ai-plugin+json',
        'application/mcp-server+json',
        'application/a2a-agent-card+json',
        'application/ai-card+json',
      ];
      for (let i = 0; i < obj.mediaTypes.length; i++) {
        checkEnum(r, `${path}.mediaTypes[${i}]`, obj.mediaTypes[i], allowed);
      }
    }
  }
}

function validateComponents(r: ResultBuilder, raw: unknown): void {
  const path = 'components';
  if (!isPlainObject(raw)) {
    r.error(path, '"components" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  // Skills
  if ('skills' in obj && obj.skills !== undefined) {
    if (!Array.isArray(obj.skills)) {
      r.error(`${path}.skills`, '"skills" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.skills.length; i++) {
        validateSkillComponent(r, `${path}.skills[${i}]`, obj.skills[i]);
      }
    }
  }

  // MCP Servers
  if ('mcpServers' in obj && obj.mcpServers !== undefined) {
    if (!Array.isArray(obj.mcpServers)) {
      r.error(`${path}.mcpServers`, '"mcpServers" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.mcpServers.length; i++) {
        validateMcpServerComponent(r, `${path}.mcpServers[${i}]`, obj.mcpServers[i]);
      }
    }
  }

  // OpenAPI
  if ('openapi' in obj && obj.openapi !== undefined) {
    if (!Array.isArray(obj.openapi)) {
      r.error(`${path}.openapi`, '"openapi" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.openapi.length; i++) {
        validateOpenApiComponent(r, `${path}.openapi[${i}]`, obj.openapi[i]);
      }
    }
  }

  // Agents
  if ('agents' in obj && obj.agents !== undefined) {
    if (!Array.isArray(obj.agents)) {
      r.error(`${path}.agents`, '"agents" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.agents.length; i++) {
        validateAgentComponent(r, `${path}.agents[${i}]`, obj.agents[i]);
      }
    }
  }

  // Workflows
  if ('workflows' in obj && obj.workflows !== undefined) {
    if (!Array.isArray(obj.workflows)) {
      r.error(`${path}.workflows`, '"workflows" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.workflows.length; i++) {
        validateWorkflowComponent(r, `${path}.workflows[${i}]`, obj.workflows[i]);
      }
    }
  }

  // Apps
  if ('apps' in obj && obj.apps !== undefined) {
    if (!Array.isArray(obj.apps)) {
      r.error(`${path}.apps`, '"apps" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.apps.length; i++) {
        validateAppComponent(r, `${path}.apps[${i}]`, obj.apps[i]);
      }
    }
  }
}

function validateComponentId(r: ResultBuilder, path: string, id: unknown): boolean {
  if (!checkRequired(r, path, { id } as Record<string, unknown>, 'id')) return false;
  return checkPattern(r, `${path}.id`, id, COMPONENT_ID_RE, 'a component id (lowercase alphanumeric and hyphens)');
}

function validateRelPath(r: ResultBuilder, path: string, value: unknown, fieldName: string): boolean {
  if (!checkRequired(r, path, { [fieldName]: value } as Record<string, unknown>, fieldName)) return false;
  return checkPattern(r, `${path}.${fieldName}`, value, REL_PATH_RE, 'a relative path starting with "./"');
}

function validateSkillComponent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each skill must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  validateComponentId(r, path, obj.id);
  if (checkRequired(r, path, obj, 'format')) checkEnum(r, `${path}.format`, obj.format, ['agent-skills/1.0']);
  validateRelPath(r, path, obj.path, 'path');
  if ('enabled' in obj && obj.enabled !== undefined && !isBoolean(obj.enabled)) {
    r.error(`${path}.enabled`, '"enabled" must be a boolean.', 'INVALID_TYPE');
  }
}

function validateMcpServerComponent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each mcpServer must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  validateComponentId(r, path, obj.id);
  if (checkRequired(r, path, obj, 'format')) checkEnum(r, `${path}.format`, obj.format, ['mcp/2026-07-28', 'mcp/2025-06-18']);
  if (checkRequired(r, path, obj, 'config')) {
    checkPattern(r, `${path}.config`, obj.config, REL_PATH_RE, 'a relative path starting with "./"');
  }
}

function validateOpenApiComponent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each openapi component must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  validateComponentId(r, path, obj.id);
  validateRelPath(r, path, obj.document, 'document');
  if (checkRequired(r, path, obj, 'operations')) {
    if (!Array.isArray(obj.operations)) {
      r.error(`${path}.operations`, '"operations" must be an array.', 'INVALID_TYPE');
    } else {
      checkMinItems(r, `${path}.operations`, obj.operations, 1);
      for (let i = 0; i < obj.operations.length; i++) {
        if (!isString(obj.operations[i])) {
          r.error(`${path}.operations[${i}]`, 'Each operation must be a string.', 'INVALID_TYPE');
        }
      }
    }
  }
  if ('exposure' in obj && obj.exposure !== undefined) {
    checkEnum(r, `${path}.exposure`, obj.exposure, ['meta-tools', 'each-operation']);
  }
  if ('baseUrl' in obj && obj.baseUrl !== undefined) {
    if (!isString(obj.baseUrl) || !URI_RE.test(obj.baseUrl)) {
      r.error(`${path}.baseUrl`, '"baseUrl" must be a valid URI.', 'INVALID_FORMAT');
    }
  }
}

function validateAgentComponent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each agent must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  validateComponentId(r, path, obj.id);
  if (checkRequired(r, path, obj, 'format')) checkEnum(r, `${path}.format`, obj.format, ['a2a/1.0']);
  // At least one of card or cardUrl required
  const hasCard = 'card' in obj && obj.card !== undefined;
  const hasCardUrl = 'cardUrl' in obj && obj.cardUrl !== undefined;
  if (!hasCard && !hasCardUrl) {
    r.error(path, 'Agent component must have at least one of "card" or "cardUrl".', 'MISSING_REQUIRED');
  }
  if (hasCard) checkPattern(r, `${path}.card`, obj.card, REL_PATH_RE, 'a relative path starting with "./"');
  if (hasCardUrl && (!isString(obj.cardUrl) || !URI_RE.test(obj.cardUrl))) {
    r.error(`${path}.cardUrl`, '"cardUrl" must be a valid URI.', 'INVALID_FORMAT');
  }
  if ('binding' in obj && obj.binding !== undefined) {
    checkEnum(r, `${path}.binding`, obj.binding, ['JSONRPC', 'GRPC', 'HTTP+JSON']);
  }
}

function validateWorkflowComponent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each workflow must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  validateComponentId(r, path, obj.id);
  if (checkRequired(r, path, obj, 'format')) checkEnum(r, `${path}.format`, obj.format, ['arazzo/1.0', 'agents-json/0.1']);
  validateRelPath(r, path, obj.path, 'path');
}

function validateAppComponent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each app must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  validateComponentId(r, path, obj.id);
  if (checkRequired(r, path, obj, 'format')) checkEnum(r, `${path}.format`, obj.format, ['mcp-apps/2026-01-26']);
  if (checkRequired(r, path, obj, 'extension')) checkEnum(r, `${path}.extension`, obj.extension, ['io.modelcontextprotocol/ui']);
  if (checkRequired(r, path, obj, 'resourceUri')) {
    if (!isString(obj.resourceUri) || !/^ui:\/\//.test(obj.resourceUri as string)) {
      r.error(`${path}.resourceUri`, '"resourceUri" must start with "ui://".', 'INVALID_PATTERN');
    }
  }
  if (checkRequired(r, path, obj, 'fallback')) checkEnum(r, `${path}.fallback`, obj.fallback, ['text', 'structured', 'none']);
}

function validateRuntime(r: ResultBuilder, raw: unknown): void {
  const path = 'runtime';
  if (!isPlainObject(raw)) {
    r.error(path, '"runtime" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  // activation
  if ('activation' in obj && obj.activation !== undefined) {
    checkEnum(r, `${path}.activation`, obj.activation, ['eager', 'lazy', 'on-demand-by-agent', 'manual']);
  }

  // entrypoints (required)
  if (checkRequired(r, path, obj, 'entrypoints')) {
    if (!Array.isArray(obj.entrypoints)) {
      r.error(`${path}.entrypoints`, '"entrypoints" must be an array.', 'INVALID_TYPE');
    } else {
      checkMinItems(r, `${path}.entrypoints`, obj.entrypoints, 1);
      for (let i = 0; i < obj.entrypoints.length; i++) {
        validateEntrypoint(r, `${path}.entrypoints[${i}]`, obj.entrypoints[i]);
      }
    }
  }

  // selection
  if ('selection' in obj && obj.selection !== undefined) {
    checkEnum(r, `${path}.selection`, obj.selection, ['prefer-local', 'prefer-hosted', 'lowest-latency']);
  }

  // health
  if ('health' in obj && obj.health !== undefined) {
    validateHealth(r, `${path}.health`, obj.health);
  }

  // lifecycle
  if ('lifecycle' in obj && obj.lifecycle !== undefined) {
    validateLifecycle(r, `${path}.lifecycle`, obj.lifecycle);
  }

  // resources
  if ('resources' in obj && obj.resources !== undefined) {
    if (!isPlainObject(obj.resources)) {
      r.error(`${path}.resources`, '"resources" must be an object.', 'INVALID_TYPE');
    }
  }

  // sandbox
  if ('sandbox' in obj && obj.sandbox !== undefined) {
    validateSandbox(r, `${path}.sandbox`, obj.sandbox);
  }
}

function validateEntrypoint(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each entrypoint must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;

  validateComponentId(r, path, obj.id);
  const transports = ['stdio', 'streamable-http', 'sse', 'grpc', 'jsonrpc-http', 'http'] as const;
  let transportOk = false;
  if (checkRequired(r, path, obj, 'transport')) {
    transportOk = checkEnum(r, `${path}.transport`, obj.transport, transports);
  }

  // Conditional requirements based on transport
  if (transportOk && isString(obj.transport)) {
    if (obj.transport === 'stdio') {
      if (!('command' in obj) || obj.command === undefined || obj.command === null) {
        r.error(`${path}.command`, 'Entrypoint with transport "stdio" requires "command".', 'MISSING_REQUIRED');
      }
    } else {
      // Non-stdio transports require url
      if (!('url' in obj) || obj.url === undefined || obj.url === null) {
        r.error(`${path}.url`, `Entrypoint with transport "${obj.transport}" requires "url".`, 'MISSING_REQUIRED');
      } else if (!isString(obj.url) || !URI_RE.test(obj.url)) {
        r.error(`${path}.url`, '"url" must be a valid URI.', 'INVALID_FORMAT');
      }
    }
  }

  if ('args' in obj && obj.args !== undefined) {
    if (!Array.isArray(obj.args)) {
      r.error(`${path}.args`, '"args" must be an array of strings.', 'INVALID_TYPE');
    }
  }
  if ('env' in obj && obj.env !== undefined) {
    if (!isPlainObject(obj.env)) {
      r.error(`${path}.env`, '"env" must be an object.', 'INVALID_TYPE');
    }
  }
  if ('platforms' in obj && obj.platforms !== undefined) {
    if (!Array.isArray(obj.platforms)) {
      r.error(`${path}.platforms`, '"platforms" must be an array.', 'INVALID_TYPE');
    } else {
      const plats = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
      for (let i = 0; i < obj.platforms.length; i++) {
        checkEnum(r, `${path}.platforms[${i}]`, obj.platforms[i], plats);
      }
    }
  }
}

function validateHealth(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, '"health" must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  if (checkRequired(r, path, obj, 'probe')) {
    checkEnum(r, `${path}.probe`, obj.probe, ['mcp-server-discover', 'http', 'tcp', 'exec', 'a2a-get-card']);
  }
  if ('intervalSeconds' in obj && obj.intervalSeconds !== undefined) {
    if (!isInteger(obj.intervalSeconds)) {
      r.error(`${path}.intervalSeconds`, '"intervalSeconds" must be an integer.', 'INVALID_TYPE');
    } else {
      checkMinValue(r, `${path}.intervalSeconds`, obj.intervalSeconds, 5);
    }
  }
  if ('timeoutSeconds' in obj && obj.timeoutSeconds !== undefined) {
    if (!isInteger(obj.timeoutSeconds)) {
      r.error(`${path}.timeoutSeconds`, '"timeoutSeconds" must be an integer.', 'INVALID_TYPE');
    } else {
      checkMinValue(r, `${path}.timeoutSeconds`, obj.timeoutSeconds, 1);
    }
  }
  if ('failureThreshold' in obj && obj.failureThreshold !== undefined) {
    if (!isInteger(obj.failureThreshold)) {
      r.error(`${path}.failureThreshold`, '"failureThreshold" must be an integer.', 'INVALID_TYPE');
    } else {
      checkMinValue(r, `${path}.failureThreshold`, obj.failureThreshold, 1);
    }
  }
}

function validateLifecycle(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, '"lifecycle" must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  if ('startTimeoutSeconds' in obj && obj.startTimeoutSeconds !== undefined) {
    if (!isInteger(obj.startTimeoutSeconds)) r.error(`${path}.startTimeoutSeconds`, 'Must be an integer.', 'INVALID_TYPE');
    else checkMinValue(r, `${path}.startTimeoutSeconds`, obj.startTimeoutSeconds, 1);
  }
  if ('idleTimeoutSeconds' in obj && obj.idleTimeoutSeconds !== undefined) {
    if (!isInteger(obj.idleTimeoutSeconds)) r.error(`${path}.idleTimeoutSeconds`, 'Must be an integer.', 'INVALID_TYPE');
    else checkMinValue(r, `${path}.idleTimeoutSeconds`, obj.idleTimeoutSeconds, 0);
  }
  if ('restartPolicy' in obj && obj.restartPolicy !== undefined) {
    checkEnum(r, `${path}.restartPolicy`, obj.restartPolicy, ['never', 'on-failure', 'always']);
  }
  if ('maxRestarts' in obj && obj.maxRestarts !== undefined) {
    if (!isInteger(obj.maxRestarts)) r.error(`${path}.maxRestarts`, 'Must be an integer.', 'INVALID_TYPE');
    else checkMinValue(r, `${path}.maxRestarts`, obj.maxRestarts, 0);
  }
  if ('shutdownGraceSeconds' in obj && obj.shutdownGraceSeconds !== undefined) {
    if (!isInteger(obj.shutdownGraceSeconds)) r.error(`${path}.shutdownGraceSeconds`, 'Must be an integer.', 'INVALID_TYPE');
    else checkMinValue(r, `${path}.shutdownGraceSeconds`, obj.shutdownGraceSeconds, 0);
  }
}

function validateSandbox(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, '"sandbox" must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;
  if ('profile' in obj && obj.profile !== undefined) {
    checkEnum(r, `${path}.profile`, obj.profile, ['none', 'restricted', 'strict']);
  }
}

function validatePermissions(r: ResultBuilder, raw: unknown): void {
  const path = 'permissions';
  if (!Array.isArray(raw)) {
    r.error(path, '"permissions" must be an array.', 'INVALID_TYPE');
    return;
  }
  const allowedIds = [
    'fs.read.workspace', 'fs.read.home', 'net.egress', 'exec',
    'secrets.read', 'artifact.write', 'clipboard.write', 'device.access',
  ];
  for (let i = 0; i < raw.length; i++) {
    const ip = `${path}[${i}]`;
    if (!isPlainObject(raw[i])) {
      r.error(ip, 'Each permission must be an object.', 'INVALID_TYPE');
      continue;
    }
    const obj = raw[i] as Record<string, unknown>;
    if (checkRequired(r, ip, obj, 'id')) {
      checkEnum(r, `${ip}.id`, obj.id, allowedIds);
    }
    if ('reason' in obj && obj.reason !== undefined) {
      checkMaxLength(r, `${ip}.reason`, obj.reason, 500);
    }
    if ('ttlSeconds' in obj && obj.ttlSeconds !== undefined) {
      if (!isInteger(obj.ttlSeconds)) {
        r.error(`${ip}.ttlSeconds`, '"ttlSeconds" must be an integer.', 'INVALID_TYPE');
      } else {
        checkMinValue(r, `${ip}.ttlSeconds`, obj.ttlSeconds, 0);
      }
    }
  }
}

function validateTrust(r: ResultBuilder, raw: unknown): void {
  const path = 'trust';
  if (!isPlainObject(raw)) {
    r.error(path, '"trust" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  // signing
  if ('signing' in obj && obj.signing !== undefined) {
    if (!isPlainObject(obj.signing)) {
      r.error(`${path}.signing`, '"signing" must be an object.', 'INVALID_TYPE');
    } else {
      const s = obj.signing as Record<string, unknown>;
      if (checkRequired(r, `${path}.signing`, s, 'algorithm')) {
        checkEnum(r, `${path}.signing.algorithm`, s.algorithm, ['ES256', 'ES384', 'EdDSA', 'RS256', 'PS256']);
      }
      checkRequired(r, `${path}.signing`, s, 'keyId');
      if (checkRequired(r, `${path}.signing`, s, 'signatureRef')) {
        checkPattern(r, `${path}.signing.signatureRef`, s.signatureRef, REL_PATH_RE, 'a relative path starting with "./"');
      }
    }
  }

  // integrity
  if ('integrity' in obj && obj.integrity !== undefined) {
    if (!isPlainObject(obj.integrity)) {
      r.error(`${path}.integrity`, '"integrity" must be an object.', 'INVALID_TYPE');
    } else {
      const ig = obj.integrity as Record<string, unknown>;
      if (checkRequired(r, `${path}.integrity`, ig, 'algorithm')) {
        checkEnum(r, `${path}.integrity.algorithm`, ig.algorithm, ['sha256', 'sha512']);
      }
      if (checkRequired(r, `${path}.integrity`, ig, 'digest')) {
        checkPattern(r, `${path}.integrity.digest`, ig.digest, HEX_DIGEST_RE, 'a hex-encoded digest (64–128 hex chars)');
      }
    }
  }

  // provenance
  if ('provenance' in obj && obj.provenance !== undefined) {
    if (!isPlainObject(obj.provenance)) {
      r.error(`${path}.provenance`, '"provenance" must be an object.', 'INVALID_TYPE');
    } else {
      const p = obj.provenance as Record<string, unknown>;
      if (checkRequired(r, `${path}.provenance`, p, 'type')) {
        checkEnum(r, `${path}.provenance.type`, p.type, ['slsa/v1', 'in-toto', 'sigstore-bundle']);
      }
      if (checkRequired(r, `${path}.provenance`, p, 'uri')) {
        if (!isString(p.uri) || !URI_RE.test(p.uri)) {
          r.error(`${path}.provenance.uri`, '"uri" must be a valid URI.', 'INVALID_FORMAT');
        }
      }
    }
  }

  // attestations
  if ('attestations' in obj && obj.attestations !== undefined) {
    if (!Array.isArray(obj.attestations)) {
      r.error(`${path}.attestations`, '"attestations" must be an array.', 'INVALID_TYPE');
    } else {
      const attTypes = ['soc2-type2', 'iso27001', 'hipaa', 'gdpr-dpa', 'custom'];
      for (let i = 0; i < obj.attestations.length; i++) {
        const ip = `${path}.attestations[${i}]`;
        if (!isPlainObject(obj.attestations[i])) {
          r.error(ip, 'Each attestation must be an object.', 'INVALID_TYPE');
          continue;
        }
        const a = obj.attestations[i] as Record<string, unknown>;
        if (checkRequired(r, ip, a, 'type')) checkEnum(r, `${ip}.type`, a.type, attTypes);
        if (checkRequired(r, ip, a, 'uri')) {
          if (!isString(a.uri) || !URI_RE.test(a.uri)) r.error(`${ip}.uri`, '"uri" must be a valid URI.', 'INVALID_FORMAT');
        }
      }
    }
  }

  // publisherVerification
  if ('publisherVerification' in obj && obj.publisherVerification !== undefined) {
    if (!isPlainObject(obj.publisherVerification)) {
      r.error(`${path}.publisherVerification`, '"publisherVerification" must be an object.', 'INVALID_TYPE');
    } else {
      const pv = obj.publisherVerification as Record<string, unknown>;
      if (checkRequired(r, `${path}.publisherVerification`, pv, 'method')) {
        checkEnum(r, `${path}.publisherVerification.method`, pv.method, ['well-known-jwks', 'did', 'oidc', 'spiffe', 'manual']);
      }
    }
  }
}

function validateRouting(r: ResultBuilder, raw: unknown): void {
  const path = 'routing';
  if (!isPlainObject(raw)) {
    r.error(path, '"routing" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  // intents
  if ('intents' in obj && obj.intents !== undefined) {
    if (!Array.isArray(obj.intents)) {
      r.error(`${path}.intents`, '"intents" must be an array.', 'INVALID_TYPE');
    } else {
      for (let i = 0; i < obj.intents.length; i++) {
        validateIntent(r, `${path}.intents[${i}]`, obj.intents[i]);
      }
    }
  }

  // triggers
  if ('triggers' in obj && obj.triggers !== undefined) {
    if (!Array.isArray(obj.triggers)) {
      r.error(`${path}.triggers`, '"triggers" must be an array.', 'INVALID_TYPE');
    } else {
      const triggerTypes = ['event', 'schedule', 'webhook', 'file-change'];
      for (let i = 0; i < obj.triggers.length; i++) {
        const ip = `${path}.triggers[${i}]`;
        if (!isPlainObject(obj.triggers[i])) {
          r.error(ip, 'Each trigger must be an object.', 'INVALID_TYPE');
          continue;
        }
        const t = obj.triggers[i] as Record<string, unknown>;
        if (checkRequired(r, ip, t, 'type')) checkEnum(r, `${ip}.type`, t.type, triggerTypes);
        if (checkRequired(r, ip, t, 'capabilityRefs')) {
          if (!Array.isArray(t.capabilityRefs)) r.error(`${ip}.capabilityRefs`, 'Must be an array.', 'INVALID_TYPE');
        }
      }
    }
  }

  // concurrency
  if ('concurrency' in obj && obj.concurrency !== undefined) {
    if (!isPlainObject(obj.concurrency)) {
      r.error(`${path}.concurrency`, '"concurrency" must be an object.', 'INVALID_TYPE');
    } else {
      const c = obj.concurrency as Record<string, unknown>;
      if ('maxParallel' in c && c.maxParallel !== undefined) {
        if (!isInteger(c.maxParallel)) r.error(`${path}.concurrency.maxParallel`, 'Must be an integer.', 'INVALID_TYPE');
        else checkMinValue(r, `${path}.concurrency.maxParallel`, c.maxParallel, 1);
      }
    }
  }

  // context
  if ('context' in obj && obj.context !== undefined) {
    if (!isPlainObject(obj.context)) {
      r.error(`${path}.context`, '"context" must be an object.', 'INVALID_TYPE');
    } else {
      const ctx = obj.context as Record<string, unknown>;
      if ('tokenBudgetHint' in ctx && ctx.tokenBudgetHint !== undefined) {
        if (!isInteger(ctx.tokenBudgetHint)) r.error(`${path}.context.tokenBudgetHint`, 'Must be an integer.', 'INVALID_TYPE');
        else checkMinValue(r, `${path}.context.tokenBudgetHint`, ctx.tokenBudgetHint, 0);
      }
      if ('toolNamePrefix' in ctx && ctx.toolNamePrefix !== undefined) {
        checkPattern(r, `${path}.context.toolNamePrefix`, ctx.toolNamePrefix, TOOL_NAME_PREFIX_RE, 'a tool name prefix matching ^[a-z][a-z0-9_]{1,19}$');
      }
    }
  }
}

function validateIntent(r: ResultBuilder, path: string, raw: unknown): void {
  if (!isPlainObject(raw)) { r.error(path, 'Each intent must be an object.', 'INVALID_TYPE'); return; }
  const obj = raw as Record<string, unknown>;

  validateComponentId(r, path, obj.id);

  // examples
  if (checkRequired(r, path, obj, 'examples')) {
    if (!Array.isArray(obj.examples)) {
      r.error(`${path}.examples`, '"examples" must be an array.', 'INVALID_TYPE');
    } else {
      checkMinItems(r, `${path}.examples`, obj.examples, 2);
      checkMaxItems(r, `${path}.examples`, obj.examples, 20);
      for (let i = 0; i < obj.examples.length; i++) {
        if (!isString(obj.examples[i])) {
          r.error(`${path}.examples[${i}]`, 'Each example must be a string.', 'INVALID_TYPE');
        } else {
          checkMaxLength(r, `${path}.examples[${i}]`, obj.examples[i], 200);
        }
      }
    }
  }

  // capabilityRefs
  if (checkRequired(r, path, obj, 'capabilityRefs')) {
    if (!Array.isArray(obj.capabilityRefs)) {
      r.error(`${path}.capabilityRefs`, '"capabilityRefs" must be an array.', 'INVALID_TYPE');
    } else {
      checkMinItems(r, `${path}.capabilityRefs`, obj.capabilityRefs, 1);
      for (let i = 0; i < obj.capabilityRefs.length; i++) {
        checkPattern(r, `${path}.capabilityRefs[${i}]`, obj.capabilityRefs[i], CAPABILITY_REF_RE, 'a capability ref like "skill:name" or "tool:name"');
      }
    }
  }

  // mode
  if (checkRequired(r, path, obj, 'mode')) {
    checkEnum(r, `${path}.mode`, obj.mode, ['tool', 'skill', 'agent', 'workflow']);
  }

  // optional enums
  if ('costHint' in obj && obj.costHint !== undefined) checkEnum(r, `${path}.costHint`, obj.costHint, ['low', 'medium', 'high']);
  if ('latencyHint' in obj && obj.latencyHint !== undefined) checkEnum(r, `${path}.latencyHint`, obj.latencyHint, ['instant', 'seconds', 'minutes', 'hours']);
  if ('requiresApproval' in obj && obj.requiresApproval !== undefined && !isBoolean(obj.requiresApproval)) {
    r.error(`${path}.requiresApproval`, '"requiresApproval" must be a boolean.', 'INVALID_TYPE');
  }
  if ('destructive' in obj && obj.destructive !== undefined && !isBoolean(obj.destructive)) {
    r.error(`${path}.destructive`, '"destructive" must be a boolean.', 'INVALID_TYPE');
  }
}

function validateCompatibility(r: ResultBuilder, raw: unknown): void {
  const path = 'compatibility';
  if (!isPlainObject(raw)) {
    r.error(path, '"compatibility" must be an object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  if ('platforms' in obj && obj.platforms !== undefined) {
    if (!Array.isArray(obj.platforms)) {
      r.error(`${path}.platforms`, '"platforms" must be an array.', 'INVALID_TYPE');
    } else {
      const plats = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];
      for (let i = 0; i < obj.platforms.length; i++) {
        checkEnum(r, `${path}.platforms[${i}]`, obj.platforms[i], plats);
      }
    }
  }
}

function validateExtensions(r: ResultBuilder, raw: unknown): void {
  const path = 'extensions';
  if (!isPlainObject(raw)) {
    r.error(path, '"extensions" must be an object.', 'INVALID_TYPE');
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!REVERSE_DOMAIN_RE.test(key)) {
      r.error(`${path}.${key}`, `Extension key "${key}" must match reverse-domain pattern.`, 'INVALID_PATTERN');
    }
  }
}

// ---------------------------------------------------------------------------
// Top-level structural validation
// ---------------------------------------------------------------------------

function validateTopLevel(r: ResultBuilder, raw: unknown): void {
  if (!isPlainObject(raw)) {
    r.error('$', 'Manifest must be a non-null object.', 'INVALID_TYPE');
    return;
  }
  const obj = raw as Record<string, unknown>;

  // apiVersion
  if (checkRequired(r, '$', obj, 'apiVersion')) {
    checkEnum(r, 'apiVersion', obj.apiVersion, ['plugin.agenthub.io/v1alpha1']);
  }

  // kind
  if (checkRequired(r, '$', obj, 'kind')) {
    checkEnum(r, 'kind', obj.kind, ['Plugin']);
  }

  // metadata (required)
  if (checkRequired(r, '$', obj, 'metadata')) {
    validateMetadata(r, obj.metadata);
  }

  // Optional sections
  if ('discovery' in obj && obj.discovery !== undefined) validateDiscovery(r, obj.discovery);
  if ('components' in obj && obj.components !== undefined) validateComponents(r, obj.components);
  if ('runtime' in obj && obj.runtime !== undefined) validateRuntime(r, obj.runtime);
  if ('permissions' in obj && obj.permissions !== undefined) validatePermissions(r, obj.permissions);
  if ('trust' in obj && obj.trust !== undefined) validateTrust(r, obj.trust);
  if ('routing' in obj && obj.routing !== undefined) validateRouting(r, obj.routing);
  if ('compatibility' in obj && obj.compatibility !== undefined) validateCompatibility(r, obj.compatibility);
  if ('extensions' in obj && obj.extensions !== undefined) validateExtensions(r, obj.extensions);
}

// ---------------------------------------------------------------------------
// Semantic validation
// ---------------------------------------------------------------------------

/**
 * Collect all component IDs grouped by type prefix for capability ref resolution.
 */
function collectComponentIds(components: Components | undefined): Set<string> {
  const ids = new Set<string>();
  if (!components) return ids;

  if (components.skills) {
    for (const s of components.skills) ids.add(`skill:${s.id}`);
  }
  if (components.mcpServers) {
    for (const m of components.mcpServers) ids.add(`tool:${m.id}`);
  }
  if (components.openapi) {
    for (const o of components.openapi) ids.add(`tool:${o.id}`);
  }
  if (components.agents) {
    for (const a of components.agents) ids.add(`agent:${a.id}`);
  }
  if (components.workflows) {
    for (const w of components.workflows) ids.add(`workflow:${w.id}`);
  }
  if (components.apps) {
    for (const a of components.apps) ids.add(`app:${a.id}`);
  }

  return ids;
}

function validateSemanticsInternal(r: ResultBuilder, manifest: PluginManifest): void {
  // Rule 1: trust.signing.algorithm != "HS256"
  // (Already enforced structurally via enum, but double-check for safety)
  if (manifest.trust?.signing) {
    const alg = manifest.trust.signing.algorithm;
    if (alg === 'HS256' as string) {
      r.error('trust.signing.algorithm', 'HS256 is not allowed for plugin manifests. Use an asymmetric algorithm.', 'FORBIDDEN_ALGORITHM');
    }
  }

  // Rule 2: routing.intents[].destructive == true ⇒ requiresApproval == true
  if (manifest.routing?.intents) {
    for (let i = 0; i < manifest.routing.intents.length; i++) {
      const intent = manifest.routing.intents[i];
      if (intent.destructive === true && intent.requiresApproval !== true) {
        r.error(
          `routing.intents[${i}]`,
          `Intent "${intent.id}" is marked destructive but does not set requiresApproval to true.`,
          'DESTRUCTIVE_REQUIRES_APPROVAL',
        );
      }
    }
  }

  // Rule 3: components.openapi[].operations must be non-empty (already checked structurally via minItems)
  // This is covered by structural validation, but we add a semantic warning if operations look suspiciously broad
  if (manifest.components?.openapi) {
    for (let i = 0; i < manifest.components.openapi.length; i++) {
      const comp = manifest.components.openapi[i];
      if (comp.operations && comp.operations.length > 50) {
        r.warn(
          `components.openapi[${i}].operations`,
          `OpenAPI component "${comp.id}" exposes ${comp.operations.length} operations. Consider narrowing the whitelist.`,
          'BROAD_OPERATION_EXPOSURE',
        );
      }
    }
  }

  // Rule 4: extensions keys must match reverse-domain regex (already checked structurally)
  // Covered in validateExtensions above.

  // Rule 5: routing.intents[].capabilityRefs must resolve in components
  const componentIds = collectComponentIds(manifest.components);
  if (manifest.routing?.intents) {
    for (let i = 0; i < manifest.routing.intents.length; i++) {
      const intent = manifest.routing.intents[i];
      if (intent.capabilityRefs) {
        for (let j = 0; j < intent.capabilityRefs.length; j++) {
          const ref = intent.capabilityRefs[j];
          if (!componentIds.has(ref)) {
            r.error(
              `routing.intents[${i}].capabilityRefs[${j}]`,
              `Capability ref "${ref}" in intent "${intent.id}" cannot be resolved in components.`,
              'UNRESOLVABLE_CAPABILITY_REF',
            );
          }
        }
      }
    }
  }

  // Also check trigger capabilityRefs
  if (manifest.routing?.triggers) {
    for (let i = 0; i < manifest.routing.triggers.length; i++) {
      const trigger = manifest.routing.triggers[i];
      if (trigger.capabilityRefs) {
        for (let j = 0; j < trigger.capabilityRefs.length; j++) {
          const ref = trigger.capabilityRefs[j];
          if (!componentIds.has(ref)) {
            r.warn(
              `routing.triggers[${i}].capabilityRefs[${j}]`,
              `Capability ref "${ref}" in trigger cannot be resolved in components.`,
              'UNRESOLVABLE_TRIGGER_REF',
            );
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Stateless validator for Plugin Manifest v1alpha1 documents.
 */
export class ManifestValidator {
  /**
   * Perform structural validation against the JSON Schema specification.
   *
   * Checks required fields, types, patterns, enums, and array constraints.
   * Does **not** load the schema file at runtime — all rules are hand-coded.
   *
   * @param manifest - The parsed manifest object (or any unknown input).
   * @returns Validation result with errors and warnings.
   */
  static validate(manifest: unknown): ValidationResult {
    const r = new ResultBuilder();
    validateTopLevel(r, manifest);
    return r.build();
  }

  /**
   * Perform semantic (cross-field) validation on a structurally valid manifest.
   *
   * Call {@link validate} first to ensure the manifest is structurally sound.
   * Semantic rules include:
   *
   * - `trust.signing.algorithm` must not be `"HS256"`
   * - Destructive intents must set `requiresApproval: true`
   * - `capabilityRefs` in intents must resolve to declared components
   * - Extension keys must follow reverse-domain naming
   *
   * @param manifest - A structurally valid {@link PluginManifest}.
   * @returns Validation result with semantic errors and warnings.
   */
  static validateSemantics(manifest: PluginManifest): ValidationResult {
    const r = new ResultBuilder();
    validateSemanticsInternal(r, manifest);
    return r.build();
  }
}
