import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  BUILD_ROOT,
  GO_RUNNER_ROOT,
  NATIVE_PACKAGES_ROOT,
  REPOSITORY_ROOT,
  RUST_CRATE_ROOT,
  RUST_RUNNER_BINARY,
  RUST_RUNNER_MANIFEST,
  SUITE_ROOT,
  TYPESCRIPT_PACKAGE_ROOT,
  TYPESCRIPT_RUNNER,
} from '../paths'
import type { EngineName } from '../runner-output'
import { sha256OfFile, type WorkloadKind } from '../workload/format'
import { firstLineOf, runCommand } from './commands'

export interface EngineIdentity {
  package: string
  version: string
  runtime: string
  build: string
}

export interface EngineSpec {
  name: EngineName
  command: string
  args(workload: string, kind: WorkloadKind, threads: number, output: string): string[]
  cwd: string
  env: NodeJS.ProcessEnv
  identity: EngineIdentity
}

const GO_RUNNER_BINARY = 'narsil-engine-languages-go-runner'
const NATIVE_CORE_FILE = 'narsil-core.node'

function cargoTargetDirectory(): string {
  const named = process.env.CARGO_TARGET_DIR
  return named !== undefined && named.length > 0 ? named : resolve(BUILD_ROOT, 'cargo-target')
}

function rustCrateVersion(): string {
  const manifest = readFileSync(resolve(RUST_CRATE_ROOT, 'Cargo.toml'), 'utf-8')
  return /^version = "([^"]+)"$/m.exec(manifest)?.[1] ?? 'unknown'
}

function typescriptPackageVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(TYPESCRIPT_PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
    version?: string
  }
  return manifest.version ?? 'unknown'
}

async function typescriptEngine(): Promise<EngineSpec> {
  if (!existsSync(resolve(TYPESCRIPT_PACKAGE_ROOT, 'dist', 'index.mjs'))) {
    throw new Error('packages/ts/dist is missing; run `pnpm nx run narsil-ts:build` before the benchmark')
  }
  const target = `${process.platform}-${process.arch}`
  const core = resolve(NATIVE_PACKAGES_ROOT, target, NATIVE_CORE_FILE)
  if (!existsSync(core)) {
    throw new Error(
      `${core} is missing; run \`pnpm --filter @delali/narsil-native-build build\` so that Node.js searches on the C core`,
    )
  }
  return {
    name: 'typescript',
    command: process.execPath,
    args: (workload, kind, threads, output) => [
      '--expose-gc',
      '--import',
      'tsx',
      TYPESCRIPT_RUNNER,
      workload,
      kind,
      String(threads),
      output,
    ],
    cwd: SUITE_ROOT,
    env: {
      ...process.env,
      NARSIL_REQUIRE_NATIVE_CORE: '1',
      NARSIL_SEARCH_BACKEND: 'native',
      NARSIL_NATIVE_CORE_PATH: core,
    },
    identity: {
      package: '@delali/narsil',
      version: typescriptPackageVersion(),
      runtime: `Node.js ${process.version}`,
      build: `C core ${NATIVE_CORE_FILE} sha256 ${await sha256OfFile(core)}`,
    },
  }
}

async function rustEngine(): Promise<EngineSpec> {
  const targetDirectory = cargoTargetDirectory()
  const env = { ...process.env, CARGO_TARGET_DIR: targetDirectory }
  await runCommand('cargo', ['build', '--release', '--locked', '--manifest-path', RUST_RUNNER_MANIFEST], {
    cwd: RUST_CRATE_ROOT,
    env,
  })
  return {
    name: 'rust',
    command: resolve(targetDirectory, 'release', RUST_RUNNER_BINARY),
    args: (workload, kind, threads, output) => [workload, kind, String(threads), output],
    cwd: SUITE_ROOT,
    env: process.env,
    identity: {
      package: 'delali-narsil',
      version: rustCrateVersion(),
      runtime: await firstLineOf('rustc', ['--version'], RUST_CRATE_ROOT),
      build: 'cargo build --release',
    },
  }
}

async function goEngine(): Promise<EngineSpec> {
  mkdirSync(BUILD_ROOT, { recursive: true })
  const binary = resolve(BUILD_ROOT, GO_RUNNER_BINARY)
  await runCommand('go', ['build', '-trimpath', '-o', binary, '.'], {
    cwd: GO_RUNNER_ROOT,
    env: { ...process.env, CGO_ENABLED: '1' },
  })
  return {
    name: 'go',
    command: binary,
    args: (workload, kind, threads, output) => [workload, kind, String(threads), output],
    cwd: SUITE_ROOT,
    env: process.env,
    identity: {
      package: 'github.com/assetcorp/narsil/packages/go/engine',
      version: 'source in this repository',
      runtime: await firstLineOf('go', ['version'], GO_RUNNER_ROOT),
      build: 'go build -trimpath',
    },
  }
}

const BUILDERS: Record<EngineName, () => Promise<EngineSpec>> = {
  typescript: typescriptEngine,
  rust: rustEngine,
  go: goEngine,
}

export async function prepareEngines(names: readonly EngineName[]): Promise<Map<EngineName, EngineSpec>> {
  const specs = new Map<EngineName, EngineSpec>()
  for (const name of names) {
    console.log(`Building the ${name} runner`)
    specs.set(name, await BUILDERS[name]())
  }
  return specs
}

export function cCompiler(): Promise<string> {
  return firstLineOf('cc', ['--version'], REPOSITORY_ROOT)
}
