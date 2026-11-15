export const VARIABLE_PREFIX = 'NARSIL_'
export const MAX_LIST_ITEMS = 1_024

export const DEFAULT_HTTP_HOST = '0.0.0.0'
export const DEFAULT_HTTP_PORT = 7700
export const MAX_HTTP_PORT = 65_535
export const DEFAULT_DATA_DIR = '/data'
export const DEFAULT_LANGUAGE = 'english'

export const MIN_KEY_CHARACTERS = 32
export const MIN_QUERY_SUGGESTIONS_KEY_BYTES = 32
export const ENGINE_MAX_RERANK_WINDOW = 1_000

export const INDEXES_FOLDER = 'indexes'
export const TASKS_FOLDER = 'tasks'
export const WEBHOOKS_FOLDER = 'webhooks'
export const MODELS_FOLDER = 'models'
export const MEMORY_MODELS_FOLDER = 'narsil-models'

export const ADAPTER_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const LANGUAGE_NAME_PATTERN = /^[a-z]+(-[a-z]+)*$/

export const DEFAULT_EMBEDDER_TRANSFORMERS_MODEL = 'Xenova/all-MiniLM-L6-v2'
export const DEFAULT_RERANKER_TRANSFORMERS_MODEL = 'Xenova/ms-marco-MiniLM-L-6-v2'
export const DEFAULT_ADAPTER_TIMEOUT_MS = 30_000
export const DEFAULT_ADAPTER_MAX_RETRIES = 3
export const DEFAULT_RERANKER_MAX_DOCUMENTS_PER_REQUEST = 1_000

export const WEBHOOK_SECRET_PREFIX = 'whsec_'
export const MIN_WEBHOOK_SECRET_BYTES = 24
export const MAX_WEBHOOK_SECRET_BYTES = 64
