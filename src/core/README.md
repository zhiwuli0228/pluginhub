# Core Module

Host-agnostic core logic for PluginHub. No DSH dependencies allowed.

## Sub-modules (planned per architecture §2)

- `discovery/` — Discovery Engine: multi-source plugin/agent collection, dedup, scoring
- `activation/` — Activation Engine: manifest parsing, permission/trust resolution, lifecycle
- `orchestrator/` — Process Orchestrator: spawn, health check, port allocation, graceful shutdown
- `router/` — Invocation Router: intent matching, approval gate, adapter dispatch
- `observer/` — Observer Bus: unified event collection, trace correlation, log aggregation
- `capability/` — Unified Capability Index: SQLite schema, canonical model, adapters
- `manifest/` — Plugin Manifest parser, validator, exporter

## Invariants

1. **No DSH imports**. This module must work standalone (CLI / MCP server / any host).
2. **Manifest is the authority**. Runtime state is derived from manifests, not the reverse.
3. **Permissions default deny**. Missing permissions = unavailable, not full access.
4. **Trust is three-state**. signed ≠ verified ≠ trusted. Never collapse.
