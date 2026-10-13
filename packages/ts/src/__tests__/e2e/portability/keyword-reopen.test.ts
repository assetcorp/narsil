import { afterEach, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { createNarsil, type Narsil } from '../../../narsil'
import type { NarsilConfig } from '../../../types/config'
import { temporaryRoots } from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []
const LANGUAGE = 'counted-reopen'
let stemmed = 0

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function registerCountingLanguage(): void {
  registerLanguage({
    name: LANGUAGE,
    revision: '1',
    stemmer: (token: string) => {
      stemmed += 1
      return token.endsWith('ing') ? token.slice(0, -3) : token
    },
    stopWords: new Set<string>(),
  })
}

describe('reopening a checkpointed index', () => {
  it('loads its terms from the segments without analysing a single document again', async () => {
    registerCountingLanguage()
    const directory = await roots.make('narsil-keyword-reopen-')
    const config: NarsilConfig = { workers: { enabled: false }, durability: { directory } }
    const writer = await createNarsil(config)
    engines.push(writer)
    await writer.createIndex('prose', { schema: { title: 'string', tags: 'string[]' }, language: LANGUAGE })
    const documents = Array.from({ length: 500 }, (_, n) => ({
      id: `d${n}`,
      title: `jumping harbour lantern number${n}`,
      tags: ['sailing', `tag${n % 9}`],
    }))
    expect((await writer.insertBatch('prose', documents)).failed).toEqual([])
    await writer.checkpoint('prose')
    await writer.shutdown()

    stemmed = 0
    const reader = await createNarsil(config)
    engines.push(reader)

    expect(stemmed).toBe(0)
    expect(await reader.countDocuments('prose')).toBe(500)
    expect((await reader.query('prose', { term: 'jump', limit: 600 })).count).toBe(500)
    expect((await reader.query('prose', { term: 'sail', limit: 600 })).count).toBe(500)
    expect((await reader.query('prose', { term: 'number77' })).hits.map(hit => hit.id)).toEqual(['d77'])
    expect(stemmed).toBeLessThan(10)
  })

  it('returns a byte field that holds its own document alone, apart from the segment it was read from', async () => {
    const directory = await roots.make('narsil-keyword-bytes-')
    const config: NarsilConfig = { workers: { enabled: false }, durability: { directory } }
    const writer = await createNarsil(config)
    engines.push(writer)
    await writer.createIndex('files', { schema: { title: 'string' } })
    for (let n = 0; n < 25; n++) {
      await writer.insert('files', { title: `scan ${n}`, thumbnail: new Uint8Array(64).fill(n) }, `f${n}`)
    }
    await writer.checkpoint('files')
    await writer.shutdown()

    const reader = await createNarsil(config)
    engines.push(reader)
    const thumbnail = (await reader.get('files', 'f7'))?.thumbnail
    if (!(thumbnail instanceof Uint8Array)) throw new Error('the recovered document lost its thumbnail')

    expect(Array.from(thumbnail)).toEqual(new Array(64).fill(7))
    expect(thumbnail.buffer.byteLength).toBeLessThan(128)
  })
})
