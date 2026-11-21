#!/usr/bin/env node

/**
 * pluginhub CLI — Standalone command-line interface
 *
 * Usage:
 *   pluginhub init                    Initialize local configuration
 *   pluginhub install <path|url>      Install a plugin from manifest
 *   pluginhub list [--kind <type>]    List registered capabilities
 *   pluginhub start <plugin-id>       Start a plugin process
 *   pluginhub stop <plugin-id>        Stop a plugin process
 *   pluginhub status                  Show global health overview
 *   pluginhub logs <plugin-id>        View plugin logs
 *   pluginhub discover <domain>       Discover plugins from a domain
 *   pluginhub validate <manifest>     Validate a plugin manifest
 *   pluginhub export <id> --format f  Export to Agent Plugins / A2A / MCP
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { PluginHubFacade } from './host-glue/index.js';
import { ManifestParser } from './core/manifest/index.js';
import { ManifestValidator } from './core/manifest/index.js';
import type { ValidationResult } from './core/manifest/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Argument parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse `--key value` flags from an argument list.
 *
 * Returns a record of flag names (without the `--` prefix) to their string
 * values. Positional arguments are ignored.
 */
function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (!value.startsWith('--')) {
        flags[key] = value;
        i++; // skip the value token
      } else {
        // Flag with no value (boolean-style) — store as empty string
        flags[key] = '';
      }
    } else if (args[i].startsWith('--')) {
      // Last token is a bare flag
      flags[args[i].slice(2)] = '';
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/**
 * Print a simple aligned table to stdout.
 *
 * @param headers - Column header labels.
 * @param rows    - Array of row arrays (same length as headers).
 */
function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log('(no results)');
    return;
  }

  // Compute column widths
  const widths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[i] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  // Print header
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join('  ');
  console.log(headerLine);
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));

  // Print rows
  for (const row of rows) {
    const line = row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join('  ');
    console.log(line);
  }
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * @example formatUptime(8_130_000) → "2h 15m 30s"
 */
function formatUptime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;

  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Print a validation result (errors + warnings) in a friendly format.
 */
