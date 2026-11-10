import { spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { registerTokenizer } from '../../../analysis/registry'
import { createNarsil } from '../../../narsil'

const checkpointCases = [
  { beforeSwap: false, afterReplay: false, metadataFailure: false, bothLayouts: false },
  { beforeSwap: true, afterReplay: false, metadataFailure: false, bothLayouts: false },
  { beforeSwap: false, afterReplay: true, metadataFailure: false, bothLayouts: false },
  { beforeSwap: true, afterReplay: true, metadataFailure: false, bothLayouts: false },
  { beforeSwap: true, afterReplay: true, metadataFailure: true, bothLayouts: true },
  { beforeSwap: true, afterReplay: false, metadataFailure: false, bothLayouts: true },
].map(entry => ({ ...entry, boundary: '', noManifest: false }))
const boundaryCases = [
  { boundary: 'before-transition', noManifest: false },
  { boundary: 'after-transition', noManifest: false },
  { boundary: 'manifest', noManifest: false },
  { boundary: 'after-transition', noManifest: true },
].map(entry => ({ ...entry, beforeSwap: true, afterReplay: true, metadataFailure: false, bothLayouts: true }))

it.each([
  ...checkpointCases,
  ...boundaryCases,
])('recovers a queued update after a crash, beforeSwap=$beforeSwap afterReplay=$afterReplay metadataFailure=$metadataFailure bothLayouts=$bothLayouts boundary=$boundary noManifest=$noManifest', async ({
  beforeSwap,
  afterReplay,
  metadataFailure,
  bothLayouts,
  boundary,
  noManifest,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-rebalance-checkpoint-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./rebalance-writer.mjs', import.meta.url))], {
    env: {
      ...process.env,
      NARSIL_WAL_DIR: directory,
      NARSIL_WRITE_BEFORE_SWAP: beforeSwap ? '1' : '0',
      NARSIL_CRASH_AFTER_REPLAY: afterReplay ? '1' : '0',
      NARSIL_METADATA_FAILURE: metadataFailure ? '1' : '0',
      NARSIL_WRITE_BOTH_LAYOUTS: bothLayouts ? '1' : '0',
      NARSIL_LAYOUT_BOUNDARY: boundary,
      NARSIL_NO_MANIFEST: noManifest ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    signal: AbortSignal.timeout(10_000),
  })
  const exited = new Promise<void>(resolve => child.once('close', () => resolve()))
  let output = ''
  let errors = ''
  child.stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('ACKED')) resolve()
      })
      child.once('exit', () => reject(new Error(errors || 'Writer exited before acknowledging the update')))
    })
    child.kill('SIGKILL')
    await exited
    registerTokenizer('rebalance-checkpoint', { tokenize: text => [{ token: text, position: 0 }] })
    const recovered = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    const docId = beforeSwap ? 'b' : 'reading'
    const partitionCount = !afterReplay || boundary === 'before-transition' ? 2 : 1
    try {
      const document = await recovered.get('readings', docId)
      const title = boundary === 'after-transition' ? 'meadow' : bothLayouts ? 'lake' : 'forest'
      expect(document?.title).toBe(title)
      expect(document?.embedding).toEqual(
        new Float32Array(boundary === 'after-transition' ? [0, -1] : bothLayouts ? [-1, 0] : [0, 1]),
      )
      expect((await recovered.query('readings', { term: title })).hits.map(hit => hit.id)).toEqual([docId])
      expect((await recovered.query('readings', { term: 'river' })).count).toBe(0)
      expect(recovered.getPartitionStats('readings')).toHaveLength(partitionCount)
      await expect(access(join(directory, 'readings/layout-transition'))).rejects.toMatchObject({ code: 'ENOENT' })
      await recovered.update('readings', docId, { title: 'mountain', embedding: [1, 1] })
    } finally {
      await recovered.shutdown()
    }
    const reopened = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    try {
      expect(reopened.getPartitionStats('readings')).toHaveLength(partitionCount)
      expect(await reopened.get('readings', docId)).toEqual({ title: 'mountain', embedding: new Float32Array([1, 1]) })
      const ranked = await reopened.query('readings', { vector: { field: 'embedding', value: [1, 0] } })
      expect(ranked.hits.map(hit => hit.id)).toEqual([docId])
      expect(ranked.hits[0].score).toBeCloseTo(1 / Math.sqrt(2), 6)
    } finally {
      await reopened.shutdown()
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await rm(directory, { recursive: true, force: true })
  }
})
