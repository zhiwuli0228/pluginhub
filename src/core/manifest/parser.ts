/**
 * Plugin Manifest v1alpha1 parser.
 *
 * Parses YAML or JSON content into a {@link PluginManifest} object.
 * Parsing performs basic type coercion only — use {@link ManifestValidator}
 * for structural and semantic validation.
 *
 * @module
 */

import { parse as parseYaml } from 'yaml';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import type { PluginManifest } from './types.js';

/**
 * Error thrown when manifest parsing fails due to malformed input.
 */
export class ManifestParseError extends Error {
  /** The underlying cause, if any. */
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ManifestParseError';
    this.cause = cause;
  }
}

/**
 * Stateless parser for Plugin Manifest v1alpha1 documents.
 *
 * Supports YAML strings, JSON objects, and file loading (auto-detects format
 * by extension). Parsing does **not** validate against the schema — call
 * `ManifestValidator.validate()` afterwards.
 */
export class ManifestParser {
  /**
   * Parse a YAML string into a {@link PluginManifest}.
   *
   * @param yamlContent - Raw YAML text.
   * @returns Parsed manifest object (unvalidated).
   * @throws {ManifestParseError} If the YAML is malformed or does not produce an object.
   */
  static parseYaml(yamlContent: string): PluginManifest {
    let parsed: unknown;
    try {
      parsed = parseYaml(yamlContent);
    } catch (err) {
      throw new ManifestParseError(
        `Failed to parse YAML: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    if (parsed === null || parsed === undefined || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ManifestParseError(
        'YAML content must parse to a non-null object at the top level.',
      );
    }

    return parsed as PluginManifest;
  }

  /**
   * Parse a JSON-compatible object into a {@link PluginManifest}.
   *
   * Accepts the result of `JSON.parse()` or any plain object. Performs a
   * shallow sanity check that the value is a non-null object.
   *
   * @param jsonContent - A parsed JSON value.
   * @returns The same object cast to {@link PluginManifest}.
   * @throws {ManifestParseError} If the input is not a plain object.
   */
  static parseJson(jsonContent: unknown): PluginManifest {
    if (jsonContent === null || jsonContent === undefined || typeof jsonContent !== 'object' || Array.isArray(jsonContent)) {
      throw new ManifestParseError(
        'JSON content must be a non-null object at the top level.',
      );
    }

    return jsonContent as PluginManifest;
  }

  /**
   * Load a manifest from a file path.
   *
   * Files with `.yaml` or `.yml` extensions are parsed as YAML; everything
   * else is parsed as JSON.
   *
   * @param filePath - Absolute or relative path to the manifest file.
   * @returns Parsed manifest object (unvalidated).
   * @throws {ManifestParseError} On I/O errors or parse failures.
   */
  static async loadFile(filePath: string): Promise<PluginManifest> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new ManifestParseError(
        `Failed to read manifest file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    const ext = extname(filePath).toLowerCase();
    if (ext === '.yaml' || ext === '.yml') {
      return ManifestParser.parseYaml(content);
    }

    // Default to JSON parsing
    try {
      const parsed = JSON.parse(content);
      return ManifestParser.parseJson(parsed);
    } catch (err) {
      throw new ManifestParseError(
        `Failed to parse JSON from "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
  }
}
