import { BATCH_SAFE_DTYPES, DEFAULT_DTYPE, DEFAULT_MODEL, DEFAULT_POOLING } from './constants'

export interface TransformersEmbeddingConfig {
  model?: string
  dimensions: number
  dtype?: string
  device?: 'wasm' | 'webgpu' | 'cpu'
  /**
   * How the adapter turns the vector of every token into one vector for the
   * passage. `mean` averages them, and it suits most sentence models. `cls`
   * keeps the first token, as BERT classifiers expect. `last_token` keeps the
   * last token, which is the only one that has seen the whole passage in a
   * model that reads left to right, such as Qwen3-Embedding. Use the mode that
   * the model card names, which `1_Pooling/config.json` records for a
   * Sentence Transformers model. With `last_token` and a tokenizer that pads on
   * the right, `embedBatch` embeds one text at a time, because Transformers.js
   * takes the last position of the batch, which holds padding for every text
   * shorter than the longest. `last_token` requires Transformers.js 3.6.0 or
   * later.
   */
  pooling?: 'mean' | 'cls' | 'last_token'
  normalize?: boolean
  documentPrefix?: string
  queryPrefix?: string
  progress?: (data: unknown) => void
  /**
   * The adapter keeps the model files that it downloads in this folder, and it
   * makes this folder the default cache of Transformers.js, because the
   * pipeline reads the list of model files from that default cache.
   */
  cacheDir?: string
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

function isBatchSafeDtype(dtype: unknown): boolean {
  if (typeof dtype === 'string') return BATCH_SAFE_DTYPES.includes(dtype)
  if (dtype === null || typeof dtype !== 'object') return false
  return Object.values(dtype).every(
    moduleDtype => typeof moduleDtype === 'string' && BATCH_SAFE_DTYPES.includes(moduleDtype),
  )
}

function paddingSideOf(pipe: unknown): unknown {
  if (pipe === null || typeof pipe !== 'object' || !('tokenizer' in pipe)) return undefined
  const tokenizer = pipe.tokenizer
  if (tokenizer === null || typeof tokenizer !== 'object' || !('padding_side' in tokenizer)) return undefined
  return tokenizer.padding_side
}

export function createTransformersEmbedding(config: TransformersEmbeddingConfig): EmbeddingResult {
  const model = config.model ?? DEFAULT_MODEL
  const dtype = config.dtype ?? DEFAULT_DTYPE
  const embedsBatchesWhole = isBatchSafeDtype(config.pipelineOptions?.dtype ?? dtype)
  const pooling = config.pooling ?? DEFAULT_POOLING
  const normalize = config.normalize ?? true
  const documentPrefix = config.documentPrefix ?? ''
  const queryPrefix = config.queryPrefix ?? ''

  type PipelineFn = (inputs: string | string[], options: Record<string, unknown>) => Promise<TransformersTensor>

  let pipelineInstance: PipelineFn | null = null
  let rawPipeline: { dispose(): Promise<void> } | null = null
  let pipelinePromise: Promise<PipelineFn> | null = null
  let poolsPaddingInBatches = false

  async function initPipeline(): Promise<PipelineFn> {
    if (pipelineInstance) return pipelineInstance

    if (pipelinePromise) return pipelinePromise

    pipelinePromise = (async () => {
      const transformers = await import('@huggingface/transformers')
      if (config.cacheDir !== undefined) transformers.env.cacheDir = config.cacheDir

      const pipelineOptions: Record<string, unknown> = {
        dtype,
        ...(config.cacheDir === undefined ? {} : { cache_dir: config.cacheDir }),
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
      poolsPaddingInBatches = pooling === 'last_token' && paddingSideOf(pipe) !== 'left'

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

      if (!embedsBatchesWhole || poolsPaddingInBatches) {
        const vectors: Float32Array[] = []
        for (const text of prefixed) {
          signal?.throwIfAborted()
          vectors.push(extractSingleVector(await pipe(text, { pooling, normalize }), config.dimensions))
        }
        return vectors
      }

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
        } catch {}
      }
    },
  }
}
