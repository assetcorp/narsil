import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resultLineOf, runNodeChild } from './node-child'

const CALLBACK_PROCESS = fileURLToPath(new URL('./callback-process.mjs', import.meta.url))

it
  .skipIf(process.platform !== 'linux')
  .each(
    ['insert', 'update', 'insertBatch', 'updateBatch'].flatMap(operation =>
      ['memory', 'durable'].map(storage => ({ operation, storage })),
    ),
  )(
  'refuses $operation in $storage when its plugin re-enters the engine and fills process memory',
  async ({ operation, storage }) => {
    const { exitCode, output } = await runNodeChild([
      '--max-old-space-size=65536',
      '--max-semi-space-size=1',
      CALLBACK_PROCESS,
      operation,
      storage,
    ])
    expect(exitCode, output).toBe(0)
    const result = JSON.parse(resultLineOf(output) ?? 'null')
    expect(result, output).toMatchObject({
      nestedCode: 'MEMORY_WRITE_BLOCKED',
      refusedCode: 'MEMORY_WRITE_BLOCKED',
      hits: ['nested', 'original'],
      recoveredHits: ['nested', 'original'],
      original: { body: 'original note' },
      held: 192 * 1024 * 1024,
    })
  },
  30_000,
)
