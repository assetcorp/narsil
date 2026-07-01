import type { BeirQuery, Qrels, RawCorpusDoc } from './types'

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function* iterateLines(bytes: Uint8Array): Generator<string> {
  const text = Buffer.from(bytes).toString('utf8')
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      const end = i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i
      if (end > start) yield text.slice(start, end)
      start = i + 1
    }
  }
  if (start < text.length) yield text.slice(start)
}

export function parseCorpus(bytes: Uint8Array): RawCorpusDoc[] {
  const docs: RawCorpusDoc[] = []
  for (const line of iterateLines(bytes)) {
    const record = JSON.parse(line) as Record<string, unknown>
    const id = record._id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`corpus record missing string "_id": ${line.slice(0, 120)}`)
    }
    docs.push({ id, title: asString(record.title), text: asString(record.text) })
  }
  return docs
}

export function parseQueries(bytes: Uint8Array): BeirQuery[] {
  const queries: BeirQuery[] = []
  for (const line of iterateLines(bytes)) {
    const record = JSON.parse(line) as Record<string, unknown>
    const id = record._id
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`query record missing string "_id": ${line.slice(0, 120)}`)
    }
    const text = asString(record.text).trim()
    if (text.length > 0) queries.push({ id, text })
  }
  return queries
}

export function parseQrels(bytes: Uint8Array): Qrels {
  const qrels: Qrels = new Map()
  for (const line of iterateLines(bytes)) {
    const columns = line.split('\t')
    if (columns.length < 3) continue
    const queryId = columns[0].trim()
    const docId = columns[1].trim()
    const relevance = Number.parseInt(columns[2].trim(), 10)
    if (queryId.length === 0 || docId.length === 0 || !Number.isFinite(relevance)) continue
    let judgments = qrels.get(queryId)
    if (judgments === undefined) {
      judgments = new Map()
      qrels.set(queryId, judgments)
    }
    judgments.set(docId, relevance)
  }
  return qrels
}

export function countJudgments(qrels: Qrels): number {
  let total = 0
  for (const judgments of qrels.values()) total += judgments.size
  return total
}

export function filterQueriesToQrels(queries: BeirQuery[], qrels: Qrels): BeirQuery[] {
  return queries.filter(query => qrels.has(query.id))
}
