# Host Glue Module

DSH Harness integration layer. **Only this module may import `@deepseek-ai/*`.**

## Responsibilities

- Register PluginHub service with DSH host runtime
- Expose tools for agent consumption
- Bridge host credentials to plugin secret broker
- Wire up Web UI panel slots

## Boundary

```
core ← transport ← host-glue
         ↑              ↑
    (MCP/CLI)      (@deepseek-ai/*)
```

Nothing in `core/` or `adapters/` may import from this module.
