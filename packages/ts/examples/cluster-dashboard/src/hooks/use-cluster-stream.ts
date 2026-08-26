import { useEffect, useRef, useState } from 'react'
import type { ClusterEvent } from '../lib/cluster-events'
import { diffSnapshots, mergeClusterEvents } from '../lib/cluster-events'
import type { ClusterSnapshot } from '../lib/cluster-types'

export type StreamState = 'connecting' | 'live' | 'offline'

const STREAM_PATH = '/api/cluster-stream'

export interface ClusterStream {
  snapshot: ClusterSnapshot | null
  stream: StreamState
  events: ClusterEvent[]
}

export function useClusterStream(): ClusterStream {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null)
  const [stream, setStream] = useState<StreamState>('connecting')
  const [events, setEvents] = useState<ClusterEvent[]>([])
  const previous = useRef<ClusterSnapshot | null>(null)

  useEffect(() => {
    const source = new EventSource(STREAM_PATH)

    function markLive(): void {
      setStream('live')
    }

    function markOffline(): void {
      setStream('offline')
    }

    function receive(message: MessageEvent<string>): void {
      let next: ClusterSnapshot
      try {
        next = JSON.parse(message.data) as ClusterSnapshot
      } catch (_) {
        return
      }

      const before = previous.current
      previous.current = next
      setSnapshot(next)
      setStream('live')

      if (before === null) {
        return
      }
      const fresh = diffSnapshots(before, next)
      if (fresh.length === 0) {
        return
      }
      setEvents(current => mergeClusterEvents(current, fresh))
    }

    source.onopen = markLive
    source.onmessage = receive
    source.onerror = markOffline

    return () => {
      previous.current = null
      source.close()
    }
  }, [])

  return { snapshot, stream, events }
}
