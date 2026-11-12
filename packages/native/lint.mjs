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

function requestedPart(given) {
  if (given.length === 0) return { part: 1, parts: 1 }
  const match = given.length === 1 ? /^([1-9]\d*)\/([1-9]\d*)$/.exec(given[0]) : null
  if (!match || Number(match[1]) > Number(match[2])) {
    console.error(
      `lint.mjs takes at most one argument, a part such as 1/2 whose number is at most the number of parts, and it received ${JSON.stringify(given)}.`,
    )
    process.exit(2)
  }
  return { part: Number(match[1]), parts: Number(match[2]) }
}

const { part, parts } = requestedPart(process.argv.slice(2))
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
const jobs = [
  ...lintedConfigurations.flatMap(configuration => sources.map(source => tidyJob(configuration, source))),
  ...fuzzConfigurations.flatMap(configuration => fuzzSources().map(source => tidyJob(configuration, source))),
]
jobs.push({
  label: 'clang-format',
  command: clangFormat,
  args: ['--dry-run', '--Werror', '--style=file', ...formattedFiles()],
})

const selectedJobs = jobs.filter((_, index) => index % parts === part - 1)
const formatting = selectedJobs.some(job => job.command === clangFormat)
const results = await runAll(selectedJobs)
const failures = results.filter(result => result.code !== 0)
for (const failure of failures) {
  console.error(`\n${failure.label}\n${failure.output.trim()}`)
}
console.log(
  `\n${results.length - failures.length} of ${results.length} lint checks passed in part ${part} of ${parts} (${lintedConfigurations
    .map(configuration => configuration.name)
    .join(', ')}${formatting ? `; clang-format over ${formattedFiles().length} files` : ''})`,
)
if (failures.length > 0) process.exit(1)
