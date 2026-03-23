import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const EXPECTED_SHA256: Record<string, string> = {
  'cran.all.1400': 'b234544b6ceccd131520df4a3cb6d42aee6576eb577933d047e722bbfe7b0b09',
  'cran.qry': '99578ceb88941ef89c14faf7c63c23776a376d8fba319b990f01d0c601d8b03f',
  cranqrel: '92e54b58dac0b980152178f350d892fae66c8a239b8a11715b835fb8d2f6bc0e',
}

const GRADE_MAP: Record<number, number> = {
  [-1]: 0,
  1: 4,
  2: 3,
  3: 2,
  4: 1,
}

interface CranfieldDoc {
  id: number
  title: string
  author: string
  body: string
}

interface CranfieldQuery {
  id: number
  text: string
}

interface CranfieldQrel {
  queryId: number
  docId: number
  relevance: number
}

function verifySha256(filePath: string, expectedHash: string): void {
  const content = readFileSync(filePath)
  const hash = createHash('sha256').update(content).digest('hex')
  if (hash !== expectedHash) {
    console.error(`SHA-256 mismatch for ${filePath}`)
    console.error(`  expected: ${expectedHash}`)
    console.error(`  got:      ${hash}`)
    process.exit(1)
  }
}

function parseDocuments(filePath: string): CranfieldDoc[] {
  const raw = readFileSync(filePath, 'utf-8')
  const docs: CranfieldDoc[] = []
  const entries = raw.split(/^\.I\s+/m).filter(s => s.trim().length > 0)

  for (const entry of entries) {
    const lines = entry.split('\n')
    const id = parseInt(lines[0].trim(), 10)

    let section = ''
    const sections: Record<string, string[]> = { T: [], A: [], B: [], W: [] }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('.T')) {
        section = 'T'
        continue
      }
      if (line.startsWith('.A')) {
        section = 'A'
        continue
      }
      if (line.startsWith('.B')) {
        section = 'B'
        continue
      }
      if (line.startsWith('.W')) {
        section = 'W'
        continue
      }
      if (section && sections[section]) {
        sections[section].push(line)
      }
    }

    const title = sections.T.join(' ').replace(/\s+/g, ' ').trim()
    const author = sections.A.join(' ').replace(/\s+/g, ' ').trim()
    const body = sections.W.join(' ').replace(/\s+/g, ' ').trim()

    if (title.length === 0 && body.length === 0) {
      console.warn(`  warning: doc ${id} has empty title and body`)
    }

    docs.push({ id, title, author, body })
  }

  return docs
}

function parseQueries(filePath: string): CranfieldQuery[] {
  const raw = readFileSync(filePath, 'utf-8')
  const queries: CranfieldQuery[] = []
  const entries = raw.split(/^\.I\s+/m).filter(s => s.trim().length > 0)

  for (let idx = 0; idx < entries.length; idx++) {
    const entry = entries[idx]
    const lines = entry.split('\n')

    let inText = false
    const textLines: string[] = []

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('.W')) {
        inText = true
        continue
      }
      if (line.startsWith('.')) {
        inText = false
        continue
      }
      if (inText) {
        textLines.push(line)
      }
    }

    const text = textLines.join(' ').replace(/\s+/g, ' ').trim()
    queries.push({ id: idx + 1, text })
  }

  return queries
}

function parseQrels(filePath: string): CranfieldQrel[] {
  const raw = readFileSync(filePath, 'utf-8')
  const deduped = new Map<string, CranfieldQrel>()

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    const parts = trimmed.split(/\s+/)
    if (parts.length < 3) {
      console.warn(`  warning: skipping malformed qrel line: "${trimmed}"`)
      continue
    }

    const queryId = parseInt(parts[0], 10)
    const docId = parseInt(parts[1], 10)
    const rawGrade = parseInt(parts[2], 10)

    const normalized = GRADE_MAP[rawGrade]
    if (normalized === undefined) {
      console.warn(`  warning: unknown relevance grade ${rawGrade} for query=${queryId} doc=${docId}`)
      continue
    }

    const key = `${queryId}:${docId}`
    const existing = deduped.get(key)
    if (existing === undefined || normalized > existing.relevance) {
      deduped.set(key, { queryId, docId, relevance: normalized })
    }
  }

  return Array.from(deduped.values())
}

