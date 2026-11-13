import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import type { IndexConfig } from '../../../types/schema'
import { DIM, normalizedVector } from './fixtures'

describe('a vector field kept on disk', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-disk-vectors-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('recovers a field due for a graph with its vectors read by position from the vector file', async () => {
    const config: IndexConfig = {
      schema: { title: 'string', embedding: `vector[${DIM}]` },
      language: 'english',
      vectorPromotion: { threshold: 8, quantization: 'none' },
    }
    const writer = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await writer.createIndex('papers', config)
    for (let i = 0; i < 40; i++) {
      await writer.insert(
        'papers',
        { title: `Paper ${i}`, embedding: Array.from(normalizedVector(DIM, i + 1)) },
        `p${i}`,
      )
    }
    await writer.checkpoint('papers')
    const query = Array.from(normalizedVector(DIM, 21))
    const expected = (
      await writer.query('papers', { vector: { field: 'embedding', value: query }, limit: 5 })
    ).hits.map(hit => hit.id)
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    const recovered = await reader.query('papers', { vector: { field: 'embedding', value: query }, limit: 5 })
    expect(recovered.hits.map(hit => hit.id)).toEqual(expected)

    const durable = createDurableDirectory(directory)
    const [key] = (await durable.list('papers/segments/')).filter(name => /\/vec-embedding-[a-z0-9]+-f\d+$/.test(name))
    const bytes = await durable.read(key)
    if (bytes === null) throw new Error('vector file missing')
    const original = normalizedVector(DIM, 10)
    const offset = Buffer.from(bytes).indexOf(Buffer.from(original.buffer, original.byteOffset, original.byteLength))
    expect(offset).toBeGreaterThan(0)
    const loadDeadline = Date.now() + 30_000
    while (reader.vectorMaintenanceStatus('papers').some(status => status.loadingFromFiles)) {
      if (Date.now() > loadDeadline) throw new Error('The vector field never finished its background load')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const replaced = new Float32Array([0.5, 0.25, 0.125, 0.0625])
    const handle = await open(await durable.pathOf(key), 'r+')
    await handle.write(new Uint8Array(replaced.buffer), 0, replaced.byteLength, offset)
    await handle.close()

    const document = await reader.get('papers', 'p9')
    expect(Array.from(document?.embedding as Float32Array)).toEqual(Array.from(replaced))
    await reader.shutdown()
  })

  it('refuses a field kept on disk on an engine without filesystem durability', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    await expect(
      engine.createIndex('papers', {
        schema: { embedding: `vector[${DIM}]` },
        vectorPromotion: { storage: 'disk' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })

    const durable = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await durable.createIndex('papers', {
      schema: { embedding: `vector[${DIM}]` },
      vectorPromotion: { storage: 'disk' },
    })
    const snapshot = new Uint8Array(await new Response(await durable.snapshot('papers')).arrayBuffer())
    await durable.shutdown()
    await expect(engine.restore('papers', snapshot)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await engine.shutdown()
  })
})
