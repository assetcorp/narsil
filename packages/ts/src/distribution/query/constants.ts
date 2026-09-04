import { RESULT_WINDOW } from '../../search/constants'
import { MAX_PARTITION_COUNT } from '../constants'

export const MAX_PARTITION_IDS = MAX_PARTITION_COUNT

export const MAX_TERM_LENGTH = 1024
export const MAX_TERMS_COUNT = 65_536
export const MAX_FIELD_NAME_LENGTH = 255
export const MAX_FIELDS_LIST = 256
export const MAX_BOOST_FIELDS = 256
export const MAX_FACETS = 64
export const MAX_FETCH_DOCUMENT_IDS = 10_000
export const MAX_FILTER_DEPTH = 30
export const MAX_FILTER_FIELDS = 256
export const MAX_FILTER_ARRAY_SIZE = 65_536
export const MAX_FILTER_STRING_LENGTH = 1024
export const MAX_TOLERANCE = 10
export const MAX_LIMIT = 10_000
export const MAX_OFFSET = 10_000
export const MAX_HYBRID_K = 10_000
export const MIN_HYBRID_K = 1
export const MAX_PREFIX_LENGTH = 1024
export const MAX_PINNED_ENTRIES = 1_000
export const MAX_PINNED_POSITION = RESULT_WINDOW
export const MAX_EF_SEARCH = 10_000
export const MAX_GROUP_FIELDS = 64

export const MAX_HIGHLIGHT_TAG_LENGTH = 256
export const MAX_HIGHLIGHT_SNIPPET_LENGTH = 65_536

export const MAX_LIST_CURSOR_LENGTH = 4096
export const MAX_SUGGEST_WIRE_LIMIT = 1_000
export const MAX_COUNT_VALUE = Number.MAX_SAFE_INTEGER
export const MAX_LANGUAGE_NAME_LENGTH = 64
export const MAX_SORT_VALUE_STRING_LENGTH = 65_536

export const MAX_RESULTS_PER_PARTITION = 10_000
export const MAX_SORT_VALUES = 8
export const MAX_FACET_FIELDS = 64
export const MAX_FACET_BUCKETS = 10_000
export const MAX_FACET_VALUE_LENGTH = 1024
export const MAX_GROUPS_PER_RESPONSE = 65_536

export const MAX_FACET_SIZE = 1_000
export const DEFAULT_MAX_FACET_BUCKETS = 100
export const MAX_VECTOR_DIMENSION = 8192
export const MAX_VECTOR_TEXT_LENGTH = 16_384
