import { describe, it, expect, afterEach } from 'vitest'
import { PortAllocator } from '../port-allocator.js'

describe('PortAllocator', () => {
  let allocator: PortAllocator

  afterEach(() => {
    // Ensure cleanup even if a test fails
    try {
      allocator?.destroy()
    } catch {
      // ignore
    }
  })

  it('allocate() returns a valid port number in range 1024-65535', async () => {
    allocator = new PortAllocator()
    const port = await allocator.allocate()
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })

  it('consecutive allocate() calls return different ports', async () => {
    allocator = new PortAllocator()
    const port1 = await allocator.allocate()
    const port2 = await allocator.allocate()
    const port3 = await allocator.allocate()

    expect(port1).not.toBe(port2)
    expect(port2).not.toBe(port3)
    expect(port1).not.toBe(port3)
  })

  it('release() marks the port as released', async () => {
    allocator = new PortAllocator()
    const port = await allocator.allocate()

    // Before release
    const beforeRelease = allocator.getAssignedPorts()
    const entryBefore = beforeRelease.find((a) => a.port === port)
    expect(entryBefore).toBeDefined()
    expect(entryBefore!.released).toBe(false)

    // After release
    allocator.release(port)
    const afterRelease = allocator.getAssignedPorts()
    const entryAfter = afterRelease.find((a) => a.port === port)
    expect(entryAfter).toBeDefined()
    expect(entryAfter!.released).toBe(true)
  })

  it('isAvailable() returns true for an unoccupied port', async () => {
    allocator = new PortAllocator()
    // Allocate and immediately release to get a port that's likely free
    const port = await allocator.allocate()
    allocator.release(port)

    // The port should be available since we released it (server was already closed)
    const available = await allocator.isAvailable(port)
    expect(available).toBe(true)
  })

  it('destroy() causes subsequent allocate() to throw', async () => {
    allocator = new PortAllocator()
    allocator.destroy()

    await expect(allocator.allocate()).rejects.toThrow(
      'PortAllocator has been destroyed',
    )
  })

  it('getAssignedPorts() returns correct snapshot', async () => {
    allocator = new PortAllocator()
    const port1 = await allocator.allocate()
    const port2 = await allocator.allocate()
    allocator.release(port1)

    const snapshot = allocator.getAssignedPorts()
    expect(snapshot).toHaveLength(2)

    const entry1 = snapshot.find((a) => a.port === port1)
    const entry2 = snapshot.find((a) => a.port === port2)

    expect(entry1).toBeDefined()
    expect(entry1!.released).toBe(true)
    expect(entry1!.allocatedAt).toBeInstanceOf(Date)

    expect(entry2).toBeDefined()
    expect(entry2!.released).toBe(false)
    expect(entry2!.allocatedAt).toBeInstanceOf(Date)
  })

  it('getAssignedPorts() returns a copy (mutations do not affect internal state)', async () => {
    allocator = new PortAllocator()
    await allocator.allocate()

    const snapshot = allocator.getAssignedPorts()
    snapshot.pop() // mutate the returned array

    const snapshotAgain = allocator.getAssignedPorts()
    expect(snapshotAgain).toHaveLength(1)
  })

  it('allocateWithRetry() returns a valid port', async () => {
    allocator = new PortAllocator()
    const port = await allocator.allocateWithRetry(3)
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65535)
  })
})
