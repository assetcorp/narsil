import { describe, expect, it } from 'vitest'
import { applyPinning } from '../../search/pinning'
import type { Hit } from '../../types/results'

function makeHit(id: string, score: number): Hit<Record<string, unknown>> {
  return { id, score, document: { title: `Doc ${id}` } }
}

function makeResolver(docs: Array<Hit<Record<string, unknown>>>) {
  const map = new Map(docs.map(d => [d.id, d]))
  return (docId: string) => map.get(docId)
}

describe('pinning', () => {
  it('pins a document at position 0', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8), makeHit('c', 5)]
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([...hits, pinnedDoc])

    const result = applyPinning(hits, [{ docId: 'x', position: 0 }], resolver)
    expect(result[0].id).toBe('x')
    expect(result).toHaveLength(4)
  })

  it('pins a document in the middle', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8), makeHit('c', 5)]
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([...hits, pinnedDoc])

    const result = applyPinning(hits, [{ docId: 'x', position: 1 }], resolver)
    expect(result[1].id).toBe('x')
    expect(result).toHaveLength(4)
  })

  it('pins a document at the end', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8)]
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([...hits, pinnedDoc])

    const result = applyPinning(hits, [{ docId: 'x', position: 2 }], resolver)
    expect(result[2].id).toBe('x')
    expect(result).toHaveLength(3)
  })

  it('clamps position beyond array length to the end', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8)]
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([...hits, pinnedDoc])

    const result = applyPinning(hits, [{ docId: 'x', position: 100 }], resolver)
    expect(result[result.length - 1].id).toBe('x')
    expect(result).toHaveLength(3)
  })

  it('treats negative position as 0', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8)]
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([...hits, pinnedDoc])

    const result = applyPinning(hits, [{ docId: 'x', position: -5 }], resolver)
    expect(result[0].id).toBe('x')
  })

  it('moves a doc already in results without duplicating', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8), makeHit('c', 5)]
    const resolver = makeResolver(hits)

    const result = applyPinning(hits, [{ docId: 'c', position: 0 }], resolver)
    expect(result[0].id).toBe('c')
    expect(result).toHaveLength(3)
    expect(result.filter(h => h.id === 'c')).toHaveLength(1)
  })

  it('skips a pinned doc that does not exist', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8)]
    const resolver = makeResolver(hits)

    const result = applyPinning(hits, [{ docId: 'missing', position: 0 }], resolver)
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('a')
  })

  it('handles multiple pins in the correct order', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8), makeHit('c', 5)]
    const pin1 = makeHit('x', 0)
    const pin2 = makeHit('y', 0)
    const resolver = makeResolver([...hits, pin1, pin2])

    const result = applyPinning(
      hits,
      [
        { docId: 'y', position: 2 },
        { docId: 'x', position: 0 },
      ],
      resolver,
    )

    expect(result[0].id).toBe('x')
    expect(result.find(h => h.id === 'y')).toBeDefined()
    expect(result).toHaveLength(5)
  })

  it('handles empty hits with pins', () => {
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([pinnedDoc])

    const result = applyPinning([], [{ docId: 'x', position: 0 }], resolver)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('x')
  })

  it('handles empty hits with no pins', () => {
    const result = applyPinning([], [], () => undefined)
    expect(result).toHaveLength(0)
  })

  it('does not mutate the original hits array', () => {
    const hits = [makeHit('a', 10), makeHit('b', 8)]
    const pinnedDoc = makeHit('x', 0)
    const resolver = makeResolver([...hits, pinnedDoc])

    applyPinning(hits, [{ docId: 'x', position: 0 }], resolver)
    expect(hits).toHaveLength(2)
    expect(hits[0].id).toBe('a')
  })
})
