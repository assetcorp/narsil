import type { FsModule, PathModule } from '#platform/durable-fs'

export async function listRecursive(dir: string, base: string, pathMod: PathModule, fs: FsModule): Promise<string[]> {
  const results: string[] = []
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as Array<{
      name: string
      isDirectory(): boolean
    }>
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return results
    }
    throw err
  }

  for (const entry of entries) {
    const full = pathMod.join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...(await listRecursive(full, base, pathMod, fs)))
    } else {
      results.push(pathMod.relative(base, full).split(pathMod.sep).join('/'))
    }
  }
  return results
}
