import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resultLineOf, runNodeChild } from './node-child'

const ENGINE_PROCESS = fileURLToPath(new URL('./engine-process.mjs', import.meta.url))
const HEAP_MEGABYTES = 160
const BLOCK_WRITES_ABOVE = '0.5'
const RESUME_WRITES_BELOW = '0.4'
const TEST_TIMEOUT_MS = 120_000
const MEMORY_WRITE_BLOCKED = 'MEMORY_WRITE_BLOCKED'

interface Refusal {
  code: string | null
  reason: string | null
  message: string
}

interface EngineProcessResult {
  accepted: number
  refusal: Refusal | null
  refusedSingle: Refusal | null
  countWhileBlocked: number
  writeAfterDrop: { accepted: boolean } & Partial<Refusal>
  laterHits: string[]
}

describe('an engine that blocks writes at its memory limit', () => {
  it(
    'refuses writes with a typed error while full and accepts them again once the filled index is dropped',
    async () => {
      const { exitCode, output } = await runNodeChild([`--max-old-space-size=${HEAP_MEGABYTES}`, ENGINE_PROCESS], {
        ...process.env,
        BLOCK_ABOVE: BLOCK_WRITES_ABOVE,
        RESUME_BELOW: RESUME_WRITES_BELOW,
      })
      expect(exitCode, output).toBe(0)
      const line = resultLineOf(output)
      expect(line, output).toBeDefined()
      const result = JSON.parse(line ?? 'null') as EngineProcessResult

      expect(result.accepted).toBeGreaterThan(0)
      expect(result.refusal?.code).toBe(MEMORY_WRITE_BLOCKED)
      expect(result.refusedSingle?.code).toBe(MEMORY_WRITE_BLOCKED)
      expect(result.countWhileBlocked).toBe(result.accepted)
      expect(result.writeAfterDrop).toEqual({ accepted: true })
      expect(result.laterHits).toEqual(['ledger-1'])
    },
    TEST_TIMEOUT_MS,
  )
})
