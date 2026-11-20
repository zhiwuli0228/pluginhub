/**
 * Adapters — protocol-specific capability normalizers.
 *
 * Each adapter converts a native protocol description into the canonical
 * `CanonicalCapability` shape defined in `../capability/types.js`.
 *
 * @module
 */

export {
  OpenApiAdapter,
  type OpenApiOperation,
  type OpenApiAdapterOptions,
} from './openapi-adapter.js';
