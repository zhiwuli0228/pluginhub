# PluginHub — 插件与 Agent 运行时管理器

> **本地优先的插件/Agent 运行时控制台** —— 补上 MCP/A2A 协议不管的那一层

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 它是什么

PluginHub 解决一个系统性空白：**AI 协议只管"怎么调用"，不管"怎么运行"**。

MCP、A2A、Agent Skills 等协议定义了工具描述、Agent 能力声明、通信格式，但完全没有覆盖：
- 进程启停与崩溃恢复
- 动态端口分配与健康检查
- 权限治理与信任验证
- 跨协议统一调度与观测

PluginHub 就是这一层。

## 核心能力

| 能力 | 说明 |
|---|---|
| **统一发现** | AI Catalog + Registry + well-known 探测 + 本地扫描，四路并行 |
| **自动拉起** | Manifest 声明式进程生命周期，bind(0) 零 TOCTOU 端口分配 |
| **安全治理** | 权限默认拒绝 + 信任三态 + 沙箱隔离 + 审批门，四层防御 |
| **智能调度** | 意图匹配 → 能力选择 → 审批 → 执行 → 观测，全链路 |
| **跨协议归一** | MCP / A2A / Skills / OpenAPI / Arazzo → Canonical Capability |
| **统一观测** | OTel trace 串联 + 结构化日志 + SSE 实时事件流 |

## 项目结构

```
pluginhub/
├── src/
│   ├── core/           # 宿主无关核心逻辑（无 DSH 依赖）
│   │   ├── discovery/  #   发现引擎
│   │   ├── activation/ #   激活引擎
│   │   ├── orchestrator/ # 进程编排内核
│   │   ├── router/     #   调度路由器
│   │   ├── observer/   #   观测总线
│   │   ├── capability/ #   统一能力索引
│   │   └── manifest/   #   Manifest 解析/校验/导出
│   ├── adapters/       # 协议适配器（MCP/A2A/Skills/OpenAPI/Arazzo/OASF）
│   ├── host-glue/      # DSH Harness 集成层（唯一可 import @deepseek-ai/* 的模块）
│   ├── index.ts        # DSH Host 插件入口
│   └── cli.ts          # 独立 CLI 入口
├── client.js           # DSH Web UI 客户端入口
├── cordis.patch.yml    # DSH Bundle 补丁
├── locale/             # 国际化（en/zh）
├── icon.svg            # 插件图标
├── docs/
│   ├── 00-product/     # 产品架构设计
│   ├── 01-research/    # 调研报告（竞品/协议/进程编排）
│   ├── 02-architecture/# ADR 与技术决策
│   └── 03-specs/       # 规范与 Schema（含 Plugin Manifest）
├── AGENTS.md           # AI Agent 操作手册
├── package.json
├── tsconfig.json
└── esbuild.config.mjs
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 构建
pnpm run build

# 类型检查 + 构建 + 测试
pnpm run check
```

### 作为 DSH 插件安装

通过 DSH Plugin Manager 安装本 bundle，或在 profile 的 `cordis.patch.yml` 中引用。

### 作为独立 CLI 使用

```bash
npx dsh-pluginhub --help
# 或全局安装后
pluginhub status
pluginhub list --kind tool
pluginhub discover example.com
```

## 运行看板（连接器驱动）

```bash
npm run demo          # 启动在 http://127.0.0.1:7895
npm run verify:demo   # Playwright 自动化验证（切 Tab + 校验真实数据）
```

看板不为每个插件写渲染代码，而是读 `connectors/*.yaml`：

```yaml
id: token-usage-statistic
name: Token 用量统计
icon: "📊"
upstream: http://127.0.0.1:59618
panelPath: /token-usage-statistic/panel   # 插件自带的自包含面板
pathPrefixes:
  - /token-usage-statistic/               # 面板内部会调用的绝对路径
injectHeaders:                            # 可选，代理时注入
  x-env-manager-request: "1"
openUrl: http://127.0.0.1:59618/
```

PluginHub 只做四件事：**探面板可达性 → 代理 → 重写面板内的绝对路径 → iframe 嵌入**。

插件侧需要遵守的契约见 [面板契约](docs/03-specs/panel-contract.md)：
`GET <prefix>/panel` 返回自包含 HTML（零外部资源、绝对路径调自己 API、错误可见）。

### 第三方 MCP server（无需改造对方）

别人写的 MCP server 不用遵守任何契约 —— 只要声明 `kind: mcp`，PluginHub 会从
`tools/list` 的 JSON Schema **自动生成 Inspector 界面**（工具列表 + 参数表单 + 调用结果）：

```yaml
kind: mcp
mcp:
  transport: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "E:\\some\\dir"]
  shell: true
```

已验证：`server-filesystem@2.4.0` 自动列出 16 个工具并真实调用成功。

### 纯静态面板（零构建 HTML）

不需要服务端的面板（例如 BlueRegion 用量面板）声明 `kind: static`，
PluginHub 直接把目录托管出来并嵌入，带 MIME、路径穿越防护、可选文件处理：

```yaml
kind: static
staticRoot: E:\009workspace\huawei\BlueRegionUsage\panel
entry: index.html
optionalFiles: [config.js]
```

## 支持的协议

| 层级 | 协议 | 支持状态 |
|---|---|---|
| Tier 0 原生 | MCP 2026-07-28, Agent Skills, 自有 Manifest | 🚧 P1 开发中 |
| Tier 1 完整 | A2A 1.0.1, AI Catalog / ARD | 📋 P2 计划 |
| Tier 2 适配 | OpenAPI 3.x, Arazzo 1.0, AGNTCY OASF | 📋 P3 计划 |
| Tier 3 观察 | ANP, NANDA, agents.json | 👀 跟踪 |

## 落地路线

| 阶段 | 周期 | 目标 |
|---|---|---|
| P0 · 进程内核 | 2 周 | 三平台进程抽象 + bind(0) + 优雅关闭 |
| P1 · 最小可用 | 4 周 | MCP + Skills + Manifest v1alpha1 |
| P2 · 发现互联 | 4 周 | Agent Plugins 导入 + AI Catalog + A2A |
| P3 · 调度治理 | 4 周 | OpenAPI/Arazzo + 上下文预算 + 审批门 |
| P4 · 观测体验 | 4 周 | Observer Bus + Control UI + CLI |
| P5 · 硬化生态 | 持续 | A2A 1.1 + MCP Apps + OASF + 身份插件化 |

## 文档导航

| 文档 | 说明 |
|---|---|
| [产品架构设计](docs/00-product/产品架构设计.md) | 完整架构（整合三份调研） |
| [竞品深度分析](docs/01-research/竞品深度分析.md) | 6 大工具能力矩阵 + 市场空白 |
| [协议选型报告](docs/01-research/协议选型报告.md) | 分层选型 + Manifest Schema 草案 |
| [进程编排选型](docs/01-research/进程编排技术选型.md) | Go 薄内核 + MCP SDK 生命周期协议 |
| [Manifest Schema](docs/03-specs/plugin-manifest/) | JSON Schema + 示例 + 校验脚本 |
| [AGENTS.md](AGENTS.md) | AI Agent 操作手册 |

## License

MIT
