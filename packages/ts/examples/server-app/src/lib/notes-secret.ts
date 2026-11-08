import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_NOTES_SECRET_BYTES, OWNER_ONLY_DIRECTORY_MODE, OWNER_ONLY_FILE_MODE } from './constants.ts'
import { createSyncGrantSecret } from './sync-grant.ts'

export async function persistentNotesSecret(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
  const path = join(directory, 'notes-cookie.key')
  const temporary = join(directory, `.notes-cookie-${randomUUID()}.tmp`)
  const created = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    OWNER_ONLY_FILE_MODE,
  )
  try {
    try {
      await created.writeFile(createSyncGrantSecret())
      await created.sync()
    } finally {
      await created.close()
    }
    try {
      await link(temporary, path)
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'EEXIST') throw error
    }
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  } finally {
    await unlink(temporary)
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_NOTES_SECRET_BYTES || (stat.mode & 0o077) !== 0) {
      throw new Error('The notes signing key must be an owner-only regular file')
    }
    const secret = await file.readFile('utf8')
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('The notes signing key is invalid')
    return secret
  } finally {
    await file.close()
  }
}
