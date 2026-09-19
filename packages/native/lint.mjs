import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { relative } from 'node:path'
import { lintTools } from './lint-tools.mjs'
import {
  addonSources,
  buildDirectory,
  coreSources,
  formattedFiles,
  packageDirectory,
  testSource,
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

function configurations(windowsHeaderDirectory) {
  const lintedEverywhere = [
    { name: `${process.arch} kernels`, extraArguments: [] },
    { name: 'portable kernels', extraArguments: ['-DNARSIL_PORTABLE_KERNELS'] },
    ...windowsConfigurations(windowsHeaderDirectory),
  ]
  if (process.platform !== 'darwin') return lintedEverywhere
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

const { clangTidy, clangFormat, windowsHeaderDirectory } = lintTools()
writeCompileDatabase()

const lintedConfigurations = configurations(windowsHeaderDirectory)
const sources = [...coreSources(), ...addonSources(), testSource]
const jobs = lintedConfigurations.flatMap(configuration =>
  sources.map(source => ({
    label: `clang-tidy, ${configuration.name}: ${relative(packageDirectory, source)}`,
    command: clangTidy,
    args: [
      '-p',
      buildDirectory,
      '--quiet',
      ...configuration.extraArguments.map(argument => `--extra-arg=${argument}`),
      source,
    ],
  })),
)
jobs.push({
  label: 'clang-format',
  command: clangFormat,
  args: ['--dry-run', '--Werror', '--style=file', ...formattedFiles()],
})

const results = await runAll(jobs)
const failures = results.filter(result => result.code !== 0)
for (const failure of failures) {
  console.error(`\n${failure.label}\n${failure.output.trim()}`)
}
console.log(
  `\n${results.length - failures.length} of ${results.length} lint checks passed (${lintedConfigurations
    .map(configuration => configuration.name)
    .join(', ')}; clang-format over ${formattedFiles().length} files)`,
)
if (failures.length > 0) process.exit(1)
