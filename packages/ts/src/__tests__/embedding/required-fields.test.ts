import { describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil } from '../../narsil'
import { createMockAdapter, vectorSchema } from './fixtures'

describe('Required fields validation', () => {
  it('rejects an update that lacks a required field before it asks the adapter for an embedding', async () => {
    const adapter = createMockAdapter()
    const narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('articles', {
      schema: vectorSchema,
      required: ['title'],
      embedding: { adapter, fields: { embedding: 'body' } },
    })
    await narsil.insert('articles', { title: 'Harbour tides', body: 'The tide turns twice a day' }, 'a1')
    const callsAfterInsert = adapter.calls.length

    await expect(narsil.update('articles', 'a1', { body: 'A body with no title' })).rejects.toMatchObject({
      code: ErrorCodes.DOC_MISSING_REQUIRED_FIELD,
    })
    expect(adapter.calls.length).toBe(callsAfterInsert)
    await narsil.shutdown()
  })
})
