import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export function findDataRoot(): string {
  let dir = import.meta.dirname ?? process.cwd()
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'data', 'processed')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(process.cwd(), 'data', 'processed')
}

export function safeDataPath(dataRoot: string, ...segments: string[]): string {
  const resolved = path.resolve(dataRoot, ...segments)
  if (!resolved.startsWith(dataRoot)) {
    throw new Error(`Path traversal detected: ${segments.join('/')}`)
  }
  return resolved
}

export async function readDocumentsFile(dataRoot: string, ...segments: string[]): Promise<Record<string, unknown>[]> {
  const filePath = safeDataPath(dataRoot, ...segments)
  return JSON.parse(await readFile(filePath, 'utf-8')) as Record<string, unknown>[]
}
