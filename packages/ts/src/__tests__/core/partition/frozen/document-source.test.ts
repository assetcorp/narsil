import { describe, expect, it } from 'vitest'
import { encodeDocumentTableData, wrapEncodedDocumentTable } from '../../../../core/partition/frozen/document-source'

const DOCUMENTS = [
  { id: 'olive-oil', title: 'Extra virgin olive oil', tags: ['pantry', 'oil'] },
  { id: 'sea-salt', title: 'Flaky sea salt', tags: ['pantry'] },
]

describe('an encoded document table reports its resident bytes', () => {
  it('counts a decoded document once it stays resident', () => {
    const data = encodeDocumentTableData(DOCUMENTS)
    const source = wrapEncodedDocumentTable(data)
    const encodedBytes = data.blob.byteLength + data.offsets.byteLength

    expect(source.byteLength).toBe(encodedBytes)

    source.docAt(0)
    const afterFirstDecode = source.byteLength
    expect(afterFirstDecode).toBeGreaterThan(encodedBytes)

    source.docAt(0)
    expect(source.byteLength).toBe(afterFirstDecode)

    source.docAt(1)
    expect(source.byteLength).toBeGreaterThan(afterFirstDecode)
  })
})
