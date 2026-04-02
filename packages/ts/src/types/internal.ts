export interface PostingEntry {
  docId: string
  termFrequency: number
  fieldName: string
  positions: number[]
}

export interface PostingList {
  docFrequency: number
  postings: PostingEntry[]
}

export interface FieldNameTable {
  names: string[]
  indexMap: Map<string, number>
}

export interface CompactPostingList {
  length: number
  docIds: string[]
  termFrequencies: Uint16Array
  fieldNameIndices: Uint8Array
  positions: number[][] | null
  docIdSet: Set<string>
  deletedDocs: Set<string>
}

export interface StoredDocument {
  fields: Record<string, unknown>
  fieldLengths: Record<string, number>
}

export interface NumericIndexEntry {
  value: number
  docId: string
}

export interface GeopointEntry {
  lat: number
  lon: number
  docId: string
}

export interface VectorEntry {
  docId: string
  vector: Float32Array
  magnitude: number
}

export interface SerializablePartition {
  indexName: string
  partitionId: number
  totalPartitions: number
  language: string
  schema: Record<string, string>
  docCount: number
  avgDocLength: number
  documents: Record<string, { fields: Record<string, unknown>; fieldLengths: Record<string, number> }>
  invertedIndex: Record<
    string,
    {
      docFrequency: number
      postings: Array<{
        docId: string
        termFrequency: number
        field: string
        positions: number[]
      }>
    }
  >
  fieldIndexes: {
    numeric: Record<string, Array<{ value: number; docId: string }>>
    boolean: Record<string, { trueDocs: string[]; falseDocs: string[] }>
    enum: Record<string, Record<string, string[]>>
    geopoint: Record<string, Array<{ lat: number; lon: number; docId: string }>>
  }
  vectorData: Record<
    string,
    {
      dimension: number
      vectors: Array<{ docId: string; vector: number[] }>
      hnswGraph: null | {
        entryPoint: string | null
        maxLayer: number
        m: number
        efConstruction: number
        metric?: 'cosine' | 'dotProduct' | 'euclidean'
        nodes: Array<[string, number, Array<[number, string[]]>]>
      }
      sq8?: {
        alpha: number
        offset: number
        quantizedVectors: Record<string, number[]>
        vectorSums: Record<string, number>
        vectorSumSqs: Record<string, number>
      } | null
    }
  >
  statistics: {
    totalDocuments: number
    totalFieldLengths: Record<string, number>
    averageFieldLengths: Record<string, number>
    docFrequencies: Record<string, number>
  }
}

export interface IndexMetadata {
  indexName: string
  schema: Record<string, string>
  language: string
  partitionCount: number
  bm25Params: { k1: number; b: number }
  createdAt: number
  engineVersion: string
}

export interface GlobalStatistics {
  totalDocuments: number
  docFrequencies: Record<string, number>
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
}

export interface ScoredDocument {
  docId: string
  score: number
  termFrequencies: Record<string, number>
  fieldLengths: Record<string, number>
  idf: Record<string, number>
}

export interface InternalSearchResult {
  scored: ScoredDocument[]
  totalMatched: number
}

export interface InternalSearchParams {
  queryTokens: Array<{ token: string; position: number }>
  fields?: string[]
  boost?: Record<string, number>
  tolerance?: number
  prefixLength?: number
  exact?: boolean
  bm25Params?: import('../types/schema').BM25Params
  globalStats?: GlobalStatistics
  maxResults?: number
  termMatch?: import('../types/search').TermMatchPolicy
}

export interface InternalVectorParams {
  field: string
  value: number[]
  k: number
  similarity?: number
  metric?: 'cosine' | 'dotProduct' | 'euclidean'
  filterDocIds?: Set<string>
  efSearch?: number
}
