/**
 * @module log-drain
 * @description LogDrain - 子进程日志聚合模块
 * 
 * 职责：
 * - 并发 drain stdout/stderr，避免管道满阻塞子进程
 * - 行帧重组（处理跨 chunk 半行）
 * - JSONL 格式事件发射与内存收集
 * - runId 注入与 per-stream buffer 限流
 */

import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

/**
 * 单条结构化日志条目（JSONL 输出单元）
 */
export interface LogEntry {
  /** ISO 8601 时间戳 */
  timestamp: string;
  /** 来源流标识 */
  level: 'stdout' | 'stderr';
  /** 所属运行实例的唯一 ID */
  runId: string;
  /** 日志消息内容（已去除尾部换行） */
  message: string;
  /** 可选的子进程 PID */
  pid?: number;
}

/**
 * LogDrain 构造选项
 */
export interface LogDrainOptions {
  /** 每个进程实例绑定的唯一运行 ID */
  runId: string;
  /** 可选的子进程 PID，注入到每条日志中 */
  pid?: number;
  /** 单流行缓冲上限（字节），默认 64KB；超限截断并标记 */
  maxBufferSize?: number;
}

/** 默认单行缓冲上限：64 KB */
const DEFAULT_MAX_BUFFER_SIZE = 64 * 1024;

/** 日志条目事件名称 */
export const LOG_ENTRY_EVENT = 'entry';

/**
 * 子进程日志聚合器。
 *
 * 同时消费 stdout 和 stderr 两条流，按 `\n` 重组完整行，
 * 将每行封装为 {@link LogEntry} 后以 `'entry'` 事件发出，
 * 并在内存中保留全部条目供后续检索。
 *
 * @example
 * ```ts
 * const drain = new LogDrain({ runId: 'run-abc', pid: child.pid });
 * drain.attach(child.stdout, child.stderr);
 * drain.onEntry((entry) => console.log(JSON.stringify(entry)));
 * await childExitPromise;
 * await drain.detach();
 * ```
 */
export class LogDrain extends EventEmitter {
  private readonly _runId: string;
  private readonly _pid: number | undefined;
  private readonly _maxBufferSize: number;

  /** 已收集的日志条目（只追加） */
  private readonly _entries: LogEntry[] = [];

  /** 当前活跃的 drain abort 控制器 */
  private _abortController: AbortController | null = null;

  /** detach 完成 Promise，用于等待残留缓冲刷新 */
  private _drainComplete: Promise<void> | null = null;

  constructor(options: LogDrainOptions) {
    super();
    this._runId = options.runId;
    this._pid = options.pid;
    this._maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  /**
   * 绑定子进程的 stdout / stderr 流并开始并发消费。
   *
   * 若某条流为 `null`（例如被重定向或忽略），则跳过该流。
   * 重复调用会先 detach 旧流再绑定新流。
   *
   * @param stdout - 子进程标准输出流
   * @param stderr - 子进程标准错误流
   */
  attach(stdout: Readable | null, stderr: Readable | null): void {
    // 如果已有活跃 drain，先清理
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    const controller = new AbortController();
    this._abortController = controller;

    const streams: Array<{ stream: Readable; level: 'stdout' | 'stderr' }> = [];
    if (stdout) streams.push({ stream: stdout, level: 'stdout' });
    if (stderr) streams.push({ stream: stderr, level: 'stderr' });

    if (streams.length === 0) {
      this._drainComplete = Promise.resolve();
      return;
    }

    // 每条流独立 drain，互不阻塞
    const promises = streams.map(({ stream, level }) =>
      this._drainStream(stream, level, controller.signal)
    );

    this._drainComplete = Promise.all(promises).then(() => undefined);
  }

  /**
   * 断开所有流并等待残留缓冲刷新完毕。
   *
   * detach 后仍可调用 {@link getEntries} 获取完整日志。
   */
  async detach(): Promise<void> {
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }

    if (this._drainComplete) {
      await this._drainComplete;
      this._drainComplete = null;
    }
  }

  /**
   * 返回迄今为止收集的全部日志条目副本。
   */
  getEntries(): LogEntry[] {
    return [...this._entries];
  }

  /**
   * 订阅新的日志条目。
   *
   * @param callback - 每当产生一条完整日志行时调用
   * @returns 取消订阅函数
   */
  onEntry(callback: (entry: LogEntry) => void): () => void {
    this.on(LOG_ENTRY_EVENT, callback);
    return () => {
      this.off(LOG_ENTRY_EVENT, callback);
    };
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * 对单条 Readable 流执行异步 drain 循环。
   *
   * 使用 `data` 事件 + 手动暂停/恢复来避免背压问题，
   * 同时维护一个 per-stream 的行缓冲来处理跨 chunk 的半行。
   */
  private async _drainStream(
    stream: Readable,
    level: 'stdout' | 'stderr',
    signal: AbortSignal
  ): Promise<void> {
    let lineBuffer = '';

    const processChunk = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      lineBuffer += text;

      // 按 \n 分割；最后一段可能是不完整的半行，保留在 buffer 中
      let newlineIdx: number;
      while ((newlineIdx = lineBuffer.indexOf('\n')) !== -1) {
        let line = lineBuffer.slice(0, newlineIdx);
        lineBuffer = lineBuffer.slice(newlineIdx + 1);

        // 去除 \r（兼容 CRLF）
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }

        this._emitLine(line, level);
      }

      // 缓冲超限保护：截断并标记
      if (lineBuffer.length > this._maxBufferSize) {
        const truncated = lineBuffer.slice(0, this._maxBufferSize) + '…[TRUNCATED]';
        this._emitLine(truncated, level);
        lineBuffer = '';
      }
    };

    return new Promise<void>((resolve) => {
      const cleanup = (): void => {
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onError);
        stream.removeListener('close', onClose);
      };

      const onData = (chunk: Buffer | string): void => {
        if (signal.aborted) return;
        processChunk(chunk);
      };

      const flushRemaining = (): void => {
        // 流结束后刷新残余缓冲（无尾换行的最后一行）
        if (lineBuffer.length > 0) {
          let line = lineBuffer;
          lineBuffer = '';
          if (line.endsWith('\r')) {
            line = line.slice(0, -1);
          }
          this._emitLine(line, level);
        }
      };

      const onEnd = (): void => {
        flushRemaining();
        cleanup();
        resolve();
      };

      const onError = (_err: Error): void => {
        // 流出错时仍尝试刷新残余，然后结束
        flushRemaining();
        cleanup();
        resolve();
      };

      const onClose = (): void => {
        // close 可能在 end 之前触发（如进程被 kill）
        flushRemaining();
        cleanup();
        resolve();
      };

      const onAbort = (): void => {
        flushRemaining();
        cleanup();
        resolve();
      };

      stream.on('data', onData);
      stream.once('end', onEnd);
      stream.once('error', onError);
      stream.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });

      // 确保流处于 flowing 模式
      stream.resume();
    });
  }

  /**
   * 将一行文本封装为 {@link LogEntry}，存入数组并发射事件。
   */
  private _emitLine(message: string, level: 'stdout' | 'stderr'): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      runId: this._runId,
      message,
    };

    if (this._pid !== undefined) {
      entry.pid = this._pid;
    }

    this._entries.push(entry);
    this.emit(LOG_ENTRY_EVENT, entry);
  }
}
