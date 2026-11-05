export const DATASET_ID = 'conformance/billsum-us'
export const ARTIFACT_FORMAT = 'narsil-conformance-dataset/1'
export const ARTIFACT_MANIFEST = 'artifact.json'
export const DOCUMENTS_FILE = 'documents.jsonl.gz'
export const VECTORS_FILE = 'vectors.f32'
export const QUERIES_FILE = 'queries.json'
export const FETCHED_MARKER = 'fetched.json'

export const SOURCE_DATASET = 'FiscalNote/billsum'
export const SOURCE_REVISION = '3d8510441c06a3d9dfb32eb0d7f80151730bcc4f'
export const SOURCE_LICENSE = 'CC0-1.0'
export const DOCUMENT_SPLIT = 'train'
export const QUERY_SPLIT = 'test'
export const DOCUMENT_SOURCE_FILE = {
  split: DOCUMENT_SPLIT,
  path: 'data/train-00000-of-00001.parquet',
  sha256: '7ca4e515ad7502ef579a055c2d64e6dfa0d64200017c15bca00f323a34cd2ae3',
  bytes: 91_811_112,
}
export const QUERY_SOURCE_FILE = {
  split: QUERY_SPLIT,
  path: 'data/test-00000-of-00001.parquet',
  sha256: '2733cb656a2a6fbff0fc012ca50bbf159615ff6451c0adb229884bbd474780b3',
  bytes: 15_797_079,
}
export const DOCUMENT_COUNT = 10_000
export const VECTOR_QUERY_COUNT = 100
export const TEXT_QUERY_COUNT = 100

export const VECTOR_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const VECTOR_DIMENSION = 384
export const EMBEDDING_BATCH_SIZE = 32

export const DOWNLOAD_ATTEMPTS = 8
export const DOWNLOAD_RETRY_DELAY_MS = 3_000
export const REQUEST_TIMEOUT_MS = 120_000
export const MAX_ARTIFACT_FILE_BYTES = 268_435_456
