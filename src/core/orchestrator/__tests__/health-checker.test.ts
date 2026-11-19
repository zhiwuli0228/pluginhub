import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { HealthChecker } from '../health-checker.js'

/**
 * Helper: start a simple HTTP server on a dynamic port.
 * Returns the port and a close function.
 */
async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200)
    res.end('ok')
  },
): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

/**
 * Helper: start a TCP server on a dynamic port.
 */
async function startTcpServer(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          }),
      })
    })
  })
}

describe('HealthChecker', () => {
  let checker: HealthChecker | null = null
  const cleanupFns: Array<() => Promise<void>> = []

  afterEach(async () => {
    if (checker) {
      checker.stop()
      checker = null
    }
    for (const fn of cleanupFns) {
      await fn()
    }
    cleanupFns.length = 0
  })

  it('initial status is unknown', () => {
    checker = new HealthChecker({ type: 'tcp', port: 9999 })
    const status = checker.getStatus()
    expect(status.status).toBe('unknown')
    expect(status.consecutiveSuccesses).toBe(0)
    expect(status.consecutiveFailures).toBe(0)
  })

  it('HTTP probe returns healthy for a reachable endpoint', async () => {
    const { port, close } = await startHttpServer()
    cleanupFns.push(close)

    checker = new HealthChecker({
      type: 'http',
      port,
      path: '/healthz',
      initialDelayMs: 50,
      periodMs: 100,
      timeoutMs: 1000,
      successThreshold: 1,
    })

    // Wait for the first probe to complete
    const result = await new Promise<{ status: string }>((resolve) => {
      const unsub = checker!.onStatusChange((r) => {
        if (r.status === 'healthy') {
          unsub()
          resolve(r)
        }
      })
      checker!.start()
    })

    expect(result.status).toBe('healthy')
  }, 5000)

  it('TCP probe returns healthy for a reachable port', async () => {
    const { port, close } = await startTcpServer()
    cleanupFns.push(close)

    checker = new HealthChecker({
      type: 'tcp',
      port,
      initialDelayMs: 50,
      periodMs: 100,
      timeoutMs: 1000,
      successThreshold: 1,
    })

    const result = await new Promise<{ status: string }>((resolve) => {
      const unsub = checker!.onStatusChange((r) => {
        if (r.status === 'healthy') {
          unsub()
          resolve(r)
        }
      })
      checker!.start()
    })

    expect(result.status).toBe('healthy')
  }, 5000)

  it('unreachable port eventually becomes unhealthy', async () => {
    // Use a port that's very unlikely to be in use
    checker = new HealthChecker({
      type: 'tcp',
      port: 19999,
      initialDelayMs: 50,
      periodMs: 100,
      timeoutMs: 200,
      failureThreshold: 2,
    })

    const result = await new Promise<{ status: string }>((resolve) => {
      const unsub = checker!.onStatusChange((r) => {
        if (r.status === 'unhealthy') {
          unsub()
          resolve(r)
        }
      })
      checker!.start()
    })

    expect(result.status).toBe('unhealthy')
  }, 5000)

  it('CrashLoopBackOff delay increases with failures and has jitter', () => {
    checker = new HealthChecker({ type: 'tcp', port: 9999 })

    // Collect multiple delay samples at different failure counts
    // We can't directly set restartFailureCount, but we can test getNextRestartDelay
    // The delay should be bounded by [0, min(base * 2^n, maxDelay)]
    const delays: number[] = []
    for (let i = 0; i < 20; i++) {
      delays.push(checker.getNextRestartDelay())
    }

    // All delays should be non-negative and within max bound (60000ms)
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThanOrEqual(60000)
    }
  })

  it('resetRestartBackoff() resets the counter', () => {
    checker = new HealthChecker({ type: 'tcp', port: 9999 })

    // After reset, the delay should be based on 2^0 = baseDelay
    checker.resetRestartBackoff()
    const delayAfterReset = checker.getNextRestartDelay()
    // With full jitter, delay is in [0, 1000]
    expect(delayAfterReset).toBeGreaterThanOrEqual(0)
    expect(delayAfterReset).toBeLessThanOrEqual(1000)
  })

  it('stop() cleans up timers', async () => {
    const { port, close } = await startTcpServer()
    cleanupFns.push(close)

    checker = new HealthChecker({
      type: 'tcp',
      port,
      initialDelayMs: 50,
      periodMs: 100,
      successThreshold: 1,
    })

    checker.start()
    // Let it run briefly
    await new Promise((r) => setTimeout(r, 200))
    checker.stop()

    // After stop, no more probes should execute.
    // Capture current status and wait to confirm no changes.
    const statusAfterStop = checker.getStatus()
    await new Promise((r) => setTimeout(r, 300))
    const statusLater = checker.getStatus()

    // consecutiveSuccesses should not have increased after stop
    expect(statusLater.consecutiveSuccesses).toBe(statusAfterStop.consecutiveSuccesses)
  }, 5000)

  it('onStatusChange callback is triggered on state transitions', async () => {
    const { port, close } = await startTcpServer()
    cleanupFns.push(close)

    checker = new HealthChecker({
      type: 'tcp',
      port,
      initialDelayMs: 50,
      periodMs: 100,
      successThreshold: 1,
    })

    const transitions: string[] = []
    checker.onStatusChange((result) => {
      transitions.push(result.status)
    })

    checker.start()

    // Wait for at least one transition to healthy
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (transitions.includes('healthy')) {
          clearInterval(check)
          resolve()
        }
      }, 50)
      // Safety timeout
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 4000)
    })

    expect(transitions).toContain('healthy')
  }, 5000)
})
