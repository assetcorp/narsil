import { type Dirent, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import type { Narsil } from '../../../narsil'

const LOG_FILE = /\/wal\/\d+\/\d{16}$/
const HISTORY_FILE = /\/history\/\d+\/\d{16}-\d{16}$/
const REWRITE_ABOVE_SHARE = 0.2

function filesUnder(path: string): string[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) files.push(...filesUnder(full))
    else files.push(full)
  }
  return files
}

function sizeOf(files: readonly string[]): number {
  let total = 0
  for (const file of files) total += statSync(file).size
  return total
}

export function checkpointFileBytes(directory: string, indexName: string): number {
  return sizeOf(filesUnder(join(directory, indexName, 'segments')))
}

export function partitionCheckpointFileBytes(directory: string, indexName: string, partitionId: number): number {
  return sizeOf(filesUnder(join(directory, indexName, 'segments', String(partitionId))))
}

export function logFileBytes(directory: string, indexName: string): number {
  return sizeOf(filesUnder(join(directory, indexName)).filter(file => LOG_FILE.test(file) || HISTORY_FILE.test(file)))
}

export function partitionLogFileBytes(directory: string, indexName: string, partitionId: number): number {
  const logs = filesUnder(join(directory, indexName, 'wal', String(partitionId))).filter(file => LOG_FILE.test(file))
  const history = filesUnder(join(directory, indexName, 'history', String(partitionId))).filter(file =>
    HISTORY_FILE.test(file),
  )
  return sizeOf([...logs, ...history])
}

export function bodyOf(seed: number, length: number): string {
  const words = ['river', 'stone', 'cloud', 'ember', 'forest', 'harbour', 'lantern', 'meadow', 'orbit', 'quarry']
  const parts: string[] = ['shared']
  let state = seed + 1
  let size = 0
  while (size < length) {
    state = (state * 1103515245 + 12345) % 2147483648
    const word = `${words[state % words.length]}${state % 997}`
    parts.push(word)
    size += word.length + 1
  }
  return parts.join(' ')
}

export function savedBytesAllowedFor(liveDocuments: number, bytesPerDocument: number): number {
  return Math.ceil((liveDocuments / (1 - REWRITE_ABOVE_SHARE)) * bytesPerDocument * 1.1)
}

export type FileMatch = 'exact' | 'listedWithinTheFiles'

export async function expectFiguresMatchTheFiles(
  engine: Narsil,
  directory: string,
  indexName: string,
  match: FileMatch = 'exact',
): Promise<void> {
  const stats = engine.getStats(indexName)
  const onDisk = checkpointFileBytes(directory, indexName)
  if (match === 'exact') expect(stats.savedBytes).toBe(onDisk)
  else expect(stats.savedBytes).toBeLessThanOrEqual(onDisk)
  expect(stats.logBytes).toBe(logFileBytes(directory, indexName))
  const partitions = engine.getPartitionStats(indexName)
  for (const partition of partitions) {
    const partitionOnDisk = partitionCheckpointFileBytes(directory, indexName, partition.partitionId)
    if (match === 'exact') expect(partition.savedBytes).toBe(partitionOnDisk)
    else expect(partition.savedBytes).toBeLessThanOrEqual(partitionOnDisk)
  }
  const partitionLogBytes = partitions.reduce((total, partition) => total + (partition.logBytes ?? 0), 0)
  expect(partitionLogBytes).toBe(stats.logBytes)
}

export async function expectDocumentsOf(
  engine: Narsil,
  indexName: string,
  expected: ReadonlyMap<string, string>,
  removed: Iterable<string>,
): Promise<void> {
  expect(await engine.countDocuments(indexName)).toBe(expected.size)
  const found = await engine.query(indexName, { term: 'shared', limit: expected.size + 100 })
  expect(new Set(found.hits.map(hit => hit.id))).toEqual(new Set(expected.keys()))
  for (const [docId, body] of expected) {
    const document = await engine.get(indexName, docId)
    expect(document?.body).toBe(body)
  }
  for (const docId of removed) {
    if (!expected.has(docId)) expect(await engine.get(indexName, docId)).toBeUndefined()
  }
}
