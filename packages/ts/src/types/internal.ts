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
        entryPoint: string
        maxLayer: number
        m: number
        efConstruction: number
        nodes: Array<[string, number, Array<[number, string[]]>]>
      }
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
