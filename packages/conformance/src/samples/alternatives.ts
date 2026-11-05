import { FormError } from '../forms/decoded'
import { isJsonObject, type Json, type JsonObject } from '../forms/json'
import { copyOf } from './derive'

const SAMPLE_INDEX_UUID = '0b7d2c9e-41f6-4a3b-8e5d-7c2f1a9b6e04'
const SAMPLE_ANALYSIS_GENERATION = 2
const SAMPLE_PENDING_GENERATION = 3
const SAMPLE_PATTERN_VALUE_LIMIT = 256
const SAMPLE_MAX_DOCS_PER_PARTITION = 100_000
const SAMPLE_MAX_PARTITIONS = 8
const SAMPLE_PARTITION_WATERMARK = 0.9
const SAMPLE_FILTER_THRESHOLD = 0.25
const SAMPLE_TITLE_K1 = 1.1
const SAMPLE_TITLE_B = 0.6
const SAMPLE_TOKENIZER = 'conformance-tokenizer'
const SAMPLE_STOP_WORDS = 'conformance-stop-words'
const SAMPLE_STOP_WORD_LIST = ['a', 'the']
const SAMPLE_EMBEDDING_ADAPTER = 'conformance-embedder'
const SAMPLE_SYNONYMS: Json[] = [{ words: ['kettle', 'teapot'] }, { word: 'hammer', synonyms: ['mallet'] }]

export type StopWordForm = 'named' | 'literal'

function payloadOf(json: JsonObject, what: string): JsonObject {
  if (!isJsonObject(json.payload)) throw new FormError(`${what} has no payload object`)
  return json.payload
}

function stopWordsOf(form: StopWordForm, nameKey: string, listKey: string): JsonObject {
  return form === 'named' ? { [nameKey]: SAMPLE_STOP_WORDS } : { [listKey]: [...SAMPLE_STOP_WORD_LIST] }
}

function embeddingOf(form: StopWordForm): JsonObject {
  const source: Json = form === 'named' ? 'title' : ['title', 'description']
  return form === 'named'
    ? { adapter: SAMPLE_EMBEDDING_ADAPTER, fields: { embedding: source } }
    : { fields: { embedding: source } }
}

export function metadataWithEveryKey(metadata: JsonObject, form: StopWordForm): JsonObject {
  const copy = copyOf(metadata)
  const payload = payloadOf(copy, 'index metadata')
  const bm25 = isJsonObject(payload.bm25_params) ? payload.bm25_params : {}
  const promotion = isJsonObject(payload.vector_promotion) ? payload.vector_promotion : {}
  Object.assign(payload, {
    bm25_params: { ...bm25, fields: { title: { k1: SAMPLE_TITLE_K1, b: SAMPLE_TITLE_B } } },
    embedding: embeddingOf(form),
    tokenizer: SAMPLE_TOKENIZER,
    ...stopWordsOf(form, 'stop_words', 'stop_word_list'),
    analysis_generation: SAMPLE_ANALYSIS_GENERATION,
    pending_analysis: {
      generation: SAMPLE_PENDING_GENERATION,
      language: 'english',
      tokenizer: SAMPLE_TOKENIZER,
      ...stopWordsOf(form === 'named' ? 'literal' : 'named', 'stop_words', 'stop_word_list'),
    },
    partition_limits: {
      max_docs_per_partition: SAMPLE_MAX_DOCS_PER_PARTITION,
      max_partitions: SAMPLE_MAX_PARTITIONS,
      watermark: SAMPLE_PARTITION_WATERMARK,
    },
    default_scoring: form === 'named' ? 'dfs' : 'broadcast',
    text_storage: form === 'named' ? 'disk' : 'memory',
    strict: true,
    vector_promotion: { ...promotion, filter_threshold: SAMPLE_FILTER_THRESHOLD },
    pattern_value_limit: SAMPLE_PATTERN_VALUE_LIMIT,
    index_uuid: SAMPLE_INDEX_UUID,
    held_partitions: [0],
    synonyms: SAMPLE_SYNONYMS,
  })
  return copy
}

export function configurationWithEveryKey(configuration: JsonObject, form: StopWordForm): JsonObject {
  const copy = copyOf(configuration)
  const payload = payloadOf(copy, 'index configuration')
  const bm25 = isJsonObject(payload.bm25) ? payload.bm25 : {}
  const promotion = isJsonObject(payload.vectorPromotion) ? payload.vectorPromotion : {}
  Object.assign(payload, {
    bm25: { ...bm25, fields: { title: { k1: SAMPLE_TITLE_K1, b: SAMPLE_TITLE_B } } },
    embedding: embeddingOf(form),
    tokenizer: SAMPLE_TOKENIZER,
    ...stopWordsOf(form, 'stopWords', 'stopWordList'),
    analysisGeneration: SAMPLE_ANALYSIS_GENERATION,
    partitionConfig: {
      maxDocsPerPartition: SAMPLE_MAX_DOCS_PER_PARTITION,
      maxPartitions: SAMPLE_MAX_PARTITIONS,
      watermark: SAMPLE_PARTITION_WATERMARK,
    },
    defaultScoring: form === 'named' ? 'local' : 'dfs',
    textStorage: form === 'named' ? 'disk' : 'memory',
    strict: true,
    vectorPromotion: { ...promotion, filterThreshold: SAMPLE_FILTER_THRESHOLD },
    patternValueLimit: SAMPLE_PATTERN_VALUE_LIMIT,
    synonyms: SAMPLE_SYNONYMS,
  })
  return copy
}

export function segmentWithoutPositions(segment: JsonObject): JsonObject {
  const copy = copyOf(segment)
  const payload = payloadOf(copy, 'keyword segment')
  payload.positionOffsets = null
  payload.positions = null
  return copy
}

export function graphWithoutEntryPoint(graphPart: JsonObject): JsonObject {
  const copy = copyOf(graphPart)
  const payload = payloadOf(copy, 'graph part')
  if (!Array.isArray(payload.graphs)) throw new FormError('the graph part holds no graphs')
  payload.graphs = payload.graphs.map(graph => {
    if (!isJsonObject(graph)) throw new FormError('a graph is not an object')
    const { shuffledBuildCount: _count, calibratedMeanLength: _length, ...rest } = graph
    return { ...rest, entryPoint: null }
  })
  return copy
}

export function manifestWithAnalysisGeneration(manifest: JsonObject): JsonObject {
  const copy = copyOf(manifest)
  payloadOf(copy, 'manifest').analysisGeneration = SAMPLE_ANALYSIS_GENERATION
  return copy
}

export function markerWithTornSlot(marker: JsonObject): JsonObject {
  const copy = copyOf(marker)
  if (!Array.isArray(copy.slots)) throw new FormError('the commit marker holds no slots')
  copy.slots = [null, ...copy.slots.slice(1)]
  return copy
}
