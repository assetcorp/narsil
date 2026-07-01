import { closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const NUL_CHAR_CODE = 0

export interface AtomicWriteOptions {
  prettyIndent?: number
}

function containsNullByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) === NUL_CHAR_CODE) return true
  }
  return false
}

function ensureSafePath(target: string): void {
  if (typeof target !== 'string' || target.length === 0) {
    throw new TypeError('atomic-write: target path must be a non-empty string')
  }
  if (containsNullByte(target)) {
    throw new TypeError('atomic-write: target path contains a null byte')
  }
  const parent = dirname(target)
  if (parent.length === 0) {
    throw new TypeError('atomic-write: target path has no parent directory')
  }
}

function buildTempPath(target: string): string {
  const resolved = resolve(target)
  const suffix = `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString(36)}`
  return `${resolved}${suffix}`
}

function writeAllSync(fd: number, payload: Uint8Array): void {
  let offset = 0
  while (offset < payload.byteLength) {
    const written = writeSync(fd, payload, offset, payload.byteLength - offset, null)
    if (written <= 0) {
      throw new Error('atomic-write: writeSync reported zero bytes written')
    }
    offset += written
  }
}

function writeBytesAtomicSync(target: string, payload: Uint8Array): void {
  ensureSafePath(target)
  const tempPath = buildTempPath(target)

  let fd: number | null = null
  try {
    fd = openSync(tempPath, 'w', 0o644)
    writeAllSync(fd, payload)
    fsyncSync(fd)
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /*
         * closeSync errors after a successful fsync do not indicate data loss.
         * The rename below is what makes the write visible to readers.
         */
      }
    }
  }

  renameSync(tempPath, target)
}

export function writeJsonAtomicSync<T>(target: string, value: T, options: AtomicWriteOptions = {}): void {
  const indent = options.prettyIndent ?? 2
  const serialized = JSON.stringify(value, null, indent)
  if (typeof serialized !== 'string') {
    throw new TypeError('atomic-write: value did not serialize to JSON (likely circular or BigInt)')
  }
  writeBytesAtomicSync(target, new TextEncoder().encode(serialized))
}

export function writeTextAtomicSync(target: string, text: string): void {
  if (typeof text !== 'string') {
    throw new TypeError('atomic-write: text must be a string')
  }
  writeBytesAtomicSync(target, new TextEncoder().encode(text))
}
