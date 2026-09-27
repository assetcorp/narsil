import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransformersEmbedding } from '../index'

const DIMENSIONS = 64

const mockPipeline = vi.fn()

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => mockPipeline),
}))

function singleTensor() {
  const data = new Float32Array(DIMENSIONS).fill(0.5)
  return { data, dims: [1, DIMENSIONS], tolist: () => [Array.from(data)] }
}

function batchTensor(rows: number) {
  const data = new Float32Array(rows * DIMENSIONS).fill(0.5)
  return {
    data,
    dims: [rows, DIMENSIONS],
    tolist: () =>
      Array.from({ length: rows }, (_, row) => Array.from(data.slice(row * DIMENSIONS, (row + 1) * DIMENSIONS))),
  }
}

function pipelineInputs(): unknown[] {
  return mockPipeline.mock.calls.map(call => call[0])
}

describe('batching under each dtype', () => {
  beforeEach(() => {
    mockPipeline.mockReset()
  })

  it('embeds each text on its own under a quantised dtype, so a batch gives the vectors that single calls give', async () => {
    mockPipeline.mockResolvedValue(singleTensor())
    const result = createTransformersEmbedding({ dimensions: DIMENSIONS, dtype: 'q8', documentPrefix: 'passage: ' })

    const vectors = await result.embedBatch(['alpha', 'beta', 'gamma'], 'document')

    expect(vectors).toHaveLength(3)
    expect(pipelineInputs()).toEqual(['passage: alpha', 'passage: beta', 'passage: gamma'])
  })

  it('embeds each text on its own when the pipeline options pick a quantised dtype', async () => {
    mockPipeline.mockResolvedValue(singleTensor())
    const result = createTransformersEmbedding({ dimensions: DIMENSIONS, pipelineOptions: { dtype: 'q8' } })

    await result.embedBatch(['alpha', 'beta'], 'document')

    expect(pipelineInputs()).toEqual(['alpha', 'beta'])
  })

  it('embeds each text on its own when any model part loads quantised', async () => {
    mockPipeline.mockResolvedValue(singleTensor())
    const result = createTransformersEmbedding({
      dimensions: DIMENSIONS,
      pipelineOptions: { dtype: { encoder_model: 'fp32', embed_tokens: 'q4' } },
    })

    await result.embedBatch(['alpha', 'beta'], 'document')

    expect(pipelineInputs()).toEqual(['alpha', 'beta'])
  })

  it('embeds a whole batch in one call under full precision', async () => {
    mockPipeline.mockResolvedValue(batchTensor(2))
    const result = createTransformersEmbedding({ dimensions: DIMENSIONS, pipelineOptions: { dtype: 'fp32' } })

    await result.embedBatch(['alpha', 'beta'], 'document')

    expect(pipelineInputs()).toEqual([['alpha', 'beta']])
  })
})
