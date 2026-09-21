import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  addonSources,
  CORE_FLAGS,
  coreSources,
  LANGUAGE_FLAGS,
  NODE_API_FLAGS,
  nodeApiHeaderDirectory,
  POSITION_INDEPENDENT_FLAGS,
  packageDirectory,
  WINDOWS_NODE_API_FLAGS,
  warningFlags,
  writeCompileDatabase,
} from './toolchain.mjs'

const platformPackagesDirectory = join(packageDirectory, 'npm')
const BINARY_NAME = 'narsil-core.node'

const TARGETS = {
  'darwin-arm64': { package: 'darwin-arm64', appleArchitecture: 'arm64' },
  'darwin-x64': { package: 'darwin-x64', appleArchitecture: 'x86_64' },
  'linux-arm64': { package: 'linux-arm64', zigTriple: 'aarch64-linux-gnu' },
  'linux-arm64-musl': { package: 'linux-arm64', libcDirectory: 'musl', zigTriple: 'aarch64-linux-musl' },
  'linux-x64': { package: 'linux-x64', zigTriple: 'x86_64-linux-gnu' },
  'linux-x64-musl': { package: 'linux-x64', libcDirectory: 'musl', zigTriple: 'x86_64-linux-musl' },
  'win32-arm64': { package: 'win32-arm64', zigTriple: 'aarch64-windows-gnu', windows: true },
  'win32-x64': { package: 'win32-x64', zigTriple: 'x86_64-windows-gnu', windows: true },
}

function hostTarget() {
  const pair = `${process.platform}-${process.arch}`
  if (process.platform !== 'linux') return pair
  return process.report.getReport().header.glibcVersionRuntime ? pair : `${pair}-musl`
}

function compilerFor(target, useHostCompiler) {
  if (target.appleArchitecture) {
    return { command: 'cc', prefix: ['-arch', target.appleArchitecture], linkFlags: ['-undefined', 'dynamic_lookup'] }
  }
  if (useHostCompiler) return { command: 'cc', prefix: [], linkFlags: [] }
  return { command: 'zig', prefix: ['cc', '-target', target.zigTriple], linkFlags: [] }
}

function commandFor(target, outputPath, useHostCompiler) {
  const { command, prefix, linkFlags } = compilerFor(target, useHostCompiler)
  const args = [
    ...prefix,
    ...linkFlags,
    ...LANGUAGE_FLAGS,
    ...CORE_FLAGS,
    ...(target.windows ? [] : POSITION_INDEPENDENT_FLAGS),
    ...NODE_API_FLAGS,
    ...(target.windows ? WINDOWS_NODE_API_FLAGS : []),
    ...warningFlags(command, prefix),
    '-shared',
    '-isystem',
    nodeApiHeaderDirectory(),
    '-o',
    outputPath,
    ...coreSources(),
    ...addonSources(),
  ]
  return { command, args }
}

const flags = process.argv.slice(2).filter(argument => argument.startsWith('--'))
const requested = process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? hostTarget()
const target = TARGETS[requested]
if (!target) {
  console.error(`build.mjs has no target called ${requested}. The targets are ${Object.keys(TARGETS).join(', ')}.`)
  process.exit(2)
}

const outputDirectory = join(platformPackagesDirectory, target.package, target.libcDirectory ?? '')
mkdirSync(outputDirectory, { recursive: true })
const outputPath = join(outputDirectory, BINARY_NAME)
const { command, args } = commandFor(target, outputPath, flags.includes('--host-compiler'))

try {
  execFileSync(command, args, { stdio: 'inherit' })
} catch (err) {
  console.error(`The compiler failed to build the native search core for ${requested}: ${err.message}`)
  process.exit(1)
}

if (requested === hostTarget()) writeCompileDatabase()
console.log(`build.mjs wrote the native search core to ${outputPath}`)
