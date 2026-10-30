const { createNarsil } = await import('../../../../dist/index.mjs')
const { createServer } = await import('../../../../dist/server.mjs')

const stopping = process.env.NARSIL_STOPPING ?? 'exit'
const dimension = 16
const count = 1_500
let seed = 7
const uniform = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 4294967296 - 0.5
}

const engine = await createNarsil()
await engine.createIndex('docs', {
  schema: { title: 'string', embedding: `vector[${dimension}]` },
  vectorPromotion: { threshold: 500 },
})
await engine.insertBatch(
  'docs',
  Array.from({ length: count }, (_, at) => ({
    id: `d${at}`,
    title: `lantern ${at}`,
    embedding: Array.from({ length: dimension }, uniform),
  })),
)
await engine.optimizeVectors('docs', 'embedding')
for (;;) {
  const [field] = engine.vectorMaintenanceStatus('docs')
  if (field !== undefined && field.graphCount === 1 && !field.building && field.bufferSize === 0) break
  await new Promise(resolve => setTimeout(resolve, 20))
}

const server = createServer(engine, { host: '127.0.0.1', port: 0 })
await server.listen()
if (stopping === 'exit') process.on('SIGTERM', () => process.exit(0))
if (stopping === 'shutdown') process.on('SIGTERM', () => void server.shutdown())
process.stdout.write(`READY ${server.listeningPort} ${server.requestThreadCount}\n`)
