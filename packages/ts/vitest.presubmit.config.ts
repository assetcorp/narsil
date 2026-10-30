import { readFileSync } from 'node:fs'
import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config'

const testLists = JSON.parse(readFileSync(new URL('./postsubmit-test-files.json', import.meta.url), 'utf8')) as {
  suitesWithTheirOwnTarget: string[]
  postsubmit: string[]
}

function excludePattern(path: string): string {
  return `src/__tests__/${path.endsWith('/') ? `${path}**` : path}`
}

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      exclude: [
        ...configDefaults.exclude,
        ...testLists.suitesWithTheirOwnTarget.map(excludePattern),
        ...testLists.postsubmit.map(excludePattern),
      ],
    },
  }),
)
