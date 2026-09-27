import { describe, expect, it } from 'vitest'
import { resolveVectorText } from '../../engine/resolve-vector-text'
import { ErrorCodes, NarsilError } from '../../errors'
import type { EmbeddingAdapter } from '../../types/adapters'
import { createFailingAdapter } from '../embedding/fixtures'

describe('resolveVectorText', () => {
  const params = { vector: { field: 'embedding', text: 'wireless headphones' } }

  it('wraps an adapter failure as EMBEDDING_FAILED, as an insert does', async () => {
    const failure = resolveVectorText(params, createFailingAdapter(8), new AbortController().signal)

    await expect(failure).rejects.toBeInstanceOf(NarsilError)
    await expect(failure).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_FAILED,
      details: { cause: 'Adapter crashed' },
    })
  })

  it('passes a NarsilError from the adapter through with its own code', async () => {
    const adapter: EmbeddingAdapter = {
      dimensions: 8,
      async embed() {
        throw new NarsilError(ErrorCodes.EMBEDDING_CONFIG_INVALID, 'The adapter has no API key')
      },
    }

    await expect(resolveVectorText(params, adapter, new AbortController().signal)).rejects.toMatchObject({
      code: ErrorCodes.EMBEDDING_CONFIG_INVALID,
    })
  })
})
