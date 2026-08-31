import type { AnyDocument, InsertOptions } from '../../types/schema'

/** Declarative index configuration accepted over HTTP. Function-valued engine
 * options (custom tokenizer, stopWords-as-function, group reducer, embedding
 * adapter object) are not representable here; the embedding adapter is named
 * instead via {@link CreateIndexEmbedding}.
 *
 * @public */
export interface CreateIndexRequest {
  /** The server creates the index under this name. */
  name: string
  /** This carries the schema and settings, in the subset JSON can express. */
  config: HttpIndexConfig
}

/**
 * How a JSON `createIndex` request connects an index to an embedding adapter.
 *
 * An adapter is a function and cannot cross JSON, so the request names one the
 * server registered instead of carrying it.
 *
 * @public
 */
export interface CreateIndexEmbedding {
  /** This names an adapter the server registered under `embeddingAdapters`. */
  adapter?: string
  /** This maps each vector field to the text field, or fields, the server embeds into it. */
  fields: Record<string, string | string[]>
}

export interface InsertBody {
  document: AnyDocument
  id?: string
  options?: InsertOptions
}

export interface DocumentBody {
  document: AnyDocument
}

export interface MultiGetBody {
  docIds: string[]
}

export interface BatchBody {
  action?: 'insert' | 'update' | 'delete'
  documents?: AnyDocument[]
  updates?: Array<{ docId: string; document: AnyDocument }>
  docIds?: string[]
  options?: InsertOptions
}

export interface RebalanceBody {
  targetPartitionCount?: number
}

/**
 * The index settings a JSON request can carry, which is {@link IndexConfig}
 * minus everything that is a function.
 *
 * A custom tokeniser, a stop-word function, and an embedding adapter object
 * have no JSON form, so an HTTP client names a registered one or supplies a
 * plain list instead.
 *
 * @public
 */
export interface HttpIndexConfig {
  /** This layout gives each value as either a field type or a nested schema. */
  schema: Record<string, unknown>
  /** The server tokenises and stems text fields with the language module registered under this name. */
  language?: string
  /** These settings control how the index splits documents across partitions as it grows. */
  partitions?: { maxDocsPerPartition?: number; maxPartitions?: number; watermark?: number }
  /** A query scores this way unless it asks for another mode. */
  defaultScoring?: 'local' | 'dfs' | 'broadcast'
  /** These parameters tune BM25 for this index. */
  bm25?: { k1?: number; b?: number }
  /** This list replaces the language's stop words. */
  stopWords?: string[]
  /** Setting this records term positions in each posting, which the `.nrsl` format carries for readers that match phrases. Highlighting works without it. */
  trackPositions?: boolean
  /** Setting this to false returns index stems from suggestions and prefix expansion, instead of the words users typed. */
  surfaceForms?: boolean
  /** These settings control when vector fields move to an HNSW graph, and how that graph is built. */
  vectorPromotion?: Record<string, unknown>
  /** Setting this rejects a document carrying a field the schema does not declare. */
  strict?: boolean
  /** This names a server-registered embedding adapter and the fields it embeds. */
  embedding?: CreateIndexEmbedding
  /** The server rejects a document that omits any of these fields. */
  required?: string[]
}

/**
 * One record an import refused, naming the line it came from and why the
 * server rejected it.
 *
 * @public
 */
export interface ImportError {
  /** The failing record sat on this line of the body, counting from one. */
  line?: number
  /** The engine rejected the document stored under this id. */
  docId?: string
  /** This says which failure it is. */
  code: string
  /** This describes the failure, for a log or a person. */
  message: string
}

/**
 * What one import produced.
 *
 * `errors` is capped by the server's `maxImportErrors` limit while `failed`
 * counts every refusal, so a run that trips the cap reports the true total and
 * sets `errorsTruncated`.
 *
 * @public
 */
export interface ImportResult {
  /** The engine accepted this many documents. */
  indexed: number
  /** The server refused this many records in total. */
  failed: number
  /** The first refusals, up to the server's reporting cap. */
  errors: ImportError[]
  /** Setting this says more records failed than `errors` lists. */
  errorsTruncated: boolean
}

/**
 * What a server announces at `/capabilities`, which is how a client finds out
 * whether an optional route or mode is available before it sends a request.
 *
 * A server that answers 404 here predates the endpoint, so treat every optional
 * capability as absent.
 *
 * @public
 */
export interface CapabilitiesResponse {
  /** Each name marks one capability this server serves. */
  capabilities: string[]
}
