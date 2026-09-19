import { createNarsil } from '../../../../dist/index.mjs'

const SCHEMA = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

async function main() {
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
  if (process.env.NARSIL_WRITE === 'batch') {
    const documents = []
    for (let i = startIndex; i < startIndex + docCount; i += 1) {
      documents.push({ id: `m${i}`, title: `Movie ${i}`, year: 2000 + i })
    }
    const result = await narsil.insertBatch('movies', documents)
    if (result.failed.length > 0) {
      process.stderr.write(`batch failed for ${result.failed.length} documents\n`)
      process.exit(3)
      return
    }
  } else {
    for (let i = startIndex; i < startIndex + docCount; i += 1) {
      await narsil.insert('movies', { title: `Movie ${i}`, year: 2000 + i }, `m${i}`)
    }
  }

  process.stdout.write('ACKED\n')

  if (exitMode === 'clean-exit') {
    process.exit(0)
    return
  }

  if (exitMode === 'normal-return') {
    return
  }

  await new Promise(() => undefined)
}

main().catch(err => {
  process.stderr.write(`child error: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
