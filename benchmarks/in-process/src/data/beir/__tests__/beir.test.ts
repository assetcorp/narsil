import { strToU8, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { extractEntries } from '../archive'
import { corpusFingerprint, documentText, indexableDocs, sha256Hex } from '../fingerprint'
import { assertManifestMatches } from '../manifest'
import { countJudgments, filterQueriesToQrels, parseCorpus, parseQrels, parseQueries } from '../parse'
import { DOCUMENT_TEXT_RULE, FINGERPRINT_ALGORITHM } from '../registry'
import type { BeirManifest, RawCorpusDoc } from '../types'

function corpusLine(id: string, title: string, text: string): string {
  return JSON.stringify({ _id: id, title, text, metadata: {} })
}

function queryLine(id: string, text: string): string {
  return JSON.stringify({ _id: id, text, metadata: {} })
}

function buildScifactZip(): Uint8Array {
  const corpus = [
    corpusLine('4983', 'White matter imaging', 'A line scan diffusion-weighted MRI sequence.'),
    corpusLine('5836', 'Cardiac output', 'Measurement of cardiac output in preterm infants.'),
    corpusLine('empty-title', '', 'A document body carrying only text.'),
  ].join('\n')
  const queries = [
    queryLine('1', '0-dimensional biomaterials lack inductive properties.'),
    queryLine('3', 'Cardiac output rises after birth.'),
    queryLine('999', 'An unjudged query never scored against qrels.'),
  ].join('\n')
  const qrels = ['query-id\tcorpus-id\tscore', '1\t4983\t1', '3\t5836\t2', '3\t4983\t0'].join('\n')
  return zipSync({
    'scifact/corpus.jsonl': strToU8(corpus),
    'scifact/queries.jsonl': strToU8(queries),
    'scifact/qrels/test.tsv': strToU8(qrels),
    'scifact/qrels/train.tsv': strToU8('query-id\tcorpus-id\tscore\n7\t5836\t1'),
  })
}

describe('documentText', () => {
  it('joins a trimmed title and text with a single space', () => {
    expect(documentText('  Title  ', '  Body  ')).toBe('Title Body')
  })

  it('returns the non-empty side alone when one field is blank', () => {
    expect(documentText('', ' Body ')).toBe('Body')
    expect(documentText(' Title ', '   ')).toBe('Title')
  })

  it('returns an empty string when both fields are blank', () => {
    expect(documentText('   ', '')).toBe('')
  })
})

describe('corpusFingerprint', () => {
  const docs: RawCorpusDoc[] = [
    { id: 'b', title: 'Two', text: 'second' },
    { id: 'a', title: 'One', text: 'first' },
  ]

  it('is independent of input order', () => {
    const reversed = [...docs].reverse()
    expect(corpusFingerprint(docs)).toBe(corpusFingerprint(reversed))
  })

  it('changes when any document body changes', () => {
    const mutated: RawCorpusDoc[] = [docs[0], { ...docs[1], text: 'first!' }]
    expect(corpusFingerprint(mutated)).not.toBe(corpusFingerprint(docs))
  })

  it('changes when an id changes', () => {
    const mutated: RawCorpusDoc[] = [docs[0], { ...docs[1], id: 'a2' }]
    expect(corpusFingerprint(mutated)).not.toBe(corpusFingerprint(docs))
  })

  it('ignores documents that reduce to an empty body', () => {
    const withEmpty: RawCorpusDoc[] = [...docs, { id: 'z', title: '  ', text: '' }]
    expect(corpusFingerprint(withEmpty)).toBe(corpusFingerprint(docs))
  })

  it('is a 64-character hex digest', () => {
    expect(corpusFingerprint(docs)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('archive extraction and parsing', () => {
  const zip = buildScifactZip()

  it('extracts only the expected members', () => {
    const entries = extractEntries(zip, 'scifact')
    expect(entries.corpus.length).toBeGreaterThan(0)
    expect(entries.queries.length).toBeGreaterThan(0)
    expect(entries.qrelsTest.length).toBeGreaterThan(0)
  })

  it('throws when a required member is missing', () => {
    const partial = zipSync({ 'scifact/corpus.jsonl': strToU8('{}') })
    expect(() => extractEntries(partial, 'scifact')).toThrow(/missing expected members/)
  })

  it('parses the corpus into raw documents', () => {
    const entries = extractEntries(zip, 'scifact')
    const docs = parseCorpus(entries.corpus)
    expect(docs).toHaveLength(3)
    expect(docs[0]).toEqual({
      id: '4983',
      title: 'White matter imaging',
      text: 'A line scan diffusion-weighted MRI sequence.',
    })
    expect(docs[2].title).toBe('')
  })

  it('keeps every document whose body is non-empty', () => {
    const entries = extractEntries(zip, 'scifact')
    expect(indexableDocs(parseCorpus(entries.corpus))).toHaveLength(3)
  })

  it('skips the qrels header and non-integer rows', () => {
    const entries = extractEntries(zip, 'scifact')
    const qrels = parseQrels(entries.qrelsTest)
    expect(qrels.has('query-id')).toBe(false)
    expect(qrels.get('1')?.get('4983')).toBe(1)
    expect(qrels.get('3')?.get('5836')).toBe(2)
    expect(qrels.get('3')?.get('4983')).toBe(0)
    expect(countJudgments(qrels)).toBe(3)
  })

  it('keeps only queries that carry test judgments', () => {
    const entries = extractEntries(zip, 'scifact')
    const qrels = parseQrels(entries.qrelsTest)
    const queries = filterQueriesToQrels(parseQueries(entries.queries), qrels)
    expect(queries.map(query => query.id).sort()).toEqual(['1', '3'])
  })
})

describe('assertManifestMatches', () => {
  const base: BeirManifest = {
    name: 'scifact',
    source: 'https://example.test/scifact.zip',
    license: 'CC BY-NC 2.0',
    archiveBytes: 100,
    archiveSha256: 'a'.repeat(64),
    counts: { documents: 3, queries: 2, qrels: 3 },
    corpusFingerprint: 'b'.repeat(64),
    documentTextRule: DOCUMENT_TEXT_RULE,
    fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
  }

  it('passes when the pin matches', () => {
    expect(() => assertManifestMatches(base, base)).not.toThrow()
  })

  it('reports a fingerprint mismatch', () => {
    const drifted: BeirManifest = { ...base, corpusFingerprint: 'c'.repeat(64) }
    expect(() => assertManifestMatches(base, drifted)).toThrow(/corpus fingerprint/)
  })

  it('reports a document-count mismatch', () => {
    const drifted: BeirManifest = { ...base, counts: { ...base.counts, documents: 4 } }
    expect(() => assertManifestMatches(base, drifted)).toThrow(/document count/)
  })
})

describe('end-to-end pipeline over a synthetic archive', () => {
  it('produces stable counts, fingerprint, and a matching regenerated pin', () => {
    const zip = buildScifactZip()
    const entries = extractEntries(zip, 'scifact')
    const corpus = indexableDocs(parseCorpus(entries.corpus))
    const qrels = parseQrels(entries.qrelsTest)
    const queries = filterQueriesToQrels(parseQueries(entries.queries), qrels)

    const manifest: BeirManifest = {
      name: 'scifact',
      source: 'https://example.test/scifact.zip',
      license: 'CC BY-NC 2.0',
      archiveBytes: zip.length,
      archiveSha256: sha256Hex(zip),
      counts: { documents: corpus.length, queries: queries.length, qrels: countJudgments(qrels) },
      corpusFingerprint: corpusFingerprint(corpus),
      documentTextRule: DOCUMENT_TEXT_RULE,
      fingerprintAlgorithm: FINGERPRINT_ALGORITHM,
    }

    expect(manifest.counts).toEqual({ documents: 3, queries: 2, qrels: 3 })
    expect(() => assertManifestMatches(manifest, manifest)).not.toThrow()
  })
})