function printValidationResult(label: string, result: ValidationResult): void {
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log(`✅ ${label}: valid`);
    return;
  }

  if (result.errors.length > 0) {
    console.log(`❌ ${label}: ${result.errors.length} error(s)`);
    for (const err of result.errors) {
      console.log(`   [${err.code}] ${err.path}: ${err.message}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log(`⚠️  ${result.warnings.length} warning(s)`);
    for (const warn of result.warnings) {
      console.log(`   [${warn.code}] ${warn.path}: ${warn.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
pluginhub v${VERSION} — PluginHub CLI

USAGE:
  pluginhub <command> [options]

COMMANDS:
  init                          Initialize local config (~/.pluginhub/)
  install <path>                Install plugin from manifest directory
  list [--kind <type>]          List registered capabilities
  start <plugin-id>             Start a plugin process
  stop <plugin-id>              Stop a plugin process
  status                        Show global health overview
  logs <plugin-id> [--follow]   View plugin logs
  discover <domain>             Discover plugins from a domain
  validate <manifest-path>      Validate a plugin manifest
  export <id> --format <fmt>    Export manifest (placeholder)

OPTIONS:
  --help, -h                    Show this help message
  --version, -v                 Show version number

EXAMPLES:
  pluginhub init
  pluginhub install ./my-plugin
  pluginhub list --kind mcp
  pluginhub start my-plugin-id
  pluginhub validate plugin.yaml
`.trim());
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

/**
 * `pluginhub init` — Create ~/.pluginhub/ directory and default config.json.
 */
async function cmdInit(): Promise<void> {
  const configDir = join(homedir(), '.pluginhub');
  const configFile = join(configDir, 'config.json');

  try {
    await mkdir(configDir, { recursive: true });

    const defaultConfig = {
      version: 1,
      localPluginPaths: [],
      defaultMaxTools: 40,
      gracefulShutdownMs: 5000,
    };

    // Only write if not already present
    try {
      const { access } = await import('node:fs/promises');
      await access(configFile);
      console.log(`Configuration already exists at ${configFile}`);
    } catch {
      // File doesn't exist — create it
      await writeFile(configFile, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
      console.log(`Initialized PluginHub config at ${configFile}`);
    }

    console.log(`Config directory: ${configDir}`);
  } catch (err) {
    console.error(`Failed to initialize: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * `pluginhub install <path>` — Load manifest, validate, and report.
 */
async function cmdInstall(manifestPath: string | undefined): Promise<void> {
  if (!manifestPath) {
    console.error('Error: Missing manifest path.');
    console.error('Usage: pluginhub install <path>');
    process.exit(1);
  }

  try {
    console.log(`Loading manifest from: ${manifestPath}`);
    const manifest = await ManifestParser.loadFile(manifestPath);

    console.log('Validating manifest...');
    const structural = ManifestValidator.validate(manifest);
    if (!structural.valid) {
      printValidationResult('Structural validation', structural);
      console.error('\nInstallation aborted due to validation errors.');
      process.exit(1);
    }

    const semantic = ManifestValidator.validateSemantics(manifest);
    printValidationResult('Structural validation', structural);
    printValidationResult('Semantic validation', semantic);

    if (!semantic.valid) {
      console.error('\nInstallation aborted due to semantic errors.');
      process.exit(1);
    }

    const name = manifest.metadata?.name ?? '(unknown)';
    const version = manifest.metadata?.version ?? '(unknown)';
    console.log(`\n✅ Plugin "${name}" v${version} validated successfully.`);
    console.log('Note: Full installation (copy to registry) is not yet implemented.');
  } catch (err) {
    console.error(`Installation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * `pluginhub list [--kind <type>]` — List discovered plugins / capabilities.
 */
async function cmdList(flags: Record<string, string>): Promise<void> {
  const facade = new PluginHubFacade();

  try {
    await facade.initialize();

    const kindFilter = flags['kind'];
    const entries = facade.listDiscoveredPlugins();

    const filtered = kindFilter
      ? entries.filter((e) => e.protocol === kindFilter)
      : entries;

    if (filtered.length === 0) {
      console.log(kindFilter
        ? `No plugins found with kind "${kindFilter}".`
        : 'No plugins discovered. Add local paths or run `pluginhub discover <domain>`.');
      return;
    }

    console.log(`Found ${filtered.length} plugin(s):\n`);
    printTable(
      ['ID', 'Name', 'Protocol', 'Source', 'Trust'],
      filtered.map((e) => [
        e.id,
        e.name,
        e.protocol,
        e.source,
        String(e.trustScore),
      ]),
    );
  } catch (err) {
    console.error(`List failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await facade.shutdown();
  }
}

/**
 * `pluginhub start <plugin-id>` — Start a plugin process.
 */
async function cmdStart(pluginId: string | undefined): Promise<void> {
  if (!pluginId) {
    console.error('Error: Missing plugin ID.');
    console.error('Usage: pluginhub start <plugin-id>');
    process.exit(1);
  }

  const facade = new PluginHubFacade();

  try {
    await facade.initialize();

    // Look up the plugin in discovered entries to find its entrypoint
    const entries = facade.listDiscoveredPlugins();
    const entry = entries.find((e) => e.id === pluginId);

    if (!entry) {
      console.error(`Plugin "${pluginId}" not found in discovered plugins.`);
      console.error('Run `pluginhub list` to see available plugins.');
      process.exit(1);
    }

    // Extract command from manifest runtime.entrypoints if available
    const raw = entry.raw as Record<string, unknown> | undefined;
    const runtime = raw?.runtime as Record<string, unknown> | undefined;
    const entrypoints = runtime?.entrypoints as Array<Record<string, unknown>> | undefined;
    const firstEntrypoint = entrypoints?.[0];

    const command = (firstEntrypoint?.command as string) ?? 'echo';
    const args = (firstEntrypoint?.args as string[]) ?? [`Starting ${pluginId} (no entrypoint configured)`];

    console.log(`Starting plugin "${pluginId}"...`);
    console.log(`  Command: ${command} ${args.join(' ')}`);

    const instance = await facade.startPlugin(pluginId, { command, args });

    console.log(`✅ Plugin "${pluginId}" started.`);
    console.log(`  PID:   ${instance.pid ?? 'N/A'}`);
    console.log(`  Port:  ${instance.port ?? 'N/A'}`);
    console.log(`  State: ${instance.processState}`);
  } catch (err) {
    console.error(`Start failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await facade.shutdown();
  }
}

/**
 * `pluginhub stop <plugin-id>` — Stop a running plugin process.
 */
async function cmdStop(pluginId: string | undefined): Promise<void> {
  if (!pluginId) {
    console.error('Error: Missing plugin ID.');
    console.error('Usage: pluginhub stop <plugin-id>');
    process.exit(1);
  }

  const facade = new PluginHubFacade();

  try {
    await facade.initialize();

    console.log(`Stopping plugin "${pluginId}"...`);
    await facade.stopPlugin(pluginId);
    console.log(`✅ Plugin "${pluginId}" stopped.`);
  } catch (err) {
    console.error(`Stop failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await facade.shutdown();
  }
}

/**
 * `pluginhub status` — Show global health overview.
 */
async function cmdStatus(): Promise<void> {
  const facade = new PluginHubFacade();

  try {
    await facade.initialize();

    const status = facade.getStatus();

    console.log('PluginHub Status');
    console.log('================');
    console.log(`  Discovered plugins:     ${status.discoveredPlugins}`);
    console.log(`  Active processes:       ${status.activeProcesses}`);
    console.log(`  Registered capabilities: ${status.registeredCapabilities}`);
    console.log(`  Uptime:                 ${formatUptime(status.uptime)}`);

    // Also show active plugin details if any
    const activePlugins = facade.listActivePlugins();
    if (activePlugins.length > 0) {
      console.log('\nActive Plugins:');
      printTable(
        ['ID', 'PID', 'Port', 'State', 'Health'],
        activePlugins.map((p) => [
          p.id,
          String(p.pid ?? '-'),
          String(p.port ?? '-'),
          p.processState,
          p.healthStatus,
        ]),
      );
    }
  } catch (err) {
    console.error(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await facade.shutdown();
  }
}

/**
 * `pluginhub logs <plugin-id> [--follow]` — View plugin logs.
 */
async function cmdLogs(
  pluginId: string | undefined,
  _flags: Record<string, string>,
): Promise<void> {
  if (!pluginId) {
    console.error('Error: Missing plugin ID.');
    console.error('Usage: pluginhub logs <plugin-id> [--follow]');
    process.exit(1);
  }

  // P4 placeholder — log tailing is not yet implemented in CLI mode
  console.log(`Logs for plugin "${pluginId}":`);
  console.log('  Logs not yet available in CLI mode.');
  console.log('  This feature will be implemented in a future release.');
}

/**
 * `pluginhub discover <domain>` — Discover plugins from a domain.
 */
async function cmdDiscover(domain: string | undefined): Promise<void> {
  if (!domain) {
    console.error('Error: Missing domain.');
    console.error('Usage: pluginhub discover <domain>');
    process.exit(1);
  }

  const facade = new PluginHubFacade();

  try {
    await facade.initialize();

    console.log(`Discovering plugins from domain: ${domain}`);
    const entries = await facade.discovery.discoverDomain(domain);

    if (entries.length === 0) {
      console.log(`No plugins discovered from "${domain}".`);
      console.log('(Domain discovery via well-known endpoints is not yet fully implemented.)');
      return;
    }

    console.log(`Found ${entries.length} plugin(s):\n`);
    printTable(
      ['ID', 'Name', 'Protocol', 'Source', 'Trust'],
      entries.map((e) => [
        e.id,
        e.name,
        e.protocol,
        e.source,
        String(e.trustScore),
      ]),
    );
  } catch (err) {
    console.error(`Discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await facade.shutdown();
  }
}

/**
 * `pluginhub validate <manifest-path>` — Validate a plugin manifest.
 */
async function cmdValidate(manifestPath: string | undefined): Promise<void> {
  if (!manifestPath) {
    console.error('Error: Missing manifest path.');
    console.error('Usage: pluginhub validate <manifest-path>');
    process.exit(1);
  }

  try {
    console.log(`Validating manifest: ${manifestPath}\n`);

    const manifest = await ManifestParser.loadFile(manifestPath);
    console.log('Parsed manifest successfully.\n');

    // Structural validation
    const structural = ManifestValidator.validate(manifest);
    printValidationResult('Structural validation', structural);

    // Semantic validation (only meaningful if structural passes)
    if (structural.valid) {
      console.log('');
      const semantic = ManifestValidator.validateSemantics(manifest);
      printValidationResult('Semantic validation', semantic);

      // Summary
      console.log('');
      if (semantic.valid) {
        console.log('✅ Manifest is valid.');
      } else {
        console.log('❌ Manifest has semantic errors.');
        process.exit(1);
      }
    } else {
      console.log('\n❌ Manifest has structural errors. Skipping semantic validation.');
      process.exit(1);
    }
  } catch (err) {
    console.error(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/**
 * `pluginhub export <id> --format <fmt>` — Export manifest (placeholder).
 */
async function cmdExport(
  id: string | undefined,
  flags: Record<string, string>,
): Promise<void> {
  if (!id) {
    console.error('Error: Missing plugin ID.');
    console.error('Usage: pluginhub export <id> --format <agent-plugins|a2a|mcp>');
    process.exit(1);
  }

  const format = flags['format'] ?? '(not specified)';

  console.log(`Export plugin "${id}" as format: ${format}`);
  console.log('Export not yet implemented.');
  console.log('This feature will support agent-plugins, a2a, and mcp formats.');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;

    case '--version':
    case '-v':
      console.log(`pluginhub v${VERSION}`);
      break;

    case 'init':
      await cmdInit();
      break;

    case 'install':
      await cmdInstall(args[1]);
      break;

    case 'list':
      await cmdList(parseFlags(args));
      break;

    case 'start':
      await cmdStart(args[1]);
      break;

    case 'stop':
      await cmdStop(args[1]);
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'logs':
      await cmdLogs(args[1], parseFlags(args));
      break;

    case 'discover':
      await cmdDiscover(args[1]);
      break;

    case 'validate':
      await cmdValidate(args[1]);
      break;

    case 'export':
      await cmdExport(args[1], parseFlags(args));
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
