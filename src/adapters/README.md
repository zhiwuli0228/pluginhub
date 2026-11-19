# Adapters Module

Protocol-specific adapters that convert native formats to Canonical Capability.

## Planned adapters (per architecture §4)

| Adapter | Input | Output Kind | Red Line |
|---|---|---|---|
| `mcp.ts` | tools/list + annotations | tool | Never auto-retry destructive |
| `a2a.ts` | AgentCard + Task lifecycle | agent | Never masquerade as sync tool |
| `skills.ts` | SKILL.md frontmatter | skill | Never read body during discovery |
| `openapi.ts` | Whitelisted operationId | tool (meta-tools) | Never import full spec |
| `arazzo.ts` | Flow definition | workflow | Never promote steps to tools |
| `oasf.ts` | OASF records | tags/classification | Never treat as executable |

## Contract

Every adapter:
1. Accepts native format → outputs Canonical Capability
2. Preserves `provenance.native` (original object, untouched)
3. Maps errors to unified error model
4. Declares degradation behavior for missing capabilities
