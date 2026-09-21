import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageDirectory } from './toolchain.mjs'

const TOOLS_DIRECTORY = join(packageDirectory, '.lint-tools')
const PINNED_VERSIONS = join(packageDirectory, 'lint-requirements.in')
const LOCKED_REQUIREMENTS = join(packageDirectory, 'lint-requirements.txt')
const INSTALLED_LOCK_DIGEST = join(TOOLS_DIRECTORY, 'lint-requirements.sha256')
const ON_WINDOWS = process.platform === 'win32'
const ZIG_PACKAGE = 'ziglang'

function executable(name) {
  return join(TOOLS_DIRECTORY, ON_WINDOWS ? 'Scripts' : 'bin', ON_WINDOWS ? `${name}.exe` : name)
}

function pinnedVersions() {
  return readFileSync(PINNED_VERSIONS, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => {
      const [name, version] = line.split('==')
      return { name, version }
    })
}

function lockDigest() {
  return createHash('sha256').update(readFileSync(LOCKED_REQUIREMENTS)).digest('hex')
}

function install(digest) {
  rmSync(TOOLS_DIRECTORY, { recursive: true, force: true })
  execFileSync(ON_WINDOWS ? 'python' : 'python3', ['-m', 'venv', TOOLS_DIRECTORY], { stdio: 'inherit' })
  execFileSync(
    executable('python'),
    [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '--require-hashes',
      '--no-deps',
      '--only-binary=:all:',
      '--requirement',
      LOCKED_REQUIREMENTS,
    ],
    { stdio: 'inherit' },
  )
  writeFileSync(INSTALLED_LOCK_DIGEST, digest)
}

function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function python(args) {
  return execFileSync(executable('python'), args, { encoding: 'utf8' })
}

function reportedVersion(name) {
  if (name === ZIG_PACKAGE) return python(['-m', ZIG_PACKAGE, 'version'])
  return execFileSync(executable(name), ['--version'], { encoding: 'utf8' })
}

function checkVersion({ name, version }) {
  const reported = reportedVersion(name)
  if (!new RegExp(`(^|version )${escapeForPattern(version)}(\\s|$)`).test(reported)) {
    throw new Error(`${name} reports '${reported.trim()}', but lint-requirements.in holds version ${version}`)
  }
}

function zigLibraryDirectory() {
  return python([
    '-c',
    `import os, ${ZIG_PACKAGE}; print(os.path.join(os.path.dirname(${ZIG_PACKAGE}.__file__), 'lib'))`,
  ]).trim()
}

export function lintTools() {
  const digest = lockDigest()
  if (!existsSync(INSTALLED_LOCK_DIGEST) || readFileSync(INSTALLED_LOCK_DIGEST, 'utf8') !== digest) install(digest)
  for (const pin of pinnedVersions()) checkVersion(pin)
  return {
    clangTidy: executable('clang-tidy'),
    clangFormat: executable('clang-format'),
    windowsHeaderDirectory: join(zigLibraryDirectory(), 'libc', 'include', 'any-windows-any'),
  }
}
