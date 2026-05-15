import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

export async function writeOutputFile(filePath: string, content: string, overwrite: boolean): Promise<void> {
  if (!overwrite) {
    const exists = await fileExists(filePath)
    if (exists) {
      throw new Error(`File already exists: ${filePath}. Use --force to overwrite.`)
    }
  }

  await ensureDirectory(dirname(filePath))
  await writeFile(filePath, content, 'utf-8')
}
