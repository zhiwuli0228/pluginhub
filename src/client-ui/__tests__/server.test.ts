/**
 * UIServer unit tests.
 *
 * @module client-ui/__tests__/server.test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { UIServer } from '../server.js';

describe('UIServer', () => {
  let server: UIServer | null = null;

  afterEach(async () => {
    if (server?.running) {
      await server.stop();
    }
    server = null;
  });

  it('constructs without error', () => {
    expect(() => {
      server = new UIServer();
    }).not.toThrow();
  });

  it('constructs with custom options without error', () => {
    expect(() => {
      server = new UIServer({ port: 17890, host: '127.0.0.1' });
    }).not.toThrow();
  });

  it('start() returns url and port', async () => {
    server = new UIServer({ port: 0 }); // port 0 = OS assigns a free port
    const result = await server.start();

    expect(result).toHaveProperty('url');
    expect(result).toHaveProperty('port');
    expect(typeof result.url).toBe('string');
    expect(typeof result.port).toBe('number');
    expect(result.port).toBeGreaterThan(0);
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('running state is false before start and true after start', async () => {
    server = new UIServer({ port: 0 });
    expect(server.running).toBe(false);

    await server.start();
    expect(server.running).toBe(true);
  });

  it('stop() sets running to false', async () => {
    server = new UIServer({ port: 0 });
    await server.start();
    expect(server.running).toBe(true);

    await server.stop();
    expect(server.running).toBe(false);
  });

  it('start() is idempotent when already running (throws)', async () => {
    server = new UIServer({ port: 0 });
    await server.start();

    // Calling start again while running should throw
    await expect(server.start()).rejects.toThrow(/already running/i);
  });

  it('stop() is idempotent when not running', async () => {
    server = new UIServer({ port: 0 });

    // stop on a never-started server should not throw
    await expect(server.stop()).resolves.toBeUndefined();
    expect(server.running).toBe(false);
  });

  it('can restart after stop', async () => {
    server = new UIServer({ port: 0 });

    await server.start();
    expect(server.running).toBe(true);

    await server.stop();
    expect(server.running).toBe(false);

    // Restart
    const result = await server.start();
    expect(server.running).toBe(true);
    expect(result.port).toBeGreaterThan(0);
  });
});
