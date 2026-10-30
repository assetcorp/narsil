import { createNarsil } from '../../../../dist/index.mjs'

const directory = process.env.NARSIL_WAL_DIR
const narsil = await createNarsil({ durability: { directory, tier: 'wal', mode: 'sync' }, workers: { enabled: false } })
await narsil.createIndex('movies', { schema: { title: 'string' }, language: 'english' })

let position = 0
while (position < 100_000) {
  try {
    await narsil.insert('movies', { title: `Film ${position} ${'long title '.repeat(40)}` }, `m${position}`)
    process.stdout.write(`ACKED m${position}\n`)
    position += 1
  } catch (error) {
    process.stdout.write(`REFUSED ${error?.code ?? 'no code'}\n`)
    break
  }
}

try {
  await narsil.insert('movies', { title: 'After the refusal' }, 'after')
  process.stdout.write('ACKED after\n')
} catch (error) {
  process.stdout.write(`REFUSED ${error?.code ?? 'no code'}\n`)
}
process.exit(0)
