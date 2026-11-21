/**
 * ObserverBus unit tests.
 *
 * @module observer/__tests__/observer-bus.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ObserverBus } from '../observer-bus.js';
import type { ObserverEvent } from '../types.js';

describe('ObserverBus', () => {
  let bus: ObserverBus;

  beforeEach(() => {
    bus = new ObserverBus({ maxBufferSize: 100 });
  });

  // ---------------------------------------------------------------------------
  // emitEvent basics
  // ---------------------------------------------------------------------------

  it('emitEvent generates a valid UUID and ISO timestamp', () => {
    const event = bus.emitEvent('process.started', { pid: 1234 });

    // UUID v4 format: 8-4-4-4-12 hex chars
    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // Valid ISO 8601 timestamp that parses back to a finite number
    const parsed = Date.parse(event.timestamp);
    expect(Number.isFinite(parsed)).toBe(true);
  });

  it('emitEvent increments totalEvents', () => {
    expect(bus.totalEvents).toBe(0);
    bus.emitEvent('process.started', { pid: 1 });
    expect(bus.totalEvents).toBe(1);
    bus.emitEvent('process.stopped', { pid: 1 });
    expect(bus.totalEvents).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // query()
  // ---------------------------------------------------------------------------

  it('query() with no filter returns all events', () => {
    bus.emitEvent('process.started', { pid: 1 });
    bus.emitEvent('process.stopped', { pid: 1 });
    bus.emitEvent('health.probe_result', { ok: true });

    const events = bus.query();
    expect(events).toHaveLength(3);
  });

  it('query({ types }) filters by event type', () => {
    bus.emitEvent('process.started', { pid: 1 });
    bus.emitEvent('process.stopped', { pid: 1 });
    bus.emitEvent('process.started', { pid: 2 });
    bus.emitEvent('health.probe_result', { ok: true });

    const started = bus.query({ types: ['process.started'] });
    expect(started).toHaveLength(2);
    expect(started.every((e) => e.type === 'process.started')).toBe(true);
  });

  it('query({ since }) filters by time', async () => {
    const before = new Date();
    bus.emitEvent('process.started', { pid: 1 });

    // Wait enough time so the next event gets a strictly later timestamp
    await new Promise((resolve) => setTimeout(resolve, 50));
    const midpoint = new Date();
    await new Promise((resolve) => setTimeout(resolve, 50));
    bus.emitEvent('process.stopped', { pid: 1 });

    const recent = bus.query({ since: midpoint });
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe('process.stopped');

    const all = bus.query({ since: before });
    expect(all).toHaveLength(2);
  });

  it('query({ limit }) limits the number of returned events', () => {
    for (let i = 0; i < 10; i++) {
      bus.emitEvent('process.started', { pid: i });
    }

    const limited = bus.query({ limit: 3 });
    expect(limited).toHaveLength(3);

    // Should return the most recent 3
    expect(limited[0].payload['pid']).toBe(7);
    expect(limited[2].payload['pid']).toBe(9);
  });

  // ---------------------------------------------------------------------------
  // Ring buffer eviction
  // ---------------------------------------------------------------------------

  it('ring buffer discards oldest events when exceeding maxBufferSize', () => {
    const smallBus = new ObserverBus({ maxBufferSize: 5 });

    for (let i = 0; i < 10; i++) {
      smallBus.emitEvent('process.started', { pid: i });
    }

    // totalEvents counts all ever emitted
    expect(smallBus.totalEvents).toBe(10);

    // But only the last 5 are in the buffer
    const events = smallBus.query();
    expect(events).toHaveLength(5);

    // The remaining events should be the most recent ones (pid 5..9)
    expect(events[0].payload['pid']).toBe(5);
    expect(events[4].payload['pid']).toBe(9);
  });

  // ---------------------------------------------------------------------------
  // getCounts()
  // ---------------------------------------------------------------------------

  it('getCounts() returns correct per-type counts', () => {
    bus.emitEvent('process.started', { pid: 1 });
    bus.emitEvent('process.started', { pid: 2 });
    bus.emitEvent('process.stopped', { pid: 1 });

    const counts = bus.getCounts();
    expect(counts['process.started']).toBe(2);
    expect(counts['process.stopped']).toBe(1);
    expect(counts['health.probe_result']).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // subscribe / unsubscribe
  // ---------------------------------------------------------------------------

  it('subscribe callback is triggered on matching events', () => {
    const received: ObserverEvent[] = [];
    bus.subscribe(['process.started'], (event) => {
      received.push(event);
    });

    bus.emitEvent('process.started', { pid: 1 });
    bus.emitEvent('process.stopped', { pid: 1 }); // should not trigger
    bus.emitEvent('process.started', { pid: 2 });

    expect(received).toHaveLength(2);
    expect(received[0].payload['pid']).toBe(1);
    expect(received[1].payload['pid']).toBe(2);
  });

  it('unsubscribe stops notifications', () => {
    const received: ObserverEvent[] = [];
    const unsub = bus.subscribe(['process.started'], (event) => {
      received.push(event);
    });

    bus.emitEvent('process.started', { pid: 1 });
    expect(received).toHaveLength(1);

    unsub();

    bus.emitEvent('process.started', { pid: 2 });
    expect(received).toHaveLength(1); // no new events
  });

  // ---------------------------------------------------------------------------
  // clear()
  // ---------------------------------------------------------------------------

  it('clear() empties all events and resets counts', () => {
    bus.emitEvent('process.started', { pid: 1 });
    bus.emitEvent('process.stopped', { pid: 1 });

    expect(bus.totalEvents).toBe(2);
    expect(bus.query()).toHaveLength(2);
    expect(Object.keys(bus.getCounts())).toHaveLength(2);

    bus.clear();

    expect(bus.totalEvents).toBe(0);
    expect(bus.query()).toHaveLength(0);
    expect(Object.keys(bus.getCounts())).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // createSSEHandler
  // ---------------------------------------------------------------------------

  it('createSSEHandler returns a function', () => {
    const handler = bus.createSSEHandler();
    expect(typeof handler).toBe('function');
  });
});
