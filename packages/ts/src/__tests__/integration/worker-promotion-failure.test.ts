import { describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import type { NarsilEventMap } from '../../types/events'
import type { CustomTokenizer, IndexConfig } from '../../types/schema'

const schema = { title: 'string' as const }

const everyCharacter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text].map((token, position) => ({ token, position }))
  },
}

async function promotionFailure(indexConfig: IndexConfig): Promise<NarsilEventMap['workerPromoteFailure'][]> {
  const narsil = await createNarsil({ workers: { enabled: true, promotionThreshold: 1 } })
  await narsil.createIndex('prose', indexConfig)

  const failures: NarsilEventMap['workerPromoteFailure'][] = []
  const seen = new Promise<void>(resolve => {
    narsil.on('workerPromoteFailure', payload => {
      failures.push(payload)
      resolve()
    })
  })

  await narsil.insert('prose', { title: 'the rise of the machine' })
  await narsil.insert('prose', { title: 'the fall of the machine' })
  await seen

  await narsil.shutdown()
  return failures
}

describe('an index that cannot reach a worker says so instead of promoting quietly', () => {
  it('reports the tokenizer instance that no worker thread can receive', async () => {
    const failures = await promotionFailure({ schema, tokenizer: everyCharacter })

    expect(failures).toHaveLength(1)
    expect(failures[0].error.message).toMatch(/tokenizer instance/)
    expect(failures[0].retryable).toBe(false)
  })

  it('reports the stop word function that no worker thread can receive', async () => {
    const failures = await promotionFailure({
      schema,
      stopWords: defaults => new Set([...defaults, 'machine']),
    })

    expect(failures).toHaveLength(1)
    expect(failures[0].error.message).toMatch(/stop word function/)
  })

  it('reports a language no worker registers without a bootstrap module', async () => {
    const { registerLanguage } = await import('../../languages/registry')
    const { french } = await import('../../languages/french')
    registerLanguage(french)

    const failures = await promotionFailure({ schema, language: 'french' })

    expect(failures).toHaveLength(1)
    expect(failures[0].error.message).toMatch(/bootstrapModule/)
  })

  it('keeps answering queries from the local index after promotion fails', async () => {
    const narsil = await createNarsil({ workers: { enabled: true, promotionThreshold: 1 } })
    await narsil.createIndex('prose', { schema, tokenizer: everyCharacter })

    const failures: NarsilEventMap['workerPromoteFailure'][] = []
    const seen = new Promise<void>(resolve => {
      narsil.on('workerPromoteFailure', payload => {
        failures.push(payload)
        resolve()
      })
    })

    await narsil.insert('prose', { title: 'machine' })
    await narsil.insert('prose', { title: 'machine' })
    await seen

    for (let i = 0; i < 5; i++) {
      await narsil.insert('prose', { title: 'machine' })
    }

    const result = await narsil.query('prose', { term: 'm' })
    expect(result.hits.length).toBeGreaterThan(0)
    expect(failures).toHaveLength(1)

    await narsil.shutdown()
  })
})
