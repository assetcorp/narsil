const SYNC_KEY_NUMBER_WIDTH = 16

export function syncDirectoryPrefix(indexName: string): string {
  return `${indexName}/sync/`
}

export function publishedSnapshotKey(indexName: string): string {
  return `${syncDirectoryPrefix(indexName)}published`
}

export function historyRoot(indexName: string): string {
  return `${indexName}/history/`
}

export function historyPrefix(indexName: string, partitionId: number): string {
  return `${historyRoot(indexName)}${partitionId}/`
}

export function walSegmentPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/wal/${partitionId}/`
}

export function formatSyncKeyNumber(value: number): string {
  return value.toString().padStart(SYNC_KEY_NUMBER_WIDTH, '0')
}

export function historyKey(indexName: string, partitionId: number, startSeqNo: number, movedAtMs: number): string {
  return `${historyPrefix(indexName, partitionId)}${formatSyncKeyNumber(startSeqNo)}-${formatSyncKeyNumber(movedAtMs)}`
}

export function walSegmentKey(indexName: string, partitionId: number, startSeqNo: number): string {
  return `${walSegmentPrefix(indexName, partitionId)}${formatSyncKeyNumber(startSeqNo)}`
}

export interface HistorySegment {
  key: string
  partitionId: number
  startSeqNo: number
  movedAtMs: number
}

const HISTORY_TAIL = /^(\d+)\/(\d{16})-(\d{16})$/

export function parseHistoryKey(indexName: string, key: string): HistorySegment | null {
  const root = historyRoot(indexName)
  if (!key.startsWith(root)) return null
  const match = HISTORY_TAIL.exec(key.slice(root.length))
  if (match === null) return null
  const partitionId = Number.parseInt(match[1], 10)
  const startSeqNo = Number.parseInt(match[2], 10)
  const movedAtMs = Number.parseInt(match[3], 10)
  if (!Number.isSafeInteger(partitionId) || !Number.isSafeInteger(startSeqNo) || !Number.isSafeInteger(movedAtMs)) {
    return null
  }
  return { key, partitionId, startSeqNo, movedAtMs }
}

export function parseWalSegmentStart(indexName: string, partitionId: number, key: string): number | null {
  const prefix = walSegmentPrefix(indexName, partitionId)
  if (!key.startsWith(prefix)) return null
  const tail = key.slice(prefix.length)
  if (!/^\d{16}$/.test(tail)) return null
  const value = Number.parseInt(tail, 10)
  return Number.isSafeInteger(value) ? value : null
}
