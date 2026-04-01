export interface TransformersEmbeddingConfig {
  model?: string
  dimensions: number
  dtype?: string
  device?: 'wasm' | 'webgpu' | 'cpu'
  pooling?: 'mean' | 'cls'
  normalize?: boolean
  documentPrefix?: string
  queryPrefix?: string
  progress?: (data: unknown) => void
  pipelineOptions?: Record<string, unknown>
}

interface EmbeddingResult {
  embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array>
  embedBatch(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]>
  readonly dimensions: number
  shutdown(): Promise<void>
}

interface TransformersTensor {
  data: Float32Array
  dims: number[]
  tolist(): number[][]
}

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2'
const DEFAULT_DTYPE = 'q8'
const DEFAULT_POOLING = 'mean'

export function createTransformersEmbedding(config: TransformersEmbeddingConfig): EmbeddingResult {
  const model = config.model ?? DEFAULT_MODEL
  const dtype = config.dtype ?? DEFAULT_DTYPE
  const pooling = config.pooling ?? DEFAULT_POOLING
  const normalize = config.normalize ?? true
  const documentPrefix = config.documentPrefix ?? ''
  const queryPrefix = config.queryPrefix ?? ''

  type PipelineFn = (inputs: string | string[], options: Record<string, unknown>) => Promise<TransformersTensor>

  let pipelineInstance: PipelineFn | null = null
  let rawPipeline: { dispose(): Promise<void> } | null = null
  let pipelinePromise: Promise<PipelineFn> | null = null

  async function initPipeline(): Promise<PipelineFn> {
    if (pipelineInstance) return pipelineInstance

    if (pipelinePromise) return pipelinePromise

    pipelinePromise = (async () => {
      const transformers = await import('@huggingface/transformers')

      const pipelineOptions: Record<string, unknown> = {
        dtype,
        ...config.pipelineOptions,
      }

      if (config.device) {
        pipelineOptions.device = config.device
      }

      if (config.progress) {
        pipelineOptions.progress_callback = config.progress
      }

      const pipe = await transformers.pipeline('feature-extraction', model, pipelineOptions)

      rawPipeline = pipe as unknown as { dispose(): Promise<void> }
      pipelineInstance = pipe as unknown as PipelineFn

      return pipelineInstance
    })()

    try {
      return await pipelinePromise
    } catch (err) {
      pipelinePromise = null
      throw err
    }
  }

  function applyPrefix(input: string, purpose: 'document' | 'query'): string {
    const prefix = purpose === 'document' ? documentPrefix : queryPrefix
    if (prefix.length === 0) return input
    return prefix + input
  }

  function extractSingleVector(tensor: TransformersTensor, expectedDimensions: number): Float32Array {
    if (tensor.dims.length === 2 && tensor.dims[0] === 1) {
      const outputDim = tensor.dims[1]
      if (outputDim !== expectedDimensions) {
        throw new Error(
          `Model output dimensions (${outputDim}) do not match configured dimensions (${expectedDimensions})`,
        )
      }
      return new Float32Array(tensor.data.slice(0, outputDim))
    }

    if (tensor.dims.length === 1) {
      if (tensor.data.length !== expectedDimensions) {
        throw new Error(
          `Model output dimensions (${tensor.data.length}) do not match configured dimensions (${expectedDimensions})`,
        )
      }
      return new Float32Array(tensor.data)
    }

    throw new Error(
      `Unexpected tensor shape [${tensor.dims.join(', ')}] from model. ` +
        'Expected [1, dimensions] or [dimensions] when pooling is enabled.',
    )
  }

  function extractBatchVectors(
    tensor: TransformersTensor,
    batchSize: number,
    expectedDimensions: number,
  ): Float32Array[] {
    if (tensor.dims.length !== 2 || tensor.dims[0] !== batchSize) {
      throw new Error(
        `Unexpected tensor shape [${tensor.dims.join(', ')}] for batch of ${batchSize}. ` +
          `Expected [${batchSize}, ${expectedDimensions}].`,
      )
    }

    const vectorDim = tensor.dims[1]
    if (vectorDim !== expectedDimensions) {
      throw new Error(
        `Model output dimensions (${vectorDim}) do not match configured dimensions (${expectedDimensions})`,
      )
    }

    const results: Float32Array[] = []
    for (let i = 0; i < batchSize; i++) {
      const start = i * vectorDim
      results.push(tensor.data.slice(start, start + vectorDim))
    }
    return results
  }

  return {
    dimensions: config.dimensions,

    async embed(input: string, purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array> {
      signal?.throwIfAborted()

      const pipe = await initPipeline()
      const prefixed = applyPrefix(input, purpose)

      signal?.throwIfAborted()

      const output = await pipe(prefixed, { pooling, normalize })
      return extractSingleVector(output, config.dimensions)
    },

    async embedBatch(inputs: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<Float32Array[]> {
      if (inputs.length === 0) return []

      signal?.throwIfAborted()

      const pipe = await initPipeline()
      const prefixed = inputs.map(input => applyPrefix(input, purpose))

      signal?.throwIfAborted()

      const output = await pipe(prefixed, { pooling, normalize })
      return extractBatchVectors(output, inputs.length, config.dimensions)
    },

    async shutdown(): Promise<void> {
      const pending = pipelinePromise
      const pipeline = rawPipeline

      pipelineInstance = null
      rawPipeline = null
      pipelinePromise = null

      if (pending) {
        try {
          await pending
        } catch {
          return
        }
      }

      if (pipeline) {
        try {
          await pipeline.dispose()
        } catch {
          /* disposal failure during shutdown is tolerable */
        }
      }
    },
  }
}
