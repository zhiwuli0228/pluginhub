import { describe, it, expect } from 'vitest';
import { PluginHubFacade } from '../facade.js';

describe('PluginHubFacade', () => {
  it('constructs without error', () => {
    expect(() => new PluginHubFacade()).not.toThrow();
  });

  it('constructs with custom config without error', () => {
    expect(() =>
      new PluginHubFacade({
        localPluginPaths: ['./test-plugins'],
        defaultMaxTools: 20,
        gracefulShutdownMs: 3000,
      }),
    ).not.toThrow();
  });

  it('initialize() completes without error', async () => {
    const facade = new PluginHubFacade();
    await expect(facade.initialize()).resolves.toBeUndefined();
    await facade.shutdown();
  });

  it('initialize() is idempotent (safe to call multiple times)', async () => {
    const facade = new PluginHubFacade();
    await facade.initialize();
    await expect(facade.initialize()).resolves.toBeUndefined();
    await facade.shutdown();
  });

  it('getStatus() returns a valid status object', async () => {
    const facade = new PluginHubFacade();
    await facade.initialize();
    const status = facade.getStatus();
    expect(status).toHaveProperty('discoveredPlugins');
    expect(status).toHaveProperty('activeProcesses');
    expect(status).toHaveProperty('registeredCapabilities');
    expect(status).toHaveProperty('uptime');
    expect(typeof status.discoveredPlugins).toBe('number');
    expect(typeof status.activeProcesses).toBe('number');
    expect(typeof status.registeredCapabilities).toBe('number');
    expect(typeof status.uptime).toBe('number');
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    await facade.shutdown();
  });

  it('getStatus() returns uptime=0 before initialization', () => {
    const facade = new PluginHubFacade();
    const status = facade.getStatus();
    expect(status.uptime).toBe(0);
  });

  it('shutdown() completes without error', async () => {
    const facade = new PluginHubFacade();
    await facade.initialize();
    await expect(facade.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown() is idempotent', async () => {
    const facade = new PluginHubFacade();
    await facade.initialize();
    await facade.shutdown();
    await expect(facade.shutdown()).resolves.toBeUndefined();
  });

  it('listDiscoveredPlugins() returns an array', async () => {
    const facade = new PluginHubFacade();
    await facade.initialize();
    const plugins = facade.listDiscoveredPlugins();
    expect(Array.isArray(plugins)).toBe(true);
    await facade.shutdown();
  });

  it('throws on operations after shutdown', async () => {
    const facade = new PluginHubFacade();
    await facade.initialize();
    await facade.shutdown();
    await expect(
      facade.startPlugin('test', { command: 'echo' }),
    ).rejects.toThrow(/shut down/i);
  });
});
