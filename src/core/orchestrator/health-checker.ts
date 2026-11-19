/**
 * @module health-checker
 * @description PluginHub 进程编排内核健康检查模块。
 *
 * 提供 HTTP / TCP 两种探针，三态状态机（healthy / unhealthy / unknown），
 * 参数化阈值配置，以及 CrashLoopBackOff 重启退避策略。
 *
 * - HTTP probe: GET 请求，2xx-3xx 视为健康
 * - TCP probe: 尝试建连，端口打开即健康
 * - CrashLoopBackOff: delay = min(baseDelay × 2^n, maxDelay)，full jitter
 * - initialDelay 带 ±20% 随机抖动防 thundering herd
 *
 * @remarks 仅依赖 Node.js 内置模块（http, net, events），不引入任何第三方包。
 */

import http from 'node:http';
import net from 'node:net';

// ─── Types & Interfaces ──────────────────────────────────────────────────────

/** 健康状态三态枚举 */
export type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

/** 探针类型 */
export type ProbeType = 'http' | 'tcp';

/**
 * 健康检查配置。
 *
 * @public
 */
export interface HealthCheckConfig {
  /** 探针类型：http 或 tcp */
  type: ProbeType;
  /** 目标主机，默认 127.0.0.1 */
  host?: string;
  /** 目标端口（必填） */
  port: number;
  /** HTTP 探针路径，仅 type=http 时生效，默认 /healthz */
  path?: string;
  /** 首次检查前的延迟（ms），默认 3000，实际会加 ±20% 抖动 */
  initialDelayMs?: number;
  /** 检查周期（ms），默认 5000 */
  periodMs?: number;
  /** 单次探针超时（ms），默认 2000 */
  timeoutMs?: number;
  /** 连续成功次数达到此值才转为 healthy，默认 1 */
  successThreshold?: number;
  /** 连续失败次数达到此值才转为 unhealthy，默认 3 */
  failureThreshold?: number;
}

/**
 * 健康检查结果快照。
 *
 * @public
 */
export interface HealthCheckResult {
  /** 当前健康状态 */
  status: HealthStatus;
  /** 当前连续成功计数 */
  consecutiveSuccesses: number;
  /** 当前连续失败计数 */
  consecutiveFailures: number;
  /** 最近一次检查时间 */
  lastCheckAt: Date;
  /** 最近一次失败的错误信息（仅在 unhealthy 时有值） */
  lastError?: string;
  /** CrashLoopBackOff 建议的重启等待时间（ms） */
  restartDelayMs?: number;
}

/** 状态变更回调签名 */
export type StatusChangeCallback = (result: HealthCheckResult) => void;

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PATH = '/healthz';
const DEFAULT_INITIAL_DELAY_MS = 3000;
const DEFAULT_PERIOD_MS = 5000;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_SUCCESS_THRESHOLD = 1;
const DEFAULT_FAILURE_THRESHOLD = 3;

/** CrashLoopBackOff 基础延迟（ms） */
const BACKOFF_BASE_MS = 1000;
/** CrashLoopBackOff 最大延迟上限（ms） */
const BACKOFF_MAX_MS = 60000;
/** initialDelay 抖动比例 ±20% */
const JITTER_RATIO = 0.2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * 对 initialDelay 施加 ±20% full jitter，防止 thundering herd。
 *
 * @param baseMs - 原始延迟毫秒数
 * @returns 抖动后的延迟毫秒数
 */
function applyJitter(baseMs: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * JITTER_RATIO; // [0.8, 1.2]
  return Math.round(baseMs * factor);
}

/**
 * 执行一次 HTTP 健康探针。
 *
 * @param host - 目标主机
 * @param port - 目标端口
 * @param path - 请求路径
 * @param timeoutMs - 超时毫秒数
 * @returns Promise<void> — resolve 表示健康，reject 携带错误原因
 */
function httpProbe(
  host: string,
  port: number,
  path: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = http.get(
      { hostname: host, port, path, timeout: timeoutMs },
      (res) => {
        // 消费响应体以避免 socket hang up
        res.resume();
        const statusCode = res.statusCode ?? 0;
        if (statusCode >= 200 && statusCode < 400) {
          resolve();
        } else {
          reject(new Error(`HTTP ${statusCode}`));
        }
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`HTTP probe timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err: Error) => {
      reject(err);
    });
  });
}

/**
 * 执行一次 TCP 健康探针。
 *
 * @param host - 目标主机
 * @param port - 目标端口
 * @param timeoutMs - 超时毫秒数
 * @returns Promise<void> — resolve 表示端口可达，reject 携带错误原因
 */
function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const cleanup = (): void => {
      if (!settled) {
        settled = true;
        socket.destroy();
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`TCP probe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      cleanup();
      resolve();
    });

    socket.once('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    socket.connect(port, host);
  });
}

// ─── HealthChecker ───────────────────────────────────────────────────────────

/**
 * 进程健康检查器。
 *
 * 支持 HTTP / TCP 两种探针模式，维护三态状态机，并在状态变更时通知订阅者。
 * 内置 CrashLoopBackOff 退避算法用于重启调度。
 *
 * @example
 * ```ts
 * const checker = new HealthChecker({
 *   type: 'http',
 *   port: 8080,
 *   path: '/healthz',
 *   periodMs: 5000,
 *   failureThreshold: 3,
 * });
 *
 * const unsubscribe = checker.onStatusChange((result) => {
 *   console.log('Status changed:', result.status);
 * });
 *
 * checker.start();
 * // ... later
 * checker.stop();
 * unsubscribe();
 * ```
 *
 * @public
 */
