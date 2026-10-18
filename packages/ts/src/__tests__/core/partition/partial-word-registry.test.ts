import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPartialWordSearch } from '../../../core/partition/partial-words/registry'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { partialWordSearch } from '../../../partial-words'
import type { PartialWordSearch } from '../../../types/partial-words'
import type { SchemaDefinition } from '../../../types/schema'

vi.mock('#platform/partial-word-search', () => ({ platformPartialWordSearch: () => null }))

const engines: Narsil[] = []

async function engine(): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  engines.push(narsil)
  return narsil
}

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

describe('a bundle that holds no partial-word search code', () => {
  it('raises an error that states the import for a schema with a partial field', async () => {
    const narsil = await engine()
    const schemas: SchemaDefinition[] = [{ title: 'string:partial' }, { title: 'string[]:partial' }]
    for (const schema of schemas) {
      const failure = narsil.createIndex('jackets', { schema })
      await expect(failure).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
      await expect(failure).rejects.toThrow(/import \{ partialWordSearch \} from '@delali\/narsil\/partial-words'/)
    }
  })

  it('creates and searches an index without a partial field as before', async () => {
    const narsil = await engine()
    await narsil.createIndex('jackets', { schema: { title: 'string' } })
    await narsil.insertBatch('jackets', [
      { id: 'waterproof', title: 'waterproof jacket' },
      { id: 'proof', title: 'proof copy' },
    ])
    const hits = (await narsil.query('jackets', { term: 'proof', partialWords: true })).hits
    expect(hits.map(hit => hit.id)).toEqual(['proof'])
  })

  it('refuses an object that is not the partial-word search code', () => {
    for (const impostor of [{ name: 'partialWords' }, { name: 'pattern' }, null]) {
      expect(() => registerPartialWordSearch(impostor as PartialWordSearch)).toThrow(
        expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
      )
    }
  })

  it('matches inside words once the app registers the partial-word search code', async () => {
    registerPartialWordSearch(partialWordSearch)
    const narsil = await engine()
    await narsil.createIndex('jackets', { schema: { title: 'string:partial' } })
    await narsil.insertBatch('jackets', [
      { id: 'waterproof', title: 'waterproof jacket' },
      { id: 'fleece', title: 'fleece jacket' },
    ])
    const hits = (await narsil.query('jackets', { term: 'proof', partialWords: true })).hits
    expect(hits.map(hit => hit.id)).toEqual(['waterproof'])
  })
})
