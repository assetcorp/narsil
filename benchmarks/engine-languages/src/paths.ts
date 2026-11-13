import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SUITE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPOSITORY_ROOT = resolve(SUITE_ROOT, '..', '..')
export const BUILD_ROOT = resolve(SUITE_ROOT, '.build')
export const STAGING_ROOT = resolve(SUITE_ROOT, '.staging')
export const WORKLOAD_ROOT = resolve(SUITE_ROOT, '.workload')
export const ORACLE_ROOT = resolve(SUITE_ROOT, 'oracle')
export const ORACLE_PYTHON = resolve(ORACLE_ROOT, '.venv', 'bin', 'python')
export const ORACLE_REQUIREMENTS = resolve(REPOSITORY_ROOT, 'packages', 'conformance', 'oracle', 'requirements.txt')
export const TYPESCRIPT_RUNNER = resolve(SUITE_ROOT, 'src', 'typescript-runner', 'main.ts')
export const RUST_RUNNER_MANIFEST = resolve(SUITE_ROOT, 'rust', 'Cargo.toml')
export const RUST_RUNNER_BINARY = 'narsil-engine-languages-runner'
export const GO_RUNNER_ROOT = resolve(SUITE_ROOT, 'go')
export const RUST_CRATE_ROOT = resolve(REPOSITORY_ROOT, 'packages', 'rust')
export const TYPESCRIPT_PACKAGE_ROOT = resolve(REPOSITORY_ROOT, 'packages', 'ts')
export const NATIVE_PACKAGES_ROOT = resolve(REPOSITORY_ROOT, 'packages', 'native', 'npm')
