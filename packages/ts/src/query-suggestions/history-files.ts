import type { HistoryStorage } from '../persistence/durability/types'
import {
  MAX_HISTORY_FILE_BYTES,
  QUERY_HISTORY_FOLDER,
  RESTORE_STAGING_INFIX,
  RESTORED_HISTORY_FOLDER,
} from './constants'

export interface HistoryFiles {
  listUnder(prefix: string): Promise<string[]>
  read(key: string): Promise<Uint8Array | 'too-long' | null>
  write(key: string, bytes: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
}

export const BUILD_RECORD_FILE = 'build.nrsl'
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.nrsl$/
const RESTORED_FILE = /^(\d{4}-\d{2}-\d{2})-(\d{4})\.nrsl$/

export function historyFolderOf(indexName: string): string {
  return `${QUERY_HISTORY_FOLDER}/${indexName}/`
}

export function dayFileKey(indexName: string, day: string): string {
  return `${historyFolderOf(indexName)}${day}.nrsl`
}

export function restoredFileKey(indexName: string, day: string, sequence: number): string {
  return `${historyFolderOf(indexName)}${RESTORED_HISTORY_FOLDER}/${day}-${String(sequence).padStart(4, '0')}.nrsl`
}

export function buildRecordKey(indexName: string): string {
  return `${historyFolderOf(indexName)}${BUILD_RECORD_FILE}`
}

export interface HistoryFileName {
  key: string
  day: string
  restored: boolean
}

export function historyFileOf(indexName: string, key: string): HistoryFileName | null {
  const folder = historyFolderOf(indexName)
  if (!key.startsWith(folder)) return null
  const rest = key.slice(folder.length)
  const own = DAY_FILE.exec(rest)
  if (own !== null) return { key, day: own[1], restored: false }
  const restoredPrefix = `${RESTORED_HISTORY_FOLDER}/`
  if (!rest.startsWith(restoredPrefix)) return null
  const restored = RESTORED_FILE.exec(rest.slice(restoredPrefix.length))
  return restored === null ? null : { key, day: restored[1], restored: true }
}

function directoryFiles(storage: Extract<HistoryStorage, { kind: 'directory' }>): HistoryFiles {
  const { directory } = storage
  return {
    listUnder: prefix => directory.list(prefix),
    async read(key) {
      const length = (await directory.byteLength?.(key)) ?? null
      if (length !== null && length > MAX_HISTORY_FILE_BYTES) return 'too-long'
      const bytes = await directory.read(key)
      if (bytes !== null && bytes.byteLength > MAX_HISTORY_FILE_BYTES) return 'too-long'
      return bytes
    },
    write: (key, bytes) => directory.atomicWrite(key, bytes),
    remove: key => directory.remove(key),
  }
}

function adapterFiles(storage: Extract<HistoryStorage, { kind: 'adapter' }>): HistoryFiles {
  const { adapter } = storage
  return {
    listUnder: prefix => adapter.list(prefix),
    async read(key) {
      const bytes = await adapter.load(key)
      if (bytes !== null && bytes.byteLength > MAX_HISTORY_FILE_BYTES) return 'too-long'
      return bytes
    },
    write: (key, bytes) => adapter.save(key, bytes),
    remove: key => adapter.delete(key),
  }
}

function memoryFiles(): HistoryFiles {
  const files = new Map<string, Uint8Array>()
  return {
    async listUnder(prefix) {
      return [...files.keys()].filter(key => key.startsWith(prefix)).sort()
    },
    async read(key) {
      return files.get(key) ?? null
    },
    async write(key, bytes) {
      files.set(key, bytes)
    },
    async remove(key) {
      files.delete(key)
    },
  }
}

export function historyFilesOf(storage: HistoryStorage | null): HistoryFiles {
  if (storage === null) return memoryFiles()
  return storage.kind === 'directory' ? directoryFiles(storage) : adapterFiles(storage)
}

export function listHistoryFolder(files: HistoryFiles, indexName: string): Promise<string[]> {
  return files.listUnder(historyFolderOf(indexName))
}

export async function removeHistoryFolder(files: HistoryFiles, indexName: string): Promise<void> {
  for (const key of await listHistoryFolder(files, indexName)) await files.remove(key)
}

export function restoreStagingPrefix(): string {
  return `${QUERY_HISTORY_FOLDER}/${RESTORE_STAGING_INFIX}${globalThis.crypto.randomUUID()}/`
}

export async function removeRestoreLeftovers(files: HistoryFiles): Promise<void> {
  for (const key of await files.listUnder(`${QUERY_HISTORY_FOLDER}/${RESTORE_STAGING_INFIX}`)) await files.remove(key)
}
