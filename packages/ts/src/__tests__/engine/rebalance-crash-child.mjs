import { createRequire, syncBuiltinESMExports } from 'node:module'
import { basename, dirname } from 'node:path'

const require = createRequire(import.meta.url)
const fsPromises = require('node:fs/promises')
const directory = process.env.NARSIL_DIR ?? ''
const killAt = process.env.NARSIL_KILL_AT ?? ''
const firstCount = Number(process.env.NARSIL_FIRST_COUNT ?? '8')
const targetCount = Number(process.env.NARSIL_TARGET_COUNT ?? '3')
const documents = Number(process.env.NARSIL_DOCUMENTS ?? '10000')
const writers = Number(process.env.NARSIL_WRITERS ?? '1')
const INDEX = 'items'
const MAX_PARTITIONS = 8
const HOUR_MS = 3_600_000

let rebalancing = false

function killNow() {
  process.kill(process.pid, 'SIGKILL')
  return new Promise(() => undefined)
}

function writesIndexFile(to, name) {
  return basename(to) === name && basename(dirname(to)) === INDEX
}

const rename = fsPromises.rename
fsPromises.rename = async (from, to) => {
  const target = String(to)
  const renamed = await rename(from, to)
  if (rebalancing && killAt === 'after-metadata' && writesIndexFile(target, 'meta')) return killNow()
  if (rebalancing && killAt === 'after-manifest' && writesIndexFile(target, 'manifest')) return killNow()
  return renamed
}
syncBuiltinESMExports()

const BACKPRESSURE_RETRY_MS = 5

async function underBackpressure(write) {
  for (;;) {
    try {
      return await write()
    } catch (error) {
      if (error?.code !== 'PARTITION_REBALANCING_BACKPRESSURE') throw error
      await new Promise(resolve => setTimeout(resolve, BACKPRESSURE_RETRY_MS))
    }
  }
}

async function replaceDocuments(engine, writer) {
  for (let at = writer; at < documents; at += writers) {
    await underBackpressure(() => engine.remove(INDEX, `d${at}`))
    process.stdout.write(`ACK remove d${at}\n`)
    await underBackpressure(() => engine.insert(INDEX, { title: `beta n${at}` }, `n${at}`))
    process.stdout.write(`ACK insert n${at}\n`)
  }
}

async function main() {
  const { createNarsil } = await import('../../../dist/index.mjs')
  const engine = await createNarsil({
    workers: { enabled: false },
    durability: { directory, checkpointIntervalMs: HOUR_MS, checkpointMutationThreshold: documents * 4 },
  })
  await engine.createIndex(INDEX, { schema: { title: 'string' }, partitions: { maxPartitions: MAX_PARTITIONS } })
  const batch = await engine.insertBatch(
    INDEX,
    Array.from({ length: documents }, (_, at) => ({ id: `d${at}`, title: `alpha d${at}` })),
  )
  if (batch.failed.length > 0) throw new Error(`${batch.failed.length} documents failed to insert`)
  if (firstCount !== MAX_PARTITIONS) await engine.rebalance(INDEX, firstCount)
  await engine.checkpoint(INDEX)
  process.stdout.write('READY\n')
  rebalancing = true
  const writes = Array.from({ length: writers }, (_, writer) => replaceDocuments(engine, writer))
  await engine.rebalance(INDEX, targetCount)
  await Promise.all(writes)
  process.stdout.write('DONE without reaching the kill point\n')
}

main().catch(error => {
  process.stderr.write(`child error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
