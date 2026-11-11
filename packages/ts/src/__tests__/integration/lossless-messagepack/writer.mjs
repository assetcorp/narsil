import { createNarsil } from '../../../../dist/index.mjs'

const directory = process.argv[2]
if (directory === undefined) throw new Error('A durability directory is required')
const engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
await engine.createIndex('records', { schema: { title: 'string', vector: 'vector[2]' } })
for (const length of [0, 1, 197, 198, 65_536]) {
  const value = `\ufeff${'x'.repeat(length)}`
  const key = `\ufeff${'k'.repeat(length)}`
  await engine.insert('records', {
    id: `record-${length}`,
    title: 'catalogue',
    value,
    [key]: value,
    nested: [{ [key]: [value, '', null, false, 0] }],
    bytes: new Uint8Array([0xef, 0xbb, 0xbf, 0, 255]),
    date: new Date('2020-02-03T04:05:06.789Z'),
    vector: [1, 0],
  })
}
process.stdout.write('ACKED\n', () => process.exit(0))
