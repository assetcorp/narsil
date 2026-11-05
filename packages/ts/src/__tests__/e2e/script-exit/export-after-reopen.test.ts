import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('./export-after-reopen.mjs', import.meta.url))
const BUILT = existsSync(new URL('../../../../dist/index.mjs', import.meta.url))
const INDEX = 'notes'
const DOCUMENTS = 40
const DIMENSION = 4
const SCRIPT_DEADLINE_MS = 60_000

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'narsil-export-after-reopen-'))
  const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
  await engine.createIndex(INDEX, {
    schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
    vectorPromotion: { threshold: 16, storage: 'disk' },
  })
  await engine.insertBatch(
    INDEX,
    Array.from({ length: DOCUMENTS }, (_, at) => ({
      id: `note-${at}`,
      title: `lantern ${at}`,
      embedding: [Math.sin(at), Math.cos(at), at / DOCUMENTS, 1],
    })),
  )
  await engine.optimizeVectors(INDEX, 'embedding')
  await engine.checkpoint(INDEX)
  await engine.shutdown()
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe.skipIf(!BUILT)('a script that reopens an index with its vectors on disk', () => {
  it('exports every document before the process ends', async () => {
    const { stdout } = await run(process.execPath, [SCRIPT, directory, INDEX], {
      env: { ...process.env, NODE_OPTIONS: '' },
      timeout: SCRIPT_DEADLINE_MS,
    })
    expect(stdout.trim()).toBe(`EXPORTED ${DOCUMENTS + 1}`)
  }, 120_000)
})
