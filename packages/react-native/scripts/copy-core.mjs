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

rmSync(targetDirectory, { recursive: true, force: true })
for (const part of ['src', 'include']) {
  const from = join(coreDirectory, part)
  const to = join(targetDirectory, part)
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    if (COPIED_EXTENSIONS.some(extension => name.endsWith(extension))) cpSync(join(from, name), join(to, name))
  }
}
