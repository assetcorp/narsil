import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface CorpusDocument {
  [field: string]: unknown
  id: string
  text: string
  topic: string
}

const CORPUS_RELATIVE_PATH = '../shared/sample-data/fiqa-forum-answers.json'
const CORPUS_DOCUMENT_COUNT = 2_000
const FALLBACK_TOPIC = 'general'

const TOPIC_KEYWORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['tax', ['tax', 'irs', 'deduction', 'refund']],
  ['investing', ['invest', 'stock', 'etf', 'portfolio', 'dividend']],
  ['credit', ['credit card', 'credit score', 'fico', 'debt']],
  ['banking', ['bank', 'checking account', 'savings account', 'wire transfer']],
  ['insurance', ['insurance', 'premium', 'deductible', 'policy']],
  ['mortgage', ['mortgage', 'refinance', 'escrow', 'down payment']],
  ['business', ['llc', 'payroll', 'invoice', 'startup', 'small business']],
]

interface SourceEntry {
  id?: unknown
  text?: unknown
}

let cached: CorpusDocument[] | null = null

export function topicOf(text: string): string {
  const haystack = text.toLowerCase()
  for (const [topic, keywords] of TOPIC_KEYWORDS) {
    for (const keyword of keywords) {
      if (haystack.includes(keyword)) {
        return topic
      }
    }
  }
  return FALLBACK_TOPIC
}

export function topicNames(): string[] {
  return [...TOPIC_KEYWORDS.map(([topic]) => topic), FALLBACK_TOPIC]
}

export function loadCorpus(): CorpusDocument[] {
  if (cached !== null) {
    return cached
  }

  const path = resolve(process.cwd(), CORPUS_RELATIVE_PATH)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`The sample corpus could not be read from ${path}: ${message}`)
  }

  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error(`The sample corpus at ${path} is not an array of documents`)
  }

  const documents: CorpusDocument[] = []
  for (const entry of parsed as SourceEntry[]) {
    if (typeof entry.id !== 'string' || typeof entry.text !== 'string') {
      continue
    }
    documents.push({ id: entry.id, text: entry.text, topic: topicOf(entry.text) })
    if (documents.length === CORPUS_DOCUMENT_COUNT) {
      break
    }
  }

  cached = documents
  return documents
}
