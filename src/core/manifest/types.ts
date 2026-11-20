/**
 * Plugin Manifest v1alpha1 TypeScript type definitions.
 *
 * These types correspond to the JSON Schema at
 * `docs/03-specs/plugin-manifest/manifest.schema.json` (JSON Schema 2020-12).
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** A string that is either a plain value or an i18n map keyed by locale tag. */
export type I18nString = string | Record<string, string>;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Publisher identity block. */
export interface Publisher {
  /** Human-readable publisher name. */
  name: string;
  /** Trust anchor domain used for well-known verification and namespace ownership. */
  domain: string;
  /** Optional DID identifier. */
  did?: string;
  /** Optional contact information. */
  contact?: string;
}

/** Core plugin identity and descriptive metadata. */
export interface Metadata {
  /** Globally unique, immutable reverse-domain identifier. */
  id: string;
  /** Machine-friendly kebab-case name. */
  name: string;
  /** Human-readable display name (supports i18n). */
  displayName?: I18nString;
  /** Semantic version string. */
  version: string;
  /** Description used for discovery and semantic routing. */
  description?: string;
  /** Publisher identity. */
  publisher?: Publisher;
  /** SPDX license identifier. */
  license?: string;
  /** Project homepage URL. */
  homepage?: string;
  /** Source repository URL. */
  repository?: string;
  /** Discovery keywords (max 32). */
  keywords?: string[];
  /** Icon path relative to plugin root. */
  icon?: string;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Well-known endpoint declaration. */
export interface WellKnownEntry {
  /** Path under /.well-known/. */
  path: string;
  /** Optional entry identifier. */
  entryId?: string;
  /** Optional media type. */
  mediaType?: string;
}

/** Registry reference for plugin discovery. */
export interface RegistryEntry {
  /** Registry type. */
  type: 'mcp-registry' | 'agntcy-dir' | 'ai-catalog' | 'marketplace' | 'oci';
  /** Registry-specific name (reverse DNS for mcp-registry). */
  name?: string;
  /** Content identifier (for agntcy-dir). */
  cid?: string;
  /** Registry URL. */
  url?: string;
}

/** Supported media types for AI Catalog entries. */
export type DiscoveryMediaType =
  | 'application/ai-plugin+json'
  | 'application/mcp-server+json'
  | 'application/a2a-agent-card+json'
  | 'application/ai-card+json';

/** Declares where this plugin can be discovered. */
export interface Discovery {
  /** Well-known endpoints. */
  wellKnown?: WellKnownEntry[];
  /** External registries. */
  registries?: RegistryEntry[];
  /** Media types for AI Catalog alignment. */
  mediaTypes?: DiscoveryMediaType[];
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Agent Skill component reference. */
export interface SkillComponent {
  /** Component identifier (kebab-case). */
  id: string;
  /** Skill format version. */
  format: 'agent-skills/1.0';
  /** Relative path to SKILL.md. */
  path: string;
  /** Whether this skill is enabled (default true). */
  enabled?: boolean;
}

/** MCP server component reference. */
export interface McpServerComponent {
  /** Component identifier (kebab-case). */
  id: string;
  /** MCP protocol format version. */
  format: 'mcp/2026-07-28' | 'mcp/2025-06-18';
  /** Relative path to mcp.json configuration. */
  config: string;
}

/** OpenAPI component reference. */
export interface OpenApiComponent {
  /** Component identifier (kebab-case). */
  id: string;
  /** Relative path to OpenAPI document. */
  document: string;
  /** Base URL override. */
  baseUrl?: string;
  /** Whitelisted operation IDs (must not be empty). */
  operations: string[];
  /** Exposure strategy (default "meta-tools"). */
  exposure?: 'meta-tools' | 'each-operation';
}

/** A2A agent component reference. */
export interface AgentComponent {
  /** Component identifier (kebab-case). */
  id: string;
  /** Agent card format version. */
  format: 'a2a/1.0';
  /** Relative path to agent card JSON. */
  card?: string;
  /** Remote agent card URL. */
  cardUrl?: string;
  /** Agent endpoint URL. */
  url?: string;
  /** Transport binding. */
  binding?: 'JSONRPC' | 'GRPC' | 'HTTP+JSON';
}

/** Workflow component reference. */
export interface WorkflowComponent {
  /** Component identifier (kebab-case). */
  id: string;
  /** Workflow format version. */
  format: 'arazzo/1.0' | 'agents-json/0.1';
  /** Relative path to workflow definition. */
  path: string;
}

/** MCP Apps rich UI component. */
export interface AppComponent {
  /** Component identifier (kebab-case). */
  id: string;
  /** App format version. */
  format: 'mcp-apps/2026-01-26';
  /** Extension identifier. */
  extension: 'io.modelcontextprotocol/ui';
  /** Resource URI with ui:// scheme. */
  resourceUri: string;
  /** Fallback behaviour when host lacks UI support. */
  fallback: 'text' | 'structured' | 'none';
}

/** All component types that a plugin can declare. */
export interface Components {
  skills?: SkillComponent[];
  mcpServers?: McpServerComponent[];
  openapi?: OpenApiComponent[];
  agents?: AgentComponent[];
  workflows?: WorkflowComponent[];
  apps?: AppComponent[];
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/** Activation strategy. */
export type ActivationMode = 'eager' | 'lazy' | 'on-demand-by-agent' | 'manual';

/** Supported transport protocols. */
export type Transport =
  | 'stdio'
  | 'streamable-http'
  | 'sse'
  | 'grpc'
  | 'jsonrpc-http'
  | 'http';

/** Target platform identifiers. */
export type Platform =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'win32-x64'
  | 'win32-arm64';

/** Entrypoint descriptor for launching the plugin runtime. */
export interface Entrypoint {
  /** Entrypoint identifier (kebab-case). */
  id: string;
  /** Transport protocol. */
  transport: Transport;
  /** Command to execute (required for stdio transport). */
  command?: string;
  /** Command arguments. */
  args?: string[];
  /** Working directory. */
  cwd?: string;
  /** Non-sensitive environment variables (secrets via permissions.secrets.read). */
  env?: Record<string, string>;
  /** Endpoint URL (required for non-stdio transports). */
  url?: string;
  /** Supported protocol versions. */
  protocolVersions?: string[];
  /** Target platforms. */
  platforms?: Platform[];
}

/** Selection preference when multiple entrypoints are available. */
export type SelectionStrategy = 'prefer-local' | 'prefer-hosted' | 'lowest-latency';

/** Health probe configuration. */
export interface HealthConfig {
  /** Probe type. */
  probe: 'mcp-server-discover' | 'http' | 'tcp' | 'exec' | 'a2a-get-card';
  /** Probe path (for http probes). */
  path?: string;
  /** Probe interval in seconds (default 30, min 5). */
  intervalSeconds?: number;
  /** Probe timeout in seconds (default 5, min 1). */
  timeoutSeconds?: number;
  /** Consecutive failures before marking unhealthy (default 3, min 1). */
  failureThreshold?: number;
}

/** Lifecycle management settings. */
export interface LifecycleConfig {
  /** Max seconds to wait for startup (default 20). */
  startTimeoutSeconds?: number;
  /** Seconds of idle time before shutdown (default 900, 0 = never). */
  idleTimeoutSeconds?: number;
  /** Restart policy (default "on-failure"). */
  restartPolicy?: 'never' | 'on-failure' | 'always';
  /** Maximum restart attempts (default 3). */
  maxRestarts?: number;
  /** Grace period for graceful shutdown in seconds (default 10). */
  shutdownGraceSeconds?: number;
}

/** Resource limits. */
export interface ResourceLimits {
  /** CPU limit (e.g. "500m", "2"). */
  cpu?: string;
  /** Memory limit (e.g. "256Mi", "1Gi"). */
  memory?: string;
  /** GPU requirement. */
  gpu?: string;
}

/** Filesystem sandbox rules. */
export interface FilesystemSandbox {
  /** Readable paths. */
  read?: string[];
  /** Writable paths. */
  write?: string[];
}

/** Network sandbox rules. */
export interface NetworkSandbox {
  /** Allowed egress destinations. */
  egress?: string[];
}

/** Sandbox configuration. */
export interface SandboxConfig {
  /** Sandbox profile (default "restricted"). */
  profile?: 'none' | 'restricted' | 'strict';
  /** Filesystem access rules. */
  filesystem?: FilesystemSandbox;
  /** Network access rules. */
  network?: NetworkSandbox;
}

/** Runtime configuration for plugin execution. */
export interface Runtime {
  /** Activation strategy (default "lazy"). */
  activation?: ActivationMode;
  /** Entrypoints (at least one required). */
  entrypoints: Entrypoint[];
  /** Selection strategy when multiple entrypoints match (default "prefer-local"). */
  selection?: SelectionStrategy;
  /** Health check configuration. */
  health?: HealthConfig;
  /** Lifecycle management. */
  lifecycle?: LifecycleConfig;
  /** Resource limits. */
  resources?: ResourceLimits;
  /** Sandbox configuration. */
  sandbox?: SandboxConfig;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/** Permission identifiers. */
export type PermissionId =
  | 'fs.read.workspace'
  | 'fs.read.home'
  | 'net.egress'
  | 'exec'
  | 'secrets.read'
  | 'artifact.write'
  | 'clipboard.write'
  | 'device.access';

/** A single permission declaration. */
export interface Permission {
  /** Permission identifier. */
  id: PermissionId;
  /** Scope qualifier. */
  scope?: string;
  /** Allowed hosts (for net.egress). */
  hosts?: string[];
  /** Allowed HTTP methods. */
  methods?: string[];
  /** Allowed commands (for exec). */
  commands?: string[];
  /** Secret reference paths (for secrets.read). */
  refs?: string[];
  /** Time-to-live in seconds. */
  ttlSeconds?: number;
  /** Human-readable justification. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/** Signing algorithm (asymmetric only). */
export type SigningAlgorithm = 'ES256' | 'ES384' | 'EdDSA' | 'RS256' | 'PS256';

/** Digital signature configuration. */
export interface SigningConfig {
  /** Asymmetric signing algorithm. */
  algorithm: SigningAlgorithm;
  /** Key identifier. */
  keyId: string;
  /** Relative path to signature file. */
  signatureRef: string;
  /** Top-level fields included in the signature (JCS canonicalized). */
  signedFields?: string[];
}

/** Integrity hash algorithm. */
export type IntegrityAlgorithm = 'sha256' | 'sha512';

/** Content integrity verification. */
export interface IntegrityConfig {
  /** Hash algorithm. */
  algorithm: IntegrityAlgorithm;
  /** Hex-encoded digest (64 chars for sha256, 128 for sha512). */
  digest: string;
}

/** Provenance attestation type. */
export type ProvenanceType = 'slsa/v1' | 'in-toto' | 'sigstore-bundle';

/** Build provenance reference. */
export interface ProvenanceConfig {
  /** Provenance format type. */
  type: ProvenanceType;
  /** URI to the provenance document. */
  uri: string;
}

/** Compliance attestation type. */
export type AttestationType = 'soc2-type2' | 'iso27001' | 'hipaa' | 'gdpr-dpa' | 'custom';

/** Compliance attestation reference. */
export interface AttestationEntry {
  /** Attestation type. */
  type: AttestationType;
  /** URI to the attestation document. */
  uri: string;
}

/** Publisher verification method. */
export type PublisherVerificationMethod =
  | 'well-known-jwks'
  | 'did'
  | 'oidc'
  | 'spiffe'
  | 'manual';

/** Publisher identity verification configuration. */
export interface PublisherVerificationConfig {
  /** Verification method. */
  method: PublisherVerificationMethod;
  /** Verification endpoint URI. */
  uri?: string;
}

/** Trust and security declarations. */
export interface Trust {
  /** Digital signature configuration. */
  signing?: SigningConfig;
  /** Content integrity verification. */
  integrity?: IntegrityConfig;
  /** Build provenance. */
  provenance?: ProvenanceConfig;
  /** Compliance attestations. */
  attestations?: AttestationEntry[];
  /** Publisher verification. */
  publisherVerification?: PublisherVerificationConfig;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Cost hint for scheduling decisions. */
export type CostHint = 'low' | 'medium' | 'high';

/** Latency hint for scheduling decisions. */
export type LatencyHint = 'instant' | 'seconds' | 'minutes' | 'hours';

/** Intent routing mode. */
export type IntentMode = 'tool' | 'skill' | 'agent' | 'workflow';

/** An intent declaration for semantic routing. */
export interface Intent {
  /** Intent identifier (kebab-case). */
  id: string;
  /** Example queries for semantic matching (2–20 items). */
  examples: string[];
  /** Capability references resolvable in components (e.g. "skill:my-skill"). */
  capabilityRefs: string[];
  /** Routing mode. */
  mode: IntentMode;
  /** Estimated cost level. */
  costHint?: CostHint;
  /** Estimated latency level. */
  latencyHint?: LatencyHint;
  /** Whether user approval is required (default false). */
  requiresApproval?: boolean;
  /** Whether this intent performs destructive operations (default false). */
  destructive?: boolean;
}

/** Trigger type for event-driven activation. */
export type TriggerType = 'event' | 'schedule' | 'webhook' | 'file-change';

/** Event/schedule trigger declaration. */
export interface Trigger {
  /** Trigger type. */
  type: TriggerType;
  /** Event source identifier. */
  source?: string;
  /** Filter expression. */
  filter?: string;
  /** Cron expression (for schedule triggers). */
  cron?: string;
  /** Capability references activated by this trigger. */
  capabilityRefs: string[];
}

/** Concurrency control settings. */
export interface ConcurrencyConfig {
  /** Maximum parallel executions (default 1). */
  maxParallel?: number;
  /** Mutually exclusive plugin IDs. */
  exclusiveWith?: string[];
}

/** Routing context hints. */
export interface RoutingContext {
  /** Token budget hint for context window planning. */
  tokenBudgetHint?: number;
  /** Tool name prefix to avoid cross-plugin naming conflicts. */
  toolNamePrefix?: string;
}

/** Routing metadata for the scheduler. */
export interface Routing {
  /** Intent declarations. */
  intents?: Intent[];
  /** Event/schedule triggers. */
  triggers?: Trigger[];
  /** Concurrency controls. */
  concurrency?: ConcurrencyConfig;
  /** Context hints. */
  context?: RoutingContext;
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

/** Protocol compatibility declarations. */
export interface ProtocolCompatibility {
  /** Supported MCP protocol versions. */
  mcp?: string[];
  /** Supported A2A protocol versions. */
  a2a?: string[];
  /** Agent Skills format version. */
  agentSkills?: string;
  /** Agent Plugins format version. */
  agentPlugins?: string;
}

/** Compatibility requirements. */
export interface Compatibility {
  /** Minimum plugin manager version. */
  minManagerVersion?: string;
  /** Protocol version requirements. */
  protocols?: ProtocolCompatibility;
  /** Supported platforms. */
  platforms?: Platform[];
}

// ---------------------------------------------------------------------------
// Root manifest
// ---------------------------------------------------------------------------

/** The complete Plugin Manifest v1alpha1 document. */
export interface PluginManifest {
  /** Schema reference (optional). */
  $schema?: string;
  /** API version — must be "plugin.agenthub.io/v1alpha1". */
  apiVersion: 'plugin.agenthub.io/v1alpha1';
  /** Resource kind — must be "Plugin". */
  kind: 'Plugin';
  /** Plugin identity and descriptive metadata. */
  metadata: Metadata;
  /** Discovery configuration. */
  discovery?: Discovery;
  /** Component references. */
  components?: Components;
  /** Runtime execution configuration. */
  runtime?: Runtime;
  /** Permission declarations (default-deny). */
  permissions?: Permission[];
  /** Trust and security declarations. */
  trust?: Trust;
  /** Routing metadata for the scheduler. */
  routing?: Routing;
  /** Compatibility requirements. */
  compatibility?: Compatibility;
  /** Client-private extensions (keys must be reverse-domain namespaced). */
  extensions?: Record<string, unknown>;
}
