import { describe, expect, it } from 'vitest'
import { applyProjection, cloneProjected, resolveProjection } from '../../core/projection'
import type { AnyDocument } from '../../types/schema'
import type { DocumentProjection } from '../../types/search'

function storedDocument(): Record<string, unknown> {
  return {
    title: 'gravity waves',
    body: 'the long text field a reader searches',
    tags: ['physics', 'waves'],
    author: { name: 'ama', contact: { email: 'ama@example.com', phone: '0800' } },
    embedding: [0.1, 0.2, 0.3, 0.4],
  }
}

const PROJECTIONS: DocumentProjection[] = [
  true,
  false,
  {},
  { include: ['title'] },
  { include: ['title', 'author.name'] },
  { include: ['author'] },
  { include: ['author.contact.email'] },
  { include: ['missing'] },
  { include: ['tags.0'] },
  { include: ['title.length'] },
  { exclude: ['embedding'] },
  { exclude: ['author'] },
  { exclude: ['author.contact.email'] },
  { exclude: ['missing'] },
  { exclude: ['tags.0'] },
  { exclude: ['title.length'] },
  { include: ['author'], exclude: ['author.contact'] },
  { include: ['author.contact'], exclude: ['author'] },
  { include: ['title', 'author'], exclude: ['author.contact.phone'] },
  { include: ['__proto__.polluted'] },
  { exclude: ['__proto__'] },
]

describe('a projected copy of a stored document', () => {
  it.each(PROJECTIONS)('holds what a full copy cut down to the projection holds: %j', projection => {
    const resolved = resolveProjection(projection)
    const stored = storedDocument()

    const projected = cloneProjected(stored, resolved)

    expect(projected).toEqual(applyProjection(structuredClone(stored) as AnyDocument, resolved))
  })

  it('copies every field where the caller leaves the projection out', () => {
    const stored = storedDocument()

    expect(cloneProjected(stored)).toEqual(stored)
  })

  it('reads no field the projection drops', () => {
    let embeddingReads = 0
    const stored: Record<string, unknown> = {
      title: 'gravity waves',
      get embedding() {
        embeddingReads++
        return [0.1, 0.2, 0.3, 0.4]
      },
    }

    cloneProjected(stored, resolveProjection({ exclude: ['embedding'] }))
    cloneProjected(stored, resolveProjection({ include: ['title'] }))
    cloneProjected(stored, resolveProjection(false))

    expect(embeddingReads).toBe(0)
  })

  it('reads a field the projection keeps', () => {
    let embeddingReads = 0
    const stored: Record<string, unknown> = {
      title: 'gravity waves',
      get embedding() {
        embeddingReads++
        return [0.1, 0.2, 0.3, 0.4]
      },
    }

    const projected = cloneProjected(stored, resolveProjection({ include: ['embedding'] }))

    expect(projected).toEqual({ embedding: [0.1, 0.2, 0.3, 0.4] })
    expect(embeddingReads).toBe(1)
  })

  it('shares no nested object with the stored document', () => {
    const stored = storedDocument()

    const projected = cloneProjected(stored, resolveProjection({ include: ['author'] }))
    const author = projected.author as { name: string; contact: { email: string } }
    author.name = 'someone else'
    author.contact.email = 'elsewhere@example.com'

    expect(stored.author).toEqual({ name: 'ama', contact: { email: 'ama@example.com', phone: '0800' } })
  })

  it('shares no nested object with the stored document where the projection only excludes', () => {
    const stored = storedDocument()

    const projected = cloneProjected(stored, resolveProjection({ exclude: ['author.contact.phone'] }))
    const author = projected.author as { name: string; contact: { email: string } }
    author.name = 'someone else'
    author.contact.email = 'elsewhere@example.com'
    ;(projected.tags as string[]).push('extra')

    expect(stored.author).toEqual({ name: 'ama', contact: { email: 'ama@example.com', phone: '0800' } })
    expect(stored.tags).toEqual(['physics', 'waves'])
  })

  it('returns an empty document where the projection keeps nothing', () => {
    expect(cloneProjected(storedDocument(), resolveProjection(false))).toEqual({})
  })

  it('keeps nothing where an included path names an inherited property', () => {
    expect(cloneProjected(storedDocument(), resolveProjection({ include: ['toString'] }))).toEqual({})
  })

  it('keeps nothing where an included path walks through an inherited property', () => {
    expect(cloneProjected(storedDocument(), resolveProjection({ include: ['constructor.name'] }))).toEqual({})
  })

  it('copies nothing inherited where the projection only excludes', () => {
    const projected = cloneProjected(storedDocument(), resolveProjection({ exclude: ['embedding'] }))

    expect(Object.hasOwn(projected, 'toString')).toBe(false)
  })

  it('leaves an inherited property out of a document another node sent', () => {
    const document: AnyDocument = { title: 'gravity waves' }

    expect(applyProjection(document, resolveProjection({ include: ['toString'] }))).toEqual({})
  })
})
