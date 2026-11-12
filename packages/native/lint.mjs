import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { relative } from 'node:path'
import { lintTools } from './lint-tools.mjs'
import {
  addonSources,
  buildDirectory,
  formattedFiles,
  fuzzSources,
  lintedCoreSources,
  packageDirectory,
  testSources,
  WINDOWS_NODE_API_FLAGS,
  writeCompileDatabase,
} from './toolchain.mjs'

const APPLE_ARCHITECTURES = { arm64: 'arm64', x64: 'x86_64' }
const WINDOWS_TRIPLES = { 'win32-arm64': 'aarch64-w64-windows-gnu', 'win32-x64': 'x86_64-w64-windows-gnu' }

function windowsConfigurations(windowsHeaderDirectory) {
  return Object.entries(WINDOWS_TRIPLES).map(([target, triple]) => ({
    name: `${target} kernels`,
    extraArguments: [
      `--target=${triple}`,
      '-nostdlibinc',
      `-isystem${windowsHeaderDirectory}`,
      ...WINDOWS_NODE_API_FLAGS,
    ],
  }))
}

function macosConfigurations(darwinHeaderDirectory) {
  const headers = ['-nostdlibinc', `-idirafter${darwinHeaderDirectory}`]
  return [
    ...Object.entries(APPLE_ARCHITECTURES).map(([arch, appleName]) => ({
      name: `macOS ${arch} kernels`,
      extraArguments: [`--target=${appleName}-apple-macos`, ...headers],
    })),
    {
      name: 'macOS portable kernels',
      extraArguments: [`--target=${APPLE_ARCHITECTURES.arm64}-apple-macos`, '-DNARSIL_PORTABLE_KERNELS', ...headers],
    },
  ]
}

function configurations(windowsHeaderDirectory, crossLintedMacos) {
  const lintedEverywhere = [
    { name: `${process.arch} kernels`, extraArguments: [] },
    { name: 'portable kernels', extraArguments: ['-DNARSIL_PORTABLE_KERNELS'] },
    ...windowsConfigurations(windowsHeaderDirectory),
  ]
  if (process.platform !== 'darwin') return [...lintedEverywhere, ...crossLintedMacos]
  const otherArchitectures = Object.entries(APPLE_ARCHITECTURES).filter(([arch]) => arch !== process.arch)
  return [
    ...lintedEverywhere,
    ...otherArchitectures.map(([arch, appleName]) => ({
      name: `${arch} kernels`,
      extraArguments: [`--target=${appleName}-apple-macos`],
    })),
  ]
}

function run(command, args) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: packageDirectory })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.stderr.on('data', chunk => {
      output += chunk
    })
    child.on('error', error => resolve({ code: 1, output: `${output}${error.message}\n` }))
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

async function runAll(jobs) {
  const results = new Array(jobs.length)
  let next = 0
  async function worker() {
    for (;;) {
      const index = next++
      if (index >= jobs.length) return
      results[index] = { ...jobs[index], ...(await run(jobs[index].command, jobs[index].args)) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(availableParallelism(), jobs.length) }, worker))
  return results
}

function requestedShard(args) {
  const shardArguments = args.filter(argument => argument.startsWith('--shard='))
  if (shardArguments.length === 0) return { index: 1, count: 1 }
  const match = shardArguments.length === 1 ? /^--shard=([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(shardArguments[0]) : null
  const index = match ? Number(match[1]) : 0
  const count = match ? Number(match[2]) : 0
  if (index < 1 || index > count) {
    throw new Error(`Pass one --shard=<index>/<count> with 1 <= index <= count, not ${shardArguments.join(' ')}`)
  }
  return { index, count }
}

const shard = requestedShard(process.argv.slice(2))
const { clangTidy, clangFormat, windowsHeaderDirectory, darwinHeaderDirectory } = lintTools()
writeCompileDatabase()

function tidyJob(configuration, source) {
  return {
    label: `clang-tidy, ${configuration.name}: ${relative(packageDirectory, source)}`,
    command: clangTidy,
    args: [
      '-p',
      buildDirectory,
      '--quiet',
      ...configuration.extraArguments.map(argument => `--extra-arg=${argument}`),
      source,
    ],
  }
}

const crossLintedMacos = process.platform === 'darwin' ? [] : macosConfigurations(darwinHeaderDirectory)
const lintedConfigurations = configurations(windowsHeaderDirectory, crossLintedMacos)
const [hostConfiguration] = lintedConfigurations
const fuzzConfigurations = [hostConfiguration, ...crossLintedMacos.slice(0, 1)]
const sources = [...lintedCoreSources(), ...addonSources(), ...testSources()]
const everyTidyJob = [
  ...lintedConfigurations.flatMap(configuration => sources.map(source => tidyJob(configuration, source))),
  ...fuzzConfigurations.flatMap(configuration => fuzzSources().map(source => tidyJob(configuration, source))),
]
const jobs = everyTidyJob.filter((_, position) => position % shard.count === shard.index - 1)
const checksFormatting = shard.index === 1
if (checksFormatting) {
  jobs.push({
    label: 'clang-format',
    command: clangFormat,
    args: ['--dry-run', '--Werror', '--style=file', ...formattedFiles()],
  })
}

const results = await runAll(jobs)
const failures = results.filter(result => result.code !== 0)
for (const failure of failures) {
  console.error(`\n${failure.label}\n${failure.output.trim()}`)
}
const shardDescription =
  shard.count === 1 ? '' : `, part ${shard.index} of ${shard.count} of ${everyTidyJob.length} clang-tidy checks`
const formattingDescription = checksFormatting ? `; clang-format over ${formattedFiles().length} files` : ''
console.log(
  `\n${results.length - failures.length} of ${results.length} lint checks passed (${lintedConfigurations
    .map(configuration => configuration.name)
    .join(', ')}${shardDescription}${formattingDescription})`,
)
if (failures.length > 0) process.exit(1)
