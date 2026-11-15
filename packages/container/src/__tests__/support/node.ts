import { type ChildProcess, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAIN = fileURLToPath(new URL('../../../dist/main.mjs', import.meta.url))
const PROGRAM_VARIABLE = 'NARSIL_CONTAINER_PROGRAM'
const SELECTED_PROGRAM = process.env[PROGRAM_VARIABLE]
const PROGRAM =
  SELECTED_PROGRAM === undefined || SELECTED_PROGRAM.length === 0
    ? { command: process.execPath, args: [MAIN] }
    : { command: resolve(SELECTED_PROGRAM), args: [] }

export const HOLDS_WORKER_COPIES = PROGRAM.command === process.execPath
const READY_LINE = 'Narsil serves HTTP'
const START_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 30_000

export const ADMIN_KEY = 'admin-key-for-container-tests-0123456789'
export const READ_KEY = 'read-key-for-container-tests-0123456789'

export type Env = Record<string, string>

export interface Exit {
  code: number | null
  stdout: string
  stderr: string
}

export interface RunningNode {
  url: string
  port: number
  stdoutLines(): string[]
  stderr(): string
  waitForStdout(match: (line: string) => boolean, timeoutMs?: number): Promise<string>
  stop(signal?: NodeJS.Signals): Promise<Exit>
}

export function temporaryFolder(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `narsil-container-${prefix}-`))
}

export function removeFolder(folder: string): void {
  rmSync(folder, { recursive: true, force: true })
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function childEnv(env: Env): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? tmpdir(), ...env }
}

function spawnMain(env: Env): ChildProcess {
  return spawn(PROGRAM.command, PROGRAM.args, { env: childEnv(env), stdio: ['ignore', 'pipe', 'pipe'] })
}

function exitOf(child: ChildProcess, out: { stdout: string; stderr: string }): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`The startup program did not exit within ${EXIT_TIMEOUT_MS} ms:\n${out.stderr}`))
    }, EXIT_TIMEOUT_MS)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve({ code, stdout: out.stdout, stderr: out.stderr })
    })
  })
}

export async function runToExit(env: Env): Promise<Exit> {
  const child = spawnMain(env)
  const out = { stdout: '', stderr: '' }
  child.stdout?.on('data', chunk => {
    out.stdout += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    out.stderr += String(chunk)
  })
  return exitOf(child, out)
}

export async function startNode(env: Env): Promise<RunningNode> {
  const port = await freePort()
  const child = spawnMain({ NARSIL_HTTP_HOST: '127.0.0.1', NARSIL_HTTP_PORT: String(port), ...env })
  const out = { stdout: '', stderr: '' }
  const listeners = new Set<() => void>()
  child.stdout?.on('data', chunk => {
    out.stdout += String(chunk)
    for (const listener of listeners) listener()
  })
  child.stderr?.on('data', chunk => {
    out.stderr += String(chunk)
    for (const listener of listeners) listener()
  })
  const exited = exitOf(child, out)
  const lines = (): string[] => out.stdout.split('\n').filter(line => line.length > 0)

  function waitFor(check: () => string | null, timeoutMs: number, what: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const done = (): void => {
        listeners.delete(probe)
        clearTimeout(timer)
      }
      const probe = (): void => {
        const found = check()
        if (found === null) return
        done()
        resolve(found)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`Timed out waiting for ${what}.\nstdout:\n${out.stdout}\nstderr:\n${out.stderr}`))
      }, timeoutMs)
      listeners.add(probe)
      child.once('exit', () => {
        if (!listeners.has(probe)) return
        done()
        reject(new Error(`The startup program exited while waiting for ${what}:\n${out.stderr}`))
      })
      probe()
    })
  }

  await waitFor(() => (out.stderr.includes(READY_LINE) ? READY_LINE : null), START_TIMEOUT_MS, 'the server')
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stdoutLines: lines,
    stderr: () => out.stderr,
    waitForStdout: (match, timeoutMs = START_TIMEOUT_MS) =>
      waitFor(() => lines().find(match) ?? null, timeoutMs, 'a line on standard output'),
    async stop(signal = 'SIGTERM') {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
      return exited
    },
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

export function signToken(
  key: string,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signature = createHmac('sha256', Buffer.from(key, 'utf8')).update(signingInput).digest()
  return `${signingInput}.${base64url(signature)}`
}

export function secondsFromNow(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds
}

export interface Answer {
  status: number
  body: unknown
}

export async function call(
  node: RunningNode,
  method: string,
  path: string,
  options: { credential?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...options.headers }
  if (options.credential !== undefined) headers.authorization = `Bearer ${options.credential}`
  let body: string | undefined
  if (options.raw !== undefined) body = options.raw
  else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    headers['content-type'] = 'application/json'
  }
  const response = await fetch(`${node.url}${path}`, { method, headers, body })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {}
  return { status: response.status, body: parsed }
}

export function errorCodeOf(answer: Answer): unknown {
  const body = answer.body
  if (typeof body !== 'object' || body === null) return undefined
  const error = (body as { error?: { code?: unknown } }).error
  return error?.code
}
