import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsilClient } from '../../../client'
import { ADMIN_TOKEN } from './fixtures'
import { type FeedOnReusedConnection, feedOnReusedConnection } from './raw-feed-client'

const SERVER_SCRIPT = fileURLToPath(new URL('./reused-connection-server.mjs', import.meta.url))
const BUILT =
  existsSync(new URL('../../../../dist/server.mjs', import.meta.url)) &&
  existsSync(new URL('../../../../dist/workers/entry.mjs', import.meta.url))
const ON_GLIBC = process.platform === 'linux' && typeof glibcVersion() === 'string'
const ALLOCATOR_THAT_FILLS_FREED_MEMORY = {
  GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0',
  MALLOC_PERTURB_: '16',
}
const ROUNDS = 4
const CONNECTIONS_PER_ROUND = 16
const DOCUMENTS_PER_BATCH = 8
const EXPIRES_IN_MS = 150
const CONNECTION_TIMEOUT_MS = 15_000
const READY_TIMEOUT_MS = 30_000
const CREDENTIAL_EXPIRED_CLOSE_CODE = 4401

type ServerProcess = ChildProcessByStdio<null, Readable, Readable>

function glibcVersion(): unknown {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined
  return report?.header?.glibcVersionRuntime
}

function batchBody(round: number, connection: number): string {
  const documents = []
  for (let at = 0; at < DOCUMENTS_PER_BATCH; at++) {
    documents.push({
      id: `r${round}-c${connection}-d${at}`,
      title: `note ${at} of connection ${connection}`,
      body: `round ${round} brings note ${at} about ${at % 2 === 0 ? 'trains' : 'boats'}`,
    })
  }
  return JSON.stringify({ documents })
}

async function startServerProcess(
  directory: string,
  threads: boolean,
): Promise<{ child: ServerProcess; base: string }> {
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: {
      ...process.env,
      ...ALLOCATOR_THAT_FILLS_FREED_MEMORY,
      NODE_OPTIONS: '',
      NARSIL_FEED_THREADS: String(threads),
      NARSIL_FEED_EXPIRES_IN_MS: String(EXPIRES_IN_MS),
      NARSIL_FEED_DIRECTORY: directory,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const ready = await new Promise<{ port: number; threads: number }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server did not listen within ${READY_TIMEOUT_MS} ms`)),
      READY_TIMEOUT_MS,
    )
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = /READY (\d+) (\d+)/.exec(stdout)
      if (line === null) return
      clearTimeout(timer)
      resolve({ port: Number(line[1]), threads: Number(line[2]) })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`The server ended before it listened: ${code} ${signal} ${stderr}`))
    })
  })
  if (threads) expect(ready.threads).toBeGreaterThan(0)
  else expect(ready.threads).toBe(0)
  return { child, base: `http://127.0.0.1:${ready.port}` }
}

async function stopServerProcess(child: ServerProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
}

describe.each([
  { threads: false, label: 'the main thread' },
  { threads: true, label: 'request threads' },
])('a device sync feed upgraded on a kept-alive connection, answered on $label', ({ threads }) => {
  let directory = ''
  let server: ServerProcess | null = null

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-sync-reused-'))
  })

  afterEach(async () => {
    if (server !== null) await stopServerProcess(server)
    server = null
    await rm(directory, { recursive: true, force: true })
  })

  it.skipIf(!BUILT || !ON_GLIBC)(
    'closes every feed with 4401 at its credential expiry, under an allocator that fills freed memory',
    async () => {
      const started = await startServerProcess(directory, threads)
      server = started.child
      const outcomes: FeedOnReusedConnection[] = []
      for (let round = 0; round < ROUNDS; round++) {
        const connections = Array.from({ length: CONNECTIONS_PER_ROUND }, (_, connection) =>
          feedOnReusedConnection(
            started.base,
            {
              method: 'POST',
              path: '/indexes/alice/documents/_batch',
              token: ADMIN_TOKEN,
              body: batchBody(round, connection),
            },
            '/indexes/alice/sync/feed',
            'alice-token',
            CONNECTION_TIMEOUT_MS,
          ),
        )
        outcomes.push(...(await Promise.all(connections)))
      }

      const total = ROUNDS * CONNECTIONS_PER_ROUND
      expect(outcomes.map(outcome => outcome.requestStatus)).toEqual(Array(total).fill(200))
      expect(outcomes.map(outcome => outcome.upgradeStatus)).toEqual(Array(total).fill(101))
      expect(outcomes.map(outcome => outcome.closeCode)).toEqual(Array(total).fill(CREDENTIAL_EXPIRED_CLOSE_CODE))
      const admin = createNarsilClient({ url: started.base, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
      expect(await admin.countDocuments('alice')).toBe(total * DOCUMENTS_PER_BATCH)
    },
    120_000,
  )
})
