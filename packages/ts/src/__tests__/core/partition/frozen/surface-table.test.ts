import { describe, expect, it } from 'vitest'
import { createPartitionIndex } from '../../../../core/partition'
import { createSharedFrozenSegment, freezeSegmentShared } from '../../../../core/partition/frozen'
import { decodeSurfaceTable, encodeSurfaceTable } from '../../../../core/partition/frozen/surface-table'
import { getLanguage } from '../../../../languages/registry'
import { simpleSchema } from '../../partition-index/fixtures'

const english = getLanguage('english')

describe('surface forms frozen into shared memory', () => {
  it('round-trips the forms through the flat table', () => {
    const forms = { running: [3, 'run'] as [number, string], qualities: [1, 'qualiti'] as [number, string] }
    const table = encodeSurfaceTable(forms)

    expect(table.counts.length).toBe(2)
    expect(decodeSurfaceTable(table)).toEqual(forms)
  })

  it('serves suggestions from a shared segment whose forms travel as shared bytes', () => {
    const live = createPartitionIndex(0)
    const documents = [
      { id: 'a', title: 'running qualities', body: 'runners', price: 1, active: true, category: 'fruit' },
      { id: 'b', title: 'running shoes', body: 'runner', price: 2, active: false, category: 'metal' },
    ]
    for (const doc of documents) live.insert(doc.id, doc, simpleSchema, english, { collectSurfaces: true })
    const payload = live.encodeSegment()
    const snapshot = freezeSegmentShared(payload, documents)
    if (snapshot === null) throw new Error('SharedArrayBuffer is unavailable in this runtime')

    expect(snapshot.surfaceTable).not.toBeNull()
    expect(snapshot.surfaceTable?.blob.buffer).toBeInstanceOf(SharedArrayBuffer)

    const segment = createSharedFrozenSegment(snapshot)
    const candidates = segment.surfaceRegistry.candidatesForPrefix('runn')
    expect(candidates.map(candidate => candidate.surface).sort()).toEqual(['runners', 'running'])
    expect(segment.surfaceRegistry.stemChangedTotalFor('run')).toBe(2)
  })
})
