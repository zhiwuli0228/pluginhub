# 本地发现与拉起

> PluginHub 是**本地管理工具**：它管理的插件都在本机。
> 因此连接器从不写死端口 —— 端口每次重启都会变。连接器只声明
> **怎么认出它**（discover）和**怎么拉起它**（launch）。

---

## 1. 为什么不能写死端口

实测中 DSH 每次重启端口都会变（`59618` → `62724`），硬编码的连接器因此全部失效。
同理 Memory Hub 可以跑在 `7777` 或默认的 `7331`。

结论：**位置是运行时事实，不是配置。**

---

## 2. 连接器写法

```yaml
id: token-usage-statistic
name: Token 用量统计
icon: "📊"

upstream: auto            # 关键：字符串 auto 表示"在本机找"
# upstream: http://127.0.0.1:59618   # 也可以手动固定（覆盖自动发现）

discover:
  env:                    # 1. 环境变量提示（最准，宿主会设置）
    - DSH_WEB_URL
  ports:                  # 2. 端口提示（已知的常见端口）
    - 7777
    - 7331
  skipPortScan: false      # 跳过全机端口扫描（默认 false）
  hosts: [127.0.0.1]       # 默认只探回环
  probe:                  # 3. 指纹：证明"这个端口上确实是它"
    path: /token-usage-statistic/api/summary?days=1
    method: GET
    expectStatus: 200
    expectJsonKey: totals          # 响应 JSON 必须含这个属性
    expectBodyContains: 环境管理器  # 或响应体必须含这个子串
    timeoutMs: 1500

launch:                   # 找不到时，用什么命令把它拉起来
  command: dsh
  args: [web]
  shell: true
  readyTimeoutMs: 90000
```

### 解析顺序

| 顺序 | 来源 | `endpointSource` |
|---|---|---|
| 1 | `upstream` 是字面量 | `configured` |
| 2 | `discover.env` 里的环境变量 | `env` |
| 3 | `discover.ports` 端口提示 | `port-hint` |
| 4 | 本机监听端口扫描 | `port-scan` |

每一步都必须通过 `probe` 指纹校验 —— **光有 200 不算命中**，否则会把
同一个宿主上的其它插件误认成它（DSH 把多个插件的路由挂在同一个端口上）。

### 本机端口扫描的实现

| 平台 | 来源 | 解析函数 |
|---|---|---|
| Windows | `netstat -ano -p TCP` | `parseWindowsNetstat` |
| Linux | `/proc/net/tcp` + `tcp6` | `parseProcNetTcp`（十六进制端口，只取 `0A` LISTEN） |
| macOS | `lsof -nP -iTCP -sTCP:LISTEN` | `parseLsof` |

结果缓存 8 秒，避免面板轮询时反复执行系统命令。

---

## 3. 一键启动

未找到时，UI 显示错误原因 + 启动命令 + **▶ 启动** 按钮。
点击后：

1. 再次解析一次 —— **若已经能发现，直接复用，不会拉起第二个进程**
2. `spawn` 命令并 `detached + unref`（PluginHub 退出不会带走插件）
3. 每 500ms 轮询 `probe`，直到指纹通过或超时（`readyTimeoutMs`）
4. 进程提前退出会立刻返回，并把 stderr 前 4KB 带回来
5. 成功后重新解析，返回真实 endpoint

API：`POST /api/launch/<id>`；重新扫描：`POST /api/rediscover`。

---

## 4. 实测结果

| 插件 | 发现方式 | endpoint |
|---|---|---|
| agent-memory-hub | `port-hint` | `http://127.0.0.1:7777` |
| token-usage-statistic | `env`（DSH_WEB_URL） | `http://127.0.0.1:62724` |
| dsh-env-manager | `env`（DSH_WEB_URL） | `http://127.0.0.1:62724` |
| mcp-filesystem | MCP stdio，无端点 | — |

**故障自愈验证**：把 `DSH_WEB_URL` 故意设成 `http://127.0.0.1:1`，
两个 DSH 插件仍通过 `port-scan` 找到 `62724` —— 正是之前会红掉的那个场景。

**拉起验证**：用一个指向空端口的临时连接器点击启动，
`waited=541ms`，返回 `origin=http://127.0.0.1:7399`，进程 pid 与端口内响应的
pid 一致；再次点击返回 `alreadyRunning=true`，未重复拉起。
