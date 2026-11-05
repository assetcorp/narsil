const { createNarsil } = await import('../../../../dist/index.mjs')

const ONE_HOUR_MS = 3_600_000
const [directory] = process.argv.slice(2)
const engine = await createNarsil({
  workers: { enabled: false },
  durability: { directory, mode: 'async', flushIntervalMs: ONE_HOUR_MS, checkpointIntervalMs: ONE_HOUR_MS },
})
await engine.insert('docs', { title: 'written after the checkpoint' }, 'late')
await engine.remove('docs', 'removed')
process.stdout.write('READY\n')
setInterval(() => undefined, ONE_HOUR_MS)
