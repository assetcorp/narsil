import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransformersEmbedding } from '../index'

function createMockTensor(dims: number[], data?: Float32Array) {
  const totalElements = dims.reduce((a, b) => a * b, 1)
  const tensorData = data ?? new Float32Array(totalElements).fill(0.5)
  return {
    data: tensorData,
    dims,
    tolist(): number[][] {
      const rows: number[][] = []
      const cols = dims.length === 2 ? dims[1] : dims[0]
      const rowCount = dims.length === 2 ? dims[0] : 1
      for (let r = 0; r < rowCount; r++) {
        rows.push(Array.from(tensorData.slice(r * cols, (r + 1) * cols)))
      }
      return rows
    },
  }
}

const mockPipeline = vi.fn()

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(async () => mockPipeline),
}))

describe('createTransformersEmbedding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
  })

  describe('dimensions', () => {
    it('reports dimensions matching the config', () => {
      const result = createTransformersEmbedding({ dimensions: 384 })
      expect(result.dimensions).toBe(384)
    })

    it('reports dimensions for non-standard values', () => {
      const result = createTransformersEmbedding({ dimensions: 1536 })
      expect(result.dimensions).toBe(1536)
    })
  })

  describe('embed', () => {
    it('returns a Float32Array with the correct number of dimensions', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 384]))
      const result = createTransformersEmbedding({ dimensions: 384 })

      const vector = await result.embed('hello world', 'document')

      expect(vector).toBeInstanceOf(Float32Array)
      expect(vector.length).toBe(384)
    })

    it('passes pooling and normalize options to the pipeline', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 128]))
      const result = createTransformersEmbedding({
        dimensions: 128,
        pooling: 'cls',
        normalize: false,
      })

      await result.embed('test', 'document')

      expect(mockPipeline).toHaveBeenCalledWith('test', {
        pooling: 'cls',
        normalize: false,
      })
    })

    it('prepends document prefix for document purpose', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        documentPrefix: 'passage: ',
      })

      await result.embed('some text', 'document')

      expect(mockPipeline).toHaveBeenCalledWith('passage: some text', expect.objectContaining({ pooling: 'mean' }))
    })

    it('prepends query prefix for query purpose', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        queryPrefix: 'query: ',
      })

      await result.embed('some text', 'query')

      expect(mockPipeline).toHaveBeenCalledWith('query: some text', expect.objectContaining({ pooling: 'mean' }))
    })

    it('does not prepend document prefix for query purpose', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        documentPrefix: 'passage: ',
        queryPrefix: 'query: ',
      })

      await result.embed('some text', 'query')

      expect(mockPipeline).toHaveBeenCalledWith('query: some text', expect.objectContaining({ pooling: 'mean' }))
    })

    it('does not prepend query prefix for document purpose', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        documentPrefix: 'passage: ',
        queryPrefix: 'query: ',
      })

      await result.embed('some text', 'document')

      expect(mockPipeline).toHaveBeenCalledWith('passage: some text', expect.objectContaining({ pooling: 'mean' }))
    })

    it('does not prepend any prefix when prefixes are empty', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      await result.embed('raw text', 'document')

      expect(mockPipeline).toHaveBeenCalledWith('raw text', expect.objectContaining({ pooling: 'mean' }))
    })

    it('throws when model output dimensions do not match configured dimensions', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 256]))
      const result = createTransformersEmbedding({ dimensions: 384 })

      await expect(result.embed('test', 'document')).rejects.toThrow(/dimensions.*256.*384/i)
    })

    it('handles 1D tensor output shape', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([128]))
      const result = createTransformersEmbedding({ dimensions: 128 })

      const vector = await result.embed('test', 'document')

      expect(vector.length).toBe(128)
    })

    it('throws on unexpected tensor shape', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([2, 3, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      await expect(result.embed('test', 'document')).rejects.toThrow(/unexpected tensor shape/i)
    })

    it('throws when AbortSignal is already aborted', async () => {
      const result = createTransformersEmbedding({ dimensions: 64 })
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))

      await expect(result.embed('test', 'document', controller.signal)).rejects.toThrow()
    })

    it('produces a valid vector for empty string input', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      const vector = await result.embed('', 'document')

      expect(vector).toBeInstanceOf(Float32Array)
      expect(vector.length).toBe(64)
    })
  })

  describe('embedBatch', () => {
    it('returns empty array for empty input', async () => {
      const result = createTransformersEmbedding({ dimensions: 64 })
      const vectors = await result.embedBatch([], 'document')
      expect(vectors).toEqual([])
      expect(mockPipeline).not.toHaveBeenCalled()
    })

    it('returns correct number of vectors for batch input', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([3, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      const vectors = await result.embedBatch(['a', 'b', 'c'], 'document')

      expect(vectors).toHaveLength(3)
      for (const vec of vectors) {
        expect(vec).toBeInstanceOf(Float32Array)
        expect(vec.length).toBe(64)
      }
    })

    it('applies document prefix to all batch inputs', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([2, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        documentPrefix: 'passage: ',
      })

      await result.embedBatch(['alpha', 'beta'], 'document')

      expect(mockPipeline).toHaveBeenCalledWith(
        ['passage: alpha', 'passage: beta'],
        expect.objectContaining({ pooling: 'mean' }),
      )
    })

    it('applies query prefix to all batch inputs', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([2, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        queryPrefix: 'search_query: ',
      })

      await result.embedBatch(['x', 'y'], 'query')

      expect(mockPipeline).toHaveBeenCalledWith(
        ['search_query: x', 'search_query: y'],
        expect.objectContaining({ pooling: 'mean' }),
      )
    })

    it('throws on dimension mismatch in batch output', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([2, 256]))
      const result = createTransformersEmbedding({ dimensions: 384 })

      await expect(result.embedBatch(['a', 'b'], 'document')).rejects.toThrow(/dimensions.*256.*384/i)
    })

    it('throws on batch size mismatch in tensor shape', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      await expect(result.embedBatch(['a', 'b', 'c'], 'document')).rejects.toThrow(/batch.*3/i)
    })

    it('throws when AbortSignal is already aborted', async () => {
      const result = createTransformersEmbedding({ dimensions: 64 })
      const controller = new AbortController()
      controller.abort(new Error('cancelled'))

      await expect(result.embedBatch(['test'], 'document', controller.signal)).rejects.toThrow()
    })
  })

  describe('pipeline initialization', () => {
    it('lazily initializes the pipeline on first embed call', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({ dimensions: 64 })
      expect(pipelineFn).not.toHaveBeenCalled()

      await result.embed('trigger init', 'document')
      expect(pipelineFn).toHaveBeenCalledTimes(1)
    })

    it('reuses the pipeline across multiple embed calls', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({ dimensions: 64 })
      await result.embed('first', 'document')
      await result.embed('second', 'query')

      expect(pipelineFn).toHaveBeenCalledTimes(1)
    })

    it('passes model name from config to pipeline factory', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({
        dimensions: 64,
        model: 'custom/model-v2',
      })
      await result.embed('test', 'document')

      expect(pipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        'custom/model-v2',
        expect.objectContaining({ dtype: 'q8' }),
      )
    })

    it('uses default model when none specified', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({ dimensions: 64 })
      await result.embed('test', 'document')

      expect(pipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2',
        expect.objectContaining({ dtype: 'q8' }),
      )
    })

    it('passes dtype from config', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({
        dimensions: 64,
        dtype: 'fp32',
      })
      await result.embed('test', 'document')

      expect(pipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        expect.any(String),
        expect.objectContaining({ dtype: 'fp32' }),
      )
    })

    it('passes device from config', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({
        dimensions: 64,
        device: 'cpu',
      })
      await result.embed('test', 'document')

      expect(pipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        expect.any(String),
        expect.objectContaining({ device: 'cpu' }),
      )
    })

    it('passes progress callback from config', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const onProgress = vi.fn()

      const result = createTransformersEmbedding({
        dimensions: 64,
        progress: onProgress,
      })
      await result.embed('test', 'document')

      expect(pipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        expect.any(String),
        expect.objectContaining({ progress_callback: onProgress }),
      )
    })

    it('merges pipelineOptions with defaults', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({
        dimensions: 64,
        pipelineOptions: { customFlag: true },
      })
      await result.embed('test', 'document')

      expect(pipelineFn).toHaveBeenCalledWith(
        'feature-extraction',
        expect.any(String),
        expect.objectContaining({ dtype: 'q8', customFlag: true }),
      )
    })

    it('resets pipeline promise on initialization failure and retries', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      const pipelineMock = pipelineFn as ReturnType<typeof vi.fn>
      pipelineMock.mockRejectedValueOnce(new Error('model not found'))
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({ dimensions: 64 })

      await expect(result.embed('first', 'document')).rejects.toThrow('model not found')

      pipelineMock.mockResolvedValueOnce(mockPipeline)
      const vector = await result.embed('retry', 'document')
      expect(vector).toBeInstanceOf(Float32Array)
    })

    it('initializes the pipeline only once when embed is called concurrently', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({ dimensions: 64 })

      const [vec1, vec2] = await Promise.all([result.embed('first', 'document'), result.embed('second', 'query')])

      expect(pipelineFn).toHaveBeenCalledTimes(1)
      expect(vec1).toBeInstanceOf(Float32Array)
      expect(vec2).toBeInstanceOf(Float32Array)
    })
  })

  describe('shutdown', () => {
    it('clears the pipeline references', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))

      const result = createTransformersEmbedding({ dimensions: 64 })
      await result.embed('init pipeline', 'document')

      expect(pipelineFn).toHaveBeenCalledTimes(1)

      await result.shutdown()

      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      await result.embed('after shutdown', 'document')

      expect(pipelineFn).toHaveBeenCalledTimes(2)
    })

    it('handles shutdown when pipeline was never initialized', async () => {
      const result = createTransformersEmbedding({ dimensions: 64 })
      await expect(result.shutdown()).resolves.toBeUndefined()
    })

    it('handles shutdown when pipeline initialization failed', async () => {
      const { pipeline: pipelineFn } = await import('@huggingface/transformers')
      const pipelineMock = pipelineFn as ReturnType<typeof vi.fn>
      pipelineMock.mockRejectedValueOnce(new Error('init failed'))

      const result = createTransformersEmbedding({ dimensions: 64 })

      await expect(result.embed('test', 'document')).rejects.toThrow()
      await expect(result.shutdown()).resolves.toBeUndefined()
    })
  })

  describe('default values', () => {
    it('uses mean pooling by default', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      await result.embed('test', 'document')

      expect(mockPipeline).toHaveBeenCalledWith('test', expect.objectContaining({ pooling: 'mean', normalize: true }))
    })

    it('uses normalize true by default', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({ dimensions: 64 })

      await result.embed('test', 'document')

      expect(mockPipeline).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ normalize: true }))
    })

    it('respects normalize: false override', async () => {
      mockPipeline.mockResolvedValueOnce(createMockTensor([1, 64]))
      const result = createTransformersEmbedding({
        dimensions: 64,
        normalize: false,
      })

      await result.embed('test', 'document')

      expect(mockPipeline).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ normalize: false }))
    })
  })
})
