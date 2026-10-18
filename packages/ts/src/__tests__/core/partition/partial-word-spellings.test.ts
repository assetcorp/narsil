import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../core/partition'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import { english } from '../partition-index/fixtures'

const schema: SchemaDefinition = { title: 'string:partial', body: 'string' }

const documents: AnyDocument[] = [
  { id: 'lamp-and-bench', title: 'lamp bench', body: 'oak' },
  { id: 'lamp', title: 'lamp', body: 'pine' },
  { id: 'body-only', body: 'oak' },
]

function spellingCountsIn(title: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const word of title.flatMap(text => text.split(' '))) counts[word] = (counts[word] ?? 0) + 1
  return counts
}

describe('the spellings that a growing partition keeps for its partial fields', () => {
  it('keeps exact counts when a document without a partial-field value leaves, and when one with a value leaves', () => {
    const partition = createPartitionIndex(0)
    for (const document of documents) {
      partition.insert(String(document.id), document, schema, english, { collectSurfaces: true })
    }

    partition.remove('body-only', schema, english, { collectSurfaces: true })
    const afterBodyOnly = partition.encodeSegment().partialSpellings
    expect(afterBodyOnly).not.toBeNull()
    const countsAfterBodyOnly: Record<string, number> = {}
    afterBodyOnly?.spellings.forEach((spelling, at) => {
      countsAfterBodyOnly[spelling] = afterBodyOnly.counts[at]
    })
    expect(countsAfterBodyOnly).toEqual(spellingCountsIn(['lamp bench', 'lamp']))

    partition.remove('lamp', schema, english, { collectSurfaces: true })
    const afterLamp = partition.encodeSegment().partialSpellings
    const countsAfterLamp: Record<string, number> = {}
    afterLamp?.spellings.forEach((spelling, at) => {
      countsAfterLamp[spelling] = afterLamp.counts[at]
    })
    expect(countsAfterLamp).toEqual(spellingCountsIn(['lamp bench']))
  })
})
