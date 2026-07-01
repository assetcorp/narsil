import { createHash } from 'node:crypto'
import type { RawCorpusDoc } from './types'

export function documentText(title: string, text: string): string {
  const t = title.trim()
  const x = text.trim()
  if (t && x) return `${t} ${x}`
  return t || x
}

export function indexableDocs(docs: RawCorpusDoc[]): RawCorpusDoc[] {
  return docs.filter(doc => documentText(doc.title, doc.text).length > 0)
}

interface FramedRecord {
  idBytes: Buffer
  bodyBytes: Buffer
}

/**
 * Corpus content identity, defined so a Python reader over the same archive
 * produces the identical hex string. Each record contributes its id and the
 * document-text rule output as length-framed UTF-8 (a 4-byte big-endian length
 * before each field), so no byte sequence inside the corpus text can forge a
 * record boundary. Records are ordered by the raw UTF-8 bytes of the id, an
 * ordering that is identical in any language regardless of Unicode collation.
 */
export function corpusFingerprint(docs: RawCorpusDoc[]): string {
  const records: FramedRecord[] = []
  for (const doc of docs) {
    const body = documentText(doc.title, doc.text)
    if (body.length === 0) continue
    records.push({ idBytes: Buffer.from(doc.id, 'utf8'), bodyBytes: Buffer.from(body, 'utf8') })
  }
  records.sort((a, b) => Buffer.compare(a.idBytes, b.idBytes))

  const hash = createHash('sha256')
  const length = Buffer.allocUnsafe(4)
  for (const record of records) {
    length.writeUInt32BE(record.idBytes.length, 0)
    hash.update(length)
    hash.update(record.idBytes)
    length.writeUInt32BE(record.bodyBytes.length, 0)
    hash.update(length)
    hash.update(record.bodyBytes)
  }
  return hash.digest('hex')
}

export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
