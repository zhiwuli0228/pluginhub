import { describe, it, expect, afterEach } from 'vitest'
import { ProcessManager } from '../process-manager.js'

describe('ProcessManager', () => {
  let pm: ProcessManager | null = null

  afterEach(async () => {
    if (pm) {
      await pm.dispose()
      pm = null
    }
  })

  it('spawn a simple command successfully', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000 })
    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "console.log('hello')"],
    })

    expect(handle.pid).toBeGreaterThan(0)

    const exitCode = await handle.waitForExit(5000)
    expect(exitCode).toBe(0)
  }, 5000)

  it('ProcessHandle.state transitions from starting → running', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000 })
    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "setTimeout(() => console.log('done'), 200)"],
    })

    // State should be starting or running immediately after spawn
    expect(['starting', 'running']).toContain(handle.state)

    // Wait for the process to reach running state
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (handle.state === 'running' || handle.state === 'stopped') {
          clearInterval(check)
          resolve()
        }
      }, 50)
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 3000)
    })

    // Should have been running at some point before exiting
    // (it may already be stopped by now)
    expect(['running', 'stopped']).toContain(handle.state)

    await handle.waitForExit(5000)
  }, 5000)

  it('kill() transitions state to stopping → stopped', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000 })
    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "setInterval(() => {}, 1000)"],
    })

    // Wait for running state
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (handle.state === 'running') {
          clearInterval(check)
          resolve()
        }
      }, 50)
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 3000)
    })

    expect(handle.state).toBe('running')

    // Kill the process
    await handle.kill()

    // Should be in terminal state
    expect(['stopped', 'failed']).toContain(handle.state)
  }, 5000)

  it('waitForExit() returns exit code', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000 })
    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "process.exit(42)"],
    })

    const exitCode = await handle.waitForExit(5000)
    expect(exitCode).toBe(42)
  }, 5000)

  it('non-zero exit code transitions state to failed', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000, autoReap: false })
    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "process.exit(1)"],
    })

    await handle.waitForExit(5000)

    // Give state machine time to transition
    await new Promise((r) => setTimeout(r, 100))

    expect(handle.state).toBe('failed')
  }, 5000)

  it('dispose() cleans up all processes', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000 })

    // Spawn a long-running process
    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "setInterval(() => {}, 1000)"],
    })

    // Wait for running
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (handle.state === 'running') {
          clearInterval(check)
          resolve()
        }
      }, 50)
      setTimeout(() => {
        clearInterval(check)
        resolve()
      }, 3000)
    })

    expect(handle.state).toBe('running')

    // Dispose should kill all processes
    await pm.dispose()

    // After dispose, spawning should throw
    expect(() =>
      pm!.spawn({ command: 'node', args: ['-e', '1'] }),
    ).toThrow('disposed')
  }, 5000)

  it('getActivePids() returns correct set', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000, autoReap: false })

    const h1 = pm.spawn({
      command: 'node',
      args: ['-e', "setInterval(() => {}, 1000)"],
    })
    const h2 = pm.spawn({
      command: 'node',
      args: ['-e', "setInterval(() => {}, 1000)"],
    })

    // Wait for both to be running
    await new Promise((r) => setTimeout(r, 500))

    const activePids = pm.getActivePids()
    expect(activePids).toContain(h1.pid)
    expect(activePids).toContain(h2.pid)

    // Kill one
    await h1.kill()
    await new Promise((r) => setTimeout(r, 200))

    const activeAfterKill = pm.getActivePids()
    expect(activeAfterKill).not.toContain(h1.pid)
    expect(activeAfterKill).toContain(h2.pid)

    await h2.kill()
  }, 5000)

  it('stateChange event is emitted on transitions', async () => {
    pm = new ProcessManager({ gracefulShutdownMs: 2000 })

    const transitions: Array<{ from: string; to: string }> = []
    pm.on('stateChange', (evt: { from: string; to: string }) => {
      transitions.push({ from: evt.from, to: evt.to })
    })

    const handle = pm.spawn({
      command: 'node',
      args: ['-e', "console.log('hi')"],
    })

    await handle.waitForExit(5000)
    await new Promise((r) => setTimeout(r, 200))

    // Should have at least: created→starting, starting→running, running→stopped
    const toStates = transitions.map((t) => t.to)
    expect(toStates).toContain('starting')
    expect(toStates).toContain('running')
    expect(toStates).toContain('stopped')
  }, 5000)
})
