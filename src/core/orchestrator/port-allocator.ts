/**
 * @module PortAllocator
 * @description 动态端口分配模块。
 *
 * 通过 Node.js `net.createServer()` 绑定端口 0，让操作系统内核分配可用端口，
 * 获取端口号后立即关闭 server，将端口号返回给调用方。
 *
 * **TOCTOU 风险说明**：
 * 在 server.close() 之后、子进程 bind 之前，该端口可能被其他进程抢占。
 * Node.js 不支持将已绑定的 fd 传递给子进程，因此采用环境变量 PORT 兜底方案：
 * 调用方拿到端口号后应尽快启动子进程并通过 env.PORT 传入，子进程若 bind 失败需自行重试。
 *
 * 本模块仅绑定 127.0.0.1（loopback），不暴露到外网。
 */

import { createServer, type Server } from 'node:net'

/**
 * 单次端口分配的元信息。
 */
export interface PortAllocation {
  /** 被分配的端口号 */
  port: number
  /** 是否已被释放 */
  released: boolean
  /** 分配时间戳 */
  allocatedAt: Date
}

/**
 * 动态端口分配器。
 *
 * 维护一个内部 Map 跟踪已分配但未释放的端口及其元信息。
 * 所有绑定操作仅限 127.0.0.1 loopback 地址。
 *
 * @example
 * ```ts
 * const allocator = new PortAllocator()
 * const port = await allocator.allocateWithRetry(3)
 * // 将 port 通过 env.PORT 传给子进程
 * childProcess.spawn('node', ['server.js'], { env: { ...process.env, PORT: String(port) } })
 * // 子进程退出后释放
 * allocator.release(port)
 * allocator.destroy()
 * ```
 */
export class PortAllocator {
  /** 已分配端口的跟踪表：port -> PortAllocation */
  private readonly _allocations: Map<number, PortAllocation> = new Map()

  /** 标记分配器是否已销毁 */
  private _destroyed = false

  /**
   * 请求操作系统分配一个可用端口。
   *
   * 内部创建一个 TCP server 绑定到 127.0.0.1:0，由内核选择可用端口，
   * 读取端口号后立即关闭 server。
   *
   * @returns 操作系统分配的端口号
   * @throws 如果分配器已销毁或底层 bind 失败
   */
  async allocate(): Promise<number> {
    this._ensureNotDestroyed()

    const port = await this._bindAndRelease()

    const allocation: PortAllocation = {
      port,
      released: false,
      allocatedAt: new Date(),
    }
    this._allocations.set(port, allocation)

    return port
  }

  /**
   * 带重试的端口分配。
   *
   * 当 bind 失败时（如极端并发场景下端口被抢占导致 EADDRINUSE），
   * 自动重试直到成功或达到最大重试次数。
   *
   * @param maxRetries - 最大重试次数，默认 5
   * @returns 操作系统分配的端口号
   * @throws 超过最大重试次数后仍失败时抛出最后一次错误
   */
  async allocateWithRetry(maxRetries: number = 5): Promise<number> {
    this._ensureNotDestroyed()

    let lastError: Error | undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.allocate()
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }

    throw new Error(
      `Port allocation failed after ${maxRetries + 1} attempts: ${lastError?.message ?? 'unknown error'}`,
    )
  }

  /**
   * 标记指定端口为已释放。
   *
   * 这仅是簿记操作——实际端口在 allocate() 返回时就已通过 server.close() 归还给 OS。
   * release() 用于更新内部分配表的 released 状态，方便审计和 getAssignedPorts() 过滤。
   *
   * @param port - 要释放的端口号
   */
  release(port: number): void {
    const allocation = this._allocations.get(port)
    if (allocation) {
      allocation.released = true
    }
  }

  /**
   * 检查指定端口当前是否可被绑定。
   *
   * 尝试在 127.0.0.1 上临时 bind 该端口，成功则说明可用并立即关闭；
   * 失败（EADDRINUSE 等）则说明不可用。
   *
   * @param port - 要检查的端口号
   * @returns true 表示端口可用，false 表示已被占用或无法绑定
   */
  async isAvailable(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const server = createServer()

      server.once('error', () => {
        resolve(false)
      })

      server.once('listening', () => {
        server.close(() => {
          resolve(true)
        })
      })

      server.listen(port, '127.0.0.1')
    })
  }

  /**
   * 返回当前所有已分配端口的快照列表。
   *
   * 包含已释放和未释放的记录，调用方可通过 `released` 字段区分。
   *
   * @returns 端口分配记录数组（副本，修改不影响内部状态）
   */
  getAssignedPorts(): PortAllocation[] {
    return Array.from(this._allocations.values()).map((a) => ({
      port: a.port,
      released: a.released,
      allocatedAt: new Date(a.allocatedAt.getTime()),
    }))
  }

  /**
   * 销毁分配器，清空所有内部跟踪状态。
   *
   * 销毁后任何 allocate / allocateWithRetry 调用都会抛出错误。
   * 注意：这不会"归还"端口——端口在 allocate() 返回时已归还给 OS，
   * destroy() 仅清理内存中的簿记数据。
   */
  destroy(): void {
    this._allocations.clear()
    this._destroyed = true
  }

  /**
   * 核心实现：创建临时 TCP server，绑定 127.0.0.1:0，
   * 从 listening 事件获取内核分配的端口号，然后立即关闭 server。
   *
   * @returns 内核分配的端口号
   * @throws bind 失败时 reject 对应错误
   */
  private _bindAndRelease(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server: Server = createServer()

      server.once('error', (err: Error) => {
        reject(err)
      })

      server.once('listening', () => {
        const address = server.address()
        if (address === null || typeof address === 'string') {
          // address 为 string 时表示 Unix domain socket，不应出现在此场景
          server.close(() => {
            reject(new Error('Failed to obtain numeric port from server.address()'))
          })
          return
        }

        const port = address.port
        server.close(() => {
          resolve(port)
        })
      })

      server.listen(0, '127.0.0.1')
    })
  }

  /**
   * 确保分配器未被销毁。
   * @throws 如果已调用 destroy()
   */
  private _ensureNotDestroyed(): void {
    if (this._destroyed) {
      throw new Error('PortAllocator has been destroyed and cannot allocate ports')
    }
  }
}