function validate(docs: CranfieldDoc[], queries: CranfieldQuery[], qrels: CranfieldQrel[]): void {
  const docIds = new Set(docs.map(d => d.id))
  const queryIds = new Set(queries.map(q => q.id))

  let orphanedDocs = 0
  let orphanedQueries = 0

  for (const qrel of qrels) {
    if (!docIds.has(qrel.docId)) orphanedDocs++
    if (!queryIds.has(qrel.queryId)) orphanedQueries++
  }

  if (orphanedDocs > 0) console.warn(`  warning: ${orphanedDocs} qrels reference non-existent doc IDs`)
  if (orphanedQueries > 0) console.warn(`  warning: ${orphanedQueries} qrels reference non-existent query IDs`)

  if (docs.length !== 1400) console.warn(`  warning: expected 1400 documents, got ${docs.length}`)
  if (queries.length !== 225) console.warn(`  warning: expected 225 queries, got ${queries.length}`)
}

function main(): void {
  const rawDir = process.argv[2]
  if (!rawDir) {
    console.error('Usage: npx tsx scripts/convert-cranfield.ts <raw-dir>')
    console.error('  <raw-dir> must contain cran.all.1400, cran.qry, and cranqrel')
    process.exit(1)
  }

  const docPath = resolve(rawDir, 'cran.all.1400')
  const queryPath = resolve(rawDir, 'cran.qry')
  const qrelPath = resolve(rawDir, 'cranqrel')

  console.log('Verifying file integrity...')
  verifySha256(docPath, EXPECTED_SHA256['cran.all.1400'])
  verifySha256(queryPath, EXPECTED_SHA256['cran.qry'])
  verifySha256(qrelPath, EXPECTED_SHA256.cranqrel)
  console.log('  checksums verified')

  console.log('Parsing documents...')
  const docs = parseDocuments(docPath)
  console.log(`  ${docs.length} documents parsed`)

  console.log('Parsing queries...')
  const queries = parseQueries(queryPath)
  console.log(`  ${queries.length} queries parsed`)

  console.log('Parsing qrels...')
  const qrels = parseQrels(qrelPath)
  console.log(`  ${qrels.length} qrels parsed (after deduplication)`)

  const gradeDistribution = new Map<number, number>()
  for (const qrel of qrels) {
    gradeDistribution.set(qrel.relevance, (gradeDistribution.get(qrel.relevance) ?? 0) + 1)
  }
  console.log('  grade distribution (normalized):')
  for (const [grade, count] of [...gradeDistribution.entries()].sort((a, b) => b[0] - a[0])) {
    console.log(`    grade ${grade}: ${count}`)
  }

  console.log('Validating...')
  validate(docs, queries, qrels)

  const fixturesDir = resolve(__dirname, '..', 'src', '__tests__', 'relevance', 'fixtures')

  const docsPath = resolve(fixturesDir, 'cranfield-documents.json')
  const queriesPath = resolve(fixturesDir, 'cranfield-queries.json')
  const qrelsPath = resolve(fixturesDir, 'cranfield-qrels.json')

  writeFileSync(docsPath, JSON.stringify(docs, null, 2))
  writeFileSync(queriesPath, JSON.stringify(queries, null, 2))
  writeFileSync(qrelsPath, JSON.stringify(qrels, null, 2))

  console.log(`\nFixtures written:`)
  console.log(`  ${docsPath} (${docs.length} docs)`)
  console.log(`  ${queriesPath} (${queries.length} queries)`)
  console.log(`  ${qrelsPath} (${qrels.length} qrels)`)

  const verifyDocs = JSON.parse(readFileSync(docsPath, 'utf-8')) as CranfieldDoc[]
  const verifyQueries = JSON.parse(readFileSync(queriesPath, 'utf-8')) as CranfieldQuery[]
  const verifyQrels = JSON.parse(readFileSync(qrelsPath, 'utf-8')) as CranfieldQrel[]

  console.log(`\nVerification (re-read):`)
  console.log(`  documents: ${verifyDocs.length}`)
  console.log(`  queries: ${verifyQueries.length}`)
  console.log(`  qrels: ${verifyQrels.length}`)
}

main()
