import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))

export const TS_PACKAGE_DIR = resolve(scriptDirectory, '..', '..')
export const NATIVE_PACKAGE_DIR = resolve(TS_PACKAGE_DIR, '..', 'native')
export const NATIVE_LANGUAGES_DIR = join(NATIVE_PACKAGE_DIR, 'src', 'languages')
export const TS_LANGUAGES_DIR = join(TS_PACKAGE_DIR, 'src', 'languages')
