import { beforeAll, expect } from 'vitest'

const LAZY_CODE_LOAD_TIMEOUT_MS = 60_000
const FIRST_USE_TESTS = ['/integration/vector-code-on-first-use.test.ts', '/runtime/simd-support.test.ts']

const testPath = expect.getState().testPath ?? ''
if (!FIRST_USE_TESTS.some(suffix => testPath.endsWith(suffix))) {
  beforeAll(async () => {
    const { loadVectorCode } = await import('../../workers/vector-code')
    await Promise.all([import('../../engine/durability-wiring'), loadVectorCode()])
  }, LAZY_CODE_LOAD_TIMEOUT_MS)
}
