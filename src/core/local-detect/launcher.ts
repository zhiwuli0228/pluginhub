/**
 * Launch a plugin's web endpoint and wait until it answers.
 *
 * @module local-detect/launcher
 */

import { spawn } from 'node:child_process'

import { probeFingerprint, refreshAfterLaunch } from './detector.js'
import type { FingerprintSpec, LaunchSpec } from './types.js'

/** Outcome of a launch attempt. */
export interface LaunchResult {
  started: boolean
  pid?: number
  /** Present when the process started but never became ready. */
  error?: string
  /** How long the readiness wait took. */
  waitedMs?: number
  /** Captured first lines of stderr, to explain early exits. */
  stderr?: string
}

/**
 * Spawn a launch spec detached and wait for its fingerprint to succeed.
 *
 * The child is fully detached (`unref`ed) so it outlives PluginHub — a local
 * manager must not take the plugins down with it when it restarts.
 *
 * @param spec    Command to run.
 * @param probe   Fingerprint that proves readiness. Without one, readiness is
 *                assumed after `readyTimeoutMs`.
 * @param origins Candidate origins to poll while waiting.
 */
export async function launchAndWait(
  spec: LaunchSpec,
  probe: FingerprintSpec | null | undefined,
  origins: string[],
): Promise<LaunchResult> {
  const startedAt = Date.now()
  const timeoutMs = spec.readyTimeoutMs ?? 30000

  let child
  try {
    child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      env: spec.env ? { ...process.env, ...spec.env } : process.env,
      shell: spec.shell === true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (e) {
    return { started: false, error: `启动失败：${(e as Error).message}` }
  }

  let stderr = ''
  let exited = false
  let exitDetail = ''

  child.stderr?.setEncoding('utf-8')
  child.stderr?.on('data', (chunk: string) => {
    if (stderr.length < 4000) stderr += chunk
  })
  child.stdout?.on('data', () => {
    /* drain so the pipe cannot fill */
  })
  child.on('error', (err: Error) => {
    exited = true
    exitDetail = err.message
  })
  child.on('exit', (code, signal) => {
    exited = true
    exitDetail = signal ? `signal ${signal}` : `exit ${code}`
  })

  child.unref()
  refreshAfterLaunch()

  const pid = child.pid
  if (!pid) return { started: false, error: `启动后未获得 PID：${exitDetail || 'unknown'}` }

  // No probe: give the caller the benefit of the doubt after a short grace.
  if (!probe) {
    await sleep(Math.min(1500, timeoutMs))
    return { started: true, pid, waitedMs: Date.now() - startedAt, stderr: stderr || undefined }
  }

  while (Date.now() - startedAt < timeoutMs) {
    for (const origin of origins) {
      if (await probeFingerprint(origin, probe)) {
        return { started: true, pid, waitedMs: Date.now() - startedAt }
      }
    }
    if (exited) {
      return {
        started: false,
        pid,
        error: `进程已退出（${exitDetail}），未就绪`,
        waitedMs: Date.now() - startedAt,
        stderr: stderr.trim() || undefined,
      }
    }
    await sleep(500)
  }

  return {
    started: false,
    pid,
    error: `等待就绪超时（${Math.round(timeoutMs / 1000)}s）`,
    waitedMs: Date.now() - startedAt,
    stderr: stderr.trim() || undefined,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
