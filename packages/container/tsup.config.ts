import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { main: 'src/main.ts', 'worker-languages': 'src/languages/worker-bootstrap.ts' },
  format: ['esm'],
  dts: false,
  splitting: false,
  clean: true,
  treeshake: true,
  platform: 'node',
  target: 'node22',
  outExtension: () => ({ js: '.mjs' }),
  external: [/^@delali\//, '@huggingface/transformers', 'uWebSockets.js'],
})
