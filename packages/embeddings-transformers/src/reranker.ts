import { DEFAULT_DTYPE, DEFAULT_RERANK_ACTIVATION, DEFAULT_RERANK_BATCH_SIZE, DEFAULT_RERANK_MODEL } from './constants'

/**
 * Settings for {@link createTransformersReranker}.
 *
 * @public
 */
export interface TransformersRerankerConfig {
  /**
   * The cross-encoder that scores each query and document pair, given as a
   * Hugging Face model ID or a local path. It defaults to
   * `Xenova/ms-marco-MiniLM-L-6-v2`. The model must give one relevance logit
   * for each pair, as MS MARCO and BGE rerankers do.
   */
  model?: string
  /** The weight precision that the model loads, such as `fp32`, `fp16`, or `q8`. It defaults to `fp32`. */
  dtype?: string
  /** The runtime that scores the pairs. Transformers.js picks one for the platform when you leave it out. */
  device?: 'wasm' | 'webgpu' | 'cpu'
  /**
   * How the adapter turns each logit into a score. `sigmoid` gives a score
   * from 0 to 1, and `none` returns the logit itself. It defaults to
   * `sigmoid`. Both keep the same order.
   */
  activation?: 'sigmoid' | 'none'
  /** The adapter scores this many pairs in one model call. It defaults to 32. */
  batchSize?: number
  /** The longest pair, in tokens, that the model reads, beyond which the tokenizer cuts the document. It defaults to the model's own limit. */
  maxLength?: number
  /** Receives the download and load progress of the model files. */
  progress?: (data: unknown) => void
  /** Extra options passed to the model loader of Transformers.js. */
  modelOptions?: Record<string, unknown>
}

/**
 * A rerank adapter that scores documents with a cross-encoder in Transformers.js.
 *
 * Register it with `registerRerankAdapter` on a Narsil engine, or pass it in
 * the `rerankAdapters` setting, and name it in a query's `rerank.adapter`.
 *
 * @public
 */
export interface TransformersReranker {
  /**
   * Scores each document against the query, in the order of `documents`, with a higher score for a more relevant
   * document.
   *
   * @param query - The text that each document is compared with.
   * @param documents - The documents to score.
   * @param signal - Stops the scoring between batches once the engine cancels the call.
   * @returns One score for each document.
   */
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]>
  /** Releases the model and the tokenizer. Calling it twice does no harm. */
  shutdown(): Promise<void>
}

interface LogitsTensor {
  dims: number[]
  data: ArrayLike<number>
}

type Tokenizer = (text: string[], options: Record<string, unknown>) => Record<string, unknown>
type Classifier = ((inputs: Record<string, unknown>) => Promise<{ logits: LogitsTensor }>) & {
  dispose?(): Promise<void>
}

interface LoadedModel {
  tokenizer: Tokenizer
  classifier: Classifier
}

function requireWholeNumber(value: number | undefined, field: string): void {
  if (value === undefined) return
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`createTransformersReranker needs ${field} to be a whole number of at least 1`)
  }
}

function scoresOf(logits: LogitsTensor, count: number, activation: 'sigmoid' | 'none'): number[] {
  const [rows, columns] = logits.dims
  if (logits.dims.length !== 2 || rows !== count || columns !== 1) {
    throw new Error(
      `The rerank model returned logits of shape [${logits.dims.join(', ')}] for ${count} pairs, but it needs to give one logit for each pair`,
    )
  }
  const scores = new Array<number>(count)
  for (let i = 0; i < count; i++) {
    const logit = Number(logits.data[i])
    scores[i] = activation === 'sigmoid' ? 1 / (1 + Math.exp(-logit)) : logit
  }
  return scores
}

/**
 * Builds a rerank adapter that scores each query and document pair with a
 * cross-encoder, which reads the two texts together and so ranks them more
 * closely than a comparison of two embeddings does.
 *
 * The adapter loads the model on its first call, and it shares that load
 * between calls that arrive together. It scores the documents in batches and
 * checks the cancel signal between them.
 *
 * @param config - The model and how the adapter runs it.
 * @returns The rerank adapter.
 * @throws An `Error` where `batchSize` or `maxLength` is not a whole number of at least 1.
 *
 * @public
 */
export function createTransformersReranker(config: TransformersRerankerConfig = {}): TransformersReranker {
  requireWholeNumber(config.batchSize, 'batchSize')
  requireWholeNumber(config.maxLength, 'maxLength')
  const model = config.model ?? DEFAULT_RERANK_MODEL
  const activation = config.activation ?? DEFAULT_RERANK_ACTIVATION
  const batchSize = config.batchSize ?? DEFAULT_RERANK_BATCH_SIZE

  let loading: Promise<LoadedModel> | null = null
  let loaded: LoadedModel | null = null

  async function load(): Promise<LoadedModel> {
    if (loaded !== null) return loaded
    if (loading !== null) return loading
    loading = (async () => {
      const transformers = await import('@huggingface/transformers')
      const progress = config.progress === undefined ? {} : { progress_callback: config.progress }
      const tokenizer = await transformers.AutoTokenizer.from_pretrained(model, progress)
      const modelOptions: Record<string, unknown> = {
        dtype: config.dtype ?? DEFAULT_DTYPE,
        ...(config.device === undefined ? {} : { device: config.device }),
        ...progress,
        ...config.modelOptions,
      }
      const classifier = await transformers.AutoModelForSequenceClassification.from_pretrained(model, modelOptions)
      loaded = {
        tokenizer: tokenizer as unknown as Tokenizer,
        classifier: classifier as unknown as Classifier,
      }
      return loaded
    })()
    try {
      return await loading
    } catch (err) {
      loading = null
      throw err
    }
  }

  return {
    async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
      if (documents.length === 0) return []
      signal?.throwIfAborted()
      const { tokenizer, classifier } = await load()
      const scores: number[] = []
      for (let start = 0; start < documents.length; start += batchSize) {
        signal?.throwIfAborted()
        const batch = documents.slice(start, start + batchSize)
        const inputs = tokenizer(new Array<string>(batch.length).fill(query), {
          text_pair: batch,
          padding: true,
          truncation: true,
          ...(config.maxLength === undefined ? {} : { max_length: config.maxLength }),
        })
        const { logits } = await classifier(inputs)
        scores.push(...scoresOf(logits, batch.length, activation))
      }
      return scores
    },

    async shutdown(): Promise<void> {
      const pending = loading
      loading = null
      loaded = null
      if (pending === null) return
      let model: LoadedModel
      try {
        model = await pending
      } catch {
        return
      }
      if (loaded === model) loaded = null
      try {
        await model.classifier.dispose?.()
      } catch {}
    },
  }
}
