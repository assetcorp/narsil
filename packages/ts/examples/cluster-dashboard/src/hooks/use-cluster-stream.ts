import { useEffect, useState } from 'react'
import type { ClusterSnapshot } from '../lib/cluster-types'

export type StreamState = 'connecting' | 'live' | 'offline'

const STREAM_PATH = '/api/cluster-stream'

export function useClusterStream(): { snapshot: ClusterSnapshot | null; stream: StreamState } {
  const [snapshot, setSnapshot] = useState<ClusterSnapshot | null>(null)
  const [stream, setStream] = useState<StreamState>('connecting')

  useEffect(() => {
    const source = new EventSource(STREAM_PATH)

    source.onopen = () => {
      setStream('live')
    }

    source.onmessage = event => {
      try {
        setSnapshot(JSON.parse(event.data) as ClusterSnapshot)
        setStream('live')
      } catch (_) {}
    }

    source.onerror = () => {
      setStream('offline')
    }

    return () => {
      source.close()
    }
  }, [])

  return { snapshot, stream }
}
