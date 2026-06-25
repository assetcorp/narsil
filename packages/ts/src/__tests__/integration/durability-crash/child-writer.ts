import { createNarsil } from '../../../narsil'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

async function main(): Promise<void> {
  const directory = process.env.NARSIL_WAL_DIR
  if (directory === undefined) {
    process.stderr.write('missing NARSIL_WAL_DIR\n')
    process.exit(2)
    return
  }
  const mode = process.env.NARSIL_MODE === 'async' ? 'async' : 'sync'
  const docCount = Number.parseInt(process.env.NARSIL_DOC_COUNT ?? '5', 10)
  const exitMode = process.env.NARSIL_EXIT ?? 'wait-for-kill'

  const narsil = await createNarsil({ durability: { directory, mode } })
  const alreadyRecovered = narsil.listIndexes().some(info => info.name === 'movies')
  if (!alreadyRecovered) {
    await narsil.createIndex('movies', SCHEMA)
  }

  const startIndex = narsil.listIndexes().find(info => info.name === 'movies')?.documentCount ?? 0
  for (let i = startIndex; i < startIndex + docCount; i += 1) {
    await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
  }

  process.stdout.write('ACKED\n')

  if (exitMode === 'clean-exit') {
    process.exit(0)
    return
  }

  if (exitMode === 'normal-return') {
    return
  }

  await new Promise<void>(() => undefined)
}

main().catch(err => {
  process.stderr.write(`child error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
