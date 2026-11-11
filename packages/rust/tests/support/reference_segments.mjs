import { cp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const NEVER_CHECKPOINT_ON_ITS_OWN_MS = 86_400_000
const NEVER_CHECKPOINT_ON_MUTATIONS = 1_000_000_000
const MILLISECONDS_PER_SECOND = 1_000
const NANOSECONDS_PER_MILLISECOND = 1_000_000

const [repositoryRoot, specPath, liveDirectory, copiedDirectory] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)

function revivedEntries(object) {
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, revived(entry)]))
}

function revived(value) {
  if (Array.isArray(value)) return value.map(revived)
  if (value === null || typeof value !== 'object') return value
  const keys = Object.keys(value)
  if (keys.length !== 1 || !keys[0].startsWith('$')) return revivedEntries(value)
  const [tag] = keys
  const held = value[tag]
  if (tag === '$date') {
    return new Date(held[0] * MILLISECONDS_PER_SECOND + held[1] / NANOSECONDS_PER_MILLISECOND)
  }
  if (tag === '$bytes') return new Uint8Array(Buffer.from(held, 'base64'))
  if (tag === '$number') return Number(held)
  if (tag === '$object') return revivedEntries(held)
  throw new Error(`the spec holds an unknown tag ${tag}`)
}

const spec = revived(JSON.parse(await readFile(specPath, 'utf8')))
const narsil = await createNarsil({
  workers: { enabled: false },
  durability: {
    directory: liveDirectory,
    mode: 'sync',
    checkpointIntervalMs: NEVER_CHECKPOINT_ON_ITS_OWN_MS,
    checkpointMutationThreshold: NEVER_CHECKPOINT_ON_MUTATIONS,
  },
})
try {
  await narsil.createIndex(spec.index, spec.config)
  for (const step of spec.steps) {
    if (step.insert !== undefined) {
      const result = await narsil.insertBatch(spec.index, step.insert)
      if (result.failed.length > 0) throw new Error(`the reference refused ${JSON.stringify(result.failed)}`)
    }
    for (const id of step.remove ?? []) await narsil.remove(spec.index, id)
    if (step.checkpoint === true) await narsil.checkpoint(spec.index)
  }
  await cp(join(liveDirectory, spec.index, 'segments'), copiedDirectory, { recursive: true })
} finally {
  await narsil.shutdown()
}
