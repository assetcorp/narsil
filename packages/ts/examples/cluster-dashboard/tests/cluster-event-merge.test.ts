import { describe, expect, it } from 'vitest'
import type { ClusterEvent } from '../src/lib/cluster-events'
import { CLUSTER_EVENT_LIMIT, mergeClusterEvents } from '../src/lib/cluster-events'

function event(id: string): ClusterEvent {
  return { id, at: '2026-08-24T10:00:00.000Z', kind: 'node', text: `node ${id} joined` }
}

describe('adding the newest cluster events to the list on screen', () => {
  it('puts the newest event at the top', () => {
    const merged = mergeClusterEvents([event('older')], [event('new-first'), event('new-second')])

    expect(merged.map(entry => entry.id)).toEqual(['new-second', 'new-first', 'older'])
  })

  it('gives the same list when React runs the update twice over one batch', () => {
    const fresh = [event('new-first'), event('new-second')]

    const once = mergeClusterEvents([event('older')], fresh)
    const twice = mergeClusterEvents([event('older')], fresh)

    expect(twice.map(entry => entry.id)).toEqual(once.map(entry => entry.id))
  })

  it('keeps the list at the limit the dashboard shows', () => {
    const current = Array.from({ length: CLUSTER_EVENT_LIMIT }, (_, index) => event(`old-${index}`))

    const merged = mergeClusterEvents(current, [event('newest')])

    expect(merged).toHaveLength(CLUSTER_EVENT_LIMIT)
    expect(merged[0].id).toBe('newest')
  })
})
