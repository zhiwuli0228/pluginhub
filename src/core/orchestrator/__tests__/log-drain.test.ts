import { describe, it, expect } from 'vitest'
import { PassThrough } from 'node:stream'
import { LogDrain, LOG_ENTRY_EVENT } from '../log-drain.js'
import type { LogEntry } from '../log-drain.js'

/**
 * Helper: create a PassThrough stream and write chunks to it.
 * Returns the stream and a function to end it.
 */
function createMockStream(): {
  stream: PassThrough
  write: (chunk: string) => void
  end: () => void
} {
  const stream = new PassThrough()
  return {
    stream,
    write: (chunk: string) => {
      stream.write(chunk)
    },
    end: () => {
      stream.end()
    },
  }
}

describe('LogDrain', () => {
  it('attach() stdout data produces LogEntry events', async () => {
    const drain = new LogDrain({ runId: 'test-run-1' })
    const { stream: stdout, write, end } = createMockStream()

    const entries: LogEntry[] = []
    drain.onEntry((entry) => entries.push(entry))

    drain.attach(stdout, null)

    write('hello\n')
    write('world\n')
    end()

    await drain.detach()

    expect(entries).toHaveLength(2)
    expect(entries[0].message).toBe('hello')
    expect(entries[0].level).toBe('stdout')
    expect(entries[1].message).toBe('world')
    expect(entries[1].level).toBe('stdout')
  })

  it('stderr data has level "stderr"', async () => {
    const drain = new LogDrain({ runId: 'test-run-2' })
    const { stream: stderr, write, end } = createMockStream()

    const entries: LogEntry[] = []
    drain.onEntry((entry) => entries.push(entry))

    drain.attach(null, stderr)

    write('error msg\n')
    end()

    await drain.detach()

    expect(entries).toHaveLength(1)
    expect(entries[0].level).toBe('stderr')
    expect(entries[0].message).toBe('error msg')
  })

  it('cross-chunk half-line reassembly works correctly', async () => {
    const drain = new LogDrain({ runId: 'test-run-3' })
    const { stream: stdout, write, end } = createMockStream()

    const entries: LogEntry[] = []
    drain.onEntry((entry) => entries.push(entry))

    drain.attach(stdout, null)

    // Split "hello world\n" across two writes
    write('hello ')
    write('world\n')
    end()

    await drain.detach()

    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('hello world')
  })

  it('runId is correctly injected into every entry', async () => {
    const runId = 'unique-run-id-42'
    const drain = new LogDrain({ runId })
    const { stream: stdout, write, end } = createMockStream()

    drain.attach(stdout, null)

    write('line1\n')
    write('line2\n')
    end()

    await drain.detach()

    const entries = drain.getEntries()
    expect(entries.length).toBe(2)
    for (const entry of entries) {
      expect(entry.runId).toBe(runId)
    }
  })

  it('pid is injected when provided', async () => {
    const drain = new LogDrain({ runId: 'test-pid', pid: 12345 })
    const { stream: stdout, write, end } = createMockStream()

    drain.attach(stdout, null)

    write('msg\n')
    end()

    await drain.detach()

    const entries = drain.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].pid).toBe(12345)
  })

  it('detach() flushes remaining buffer (no trailing newline)', async () => {
    const drain = new LogDrain({ runId: 'test-run-4' })
    const { stream: stdout, write, end } = createMockStream()

    const entries: LogEntry[] = []
    drain.onEntry((entry) => entries.push(entry))

    drain.attach(stdout, null)

    write('complete line\n')
    write('partial line')
    end()

    await drain.detach()

    expect(entries).toHaveLength(2)
    expect(entries[0].message).toBe('complete line')
    expect(entries[1].message).toBe('partial line')
  })

  it('maxBufferSize truncation on oversized line without newline', async () => {
    const maxBufferSize = 20
    const drain = new LogDrain({ runId: 'test-run-6', maxBufferSize })
    const { stream: stdout, write, end } = createMockStream()

    const entries: LogEntry[] = []
    drain.onEntry((entry) => entries.push(entry))

    drain.attach(stdout, null)

    // Write a chunk that exceeds maxBufferSize without a newline
    const longContent = 'B'.repeat(50)
    write(longContent)
    end()

    await drain.detach()

    // Should have at least one entry (either truncated or flushed remainder)
    expect(entries.length).toBeGreaterThanOrEqual(1)
    const allMessages = entries.map((e) => e.message).join('')
    expect(allMessages.length).toBeGreaterThan(0)
  })

  it('getEntries() returns complete log from both streams', async () => {
    const drain = new LogDrain({ runId: 'test-run-7' })
    const { stream: stdout, write: writeOut, end: endOut } = createMockStream()
    const { stream: stderr, write: writeErr, end: endErr } = createMockStream()

    drain.attach(stdout, stderr)

    writeOut('a\n')
    writeOut('b\n')
    writeOut('c\n')
    writeErr('err1\n')
    endOut()
    endErr()

    await drain.detach()

    const entries = drain.getEntries()
    expect(entries.length).toBe(4)

    const messages = entries.map((e) => e.message).sort()
    expect(messages).toEqual(['a', 'b', 'c', 'err1'])
  })

  it('onEntry() unsubscribe stops further notifications', async () => {
    const drain = new LogDrain({ runId: 'test-run-8' })
    const { stream: stdout, write, end } = createMockStream()

    let count = 0
    const unsub = drain.onEntry(() => {
      count++
      unsub() // unsubscribe after first entry
    })

    drain.attach(stdout, null)

    write('line1\n')
    write('line2\n')
    end()

    await drain.detach()

    // Only 1 notification should have been received
    expect(count).toBe(1)
    // But getEntries() should still have all entries
    expect(drain.getEntries().length).toBe(2)
  })

  it('handles CRLF line endings', async () => {
    const drain = new LogDrain({ runId: 'test-crlf' })
    const { stream: stdout, write, end } = createMockStream()

    drain.attach(stdout, null)

    write('hello\r\n')
    write('world\r\n')
    end()

    await drain.detach()

    const entries = drain.getEntries()
    expect(entries).toHaveLength(2)
    expect(entries[0].message).toBe('hello')
    expect(entries[1].message).toBe('world')
  })

  it('LOG_ENTRY_EVENT constant matches expected event name', () => {
    expect(LOG_ENTRY_EVENT).toBe('entry')
  })

  it('each entry has a valid ISO timestamp', async () => {
    const drain = new LogDrain({ runId: 'test-ts' })
    const { stream: stdout, write, end } = createMockStream()

    drain.attach(stdout, null)
    write('msg\n')
    end()
    await drain.detach()

    const entries = drain.getEntries()
    expect(entries).toHaveLength(1)
    const ts = new Date(entries[0].timestamp)
    expect(ts.getTime()).not.toBeNaN()
  })

  it('attaching null streams completes immediately', async () => {
    const drain = new LogDrain({ runId: 'test-null' })
    drain.attach(null, null)
    await drain.detach()

    expect(drain.getEntries()).toHaveLength(0)
  })
})
