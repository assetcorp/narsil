import { describe, expect, it } from 'vitest'
import { encodeDocumentTableData, wrapEncodedDocumentTable } from '../../../../core/partition/frozen/document-source'

const DOCUMENTS = [
  { id: 'olive-oil', title: 'Extra virgin olive oil', tags: ['pantry', 'oil'] },
  { id: 'sea-salt', title: 'Flaky sea salt', tags: ['pantry'] },
]

describe('an encoded document table reports its resident bytes', () => {
  it('holds only its encoded bytes and hands every read its own copy', () => {
    const data = encodeDocumentTableData(DOCUMENTS)
    const source = wrapEncodedDocumentTable(data)
    const encodedBytes = data.blob.byteLength + data.offsets.byteLength

    expect(source.byteLength).toBe(encodedBytes)

    const first = source.docAt(0)
    const second = source.docAt(0)
    expect(first).toEqual(DOCUMENTS[0])
    expect(second).toEqual(DOCUMENTS[0])
    expect(second).not.toBe(first)
    ;(first.tags as string[]).push('changed by the caller')
    expect(source.docAt(0)).toEqual(DOCUMENTS[0])

    expect(source.docAt(1)).toEqual(DOCUMENTS[1])
    expect(source.byteLength).toBe(encodedBytes)
  })
})
