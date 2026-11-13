import { readFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { createNarsil } from '../../../../dist/index.mjs'
import { kibibyteField, processStatus } from '../../runtime/process-memory-oracle.mjs'

const MAPPED_INDEX = 'passages'
const WRITTEN_INDEX = 'ledger'
const BUILD_BATCH_DOCUMENTS = 500
const GRAPH_THRESHOLD = 64
const LOAD_POLL_MS = 50
const LOAD_WAIT_MS = 60_000
const MEASUREMENT_AGE_MS = 50
const ANONYMOUS_GROWTH_MARGINS = 3
const WRITES_BESIDE_MAPPED_VECTORS = 10

const [phase, directory, documentsText, dimensionText, marginText] = process.argv.slice(2)
const documents = Number(documentsText)
const dimension = Number(dimensionText)
const marginBytes = Number(marginText)
const durableConfig = { durability: { directory }, workers: { enabled: false } }

function containerLimitBytes() {
  const membership = readFileSync('/proc/self/cgroup', 'latin1')
  const path = /^0::(.*)$/m.exec(membership)?.[1]
  if (path === undefined) return null
  try {
    const text = readFileSync(`/sys/fs/cgroup${path}/memory.max`, 'latin1').trim()
    return /^\d+$/.test(text) ? Number(text) : null
  } catch {
    return null
  }
}

function processLimitBytes(unbackedBytes) {
  const meminfo = readFileSync('/proc/meminfo', 'latin1')
  const hostBytes = kibibyteField(meminfo, 'MemTotal')
  const container = containerLimitBytes()
  if (container !== null && container < hostBytes) return container
  return Math.min(hostBytes, unbackedBytes + kibibyteField(meminfo, 'MemAvailable'))
}

function vectorOf(serial) {
  let state = (serial * 0x9e3779b1) >>> 0
  const vector = new Array(dimension)
  for (let at = 0; at < dimension; at++) {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    vector[at] = ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296 - 0.5
  }
  return vector
}

function describe(error) {
  return { code: error?.code ?? null, reason: error?.details?.reason ?? null, message: String(error?.message) }
}

async function build() {
  const engine = await createNarsil(durableConfig)
  await engine.createIndex(MAPPED_INDEX, {
    schema: { serial: 'number', embedding: `vector[${dimension}]` },
    vectorPromotion: {
      threshold: GRAPH_THRESHOLD,
      storage: 'disk',
      filterThreshold: 1,
      hnswConfig: { m: 4, efConstruction: 8 },
    },
  })
  for (let first = 0; first < documents; first += BUILD_BATCH_DOCUMENTS) {
    const batch = []
    for (let serial = first; serial < Math.min(documents, first + BUILD_BATCH_DOCUMENTS); serial++) {
      batch.push({ id: `passage-${serial}`, serial, embedding: vectorOf(serial) })
    }
    const inserted = await engine.insertBatch(MAPPED_INDEX, batch)
    if (inserted.failed.length > 0) throw new Error(`The build refused ${JSON.stringify(inserted.failed[0])}`)
  }
  await engine.checkpoint(MAPPED_INDEX)
  await engine.shutdown()
}

async function waitForVectorFiles(engine) {
  const deadline = Date.now() + LOAD_WAIT_MS
  do {
    if (Date.now() > deadline) throw new Error('The vector field never finished loading from its files')
    await engine.query(MAPPED_INDEX, { vector: { field: 'embedding', value: vectorOf(0) }, limit: 1 })
    await sleep(LOAD_POLL_MS)
  } while (engine.vectorMaintenanceStatus(MAPPED_INDEX).some(field => field.loadingFromFiles))
}

async function faultEveryMappedPage(engine) {
  const found = await engine.query(MAPPED_INDEX, {
    vector: { field: 'embedding', value: vectorOf(documents - 1) },
    filters: { fields: { serial: { gte: 1 } } },
    limit: 1,
  })
  return found.hits[0]?.id ?? null
}

async function writeOne(engine, serial) {
  try {
    await engine.insert(WRITTEN_INDEX, { id: `entry-${serial}`, body: `ledger entry ${serial}` })
    return { accepted: true }
  } catch (error) {
    return { accepted: false, ...describe(error) }
  }
}

async function writeAgainstMappedVectors() {
  const mapped = await createNarsil(durableConfig)
  await waitForVectorFiles(mapped)
  const nearest = await faultEveryMappedPage(mapped)
  const before = processStatus()
  const limitBytes = processLimitBytes(before.unbackedBytes)
  const blockWritesAbove = (before.unbackedBytes + marginBytes) / limitBytes
  const written = await createNarsil({
    workers: { enabled: false },
    memory: { blockWritesAbove, resumeWritesBelow: blockWritesAbove / 2 },
  })
  await written.createIndex(WRITTEN_INDEX, { schema: { body: 'string' } })
  const besideMappedVectors = []
  for (let serial = 1; serial <= WRITES_BESIDE_MAPPED_VECTORS; serial++) {
    await faultEveryMappedPage(mapped)
    await sleep(MEASUREMENT_AGE_MS)
    besideMappedVectors.push(await writeOne(written, serial))
  }
  const during = processStatus()
  const grown = Buffer.alloc(ANONYMOUS_GROWTH_MARGINS * marginBytes, 1)
  await sleep(MEASUREMENT_AGE_MS)
  const afterAnonymousGrowth = await writeOne(written, WRITES_BESIDE_MAPPED_VECTORS + 1)
  const after = processStatus()
  process.stdout.write(
    `RESULT ${JSON.stringify({
      nearest,
      fileBytes: before.fileBytes,
      unbackedBytesBefore: before.unbackedBytes,
      unbackedBytesDuring: during.unbackedBytes,
      unbackedBytesAfter: after.unbackedBytes,
      grownBytes: grown.length,
      limitBytes,
      blockWritesAbove,
      besideMappedVectors,
      afterAnonymousGrowth,
    })}\n`,
  )
  await written.shutdown()
  await mapped.shutdown()
}

if (phase === 'build') await build()
else await writeAgainstMappedVectors()
