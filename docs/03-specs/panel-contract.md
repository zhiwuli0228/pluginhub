# PluginHub 面板契约（Tier 0）

> 版本 v1 · 2026-11-22
>
> 目的：让任何插件都能被 PluginHub（或任何外部看板）以 iframe 直接嵌入，
> **无需在宿主侧重写 UI，也无需在看板侧写适配代码**。

---

## 1. 为什么需要这个契约

插件在宿主里的 UI 通常是**宿主专属**的：它依赖宿主的 React/Solid 运行时、slot 机制、
认证会话。一旦离开宿主，这些 UI 就无法渲染。

Memory Hub 之所以能第一个被嵌入，只因为它**额外**提供了一个自包含的 `GET /panel` 页面。
把这件事变成规范，插件就能被任何外部工具嵌入。

---

## 2. 契约要求（必须全部满足）

### 2.1 端点

```
GET <plugin-prefix>/panel
```

- 返回 `200`
- `content-type: text/html; charset=utf-8`
- `cache-control: no-store`
- 支持 `HEAD`（返回相同 headers，无 body）
- 其他方法返回 `405`，并带 `allow: GET, HEAD`

### 2.2 自包含

- **零外部资源**：不引用 CDN、不引用外部 CSS/JS/字体/图片
- 所有样式与脚本**内联**在 HTML 中
- 不依赖宿主的任何全局变量（`window.__DSH_*`、宿主 React 等）
- 页面在空白浏览器里单独打开也必须完整工作

### 2.3 数据自取

- 页面内 JS 通过 **绝对路径** 调用本插件自己的 API，例如：
  ```js
  fetch('/token-usage-statistic/api/summary?days=7')
  ```
  不要用相对路径（`./api/...` 或 `api/...`），因为外部看板可能在任意路径深度嵌入它。
- 需要特殊请求头时，页面自己带上（例如 `x-env-manager-request: 1`）

### 2.4 只读优先

- panel **不得**执行破坏性写操作而不经用户显式确认
- 若提供写操作（批准/拒绝/删除），必须是用户点击触发，不得自动执行

### 2.5 错误可见

- API 失败时必须在页面上显示**具体错误**（HTTP 状态 / 错误消息），
  不得静默失败或只显示空状态

### 2.6 转义

- 所有插入 DOM 的字符串必须 HTML 转义（提供 `esc()`），禁止裸拼用户数据

---

## 3. PluginHub 侧如何消费

连接器声明（`connectors/<id>.yaml`）：

```yaml
id: token-usage-statistic
name: Token 用量统计
icon: "📊"
upstream: http://127.0.0.1:59618      # 谁提供这些路由
panelPath: /token-usage-statistic/panel
pathPrefixes:                          # panel 内部会调用的绝对路径前缀
  - /token-usage-statistic/
injectHeaders:                         # 可选：代理时注入的必需请求头
  x-env-manager-request: "1"
openUrl: http://127.0.0.1:59618/       # 需要宿主会话的功能，跳转打开
```

PluginHub 的行为：

1. **健康检查以 panel 可达性为准**：`GET panelPath` 必须返回 200 且 `text/html`，
   否则该插件显示为离线（并给出具体原因），避免"看起来在线但嵌入是空白"
2. **代理**：`/p/<id>/*` → `upstream/*`，剥离 `origin`/`referer`，注入 `injectHeaders`
3. **重写**：panel HTML 里所有以 `pathPrefixes` 开头的绝对路径改为 `/p/<id>` 前缀
4. **运行时兜底**：注入 fetch/XHR 补丁，捕获模板字符串和动态拼接的 URL
5. **嵌入**：`<iframe src="/p/<id><panelPath>">`

---

## 4. 不带 panel 时怎么办（降级）

| 插件能力 | PluginHub 表现 |
|---|---|
| 有 `panelPath` | iframe 直嵌（Tier 0） |
| 只有 JSON API | 声明 `livePath`，以原始 JSON 展示 + 「打开上游界面」链接（Tier 1 降级） |
| 只有 MCP 协议 | 声明 `kind: mcp`，PluginHub 自动生成 Inspector（Tier 2） |
| **纯静态 HTML 面板（零构建）** | 声明 `kind: static`，PluginHub 直接托管该目录并嵌入 |
| 什么都没有 | 不注册连接器 |

