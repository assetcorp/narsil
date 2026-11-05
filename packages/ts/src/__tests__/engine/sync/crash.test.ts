import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createServer, type NarsilServer } from '../../../server'
import { catchUp, documentsOf, type Note, note, positionMap } from '../../server/sync/cluster-fixtures'
import { archivePositions, download, openFeed, ownerHook } from '../../server/sync/fixtures'

const CHILD_SCRIPT = fileURLToPath(new URL('./crash-child.mjs', import.meta.url))
const built = existsSync(new URL('../../../../dist/server.mjs', import.meta.url))
const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const FIRST_DOCUMENTS = 300
const LATER_DOCUMENTS = 200
const EDITED_DOCUMENTS = 40
const REMOVED_DOCUMENTS = 30
const SMALLEST_HISTORY_BYTES = 1

type Scenario = 'publish' | 'history' | 'republish' | 'release'

const KILL_POINTS: Array<{ scenario: Scenario; killAt: string; what: string }> = [
  { scenario: 'publish', killAt: 'first-publish', what: 'before the first published snapshot is in place' },
  { scenario: 'history', killAt: 'history-move', what: 'while a checkpoint moves a log segment into history' },
  { scenario: 'republish', killAt: 'republish', what: 'before the next published snapshot replaces the first' },
  { scenario: 'republish', killAt: 'republish-cleanup', what: 'while the next snapshot deletes the old files' },
  { scenario: 'release', killAt: 'release-published', what: 'before sync off deletes the published snapshot' },
  { scenario: 'release', killAt: 'release-files', what: 'while sync off deletes the snapshot files' },
]

const roots: string[] = []
const engines: Narsil[] = []
const servers: NarsilServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close().catch(() => undefined)
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function openEngine(directory: string | null): Promise<Narsil> {
  const engine = await createNarsil({
    workers: { enabled: false },
    ...(directory === null ? {} : { durability: { directory } }),
  })
  engines.push(engine)
  return engine
}

function expectedDocuments(scenario: Scenario): Map<string, Note> {
  const oracle = new Map<string, Note>()
  for (let at = 0; at < FIRST_DOCUMENTS; at++) oracle.set(`n${at}`, note(at))
  if (scenario === 'publish') return oracle
  for (let at = 0; at < LATER_DOCUMENTS; at++) {
    oracle.set(`l${at}`, { title: `later note ${at}`, body: `written before the crash, number ${at}` })
  }
  for (let at = 0; at < EDITED_DOCUMENTS; at++) {
    oracle.set(`n${at}`, { title: `edited note ${at}`, body: 'changed before the crash' })
  }
  for (let at = EDITED_DOCUMENTS; at < EDITED_DOCUMENTS + REMOVED_DOCUMENTS; at++) oracle.delete(`n${at}`)
  return oracle
}

async function preparedDirectory(scenario: Scenario): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-sync-crash-'))
  roots.push(directory)
  const engine = await openEngine(directory)
  await engine.createIndex('alice', SCHEMA)
  const batch = Array.from({ length: FIRST_DOCUMENTS }, (_, at) => ({ id: `n${at}`, ...note(at) }))
  await engine.insertBatch('alice', batch)
  await engine.updateSync('alice', {
    enabled: true,
    ...(scenario === 'republish' ? { historyMaxBytes: SMALLEST_HISTORY_BYTES } : {}),
  })
  await engine.shutdown()
  engines.splice(engines.indexOf(engine), 1)
  return directory
}

function runChild(directory: string, scenario: Scenario, killAt: string) {
  const child = spawn(process.execPath, [CHILD_SCRIPT], {
    env: {
      ...process.env,
      NARSIL_DIR: directory,
      NARSIL_SCENARIO: scenario,
      NARSIL_KILL_AT: killAt,
      NARSIL_LATER_DOCUMENTS: String(LATER_DOCUMENTS),
      NARSIL_EDITED_DOCUMENTS: String(EDITED_DOCUMENTS),
      NARSIL_REMOVED_DOCUMENTS: String(REMOVED_DOCUMENTS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  return new Promise<{ signal: NodeJS.Signals | null; output: string }>(resolve => {
    child.on('exit', (_code, signal) => resolve({ signal, output }))
  })
}

async function filesUnder(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return []
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

async function serve(engine: Narsil): Promise<string> {
  const server = createServer(engine, { host: '127.0.0.1', port: 0, sync: true, onRequest: ownerHook().hook })
  await server.listen()
  servers.push(server)
  return `http://127.0.0.1:${server.listeningPort}`
}

describe.skipIf(!built)('device sync storage after the process dies', () => {
  for (const { scenario, killAt, what } of KILL_POINTS) {
    it(`keeps every document and serves a device whole after a kill ${what}`, async () => {
      const directory = await preparedDirectory(scenario)

      const { signal, output } = await runChild(directory, scenario, killAt)
      expect(signal, output).toBe('SIGKILL')

      const oracle = expectedDocuments(scenario)
      const engine = await openEngine(directory)
      expect(await documentsOf(engine, 'alice')).toEqual(oracle)
      expect((await filesUnder(directory)).filter(path => path.includes('.tmp-'))).toEqual([])

      const status = await engine.getSync('alice')
      const base = await serve(engine)
      if (!status.enabled) {
        expect(scenario).toBe('release')
        expect(await filesUnder(join(directory, 'alice', 'sync'))).toEqual([])
        expect(await filesUnder(join(directory, 'alice', 'history'))).toEqual([])
        expect((await download(base, 'alice', 'alice-token')).status).toBe(404)
        return
      }

      const snapshot = await download(base, 'alice', 'alice-token')
      expect(snapshot.status).toBe(200)
      const device = await openEngine(null)
      await device.restore('alice', snapshot.bytes)
      const positions = await archivePositions(snapshot.bytes)
      const feed = await openFeed(base, 'alice', 'alice-token')
      feed.send({ type: 'subscribe', epoch: status.epoch, positions })
      await feed.next('subscribed')
      await catchUp(feed, device, 'alice', positionMap(positions))
      expect(await documentsOf(device, 'alice')).toEqual(oracle)
      feed.close()
    }, 60_000)
  }
})
