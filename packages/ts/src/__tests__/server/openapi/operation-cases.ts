export interface ContractState {
  taskIdToRead: string
  snapshot: Uint8Array
  documentExport: Uint8Array
  startTask(): Promise<string>
}

export type ServerKind = 'single' | 'cluster'

export interface Probe {
  on?: ServerKind
  name?: string
  id?: string
  query?: string
  json?: unknown
  raw?: Uint8Array
  rawContentType?: string
  statuses: number[]
  verify?: (body: unknown) => void
}

export interface OperationCase {
  valid: (state: ContractState) => Probe | Promise<Probe>
  alsoValid?: () => Probe[]
  hostile: (state: ContractState) => Probe
}

export const INDEX = 'products'
export const LIMITED_BYTES = 1024 * 1024
export const FILTERED_CATEGORY = 'footwear'

export const INDEX_SCHEMA = {
  title: 'string',
  category: 'enum',
  brand: 'enum',
  price: 'number',
  location: 'geopoint',
  embedding: 'vector[3]',
}

const SEEDED_DOCUMENTS = [
  { title: 'red trail shoes', category: FILTERED_CATEGORY, brand: 'north', price: 120, embedding: [1, 0, 0] },
  { title: 'blue trail shoes', category: FILTERED_CATEGORY, brand: 'south', price: 90, embedding: [0, 1, 0] },
  { title: 'trail tent', category: 'camping', brand: 'north', price: 300, embedding: [0, 0, 1] },
]

const MALFORMED_JSON = new TextEncoder().encode('{"truncated":')
const JSON_CONTENT_TYPE = 'application/json'
const NDJSON_CONTENT_TYPE = 'application/x-ndjson'
const TAR_CONTENT_TYPE = 'application/x-tar'

function malformed(statuses = [400]): Probe {
  return { raw: MALFORMED_JSON, rawContentType: JSON_CONTENT_TYPE, statuses }
}

function missingIndex(): Probe {
  return { name: 'no-such-index', statuses: [404] }
}

function ignoredJunkQuery(statuses = [200]): Probe {
  return { query: 'junk=%ZZ&&=', statuses }
}

function overLimit(contentType: string): Probe {
  return { raw: new Uint8Array(LIMITED_BYTES + 1), rawContentType: contentType, statuses: [413] }
}

function objectField(body: unknown, field: string): unknown {
  return (body as Record<string, unknown>)[field]
}

function verifyFilteredSearch(body: unknown): void {
  const hits = objectField(body, 'hits') as Array<{ document: { category: string } }>
  if (hits.length !== 2 || hits.some(hit => hit.document.category !== FILTERED_CATEGORY)) {
    throw new Error(`The filter on category kept the wrong hits: ${JSON.stringify(hits)}`)
  }
  const facets = objectField(body, 'facets') as { brand: { values: Record<string, number> } }
  if (facets.brand.values.north !== 1 || facets.brand.values.south !== 1) {
    throw new Error(`The brand facet counted the wrong documents: ${JSON.stringify(facets)}`)
  }
  const groups = objectField(body, 'groups') as unknown[]
  if (groups.length !== 2) throw new Error(`Grouping by brand made ${groups.length} groups, and two brands matched`)
}

function verifyOneFailedDocument(body: unknown): void {
  const succeeded = objectField(body, 'succeeded') as string[]
  const failed = objectField(body, 'failed') as Array<{ docId: string; error: { code: string } }>
  if (succeeded.length !== 1 || failed.length !== 1 || failed[0]?.docId !== 'batch-bad') {
    throw new Error(`One of the two batched documents has a bad price: ${JSON.stringify(body)}`)
  }
}

