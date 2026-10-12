import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ErrorCodes, NarsilError } from '../../errors'
import { crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'
import { SNAPSHOT_CHUNK_SIZE } from './constants'

const SPOOL_FILE_PREFIX = 'narsil-snapshot-'
const DURABLE_SPOOL_DIRECTORY = '.snapshot-transfer'
const TEMPORARY_SPOOL_DIRECTORY_PREFIX = 'narsil-snapshot-transfer-'
const OWNER_ONLY_FILE_MODE = 0o600
const OWNER_ONLY_DIRECTORY_MODE = 0o700

export interface SpooledSnapshot {
  readonly totalBytes: number
  readonly checksum: number
  read(): AsyncGenerator<Uint8Array>
  discard(): Promise<void>
}

export interface SnapshotSpoolWriter {
  write(bytes: Uint8Array): void
  checksum(): number
  finish(): SpooledSnapshot
  discard(): void
}

export interface SnapshotSpoolDirectory {
  readonly path: string
  dispose(): Promise<void>
}

export function defaultSpoolDirectory(): string {
  return tmpdir()
}

function spoolFilePath(directory: string): string {
  return join(directory, `${SPOOL_FILE_PREFIX}${randomUUID()}`)
}

async function* readSpoolFile(path: string): AsyncGenerator<Uint8Array> {
  const descriptor = openSync(path, 'r')
  try {
    for (;;) {
      const buffer = new Uint8Array(SNAPSHOT_CHUNK_SIZE)
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) return
      yield bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead)
    }
  } finally {
    closeSync(descriptor)
  }
}

function spooledFile(path: string, totalBytes: number, checksum: number): SpooledSnapshot {
  let discarded = false
  return {
    totalBytes,
    checksum,
    read: () => readSpoolFile(path),
    async discard(): Promise<void> {
      if (discarded) return
      discarded = true
      removeQuietly(path)
    },
  }
}

export function openSnapshotSpoolWriter(directory: string): SnapshotSpoolWriter {
  const path = spoolFilePath(directory)
  let descriptor: number | null = openSync(path, 'wx', OWNER_ONLY_FILE_MODE)
  let checksumState = crc32Init()
  let totalBytes = 0
  const close = (): void => {
    if (descriptor === null) return
    const closing = descriptor
    descriptor = null
    closeSync(closing)
  }
  return {
    write(bytes: Uint8Array): void {
      if (descriptor === null) {
        throw new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, 'The snapshot spool file is already closed', {
          path,
        })
      }
      let offset = 0
      while (offset < bytes.byteLength) {
        offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset)
      }
      checksumState = crc32Update(checksumState, bytes)
      totalBytes += bytes.byteLength
    },
    checksum(): number {
      return crc32Final(checksumState)
    },
    finish(): SpooledSnapshot {
      close()
      return spooledFile(path, totalBytes, crc32Final(checksumState))
    },
    discard(): void {
      try {
        close()
      } finally {
        removeQuietly(path)
      }
    },
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch (_) {}
}

export async function spoolSnapshotStream(
  directory: string,
  stream: ReadableStream<Uint8Array>,
): Promise<SpooledSnapshot> {
  const reader = stream.getReader()
  let writer: SnapshotSpoolWriter | null = null
  try {
    writer = openSnapshotSpoolWriter(directory)
    for (;;) {
      const step = await reader.read()
      if (step.done) break
      if (step.value.byteLength > 0) writer.write(step.value)
    }
    const spooled = writer.finish()
    writer = null
    return spooled
  } catch (err) {
    writer?.discard()
    await reader.cancel().catch(() => undefined)
    throw err
  } finally {
    reader.releaseLock()
  }
}

export async function openSnapshotSpoolDirectory(
  durabilityDirectory: string | undefined,
): Promise<SnapshotSpoolDirectory> {
  const path =
    durabilityDirectory === undefined
      ? await mkdtemp(join(tmpdir(), TEMPORARY_SPOOL_DIRECTORY_PREFIX))
      : join(durabilityDirectory, DURABLE_SPOOL_DIRECTORY)
  if (durabilityDirectory !== undefined) {
    await rm(path, { recursive: true, force: true })
    await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
  }
  return { path, dispose: () => rm(path, { recursive: true, force: true }) }
}
