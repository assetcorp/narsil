import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransformersReranker } from '../reranker'

interface TokenizerCall {
  text: string[]
  options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length?: number }
}

const tokenizerCalls: TokenizerCall[] = []
const dispose = vi.fn(async () => undefined)
let logitOf = (_query: string, document: string): number => document.length
let shapeOverride: number[] | null = null

const tokenizer = (text: string[], options: TokenizerCall['options']) => {
  tokenizerCalls.push({ text, options })
  return { pairs: text.map((query, i) => [query, options.text_pair[i]]) }
}

const classifier = Object.assign(
  async (inputs: { pairs: string[][] }) => ({
    logits: {
      dims: shapeOverride ?? [inputs.pairs.length, 1],
      data: Float32Array.from(inputs.pairs.map(([query, document]) => logitOf(query, document))),
    },
  }),
  { dispose },
)

const loadTokenizer = vi.fn(async () => tokenizer)
const loadClassifier = vi.fn(async () => classifier)

vi.mock('@huggingface/transformers', () => ({
  AutoTokenizer: { from_pretrained: (...args: unknown[]) => loadTokenizer(...(args as [])) },
  AutoModelForSequenceClassification: { from_pretrained: (...args: unknown[]) => loadClassifier(...(args as [])) },
}))

describe('createTransformersReranker', () => {
  beforeEach(() => {
    tokenizerCalls.length = 0
    shapeOverride = null
    logitOf = (_query, document) => document.length
    vi.clearAllMocks()
  })

  it('pairs the query with each document and returns one sigmoid score per document, in order, across batches', async () => {
    const reranker = createTransformersReranker({ batchSize: 2, maxLength: 128 })
    const documents = ['a', 'abcd', 'ab', 'abc', 'abcde']

    const scores = await reranker.rerank('letters', documents)

    expect(scores).toEqual(documents.map(document => 1 / (1 + Math.exp(-document.length))))
    expect(tokenizerCalls.map(call => call.options.text_pair)).toEqual([['a', 'abcd'], ['ab', 'abc'], ['abcde']])
    expect(tokenizerCalls.every(call => call.text.every(text => text === 'letters'))).toBe(true)
    expect(tokenizerCalls[0].options).toMatchObject({ padding: true, truncation: true, max_length: 128 })
    expect(loadClassifier).toHaveBeenCalledWith(
      'Xenova/ms-marco-MiniLM-L-6-v2',
      expect.objectContaining({ dtype: 'fp32' }),
    )
  })

  it('returns the raw logits where the activation is none', async () => {
    logitOf = (_query, document) => -document.length
    const reranker = createTransformersReranker({ activation: 'none' })
    expect(await reranker.rerank('q', ['ab', 'abc'])).toEqual([-2, -3])
  })

  it('loads the model once for calls that arrive together, and never for an empty list', async () => {
    const reranker = createTransformersReranker()
    expect(await reranker.rerank('q', [])).toEqual([])
    expect(loadClassifier).not.toHaveBeenCalled()
    await Promise.all([reranker.rerank('q', ['a']), reranker.rerank('q', ['b'])])
    expect(loadClassifier).toHaveBeenCalledTimes(1)
    expect(loadTokenizer).toHaveBeenCalledTimes(1)
  })

  it('stops between batches once the signal aborts', async () => {
    const controller = new AbortController()
    logitOf = () => {
      controller.abort()
      return 1
    }
    const reranker = createTransformersReranker({ batchSize: 1 })
    await expect(reranker.rerank('q', ['a', 'b', 'c'], controller.signal)).rejects.toThrow()
    expect(tokenizerCalls).toHaveLength(1)
  })

  it('refuses a model that gives more than one logit for each pair', async () => {
    shapeOverride = [2, 2]
    const reranker = createTransformersReranker()
    await expect(reranker.rerank('q', ['a', 'b'])).rejects.toThrow('one logit for each pair')
  })

  it.each([{ batchSize: 0 }, { batchSize: 1.5 }, { maxLength: -1 }])('refuses the settings %j', settings => {
    expect(() => createTransformersReranker(settings)).toThrow('whole number')
  })

  it('releases the model on shutdown and loads it again on the next call', async () => {
    const reranker = createTransformersReranker()
    await reranker.rerank('q', ['a'])
    await reranker.shutdown()
    await reranker.shutdown()
    expect(dispose).toHaveBeenCalledTimes(1)
    await reranker.rerank('q', ['a'])
    expect(loadClassifier).toHaveBeenCalledTimes(2)
  })
})
