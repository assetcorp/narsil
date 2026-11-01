import { INDEX_NAME_PATTERN, MAX_INDEX_NAME_LENGTH } from '../../engine/constants'
import { ErrorCodes, NarsilError } from '../../errors'
import type { DurableDirectory } from './durable-filesystem'
import { manifestKey } from './segment/layout'
import { manifestFileRefs } from './segment/manifest'
import { decodeSegmentManifest } from './segment/manifest-decode'
import { sha256 } from './sha256'

export const RESTORE_JOURNAL_PREFIX = '.swap-'
export const RESTORE_STAGING_PREFIX = '.restore-'
export const RETIRED_INDEX_PREFIX = '.retired-'
const LOCK_FILE_KEY = '.narsil.lock'
const STAGING_PREFIX_PATTERN = /^\.[A-Za-z0-9][A-Za-z0-9._-]*\/$/

export interface RestoreStorage {
  read(key: string): Promise<Uint8Array | null>
  write(key: string, chunks: readonly Uint8Array[]): Promise<void>
  writeJournal(key: string, bytes: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
  moveKey(from: string, to: string): Promise<void>
  moveTree?(from: string, to: string): Promise<void>
  removeTree?(prefix: string): Promise<void>
  pathOf?(key: string): Promise<string>
  directory?: DurableDirectory
}

function digestOf(indexName: string): string {
  let hex = ''
  for (const byte of sha256(new TextEncoder().encode(indexName))) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export function journalKey(indexName: string): string {
  return `${RESTORE_JOURNAL_PREFIX}${digestOf(indexName)}`
}

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

export function newStagingPrefix(): string {
  return `${RESTORE_STAGING_PREFIX}${randomSuffix()}/`
}

function newRetiredPrefix(): string {
  return `${RETIRED_INDEX_PREFIX}${randomSuffix()}/`
}

export function encodeJournal(indexName: string, stagingPrefix: string): Uint8Array {
  return new TextEncoder().encode(`${indexName}\n${stagingPrefix}`)
}

function isStagingPrefix(prefix: string): boolean {
  return STAGING_PREFIX_PATTERN.test(prefix) && !prefix.includes('..')
}

function corruptJournal(key: string, reason: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The restore journal "${key}" ${reason}`, { key })
}

export type JournalReading = { kind: 'leftover' } | { kind: 'journal'; indexName: string; stagingPrefix: string }

export function readJournal(key: string, bytes: Uint8Array): JournalReading {
  const text = new TextDecoder().decode(bytes)
  const lineEnd = text.indexOf('\n')
  const indexName = lineEnd === -1 ? text : text.slice(0, lineEnd)
  if (key.slice(RESTORE_JOURNAL_PREFIX.length) !== digestOf(indexName)) return { kind: 'leftover' }
  if (indexName.length > MAX_INDEX_NAME_LENGTH || !INDEX_NAME_PATTERN.test(indexName) || indexName.includes('..')) {
    corruptJournal(key, 'names an index that no index name can match')
  }
  const stagingPrefix = lineEnd === -1 ? '' : text.slice(lineEnd + 1)
  if (!isStagingPrefix(stagingPrefix) || stagingPrefix === `${LOCK_FILE_KEY}/`) {
    corruptJournal(key, 'names no staging prefix that a restore writes')
  }
  return { kind: 'journal', indexName, stagingPrefix }
}

async function listedKeys(storage: RestoreStorage, indexName: string, stagingPrefix: string): Promise<Set<string>> {
  const manifestBytes = (await storage.read(`${stagingPrefix}manifest`)) ?? (await storage.read(manifestKey(indexName)))
  if (manifestBytes === null) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The restore of index "${indexName}" lost its manifest, both from staging and from the index`,
      { indexName, stagingPrefix },
    )
  }
  const decoded = await decodeSegmentManifest(manifestBytes, indexName)
  if (decoded.kind !== 'current') {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The restore of index "${indexName}" staged a manifest in the layout of an earlier release`,
      { indexName },
    )
  }
  const root = `${indexName}/`
  const keys = new Set(['meta', 'manifest'])
  for (const ref of manifestFileRefs(decoded.manifest)) keys.add(ref.key.slice(root.length))
  return keys
}

function withoutTrailingSlash(prefix: string): string {
  return prefix.slice(0, -1)
}

export async function finishJournal(
  storage: RestoreStorage,
  indexName: string,
  stagingPrefix: string,
): Promise<string | null> {
  const root = `${indexName}/`
  const listed = await listedKeys(storage, indexName, stagingPrefix)
  const staged = await storage.list(stagingPrefix)
  let retiredPrefix: string | null = null
  if (storage.moveTree !== undefined && staged.length > 0) {
    retiredPrefix = newRetiredPrefix()
    await storage.moveTree(indexName, withoutTrailingSlash(retiredPrefix))
    await storage.moveTree(withoutTrailingSlash(stagingPrefix), indexName)
  } else {
    const stagedKeys = new Set(staged)
    for (const key of listed) {
      if (stagedKeys.has(`${stagingPrefix}${key}`)) await storage.moveKey(`${stagingPrefix}${key}`, `${root}${key}`)
    }
  }
  for (const key of await storage.list(root)) {
    if (!listed.has(key.slice(root.length))) await storage.remove(key)
  }
  await storage.remove(journalKey(indexName))
  return retiredPrefix
}

export async function removePrefix(storage: RestoreStorage, prefix: string): Promise<void> {
  if (storage.removeTree !== undefined) {
    await storage.removeTree(prefix)
    return
  }
  for (const key of await storage.list(prefix)) await storage.remove(key)
}

export async function commitJournal(storage: RestoreStorage, indexName: string, stagingPrefix: string): Promise<void> {
  await storage.writeJournal(journalKey(indexName), encodeJournal(indexName, stagingPrefix))
}

function isTopLevelJournal(key: string): boolean {
  return key.startsWith(RESTORE_JOURNAL_PREFIX) && !key.includes('/')
}

export async function removeStagingPrefixes(storage: RestoreStorage): Promise<void> {
  const prefixes = new Set<string>()
  for (const key of await storage.list('.')) {
    const slash = key.indexOf('/')
    if (slash !== -1 && isStagingPrefix(key.slice(0, slash + 1))) prefixes.add(key.slice(0, slash + 1))
  }
  for (const prefix of prefixes) await removePrefix(storage, prefix)
}

export async function recoverRestoreJournals(storage: RestoreStorage): Promise<void> {
  for (const key of await storage.list(RESTORE_JOURNAL_PREFIX)) {
    if (!isTopLevelJournal(key)) continue
    const bytes = await storage.read(key)
    if (bytes === null) continue
    const reading = readJournal(key, bytes)
    if (reading.kind === 'leftover') {
      await storage.remove(key)
      continue
    }
    await finishJournal(storage, reading.indexName, reading.stagingPrefix)
  }
  await removeStagingPrefixes(storage)
}
