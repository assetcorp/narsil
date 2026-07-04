import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ARCHIVE_URL = 'https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip'
const ARCHIVE_SHA256 = '536e14446a0ba56ed1398ab1055f39fe852686ecad24a6306c80c490fa8e0165'
const ARCHIVE_BYTES = 2_816_079
const DOWNLOAD_TIMEOUT_MS = 300_000

const EXPECTED_DOCS = 5_183
const EXPECTED_QUERIES = 300
const EXPECTED_QRELS = 339

const QRELS_HEADER = 'query-id\tcorpus-id\tscore'

interface ScifactDoc {
  id: number
  title: string
  text: string
}

interface ScifactQuery {
  id: number
  text: string
}

interface ScifactQrel {
  queryId: number
  docId: number
  relevance: number
}

function parseBeirId(value: unknown, context: string): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${context}: expected an integer-string "_id", got ${JSON.stringify(value)}`)
  }
  const id = Number(value)
  if (!Number.isSafeInteger(id)) {
    throw new Error(`${context}: "_id" ${value} exceeds the safe integer range`)
  }
  return id
}

async function downloadArchive(): Promise<Buffer> {
  console.log(`Downloading ${ARCHIVE_URL}`)
  const response = await fetch(ARCHIVE_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`)
  }
  if (response.body === null) {
    throw new Error('download failed: response has no body')
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > ARCHIVE_BYTES) {
      await reader.cancel()
      throw new Error(`download exceeded the pinned archive size of ${ARCHIVE_BYTES} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

function verifyArchive(bytes: Buffer): void {
  if (bytes.byteLength !== ARCHIVE_BYTES) {
    throw new Error(`archive is ${bytes.byteLength} bytes, expected ${ARCHIVE_BYTES}`)
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== ARCHIVE_SHA256) {
    throw new Error(`archive SHA-256 mismatch\n  expected: ${ARCHIVE_SHA256}\n  got:      ${hash}`)
  }
  console.log('  archive checksum verified')
}

interface ArchiveMembers {
  corpus: Uint8Array
  queries: Uint8Array
  qrelsTest: Uint8Array
}

function extractMembers(zip: Uint8Array): ArchiveMembers {
  const files = unzipSync(zip, {
    filter: file =>
      file.name === 'scifact/corpus.jsonl' ||
      file.name === 'scifact/queries.jsonl' ||
      file.name === 'scifact/qrels/test.tsv',
  })
  const corpus = files['scifact/corpus.jsonl']
  const queries = files['scifact/queries.jsonl']
  const qrelsTest = files['scifact/qrels/test.tsv']
  if (!corpus || !queries || !qrelsTest) {
    throw new Error('archive is missing corpus.jsonl, queries.jsonl, or qrels/test.tsv')
  }
  return { corpus, queries, qrelsTest }
}

function* iterateLines(bytes: Uint8Array): Generator<string> {
  const text = Buffer.from(bytes).toString('utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    if (trimmed.length > 0) yield trimmed
  }
}

function parseCorpus(bytes: Uint8Array): ScifactDoc[] {
  const docs: ScifactDoc[] = []
  for (const line of iterateLines(bytes)) {
    const record = JSON.parse(line) as Record<string, unknown>
    const id = parseBeirId(record._id, 'corpus record')
    const title = typeof record.title === 'string' ? record.title.trim() : ''
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (title.length === 0 && text.length === 0) {
      throw new Error(`corpus record ${id} has neither title nor text`)
    }
    docs.push({ id, title, text })
  }
  return docs
}

function parseQueries(bytes: Uint8Array): ScifactQuery[] {
  const queries: ScifactQuery[] = []
  for (const line of iterateLines(bytes)) {
    const record = JSON.parse(line) as Record<string, unknown>
    const id = parseBeirId(record._id, 'query record')
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (text.length === 0) {
      throw new Error(`query record ${id} has empty text`)
    }
    queries.push({ id, text })
  }
  return queries
}

function parseQrels(bytes: Uint8Array): ScifactQrel[] {
  const lines = Array.from(iterateLines(bytes))
  if (lines[0] !== QRELS_HEADER) {
    throw new Error(`qrels file does not start with the expected header "${QRELS_HEADER}"`)
  }

  const deduped = new Map<string, ScifactQrel>()
  for (const line of lines.slice(1)) {
    const columns = line.split('\t')
    if (columns.length !== 3) {
      throw new Error(`malformed qrels line: "${line}"`)
    }
    const queryId = parseBeirId(columns[0].trim(), 'qrels query-id')
    const docId = parseBeirId(columns[1].trim(), 'qrels corpus-id')
    const relevance = Number.parseInt(columns[2].trim(), 10)
    if (!Number.isFinite(relevance) || relevance < 0) {
      throw new Error(`invalid relevance score on qrels line: "${line}"`)
    }
    const key = `${queryId}:${docId}`
    const existing = deduped.get(key)
    if (existing === undefined || relevance > existing.relevance) {
      deduped.set(key, { queryId, docId, relevance })
    }
  }
  return Array.from(deduped.values())
}

function validate(docs: ScifactDoc[], queries: ScifactQuery[], qrels: ScifactQrel[]): void {
  const docIds = new Set(docs.map(d => d.id))
  const queryIds = new Set(queries.map(q => q.id))

  if (docIds.size !== docs.length) throw new Error('corpus contains duplicate document IDs')
  if (queryIds.size !== queries.length) throw new Error('queries contain duplicate IDs')

  for (const qrel of qrels) {
    if (!docIds.has(qrel.docId)) {
      throw new Error(`qrel references unknown document ${qrel.docId}`)
    }
    if (!queryIds.has(qrel.queryId)) {
      throw new Error(`qrel references unknown query ${qrel.queryId}`)
    }
  }

  if (docs.length !== EXPECTED_DOCS) {
    throw new Error(`expected ${EXPECTED_DOCS} documents, got ${docs.length}`)
  }
  if (queries.length !== EXPECTED_QUERIES) {
    throw new Error(`expected ${EXPECTED_QUERIES} test queries, got ${queries.length}`)
  }
  if (qrels.length !== EXPECTED_QRELS) {
    throw new Error(`expected ${EXPECTED_QRELS} qrels, got ${qrels.length}`)
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  console.log(`  ${path}`)
}

async function main(): Promise<void> {
  const localZipPath = process.argv[2]
  const archive = localZipPath ? readFileSync(resolve(localZipPath)) : await downloadArchive()
  verifyArchive(archive)

  const members = extractMembers(archive)

  const docs = parseCorpus(members.corpus)
  console.log(`Parsed ${docs.length} documents`)

  const qrels = parseQrels(members.qrelsTest)
  console.log(`Parsed ${qrels.length} test qrels`)

  const judgedQueryIds = new Set(qrels.map(q => q.queryId))
  const queries = parseQueries(members.queries).filter(q => judgedQueryIds.has(q.id))
  console.log(`Kept ${queries.length} test-split queries (queries.jsonl holds every split)`)

  validate(docs, queries, qrels)
  console.log('Validation passed')

  const fixturesDir = resolve(__dirname, '..', 'src', '__tests__', 'relevance', 'fixtures')
  const dataDir = resolve(__dirname, '..', '..', '..', 'data', 'processed', 'scifact')
  mkdirSync(dataDir, { recursive: true })

  console.log('Writing test fixtures:')
  writeJson(resolve(fixturesDir, 'scifact-documents.json'), docs)
  writeJson(resolve(fixturesDir, 'scifact-queries.json'), queries)
  writeJson(resolve(fixturesDir, 'scifact-qrels.json'), qrels)

  console.log('Writing example data:')
  writeJson(resolve(dataDir, 'scifact-docs.json'), docs)
  writeJson(resolve(dataDir, 'scifact-queries.json'), queries)
  writeJson(resolve(dataDir, 'scifact-qrels.json'), qrels)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
