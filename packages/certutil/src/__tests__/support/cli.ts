import { execFile } from 'node:child_process'
import { createPrivateKey, type KeyObject, X509Certificate } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'

const CLI_ENTRY = fileURLToPath(new URL('../../../dist/cli.mjs', import.meta.url))
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_CLI_OUTPUT_BYTES = 10 * 1024 * 1024

if (!existsSync(CLI_ENTRY)) {
  throw new Error(`${CLI_ENTRY} is missing, so run pnpm nx run narsil-certutil:build first`)
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export interface CliOptions {
  cwd?: string
  env?: Record<string, string>
}

export interface Envelope<T> {
  status: 'success' | 'error'
  data: T | null
  error: { code: string; message: string; suggestion?: string } | null
  metadata: { duration_ms: number }
}

export interface Authority {
  name: string
  certPath: string
  keyPath: string
  certPem: string
  keyPem: string
  certificate: X509Certificate
}

export interface NodeIdentity {
  certPath: string
  keyPath: string
  certPem: string
  keyPem: string
  certificate: X509Certificate
  privateKey: KeyObject
}

function inheritedEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(environment)) {
    if (name.startsWith('NARSIL_')) {
      delete environment[name]
    }
  }
  return { ...environment, ...overrides }
}

export async function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  return await new Promise<CliResult>(resolve => {
    execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      {
        cwd: options.cwd ?? tmpdir(),
        encoding: 'utf8',
        env: inheritedEnvironment(options.env),
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

export async function createWorkspace(parent: string = tmpdir()): Promise<string> {
  return await mkdtemp(join(parent, 'certutil-'))
}

export async function removeWorkspace(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

export async function listFiles(path: string): Promise<string[]> {
  if (!existsSync(path)) {
    return []
  }
  const entries = await readdir(path, { recursive: true, withFileTypes: true })
  return entries
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name).slice(path.length + 1))
    .sort()
}

export function parseEnvelope<T>(text: string): Envelope<T> {
  return JSON.parse(text) as Envelope<T>
}

export function expectRefusal(result: CliResult, code: number, message: string | RegExp): void {
  expect(result.code).toBe(code)
  expect(result.stderr).toMatch(message)
  expect(result.stderr).not.toContain('    at ')
}

export function expectNoPrivateKeyInOutput(result: CliResult): void {
  expect(result.stdout).not.toContain('-----BEGIN')
  expect(result.stderr).not.toContain('-----BEGIN')
}

export function daysUntilExpiry(certificate: X509Certificate): number {
  return Math.round((Date.parse(certificate.validTo) - Date.now()) / MILLISECONDS_PER_DAY)
}

export function subjectAlternativeNames(certificate: X509Certificate): string[] {
  return (certificate.subjectAltName ?? '').split(', ').sort()
}

export function commonName(distinguishedName: string): string | undefined {
  return distinguishedName
    .split('\n')
    .find(line => line.startsWith('CN='))
    ?.slice('CN='.length)
}

export function modulusBits(key: KeyObject): number | undefined {
  return key.asymmetricKeyDetails?.modulusLength
}

export async function createAuthority(directory: string, name: string): Promise<Authority> {
  const result = await runCli(['ca', '--name', name, '--key-size', '2048', '--out-dir', directory])
  if (result.code !== 0) {
    throw new Error(`The CLI refused to create the CA ${name}: ${result.stderr}`)
  }
  const certPath = join(directory, 'ca.crt')
  const keyPath = join(directory, 'ca.key')
  const certPem = await readFile(certPath, 'utf-8')
  const keyPem = await readFile(keyPath, 'utf-8')
  return { name, certPath, keyPath, certPem, keyPem, certificate: new X509Certificate(certPem) }
}

export async function loadIdentity(certPath: string, keyPath: string): Promise<NodeIdentity> {
  const certPem = await readFile(certPath, 'utf-8')
  const keyPem = await readFile(keyPath, 'utf-8')
  return {
    certPath,
    keyPath,
    certPem,
    keyPem,
    certificate: new X509Certificate(certPem),
    privateKey: createPrivateKey(keyPem),
  }
}

export async function issueNodeCertificate(
  authority: Authority,
  directory: string,
  cn: string,
  extraArgs: string[] = [],
): Promise<NodeIdentity> {
  const result = await runCli([
    'cert',
    '--cn',
    cn,
    '--ca-cert',
    authority.certPath,
    '--ca-key',
    authority.keyPath,
    '--out-dir',
    directory,
    ...extraArgs,
  ])
  if (result.code !== 0) {
    throw new Error(`The CLI refused to issue a certificate for ${cn}: ${result.stderr}`)
  }
  return await loadIdentity(join(directory, `${cn}.crt`), join(directory, `${cn}.key`))
}
