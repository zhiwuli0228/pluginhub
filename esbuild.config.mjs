import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  external: [
    '@deepseek-ai/*',
    'react',
    'react-dom',
  ],
}

await Promise.all([
  // Host plugin entry
  build({
    ...shared,
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
  }),
  // CLI entry
  build({
    ...shared,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/cli.js',
    banner: { js: '#!/usr/bin/env node' },
  }),
])

console.log('Build complete')
