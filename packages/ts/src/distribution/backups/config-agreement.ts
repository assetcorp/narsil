import { decodeIndexConfiguration } from '../../engine/snapshot/index-configuration-decode'
import { ErrorCodes, NarsilError } from '../../errors'
import { isRecord } from '../payload-guards'
import type { BackupPartitionResult } from '../transport/backup-payloads'
import { loadCheckedBytes } from './files'
import type { StoredFile } from './manifest'
import type { BackupStore } from './store'

function isNil(value: unknown): boolean {
  return value === null || value === undefined
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let at = 0; at < left.byteLength; at++) {
    if (left[at] !== right[at]) return false
  }
  return true
}

function pushMembers(
  pending: Array<[unknown, unknown]>,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  for (const key of Object.keys(left)) pending.push([left[key], right[key]])
  for (const key of Object.keys(right)) {
    if (!Object.hasOwn(left, key)) pending.push([undefined, right[key]])
  }
}

function sameDecodedValue(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]]
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [a, b] = pair
    if (a === b || (isNil(a) && isNil(b))) continue
    if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) continue
    if (a instanceof Uint8Array || b instanceof Uint8Array) {
      if (a instanceof Uint8Array && b instanceof Uint8Array && sameBytes(a, b)) continue
      return false
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
      for (let at = 0; at < a.length; at++) pending.push([a[at], b[at]])
      continue
    }
    if (!isRecord(a) || !isRecord(b)) return false
    pushMembers(pending, a, b)
  }
  return true
}

function settingsChanged(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.ANALYSIS_CHANGE_NOT_READY,
    `The settings of index '${indexName}' changed while its partitions were backed up, so the backup stores no manifest`,
    { indexName },
  )
}

export async function agreedConfigOf(
  store: BackupStore,
  results: readonly BackupPartitionResult[],
  indexName: string,
  backupName: string,
): Promise<StoredFile> {
  const [first] = results
  if (first === undefined) throw settingsChanged(indexName)
  const distinct = new Map<string, StoredFile>()
  for (const result of results) {
    if (result.config.sha256 !== first.config.sha256) distinct.set(result.config.sha256, result.config)
  }
  if (distinct.size === 0) return first.config
  const decodedFirst = await decodeIndexConfiguration(await loadCheckedBytes(store, first.config, backupName))
  for (const config of distinct.values()) {
    const decoded = await decodeIndexConfiguration(await loadCheckedBytes(store, config, backupName))
    if (!sameDecodedValue(decodedFirst, decoded)) throw settingsChanged(indexName)
  }
  return first.config
}
