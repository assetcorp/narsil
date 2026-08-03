import type { EmbeddingAdapter } from './adapters'

/**
 * A document as the engine stores it: any set of fields, with an optional `id`.
 *
 * The engine takes the `id` field as the document id when you insert without
 * passing one. Every other field must match the type its schema declares.
 *
 * @public
 */
export type AnyDocument = Record<string, unknown> & { id?: string }

/**
 * The type a schema field declares, which sets how the engine indexes it.
 *
 * `string` is analysed and searchable, `number`, `boolean`, and `enum` are
 * filterable and sortable, `geopoint` accepts a latitude and longitude pair,
 * and `vector[N]` holds an N-dimensional embedding. Each array form indexes
 * every element of the field.
 *
 * @public
 */
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'geopoint'
  | `vector[${number}]`
  | 'string[]'
  | 'number[]'
  | 'boolean[]'
  | 'enum[]'

/**
 * The field layout of an index, written as a plain object.
 *
 * Each key names a field and each value is either its {@link FieldType} or a
 * nested schema, which is how you describe an object inside a document.
 * Nesting goes four levels deep.
 *
 * @public
 */
export type SchemaDefinition = {
  [field: string]: FieldType | SchemaDefinition
}

/**
 * How the engine stores vectors once a field is promoted to an HNSW graph.
 *
 * `sq8` quantises each component to a signed byte, which cuts memory to a
 * quarter and costs a small amount of recall. `none` keeps full precision.
 *
 * @public
 */
export type VectorQuantizationMode = 'sq8' | 'none'

/**
 * Controls when a vector field moves from a brute-force scan to an HNSW graph,
 * and how that graph is built.
 *
 * A small field answers faster from a brute-force scan, so the engine builds a
 * graph only once the field holds enough vectors to earn one. Leave every
 * field unset to accept the engine's own values.
 *
 * @public
 */
export interface VectorIndexConfig {
  /** The engine promotes the field to an HNSW graph once it holds this many vectors. */
  threshold?: number
  /** A filtered search prefers the graph over a scan once the field holds this many vectors. */
  filterThreshold?: number
  /** These settings shape the graph: neighbours per node, build-time exploration, and the metric that ranks results. */
  hnswConfig?: { m?: number; efConstruction?: number; metric?: 'cosine' | 'dotProduct' | 'euclidean' }
  /** The engine stores the promoted vectors at this precision. It keeps full precision by default. */
  quantization?: VectorQuantizationMode
}

/**
 * Connects an index to an embedding adapter and says which fields feed it.
 *
 * The engine embeds the named source fields on every insert and update, so a
 * document arrives as text and is stored with its vector alongside.
 *
 * @public
 */
export interface EmbeddingFieldConfig {
  /** An adapter instance, or a registered adapter name. Only a name survives
   * durability recovery, since instances cannot be serialised. */
  adapter?: EmbeddingAdapter | string
  /** This maps each vector field to the text field, or fields, the engine embeds into it. */
  fields: Record<string, string | string[]>
}

/**
 * Replaces a language's stop word list, either with a fixed set or with a
 * function that receives the language defaults and returns the set to use.
 *
 * @public
 */
export type StopWordOverride = Set<string> | ((defaults: Set<string>) => Set<string>)

/**
 * Everything {@link Narsil.createIndex} needs to build an index.
 *
 * Only `schema` is required. The rest tune analysis, scoring, partitioning,
 * and vector handling, and each one falls back to an engine default.
 *
 * @public
 */
export interface IndexConfig {
  /** This layout fixes the type of every field you search, filter, or sort on. */
  schema: SchemaDefinition
  /** The engine tokenises and stems text fields with the language module registered under this name. It uses English by default. */
  language?: string
  /** These settings decide how the index splits documents across partitions as it grows. */
  partitions?: PartitionConfig
  /** A query scores this way unless it asks for another mode. */
  defaultScoring?: ScoringMode
  /** These parameters tune BM25 for this index. */
  bm25?: BM25Params
  /** This replaces the language's stop words, either inline or by the name a stop word list registered under. */
  stopWords?: StopWordOverride | string
  /** This replaces the language's tokeniser, either inline or by the name a tokeniser registered under. */
  tokenizer?: CustomTokenizer | string
  /** Setting this records term positions, which phrase queries and highlighting need. */
  trackPositions?: boolean
  /** These settings decide when vector fields move to an HNSW graph, and how that graph is built. */
  vectorPromotion?: VectorIndexConfig
  /** Setting this rejects a document carrying a field the schema does not declare. The engine accepts extra fields by default. */
  strict?: boolean
  /** These settings embed text fields into vector fields on every write. */
  embedding?: EmbeddingFieldConfig
  /** The engine rejects a document that omits any of these fields. */
  required?: string[]
  /**
   * Return the words users typed from suggest() and prefix expansion
   * instead of index stems, at an insert-throughput cost. Default false.
   */
  surfaceForms?: boolean
}

/**
 * BM25 tuning for an index.
 *
 * Both parameters default to the values the literature settles on, so change
 * them only once you have measured relevance on your own corpus.
 *
 * @public
 */
export interface BM25Params {
  /** This saturates term frequency, so a higher value lets a repeated term keep raising a score. It defaults to 1.2. */
  k1?: number
  /** This normalises by field length, from 0 for none to 1 for full. It defaults to 0.75. */
  b?: number
}

/**
 * A tokeniser you supply, which replaces the language module's own.
 *
 * The engine calls it for every text field on write and for every query term,
 * so the same rules apply on both sides.
 *
 * @public
 */
export interface CustomTokenizer {
  /**
   * Splits one field value into the tokens the engine indexes.
   *
   * @param text - The raw field value, before any stemming or stop word removal.
   * @returns Each token with the character offset it starts at, which
   * highlighting and phrase matching rely on.
   */
  tokenize(text: string): Array<{ token: string; position: number }>
}

/**
 * How an index splits its documents across partitions as it grows.
 *
 * The engine adds a partition once a partition passes its watermark, and it
 * refuses a write once every partition is full and the ceiling is reached.
 *
 * @public
 */
export interface PartitionConfig {
  /** The engine refuses a write that would push one partition past this many documents. */
  maxDocsPerPartition?: number
  /** The index grows to this many partitions and no further. */
  maxPartitions?: number
  /** The engine adds a partition once one fills this fraction of `maxDocsPerPartition`, from 0 to 1. */
  watermark?: number
}

/**
 * How a query gathers the term statistics BM25 scores with.
 *
 * `local` scores each partition from its own statistics, which is fastest and
 * accurate enough for evenly spread data. `dfs` gathers document frequencies
 * across partitions first, so every score compares like for like. `broadcast`
 * sends the query to every partition and merges the results.
 *
 * @public
 */
export type ScoringMode = 'local' | 'dfs' | 'broadcast'

/**
 * Per-write options for {@link Narsil.insert} and {@link Narsil.insertBatch}.
 *
 * @public
 */
export interface InsertOptions {
  /**
   * Setting this stores the document object you passed instead of a copy,
   * which saves a clone on a large load. Changing that object afterwards
   * changes the stored document with it, so pass this only for a document you
   * discard.
   */
  skipClone?: boolean
}
