import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', reranker: 'src/reranker.ts' },
  format: ['esm'],
  dts: true,
  splitting: false,
  clean: true,
  treeshake: true,
  outExtension: () => ({ js: '.mjs' }),
  external: ['@huggingface/transformers'],
})
