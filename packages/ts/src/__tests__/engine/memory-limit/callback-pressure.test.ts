import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resultLineOf, runNodeChild } from './node-child'

const CALLBACK_PROCESS = fileURLToPath(new URL('./callback-process.mjs', import.meta.url))
const BATCH_DOCUMENTS = 2500
const CHUNK_DOCUMENTS = 1000
const BALLAST_BYTES = 192 * 1024 * 1024
const batchIds = Array.from({ length: BATCH_DOCUMENTS }, (_, at) => `batch-${at}`)

function runCallbackProcess(operation: string, storage: string) {
  return runNodeChild(['--max-old-space-size=65536', '--max-semi-space-size=1', CALLBACK_PROCESS, operation, storage])
}

it
  .skipIf(process.platform !== 'linux')
  .each(
    ['insert', 'update', 'insertBatch', 'updateBatch'].flatMap(operation =>
      ['memory', 'durable'].map(storage => ({ operation, storage })),
    ),
  )(
  'refuses $operation in $storage when its plugin re-enters the engine and fills process memory',
  async ({ operation, storage }) => {
    const { exitCode, output } = await runCallbackProcess(operation, storage)
    expect(exitCode, output).toBe(0)
    const result = JSON.parse(resultLineOf(output) ?? 'null')
    expect(result, output).toMatchObject({
      nestedCode: 'MEMORY_WRITE_BLOCKED',
      refusedCode: 'MEMORY_WRITE_BLOCKED',
      hits: ['nested', 'original'],
      recoveredHits: ['nested', 'original'],
      original: { body: 'original note' },
      held: BALLAST_BYTES,
    })
  },
  30_000,
)

it.skipIf(process.platform !== 'linux').each(
  [
    { operation: 'insertBatchChunks', unwritten: 'absent' },
    { operation: 'updateBatchChunks', unwritten: 'original note' },
  ].flatMap(batch => ['memory', 'durable'].map(storage => ({ ...batch, storage }))),
)(
  'refuses every later document of $operation in $storage without preparing it once memory fills after the first chunk',
  async ({ operation, storage, unwritten }) => {
    const { exitCode, output } = await runCallbackProcess(operation, storage)
    expect(exitCode, output).toBe(0)
    const result = JSON.parse(resultLineOf(output) ?? 'null')
    const kept = { 'outer note': CHUNK_DOCUMENTS, [unwritten]: BATCH_DOCUMENTS - CHUNK_DOCUMENTS }
    expect(result, output).toEqual({
      succeeded: batchIds.slice(0, CHUNK_DOCUMENTS),
      failedIds: batchIds.slice(CHUNK_DOCUMENTS),
      failedCodes: ['MEMORY_WRITE_BLOCKED'],
      preparedBatchDocuments: 2 * CHUNK_DOCUMENTS,
      stored: kept,
      recovered: kept,
      held: BALLAST_BYTES,
    })
  },
  60_000,
)
