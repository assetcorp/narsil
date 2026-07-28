import { describe, expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../../analysis/registry'
import type { FanOutResult } from '../../../partitioning/fan-out'
import type { CustomTokenizer, IndexConfig } from '../../../types/schema'
import { createDirectExecutor } from '../../../workers/direct-executor'
import { reqId, schema } from './fixtures'

const SENTENCE = 'the rise of the machine'

async function seed(config: IndexConfig) {
  const executor = createDirectExecutor()
  await executor.execute({ type: 'createIndex', indexName: 'prose', config, requestId: reqId() })
  await executor.execute({
    type: 'insert',
    indexName: 'prose',
    docId: 'doc-1',
    document: { title: SENTENCE, score: 1 },
    requestId: reqId(),
  })
  return executor
}

describe('the executor a worker runs searches under the analysis its index config asks for', () => {
  it('keeps a term the index config declines to treat as a stop word', async () => {
    const executor = await seed({ schema, language: 'english', stopWords: new Set<string>() })

    const result = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'prose',
      params: { term: 'the' },
      requestId: reqId(),
    })

    expect(result.scored.map(hit => hit.docId)).toEqual(['doc-1'])
    await executor.shutdown()
  })

  it('drops a term the index config declares a stop word', async () => {
    const executor = await seed({ schema, language: 'english', stopWords: new Set(['machine']) })

    const result = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'prose',
      params: { term: 'machine' },
      requestId: reqId(),
    })

    expect(result.scored).toEqual([])
    await executor.shutdown()
  })

  it('counts the same documents in preflight as in query', async () => {
    const executor = await seed({ schema, language: 'english', stopWords: new Set<string>() })

    const result = await executor.execute<{ count: number }>({
      type: 'preflight',
      indexName: 'prose',
      params: { term: 'the' },
      requestId: reqId(),
    })

    expect(result.count).toBe(1)
    await executor.shutdown()
  })

  it('splits query text with the tokenizer the config names', async () => {
    const singleLetters: CustomTokenizer = {
      tokenize(text: string) {
        return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
      },
    }
    registerTokenizer('single-letters', singleLetters)
    const executor = await seed({ schema, language: 'english', tokenizer: 'single-letters' })

    const result = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'prose',
      params: { term: 'z' },
      requestId: reqId(),
    })

    expect(result.scored).toEqual([])

    const found = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'prose',
      params: { term: 'm' },
      requestId: reqId(),
    })

    expect(found.scored.map(hit => hit.docId)).toEqual(['doc-1'])
    await executor.shutdown()
  })

  it('applies a stop word set the config names', async () => {
    registerStopWords('keeps-everything', new Set<string>())
    const executor = await seed({ schema, language: 'english', stopWords: 'keeps-everything' })

    const result = await executor.execute<FanOutResult>({
      type: 'query',
      indexName: 'prose',
      params: { term: 'the' },
      requestId: reqId(),
    })

    expect(result.scored.map(hit => hit.docId)).toEqual(['doc-1'])
    await executor.shutdown()
  })
})

describe('a worker registers the caller analysis from a bootstrap module', () => {
  it('imports the module the bootstrap action names', async () => {
    const executor = createDirectExecutor()
    const marker = 'narsilBootstrapProof'

    await executor.execute({
      type: 'bootstrap',
      moduleUrl: `data:text/javascript,globalThis.${marker} = true`,
      requestId: reqId(),
    })

    expect((globalThis as Record<string, unknown>)[marker]).toBe(true)
    delete (globalThis as Record<string, unknown>)[marker]
    await executor.shutdown()
  })

  it('refuses an empty module URL', async () => {
    const executor = createDirectExecutor()

    await expect(executor.execute({ type: 'bootstrap', moduleUrl: '   ', requestId: reqId() })).rejects.toThrow(
      /non-empty module URL/,
    )

    await executor.shutdown()
  })
})
