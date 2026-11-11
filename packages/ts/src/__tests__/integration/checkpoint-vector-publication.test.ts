import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { createFilesystemPersistence } from '../../persistence/filesystem'

it('keeps checkpoint vectors paired with the documents captured before a concurrent update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-checkpoint-vector-'))
  const storage = createFilesystemPersistence({ directory })
  let release: () => void = () => undefined
  let entered: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  const writing = new Promise<void>(resolve => {
    entered = resolve
  })
  let armed = false
  const engine = await createNarsil({
    workers: { enabled: false },
    durability: { tier: 'snapshot', checkpointIntervalMs: 0 },
    persistence: {
      ...storage,
      async save(key, bytes) {
        if (armed && key.includes('/segments/0/')) {
          armed = false
          entered()
          await held
        }
        await storage.save(key, bytes)
      },
    },
  })
  let checkpoint: Promise<void> | undefined
  try {
    await engine.createIndex('readings', { schema: { title: 'string', embedding: 'vector[2]' } })
    await engine.insert('readings', { title: 'river', embedding: [1, 0] }, 'reading')
    armed = true
    checkpoint = engine.checkpoint('readings')
    await Promise.race([
      writing,
      checkpoint.then(() => {
        throw new Error('Checkpoint never wrote a segment')
      }),
    ])
    await engine.update('readings', 'reading', { title: 'forest', embedding: [0, 1] })
    release()
    await checkpoint
    const recovered = await createNarsil({
      workers: { enabled: false },
      persistence: storage,
      durability: { tier: 'snapshot', checkpointIntervalMs: 0 },
    })
    try {
      const document = await recovered.get('readings', 'reading')
      expect(document?.title).toBe('river')
      expect(document?.embedding).toEqual(new Float32Array([1, 0]))
    } finally {
      await recovered.shutdown()
    }
  } finally {
    release()
    await checkpoint?.catch(() => undefined)
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