export const OPERATION_CASES: Readonly<Record<string, OperationCase>> = {
  isAlive: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  isReady: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  health: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  version: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  capabilities: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  getMemoryStats: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  createIndex: {
    valid: () => ({ json: { name: INDEX, config: { schema: INDEX_SCHEMA } }, statuses: [201] }),
    hostile: () => ({ json: { name: 'bad', config: { schema: { title: 'text' } } }, statuses: [400] }),
  },
  listIndexes: { valid: () => ({ statuses: [200] }), hostile: () => ignoredJunkQuery() },
  insert: {
    valid: () => ({ name: INDEX, json: { document: SEEDED_DOCUMENTS[0], id: 'seed-1' }, statuses: [201] }),
    hostile: () => ({ name: INDEX, ...malformed() }),
  },
  put: {
    valid: () => ({ name: INDEX, id: 'seed-2', json: { document: SEEDED_DOCUMENTS[1] }, statuses: [201] }),
    alsoValid: () => [{ name: INDEX, id: 'seed-2', json: { document: SEEDED_DOCUMENTS[1] }, statuses: [200] }],
    hostile: () => ({ name: INDEX, id: 'seed-2', json: { document: { price: 'free' } }, statuses: [400] }),
  },
  writeBatch: {
    valid: () => ({
      name: INDEX,
      json: {
        action: 'insert',
        documents: [
          { id: 'seed-3', ...SEEDED_DOCUMENTS[2] },
          { id: 'batch-bad', title: 'bad price', price: 'free' },
        ],
      },
      statuses: [200],
      verify: verifyOneFailedDocument,
    }),
    hostile: () => ({ name: INDEX, json: { action: 'explode' }, statuses: [400] }),
  },
  update: {
    valid: () => ({
      name: INDEX,
      id: 'seed-1',
      json: { document: { ...SEEDED_DOCUMENTS[0], price: 125 } },
      statuses: [200],
    }),
    hostile: () => ({ name: INDEX, id: 'no-such-document', json: { document: { price: 1 } }, statuses: [404] }),
  },
  get: {
    valid: () => ({ name: INDEX, id: 'seed-1', statuses: [200] }),
    hostile: () => ({ name: INDEX, id: 'no-such-document', statuses: [404] }),
  },
  has: {
    valid: () => ({ name: INDEX, id: 'seed-1', statuses: [200] }),
    hostile: () => ({ name: 'no-such-index', id: 'seed-1', statuses: [404] }),
  },
  countDocuments: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  listDocuments: {
    valid: () => ({ name: INDEX, json: { limit: 2 }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { limit: 'two' }, statuses: [400] }),
  },
  getMultiple: {
    valid: () => ({ name: INDEX, json: { docIds: ['seed-1', 'no-such-document'] }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { docIds: 'seed-1' }, statuses: [400] }),
  },
  importNdjson: {
    valid: () => ({
      name: INDEX,
      raw: new TextEncoder().encode(`${JSON.stringify({ id: 'imported-1', title: 'trail mug', price: 12 })}\n{"bad\n`),
      rawContentType: NDJSON_CONTENT_TYPE,
      statuses: [200],
    }),
    alsoValid: () => [
      {
        name: INDEX,
        query: 'async=true',
        raw: new TextEncoder().encode(`${JSON.stringify({ id: 'imported-2', title: 'trail flask', price: 15 })}\n`),
        rawContentType: NDJSON_CONTENT_TYPE,
        statuses: [202],
      },
    ],
    hostile: () => ({ name: INDEX, ...overLimit(NDJSON_CONTENT_TYPE) }),
  },
  waitForWrites: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  query: {
    valid: () => ({
      name: INDEX,
      json: {
        term: 'trail',
        filters: { fields: { category: { eq: FILTERED_CATEGORY } } },
        facets: { brand: {} },
        group: { fields: ['brand'] },
      },
      statuses: [200],
      verify: verifyFilteredSearch,
    }),
    hostile: () => ({ name: INDEX, json: { term: 'trail', limit: 1_000_000 }, statuses: [400] }),
  },
  preflight: {
    valid: () => ({ name: INDEX, json: { term: 'trail' }, statuses: [200] }),
    hostile: () => ({ name: INDEX, ...malformed() }),
  },
  suggest: {
    valid: () => ({ name: INDEX, json: { prefix: 'tr' }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { limit: 1 }, statuses: [400] }),
  },
  getStats: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  getPartitionStats: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  checkpoint: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  rebuildAnalysis: { valid: () => ({ name: INDEX, statuses: [202] }), hostile: missingIndex },
  changeAnalysis: {
    valid: () => ({ name: INDEX, json: { stopWords: ['no-such-word-in-any-title'] }, statuses: [202] }),
    hostile: () => ({ name: INDEX, json: { stemmer: 'porter' }, statuses: [400] }),
  },
  vectorMaintenanceStatus: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  compactVectors: {
    valid: () => ({ name: INDEX, json: { field: 'embedding' }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { field: 'no-such-field' }, statuses: [404] }),
  },
  optimizeVectors: {
    valid: () => ({ name: INDEX, json: { field: 'embedding' }, statuses: [202] }),
    hostile: () => ({ name: INDEX, ...malformed() }),
  },
  rebalance: {
    valid: () => ({ name: INDEX, json: { targetPartitionCount: 2 }, statuses: [202] }),
    hostile: () => ({ name: INDEX, json: { targetPartitionCount: -1 }, statuses: [400] }),
  },
  updatePartitionConfig: {
    valid: () => ({ name: INDEX, json: { maxPartitions: 16 }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { maxPartitions: 'many' }, statuses: [400] }),
  },
  updateSynonyms: {
    valid: () => ({ name: INDEX, json: { synonyms: [{ words: ['tent', 'shelter'] }] }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { synonyms: 'tent' }, statuses: [400] }),
  },
  getSynonyms: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  updateBM25: {
    valid: () => ({ name: INDEX, json: { k1: 1.2, b: 0.75 }, statuses: [200] }),
    hostile: () => ({ name: INDEX, json: { k1: -5 }, statuses: [400] }),
  },
  snapshot: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  restore: {
    valid: state => ({ name: INDEX, raw: state.snapshot, rawContentType: TAR_CONTENT_TYPE, statuses: [202] }),
    hostile: () => ({ name: INDEX, ...overLimit(TAR_CONTENT_TYPE) }),
  },
  exportDocuments: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  importDocumentExport: {
    valid: state => ({ name: INDEX, raw: state.documentExport, rawContentType: NDJSON_CONTENT_TYPE, statuses: [202] }),
    hostile: () => ({ name: INDEX, ...overLimit(NDJSON_CONTENT_TYPE) }),
  },
  listTasks: {
    valid: () => ({ query: 'status=succeeded,failed&limit=5', statuses: [200] }),
    hostile: () => ({ query: 'limit=-1', statuses: [400] }),
  },
  getTask: {
    valid: state => ({ id: state.taskIdToRead, statuses: [200] }),
    hostile: () => ({ id: 'no-such-task', statuses: [404] }),
  },
  cancelTask: {
    valid: async state => ({ id: await state.startTask(), statuses: [202, 409] }),
    hostile: () => ({ id: 'no-such-task', statuses: [404] }),
  },
  remove: {
    valid: () => ({ name: INDEX, id: 'imported-1', query: 'wait=true', statuses: [200] }),
    hostile: () => ({ name: INDEX, id: 'no-such-document', statuses: [404] }),
  },
  clear: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  close: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  open: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
  getClusterTopology: { valid: () => ({ on: 'cluster', statuses: [200] }), hostile: () => ({ statuses: [501] }) },
  getClusterHealth: { valid: () => ({ on: 'cluster', statuses: [200] }), hostile: () => ({ statuses: [501] }) },
  getMetrics: { valid: () => ({ on: 'cluster', statuses: [200] }), hostile: () => ({ statuses: [501] }) },
  getIndexAllocation: {
    valid: () => ({ on: 'cluster', name: INDEX, statuses: [200] }),
    hostile: () => ({ name: INDEX, statuses: [501] }),
  },
  setReplicationFactor: {
    valid: () => ({ on: 'cluster', name: INDEX, json: { replicationFactor: 0 }, statuses: [200] }),
    hostile: () => ({ on: 'cluster', name: INDEX, json: { replicationFactor: -1 }, statuses: [400] }),
  },
  dropIndex: { valid: () => ({ name: INDEX, statuses: [200] }), hostile: missingIndex },
}
