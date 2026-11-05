const { createNarsil } = await import('../../../../dist/index.mjs')

const [directory, indexName] = process.argv.slice(2)
const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
const stream = await engine.exportDocuments(indexName)
const text = await new Response(stream).text()
await engine.shutdown()
process.stdout.write(`EXPORTED ${text.split('\n').filter(line => line !== '').length}\n`)
