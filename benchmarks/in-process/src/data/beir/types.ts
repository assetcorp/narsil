import type { BenchDocument } from '../../types'

export const BEIR_DATASETS = ['scifact', 'nfcorpus', 'fiqa'] as const

export type BeirDatasetName = (typeof BEIR_DATASETS)[number]

export interface RawCorpusDoc {
  id: string
  title: string
  text: string
}

export interface BeirQuery {
  id: string
  text: string
}

export type Qrels = Map<string, Map<string, number>>

export interface DatasetCounts {
  documents: number
  queries: number
  qrels: number
}

export interface BeirManifest {
  name: BeirDatasetName
  source: string
  license: string
  archiveBytes: number
  archiveSha256: string
  counts: DatasetCounts
  corpusFingerprint: string
  documentTextRule: string
  fingerprintAlgorithm: string
}

export interface BeirDataset {
  name: BeirDatasetName
  documents: BenchDocument[]
  queries: BeirQuery[]
  qrels: Qrels
  counts: DatasetCounts
  archiveSha256: string
  corpusFingerprint: string
}

export interface LoadBeirOptions {
  noDownload?: boolean
  refresh?: boolean
  updatePin?: boolean
}
