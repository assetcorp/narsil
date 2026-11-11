import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const coreDirectory = join(packageDirectory, '..', 'native')
const targetDirectory = join(packageDirectory, 'cpp', 'core')
const COPIED_EXTENSIONS = ['.c', '.h']

if (!existsSync(join(coreDirectory, 'include', 'narsil_core.h'))) {
  console.error(`copy-core.mjs finds no search core at ${coreDirectory}, so it cannot copy the C sources.`)
  process.exit(1)
}

function copySources(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copySources(join(from, entry.name), join(to, entry.name))
    } else if (entry.isFile() && COPIED_EXTENSIONS.some(extension => entry.name.endsWith(extension))) {
      cpSync(join(from, entry.name), join(to, entry.name))
    }
  }
}

rmSync(targetDirectory, { recursive: true, force: true })
for (const part of ['src', 'include']) copySources(join(coreDirectory, part), join(targetDirectory, part))
