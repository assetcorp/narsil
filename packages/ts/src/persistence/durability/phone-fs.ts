import type { ReactNativeFileStatus, ReactNativeFiles } from '../../runtime/react-native-host'

const CURRENT_POSITION = -1

interface PhoneStats {
  size: number
  dev: string | bigint
  ino: string | bigint
  mtimeMs: number
  isDirectory(): boolean
  isFile(): boolean
}

interface PhoneDirent {
  name: string
  isDirectory(): boolean
  isFile(): boolean
}

interface WriteFileOptions {
  flag?: string
}

function errnoOf(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code
}

function statsOf(status: ReactNativeFileStatus, bigint: boolean): PhoneStats {
  return {
    size: status.size,
    dev: bigint ? BigInt(status.device) : status.device,
    ino: bigint ? BigInt(status.inode) : status.inode,
    mtimeMs: status.modifiedMs,
    isDirectory: () => status.isDirectory,
    isFile: () => status.isFile,
  }
}

function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data
}

function positionOf(position: number | null | undefined): number {
  return position === null || position === undefined || position < 0 ? CURRENT_POSITION : position
}

export function createPhoneFileHandle(files: ReactNativeFiles, descriptor: number) {
  let closed = false

  function requireOpen(): number {
    if (closed) throw Object.assign(new Error('The file handle is closed'), { code: 'EBADF' })
    return descriptor
  }

  return {
    fd: descriptor,
    async read(buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null) {
      const target = buffer.subarray(offset, offset + length)
      const bytesRead = files.read(requireOpen(), target, positionOf(position))
      return { bytesRead, buffer }
    },
    async write(buffer: Uint8Array, offset = 0, length = buffer.byteLength - offset, position?: number | null) {
      const source = buffer.subarray(offset, offset + length)
      const bytesWritten = files.write(requireOpen(), source, positionOf(position))
      return { bytesWritten, buffer }
    },
    async sync() {
      files.sync(requireOpen())
    },
    async truncate(byteLength = 0) {
      files.truncate(requireOpen(), byteLength)
    },
    async stat() {
      return statsOf(files.descriptorStatus(requireOpen()), false)
    },
    async close() {
      if (closed) return
      closed = true
      files.close(descriptor)
    },
  }
}

function readWhole(files: ReactNativeFiles, path: string): Uint8Array {
  const descriptor = files.open(path, 'r')
  try {
    const size = files.descriptorStatus(descriptor).size
    const bytes = new Uint8Array(size)
    let filled = 0
    while (filled < size) {
      const chunk = files.read(descriptor, bytes.subarray(filled), filled)
      if (chunk <= 0) break
      filled += chunk
    }
    return filled === size ? bytes : bytes.slice(0, filled)
  } finally {
    files.close(descriptor)
  }
}

function writeWhole(files: ReactNativeFiles, path: string, data: Uint8Array, flag: string): void {
  const descriptor = files.open(path, flag)
  try {
    let written = 0
    while (written < data.byteLength) {
      const chunk = files.write(descriptor, data.subarray(written), CURRENT_POSITION)
      if (chunk <= 0) throw Object.assign(new Error(`Writing ${path} made no progress`), { code: 'EIO' })
      written += chunk
    }
  } finally {
    files.close(descriptor)
  }
}

function removeTree(files: ReactNativeFiles, path: string): void {
  const status = files.pathStatus(path)
  if (!status.isDirectory) {
    files.unlink(path)
    return
  }
  for (const entry of files.readDirectory(path)) removeTree(files, `${path}/${entry.name}`)
  files.removeDirectory(path)
}

function makeDirectories(files: ReactNativeFiles, path: string, dirname: (path: string) => string): void {
  try {
    files.makeDirectory(path)
    return
  } catch (err) {
    const code = errnoOf(err)
    if (code === 'EEXIST') {
      if (files.pathStatus(path).isDirectory) return
      throw err
    }
    if (code !== 'ENOENT') throw err
  }
  const parent = dirname(path)
  if (parent === path) return
  makeDirectories(files, parent, dirname)
  try {
    files.makeDirectory(path)
  } catch (err) {
    if (errnoOf(err) !== 'EEXIST' || !files.pathStatus(path).isDirectory) throw err
  }
}

export function createPhoneFs(files: ReactNativeFiles, dirname: (path: string) => string) {
  return {
    async open(path: string, flags = 'r') {
      return createPhoneFileHandle(files, files.open(path, flags))
    },
    async mkdir(path: string, options?: { recursive?: boolean }) {
      if (options?.recursive === true) makeDirectories(files, path, dirname)
      else files.makeDirectory(path)
    },
    async readdir(path: string, options?: { withFileTypes?: boolean }) {
      const entries = files.readDirectory(path)
      if (options?.withFileTypes !== true) return entries.map(entry => entry.name)
      return entries.map(
        (entry): PhoneDirent => ({
          name: entry.name,
          isDirectory: () => entry.isDirectory,
          isFile: () => entry.isFile,
        }),
      )
    },
    async rename(from: string, to: string) {
      files.rename(from, to)
    },
    async rm(path: string, options?: { recursive?: boolean; force?: boolean }) {
      try {
        if (options?.recursive === true) removeTree(files, path)
        else files.unlink(path)
      } catch (err) {
        if (options?.force === true && errnoOf(err) === 'ENOENT') return
        throw err
      }
    },
    async stat(path: string, options?: { bigint?: boolean }) {
      return statsOf(files.pathStatus(path), options?.bigint === true)
    },
    async unlink(path: string) {
      files.unlink(path)
    },
    async link(existingPath: string, newPath: string) {
      files.link(existingPath, newPath)
    },
    async readFile(path: string, encoding?: string | { encoding?: string }) {
      const bytes = readWhole(files, path)
      const named = typeof encoding === 'string' ? encoding : encoding?.encoding
      return named === undefined ? bytes : new TextDecoder().decode(bytes)
    },
    async writeFile(path: string, data: string | Uint8Array, options?: WriteFileOptions) {
      writeWhole(files, path, bytesOf(data), options?.flag ?? 'w')
    },
  }
}