export class HealthChecker {
  /** 归一化后的配置 */
  private readonly config: Required<HealthCheckConfig>;

  /** 当前状态 */
  private status: HealthStatus = 'unknown';

  /** 连续成功计数 */
  private consecutiveSuccesses = 0;

  /** 连续失败计数 */
  private consecutiveFailures = 0;

  /** 最近一次检查时间 */
  private lastCheckAt: Date = new Date(0);

  /** 最近一次错误信息 */
  private lastError?: string;

  /** 累计重启失败次数（用于 CrashLoopBackOff 指数计算） */
  private restartFailureCount = 0;

  /** 定时器句柄 */
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 初始延迟定时器句柄 */
  private initialTimer: ReturnType<typeof setTimeout> | null = null;

  /** 是否已启动 */
  private running = false;

  /** 状态变更回调集合 */
  private readonly listeners = new Set<StatusChangeCallback>();

  /**
   * 创建 HealthChecker 实例。
   *
   * @param config - 健康检查配置
   */
  constructor(config: HealthCheckConfig) {
    this.config = {
      type: config.type,
      host: config.host ?? DEFAULT_HOST,
      port: config.port,
      path: config.path ?? DEFAULT_PATH,
      initialDelayMs: config.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS,
      periodMs: config.periodMs ?? DEFAULT_PERIOD_MS,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      successThreshold: config.successThreshold ?? DEFAULT_SUCCESS_THRESHOLD,
      failureThreshold: config.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
    };
  }

  /**
   * 启动健康检查循环。
   *
   * 首次检查会在 initialDelayMs（±20% 抖动）后执行，之后按 periodMs 周期重复。
   * 重复调用 start() 不会产生副作用。
   */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;

    const jitteredDelay = applyJitter(this.config.initialDelayMs);

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      // 立即执行第一次检查
      void this.runProbe();
      // 启动周期定时器
      this.timer = setInterval(() => {
        void this.runProbe();
      }, this.config.periodMs);
    }, jitteredDelay);
  }

  /**
   * 停止健康检查循环并清理所有定时器。
   *
   * 停止后状态保持不变，可再次调用 start() 恢复。
   */
  stop(): void {
    this.running = false;

    if (this.initialTimer !== null) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 获取当前健康检查结果快照。
   *
   * @returns 不可变的健康检查结果
   */
  getStatus(): HealthCheckResult {
    const result: HealthCheckResult = {
      status: this.status,
      consecutiveSuccesses: this.consecutiveSuccesses,
      consecutiveFailures: this.consecutiveFailures,
      lastCheckAt: this.lastCheckAt,
    };

    if (this.lastError !== undefined) {
      result.lastError = this.lastError;
    }

    if (this.status === 'unhealthy') {
      result.restartDelayMs = this.getNextRestartDelay();
    }

    return result;
  }

  /**
   * 注册状态变更回调。
   *
   * 仅在状态实际发生变化时触发（例如从 healthy → unhealthy）。
   *
   * @param callback - 状态变更时调用的回调函数
   * @returns 取消订阅函数
   */
  onStatusChange(callback: StatusChangeCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /**
   * 计算下一次 CrashLoopBackOff 重启延迟。
   *
   * 公式：delay = min(baseDelay × 2^failures, maxDelay)，再施加 full jitter（random 0~delay）。
   *
   * @returns 建议的重启等待时间（ms）
   */
  getNextRestartDelay(): number {
    const exponential = BACKOFF_BASE_MS * Math.pow(2, this.restartFailureCount);
    const capped = Math.min(exponential, BACKOFF_MAX_MS);
    // Full jitter: uniform random in [0, capped]
    return Math.round(Math.random() * capped);
  }

  /**
   * 重置 CrashLoopBackOff 计数器。
   *
   * 当进程成功启动并通过健康检查后应调用此方法。
   */
  resetRestartBackoff(): void {
    this.restartFailureCount = 0;
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  /**
   * 执行单次探针并根据结果更新状态机。
   */
  private async runProbe(): Promise<void> {
    const previousStatus = this.status;

    try {
      if (this.config.type === 'http') {
        await httpProbe(
          this.config.host,
          this.config.port,
          this.config.path,
          this.config.timeoutMs,
        );
      } else {
        await tcpProbe(
          this.config.host,
          this.config.port,
          this.config.timeoutMs,
        );
      }

      // 探针成功
      this.consecutiveSuccesses += 1;
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      this.lastCheckAt = new Date();

      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.status = 'healthy';
      }
    } catch (err: unknown) {
      // 探针失败
      this.consecutiveFailures += 1;
      this.consecutiveSuccesses = 0;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.lastCheckAt = new Date();

      if (this.consecutiveFailures >= this.config.failureThreshold) {
        this.status = 'unhealthy';
        this.restartFailureCount += 1;
      }
    }

    // 状态变更时通知所有订阅者
    if (this.status !== previousStatus) {
      const snapshot = this.getStatus();
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch {
          // 回调异常不应中断检查循环
        }
      }
    }
  }
}
