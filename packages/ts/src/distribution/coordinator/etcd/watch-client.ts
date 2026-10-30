import type { Etcd3 as Etcd3Client } from 'etcd3'

export interface ReplaceableWatchClient {
  current(): Etcd3Client
  replace(stale: Etcd3Client): void
  close(): void
}

export function createReplaceableWatchClient(open: () => Etcd3Client): ReplaceableWatchClient {
  let client = open()
  let closed = false
  return {
    current: () => client,
    replace(stale) {
      if (closed || stale !== client) return
      client = open()
      stale.close()
    },
    close() {
      closed = true
      client.close()
    },
  }
}
