export const INDEX_NAME = 'bills'
export const INDEX_LANGUAGE = 'english'
export const VECTOR_FIELD = 'embedding'
export const INDEX_SCHEMA = { title: 'string', summary: 'string', embedding: 'vector[384]' } as const
export const INSERT_BATCH_DOCUMENTS = 500

export const TEXT_RESULT_LIMIT = 10
export const FIELD_THAT_NO_DOCUMENT_HOLDS = 'sponsor'
export const GROUP_FIELDS = ['title', FIELD_THAT_NO_DOCUMENT_HOLDS] as const
export const GROUP_LIMIT = 3
export const GROUP_MAX_PER_GROUP = 2
export const EXACT_NEIGHBOURS = 100
export const RECALL_FLOORS = [
  { k: 10, floor: 0.95 },
  { k: 100, floor: 0.9 },
] as const
export const SIMILARITY_TOLERANCE = 1e-6
export const SCORE_RELATIVE_TOLERANCE = 1e-9
