import { useEffect, useRef, useState } from 'react'
import type { ClusterEvent } from '../lib/cluster-events'
import { diffSnapshots } from '../lib/cluster-events'
import type { ClusterSnapshot } from '../lib/cluster-types'

const EVENT_LIMIT = 100

export function useClusterEvents(snapshot: ClusterSnapshot | null): ClusterEvent[] {
  const [events, setEvents] = useState<ClusterEvent[]>([])
  const previous = useRef<ClusterSnapshot | null>(null)

  useEffect(() => {
    if (snapshot === null) {
      return
    }
    const before = previous.current
    previous.current = snapshot
    if (before === null) {
      return
    }
    const fresh = diffSnapshots(before, snapshot)
    if (fresh.length === 0) {
      return
    }
    setEvents(current => [...fresh.reverse(), ...current].slice(0, EVENT_LIMIT))
  }, [snapshot])

  return events
}
