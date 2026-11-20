/**
 * Plugin Manifest v1alpha1 — public API.
 *
 * @module
 */

// Types
export type {
  PluginManifest,
  Metadata,
  Publisher,
  I18nString,
  Discovery,
  WellKnownEntry,
  RegistryEntry,
  DiscoveryMediaType,
  Components,
  SkillComponent,
  McpServerComponent,
  OpenApiComponent,
  AgentComponent,
  WorkflowComponent,
  AppComponent,
  Runtime,
  Entrypoint,
  ActivationMode,
  Transport,
  Platform,
  SelectionStrategy,
  HealthConfig,
  LifecycleConfig,
  ResourceLimits,
  SandboxConfig,
  FilesystemSandbox,
  NetworkSandbox,
  Permission,
  PermissionId,
  Trust,
  SigningConfig,
  SigningAlgorithm,
  IntegrityConfig,
  IntegrityAlgorithm,
  ProvenanceConfig,
  ProvenanceType,
  AttestationEntry,
  AttestationType,
  PublisherVerificationConfig,
  PublisherVerificationMethod,
  Routing,
  Intent,
  IntentMode,
  CostHint,
  LatencyHint,
  Trigger,
  TriggerType,
  ConcurrencyConfig,
  RoutingContext,
  Compatibility,
  ProtocolCompatibility,
} from './types.js';

// Parser
export { ManifestParser, ManifestParseError } from './parser.js';

// Validator
export { ManifestValidator } from './validator.js';
export type { ValidationResult, ValidationError, ValidationWarning } from './validator.js';
