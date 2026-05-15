import { defineConfig } from 'tsup'

const EXTERNAL = ['node-forge', 'commander', 'yaml']

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    splitting: false,
    clean: true,
    treeshake: true,
    outExtension: () => ({ js: '.mjs' }),
    banner: { js: '#!/usr/bin/env node' },
    external: EXTERNAL,
  },
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    tsconfig: './tsconfig.dts.json',
    dts: true,
    splitting: false,
    clean: false,
    treeshake: true,
    outExtension: () => ({ js: '.mjs' }),
    external: EXTERNAL,
  },
])
