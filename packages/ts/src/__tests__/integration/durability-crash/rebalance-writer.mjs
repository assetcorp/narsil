import { mkdirSync, renameSync, watch } from 'node:fs'
import { access, mkdir, rename, rm } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { createNarsil, ErrorCodes, NarsilError, registerTokenizer } from '../../../../dist/index.mjs'

const directory = process.env.NARSIL_WAL_DIR
if (directory === undefined) throw new Error('Missing durability directory')
const beforeSwap = process.env.NARSIL_WRITE_BEFORE_SWAP === '1'
const afterReplay = process.env.NARSIL_CRASH_AFTER_REPLAY === '1'
const metadataFailure = process.env.NARSIL_METADATA_FAILURE === '1'
const boundary = process.env.NARSIL_LAYOUT_BOUNDARY ?? ''
const noManifest = process.env.NARSIL_NO_MANIFEST === '1'
const bothLayouts = process.env.NARSIL_WRITE_BOTH_LAYOUTS === '1' || metadataFailure
const docId = beforeSwap ? 'b' : 'reading'
let armed = false
let update
let watcher
let manifestBlocked = false
let boundaryHook = false

async function awaitCrash() {
  process.stdout.write('ACKED\n')
  await new Promise(() => setInterval(() => undefined, 60_000))
}
registerTokenizer('rebalance-checkpoint', {
  tokenize(text) {
    if (armed && text === 'river') {
      armed = false
      update = engine.update('readings', docId, { title: 'forest', embedding: [0, 1] })
    }
    return [{ token: text, position: 0 }]
  },
})
const engine = await createNarsil({
  durability: { directory, mode: 'sync', checkpointIntervalMs: metadataFailure || boundary || noManifest ? 0 : 10 },
  workers: { enabled: false },
  plugins: [
    {
      name: 'checkpoint-before-replay',
      async afterUpdate() {
        if (!boundary || boundaryHook) return
        boundaryHook = true
        await access(`${directory}/readings/layout-transition`)
        if (boundary === 'after-transition') {
          await engine.update('readings', docId, { title: 'meadow', embedding: [0, -1] })
          await awaitCrash()
        } else if (boundary === 'manifest') {
          watcher = watch(`${directory}/readings`, (_event, file) => {
            if (manifestBlocked || !file?.startsWith('manifest.tmp-')) return
            renameSync(`${directory}/readings/manifest`, `${directory}/readings/saved-manifest`)
            mkdirSync(`${directory}/readings/manifest`)
            manifestBlocked = true
          })
        }
      },
      async onPartitionSplit() {
        if (beforeSwap) {
          if (update === undefined) throw new Error('No write started before the swap')
          await update
        } else await engine.update('readings', docId, { title: 'forest', embedding: [0, 1] })
        if (bothLayouts) await engine.update('readings', docId, { title: 'lake', embedding: [-1, 0] })
        await setTimeout(50)
        try {
          await engine.checkpoint('readings')
          throw new Error('Checkpoint accepted writes before the durable routing boundary')
        } catch (error) {
          if (!(error instanceof NarsilError) || error.code !== ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
            throw error
        }
        if (metadataFailure) {
          await rename(`${directory}/readings/meta`, `${directory}/readings/saved-meta`)
          await mkdir(`${directory}/readings/meta`)
        }
        if (boundary === 'before-transition') await mkdir(`${directory}/readings/layout-transition`)
        if (afterReplay) return
        await awaitCrash()
      },
    },
  ],
})
await engine.createIndex('readings', {
  schema: { title: 'string', embedding: 'vector[2]' },
  tokenizer: 'rebalance-checkpoint',
  partitions: { maxPartitions: 2 },
})
await engine.insert('readings', { title: 'river', embedding: [1, 0] }, docId)
if (!noManifest) await engine.checkpoint('readings')
armed = beforeSwap
try {
  await engine.rebalance('readings', 1)
  if (metadataFailure || boundary) throw new Error('Rebalance completed past its failure boundary')
} catch (error) {
  if (
    (!metadataFailure && boundary !== 'before-transition' && boundary !== 'manifest') ||
    !(error instanceof NarsilError) ||
    error.code !== ErrorCodes.PERSISTENCE_SAVE_FAILED
  )
    throw error
  if (metadataFailure) {
    await rm(`${directory}/readings/meta`, { recursive: true })
    await rename(`${directory}/readings/saved-meta`, `${directory}/readings/meta`)
  }
  if (boundary === 'before-transition') await rm(`${directory}/readings/layout-transition`, { recursive: true })
  if (boundary === 'manifest') {
    watcher?.close()
    if (!manifestBlocked) throw new Error('Manifest failure did not occur')
    await rm(`${directory}/readings/manifest`, { recursive: true })
    await rename(`${directory}/readings/saved-manifest`, `${directory}/readings/manifest`)
  }
  let refused = false
  try {
    await engine.insert('readings', { title: 'rejected', embedding: [1, 1] }, 'rejected')
  } catch {
    refused = true
  }
  if (!refused) throw new Error('A write succeeded after the layout change failed')
}
await awaitCrash()
