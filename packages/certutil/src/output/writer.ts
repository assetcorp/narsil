import { access, mkdir, open, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const OWNER_ONLY_FILE_MODE = 0o600
const PATH_SEPARATOR_OR_NUL = /[/\\\0]/

export function isSafeFileName(name: string): boolean {
  return name !== '.' && name !== '..' && !PATH_SEPARATOR_OR_NUL.test(name)
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

export async function ensureDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function prepareToWrite(filePath: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    const exists = await fileExists(filePath)
    if (exists) {
      throw new Error(`File already exists: ${filePath}. Use --force to overwrite.`)
    }
  }

  await ensureDirectory(dirname(filePath))
}

export async function writeOutputFile(filePath: string, content: string, overwrite: boolean): Promise<void> {
  await prepareToWrite(filePath, overwrite)
  await writeFile(filePath, content, 'utf-8')
}

export async function writePrivateFile(
  filePath: string,
  content: string | Uint8Array,
  overwrite: boolean,
): Promise<void> {
  await prepareToWrite(filePath, overwrite)
  const handle = await open(filePath, 'w', OWNER_ONLY_FILE_MODE)
  try {
    await handle.chmod(OWNER_ONLY_FILE_MODE)
    await handle.writeFile(content)
  } finally {
    await handle.close()
  }
}
