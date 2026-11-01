import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'

const CHILD_SCRIPT = fileURLToPath(new URL('./child-memory-refusal-dist.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))
const HEAP_MEGABYTES = 128

interface ChildOutcome {
  code: string | null
  documents: number
  probeHitsMatch: boolean
  writeMatches: boolean
}

function runChild(): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [`--max-old-space-size=${HEAP_MEGABYTES}`, CHILD_SCRIPT, String(HEAP_MEGABYTES)],
      { timeout: 120_000 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`the child failed: ${error.message}\n${stderr}`))
          return
        }
        resolve(JSON.parse(stdout) as ChildOutcome)
      },
    )
  })
}

describe('an analysis change on a process without the memory for a second copy of the terms', () => {
  it.skipIf(!BUILT)(
    'refuses with its own code, keeps the old answers, and keeps accepting writes',
    async () => {
      const outcome = await runChild()
      expect(outcome.documents).toBeGreaterThan(0)
      expect(outcome).toMatchObject({
        code: ErrorCodes.ANALYSIS_REBUILD_MEMORY_EXCEEDED,
        probeHitsMatch: true,
        writeMatches: true,
      })
    },
    150_000,
  )
})
