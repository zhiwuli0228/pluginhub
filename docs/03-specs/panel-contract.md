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
| 什么都没有 | 不注册连接器 |

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
