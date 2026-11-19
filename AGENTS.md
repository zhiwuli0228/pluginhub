# AGENTS.md — dsh-pluginhub

本文件是给在 `dsh-pluginhub` 仓库上工作的 AI agent 的操作手册。

## 角色

你是 PluginHub 的协作者。PluginHub 是一个**本地优先的插件与 Agent 运行时管理器**：统一发现、自动拉起、安全治理、智能调度，补上 MCP/A2A 协议不管的运行时层。

## 开始工作前必读

1. `docs/00-product/产品架构设计.md` — 完整产品架构（整合三份调研）
2. `docs/01-research/` — 原始调研报告（竞品/协议/进程编排）
3. `docs/02-architecture/` — ADR 与技术决策（待建）
4. `README.md` — 项目概览

## 不变量（动之前必须先讨论）

1. **Manifest 是权威，不是缓存**。运行时状态从 Manifest 派生，不能反向写入。
2. **权限默认拒绝**。缺失权限 = unavailable，永远不是 full access。
3. **信任三态分离**。signed / verified / trusted 不得合并为单一布尔值。
4. **Core 不依赖 DSH**。三层单向依赖：`core` → `adapters` → `host-glue`。只有 `host-glue` 可以 import `@deepseek-ai/*`。
5. **协议原生格式保持权威**。Manifest 只放指针，不复制内容；SKILL.md / mcp.json / agent-card.json 的原生格式是不可变事实源。
6. **可降级导出**。自家 Manifest 必须能无损导出为 Agent Plugins / Claude Code / MCP / A2A 格式。

## 当前方向（2026-11 起）

- **P0 · 进程内核**：Go 薄编排内核（或 Node+execa 备选），三平台进程抽象 + bind(0) + 优雅关闭
- **P1 · 最小可用**：MCP + Agent Skills + Manifest v1alpha1 + 权限/信任最小实现
- **多入口**：DSH 内嵌面板、standalone CLI、MCP server，共用同一份 core

## 工作流

1. 新功能 / 大改动 → 先写 ADR（`docs/02-architecture/decisions/`）
2. 核心逻辑改动必须补/改测试；改完跑 `npm run check`
3. 中文为主；技术名词、API 名、协议字段、文件路径保留原样
4. 更新本文档或 README 中的相关引用

## 明确不做

- 低代码画布（Flowise EOL 已证伪）
- 自研传输协议（传输层已收敛）
- 纯注册表/托管服务（Smithery/mcp.run 关停证明不成立）
- 把 A2A Agent 伪装成 MCP Tool（丢失人工介入语义）
- 全量暴露 OpenAPI 为工具（上下文爆炸）
