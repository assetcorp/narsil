import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isJsonObject, type Json, type JsonObject } from '../forms/json'
import { SAMPLES_ROOT } from '../samples/catalog'
import type { CaseBuild, FileBuild } from './build'

const INDEX = 'products'
const EXPORT = 'files/document-export/products.jsonl'
const RULE = 'durability.md#document-export'
const ID_RULE = 'envelope.md#documents'
const DOC_VALIDATION_FAILED = 'DOC_VALIDATION_FAILED'
const DAMAGED_LINE = 2
const LONGEST_LINE_BYTES = 117_443_592
const LONGEST_ID_UNITS = 512
const SAFE_SECONDS_PAST_RANGE = 9_007_199_254_740_992
const NANOSECONDS_PAST_RANGE = 1_000_000_000
const LINE_FEED = '\n'

interface ExportLines {
  header: JsonObject
  documents: string[]
}

async function exportLines(): Promise<ExportLines> {
  const text = await readFile(join(SAMPLES_ROOT, EXPORT), 'utf8')
  const [header, ...documents] = text.split(LINE_FEED).filter(line => line !== '')
  const parsed: Json = JSON.parse(header ?? '')
  if (!isJsonObject(parsed)) throw new Error(`${EXPORT} begins with no header object`)
  return { header: parsed, documents }
}

function exportText(header: JsonObject, documents: readonly string[]): Uint8Array {
  return new TextEncoder().encode([JSON.stringify(header), ...documents].map(line => `${line}${LINE_FEED}`).join(''))
}

function firstDocument(lines: ExportLines): JsonObject {
  const parsed: Json = JSON.parse(lines.documents[0] ?? '')
  if (!isJsonObject(parsed)) throw new Error(`${EXPORT} holds no document line`)
  return parsed
}

function lineCase(name: string, rule: string, lines: ExportLines, change: (document: JsonObject) => void): FileBuild {
  const document = firstDocument(lines)
  change(document)
  const documents = [JSON.stringify(document), ...lines.documents.slice(1)]
  return {
    open: 'export',
    name,
    rule,
    index: INDEX,
    bytes: exportText(lines.header, documents),
    gzip: false,
    code: DOC_VALIDATION_FAILED,
    line: { line: DAMAGED_LINE, imported: lines.documents.length - 1 },
  }
}

function tagCase(name: string, lines: ExportLines, tag: JsonObject): FileBuild {
  return lineCase(name, RULE, lines, document => {
    const notes = document.notes
    if (!isJsonObject(notes)) throw new Error(`the first document of ${EXPORT} holds no notes object`)
    notes.extra = tag
  })
}

function longestLine(lines: ExportLines): FileBuild {
  const [first, ...rest] = lines.documents
  if (first === undefined || !first.startsWith('{')) throw new Error(`${EXPORT} holds no document line`)
  const padding = LONGEST_LINE_BYTES - new TextEncoder().encode(first).byteLength
  return {
    open: 'export',
    name: 'export-line-at-the-longest-length',
    rule: RULE,
    index: INDEX,
    bytes: exportText(lines.header, [`{${' '.repeat(padding)}${first.slice(1)}`, ...rest]),
    gzip: true,
    code: null,
  }
}

export async function exportCases(): Promise<CaseBuild[]> {
  const lines = await exportLines()
  return [
    {
      open: 'export',
      name: 'export-header-version',
      rule: RULE,
      index: INDEX,
      bytes: exportText({ ...lines.header, version: 2 }, lines.documents),
      gzip: false,
      code: 'CONFIG_INVALID',
    },
    tagCase('export-tag-unknown', lines, { $when: 1 }),
    tagCase('export-date-not-two-integers', lines, { $date: [1, 0, 0] }),
    tagCase('export-date-seconds-out-of-range', lines, { $date: [SAFE_SECONDS_PAST_RANGE, 0] }),
    tagCase('export-date-nanoseconds-out-of-range', lines, { $date: [0, NANOSECONDS_PAST_RANGE] }),
    tagCase('export-bytes-not-canonical', lines, { $bytes: 'AP9=' }),
    tagCase('export-number-text', lines, { $number: 'nan' }),
    tagCase('export-object-not-an-object', lines, { $object: [1] }),
    lineCase('export-id-empty', ID_RULE, lines, document => {
      document.id = ''
    }),
    lineCase('export-id-too-long', ID_RULE, lines, document => {
      document.id = 'p'.repeat(LONGEST_ID_UNITS + 1)
    }),
    lineCase('export-id-lone-surrogate', ID_RULE, lines, document => {
      document.id = 'product-\ud800'
    }),
    longestLine(lines),
  ]
}
