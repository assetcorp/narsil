import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPatternSearch } from '../../../core/pattern-index/registry'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import { patternSearch } from '../../../pattern'
import type { PatternSearch } from '../../../types/pattern'
import type { SchemaDefinition } from '../../../types/schema'

vi.mock('#platform/pattern-search', () => ({ platformPatternSearch: () => null }))

const engines: Narsil[] = []

async function engine(): Promise<Narsil> {
  const narsil = await createNarsil({ workers: { enabled: false } })
  engines.push(narsil)
  return narsil
}

afterEach(async () => {
  for (const narsil of engines.splice(0)) await narsil.shutdown()
})

describe('a bundle that holds no pattern search code', () => {
  it('raises an error that states the import for a schema with a pattern field', async () => {
    const narsil = await engine()
    const schemas: SchemaDefinition[] = [{ code: 'verbatim' }, { title: 'string:pattern' }]
    for (const schema of schemas) {
      const failure = narsil.createIndex('records', { schema })
      await expect(failure).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
      await expect(failure).rejects.toThrow(/import \{ patternSearch \} from '@delali\/narsil\/pattern'/)
    }
  })

  it('creates an index without a pattern field as before', async () => {
    const narsil = await engine()
    await narsil.createIndex('prose', { schema: { title: 'string:sortable' } })
    await narsil.insert('prose', { title: 'plain words' })
    expect((await narsil.query('prose', { term: 'plain' })).hits).toHaveLength(1)
  })

  it('refuses an object that is not the pattern search code', () => {
    expect(() => registerPatternSearch({ name: 'pattern' } as PatternSearch)).toThrow(
      expect.objectContaining({ code: ErrorCodes.CONFIG_INVALID }),
    )
  })

  it('searches pattern fields once the app registers the pattern search code', async () => {
    registerPatternSearch(patternSearch)
    const narsil = await engine()
    await narsil.createIndex('records', { schema: { code: 'verbatim' } })
    await narsil.insertBatch('records', [
      { id: 'a', code: 'INV-2024-001' },
      { id: 'b', code: 'REF-77' },
    ])
    const listed = await narsil.listDocuments('records', {
      filters: { fields: { code: { contains: 'inv', caseFold: true } } },
    })
    expect(listed.documents.map(document => document.id)).toEqual(['a'])
  })
})
