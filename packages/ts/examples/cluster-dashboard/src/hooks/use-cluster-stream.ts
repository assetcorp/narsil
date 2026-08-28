import { useEffect, useRef, useState } from 'react'
import type { ClusterEvent } from '../lib/cluster-events'
import { diffSnapshots, mergeClusterEvents } from '../lib/cluster-events'
import type { ClusterSnapshot, StreamState } from '../lib/cluster-types'

const STREAM_PATH = '/api/cluster-stream'

export interface ClusterStream {
  snapshot: ClusterSnapshot | null
  stream: StreamState
  streamError: string | null
  events: ClusterEvent[]
}

const OBSERVER_FAILURE_TEXT = 'The dashboard could not reach the cluster coordinator'

function observerMessageOf(event: Event): string {
  if (!(event instanceof MessageEvent) || typeof event.data !== 'string') {
    return OBSERVER_FAILURE_TEXT
  }
  try {
    const parsed = JSON.parse(event.data) as { message?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : OBSERVER_FAILURE_TEXT
  } catch (_) {
    return OBSERVER_FAILURE_TEXT
  }
}

export function useClusterStream(): ClusterStream {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null)
  const [stream, setStream] = useState<StreamState>('connecting')
  const [streamError, setStreamError] = useState<string | null>(null)
  const [events, setEvents] = useState<ClusterEvent[]>([])
  const previous = useRef<ClusterSnapshot | null>(null)

  useEffect(() => {
    const source = new EventSource(STREAM_PATH)

    function markLive(): void {
      setStream('live')
      setStreamError(null)
    }

    function receiveObserverError(event: Event): void {
      setStreamError(observerMessageOf(event))
      setStream('offline')
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
      setStreamError(null)

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
    source.addEventListener('observer-error', receiveObserverError)

    return () => {
      previous.current = null
      source.removeEventListener('observer-error', receiveObserverError)
      source.close()
    }
  }, [])

  return { snapshot, stream, streamError, events }
}