---

## 4ter. Tier 0b：纯静态面板（`kind: static`）

有些面板根本不需要服务端 —— 一个 `index.html` + 原生 JS 就够，设计上就是"双击打开"。
PluginHub 直接把目录托管出来：

```yaml
id: blue-region-usage
name: BlueRegion 用量
icon: "🟦"
kind: static
staticRoot: E:\009workspace\huawei\BlueRegionUsage\panel
entry: index.html
optionalFiles:      # 声明"允许不存在"的文件
  - config.js
```

行为：

1. `GET /s/<id>/<path>` 从 `staticRoot` 读文件，带正确 MIME（html/css/js/svg/woff2/…）
2. **路径穿越防护**：解析后的绝对路径必须仍在 `staticRoot` 内，`..`／绝对路径一律拒绝
3. 目录不列出内容；`/dir/` 有 `index.html` 时重定向，否则 403
4. `optionalFiles` 里的文件缺失时返回 **200 空响应**。面板会 `<script src="config.js">`
   引入本机私有配置，该文件按设计被 gitignore；声明为可选后控制台不再有 404，
   而面板看到的仍是"没有 `window.APP_CONFIG`"，行为不变
5. 健康检查只看**磁盘上的入口文件是否存在**，不发网络请求

数据来源可以是远端 API（BlueRegion 就是这样：面板自己去调网关），
PluginHub 不参与、不代理、也不需要知道凭证。

---

## 4bis. Tier 2：第三方 MCP server（不需要插件遵守任何契约）

别人写的 MCP server 既没有 panel，也不会为你改造。它们唯一提供的接口是
`tools/list` + 输入 JSON Schema + `tools/call`。PluginHub 因此**从 schema 生成 UI**：

```yaml
id: mcp-filesystem
name: Filesystem (MCP)
kind: mcp
mcp:
  transport: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "E:\\009workspace\\pluginhub"]
  shell: true          # npx 在 Windows 上是 .cmd shim，必须过 shell
  idleTimeoutMs: 300000
  requestTimeoutMs: 120000
```

PluginHub 的行为：

1. 懒加载会话：首次访问才 spawn，同连接器共享一个进程，空闲 `idleTimeoutMs` 后关闭
2. `/api/mcp/<id>/tools` 返回 `tools/list` 结果（含 annotations）
3. `/api/mcp/<id>/call` 代理 `tools/call`
4. `/mcp?id=<id>` 渲染通用 Inspector：左侧工具列表、右侧按 JSON Schema 生成表单
   （string / number / integer / boolean / enum / array / object，含必填标记与描述提示）、
   执行并把结果以 JSON 展示
5. annotations 映射为只读 / 破坏性 / 幂等 / 开放世界徽章

**关键点：这不是 per-plugin 代码。** 加任何一个新 MCP server 都只是加一个 YAML。

已验证：`@modelcontextprotocol/server-filesystem@2.4.0` 自动列出 16 个工具，
`list_directory` / `read_text_file` / `search_files` 等真实调用成功（7–139ms）。

---

## 5. 迁移清单（把一个插件接入 PluginHub）

1. 在插件里新增 `GET <prefix>/panel`，返回自包含 HTML
2. 页面内 API 调用使用**绝对路径**，需要时自带请求头
3. 在插件的测试里断言：`200` + `text/html` + 关键标记 + `HEAD` 无 body
4. 在 PluginHub 的 `connectors/` 下写一个 YAML
5. 重启宿主使新路由生效；PluginHub 刷新即可看到面板
6. 若面板依赖宿主登录态，另配 `openUrl` 指向宿主界面

---

## 6. 已知边界

- **宿主专属且不可导出的 UI** 永远无法嵌入。只能降级到 Tier 1/2（拿 API 自动渲染）
- 认证墙无法穿透：若 panel 路径本身要求宿主会话，则该插件不可嵌入，
  必须提供免会话的 panel 或走 `openUrl`
- MCP Apps（SEP-1865）普及后，`ui://` 资源将成为标准形态，
  届时本契约可退化为"MCP Apps 的一个实现"
