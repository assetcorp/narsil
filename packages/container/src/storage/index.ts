import { constants as bufferConstants } from 'node:buffer'
import { constants } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCodes, NarsilError, type PersistenceAdapter } from '@delali/narsil'
import { createFilesystemPersistence } from '@delali/narsil/adapters/filesystem'

const MAX_UTF8_BYTES_PER_UTF16_UNIT = 3
const LARGEST_WRITABLE_RECORD_BYTES = MAX_UTF8_BYTES_PER_UTF16_UNIT * bufferConstants.MAX_STRING_LENGTH

function requireFilename(key: string): void {
  if (key.length === 0 || key === '.' || key === '..' || /[/\\\0]/.test(key)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'A record key must be a filename')
  }
}

export function createRecordPersistence(directory: string): PersistenceAdapter {
  const files = createFilesystemPersistence({ directory })
  return {
    async save(key, data) {
      requireFilename(key)
      await files.save(key, data)
    },
    async delete(key) {
      requireFilename(key)
      await files.delete(key)
    },
    async list(prefix) {
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.filter(entry => !entry.isDirectory() && entry.name.startsWith(prefix)).map(entry => entry.name)
    },
    async load(key) {
      requireFilename(key)
      const handle = await open(join(directory, key), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > LARGEST_WRITABLE_RECORD_BYTES) return null
        const bytes = new Uint8Array(stat.size)
        let offset = 0
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
          if (bytesRead === 0) return null
          offset += bytesRead
        }
        return bytes
      } finally {
        await handle.close()
      }
    },
  }
}
