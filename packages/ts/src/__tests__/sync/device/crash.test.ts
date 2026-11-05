import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import {
  documentsOf,
  INDEX,
  type Note,
  SCHEMA,
  type SyncServer,
  sorted,
  startSyncServer,
  temporaryDirectory,
} from './fixtures'

const CHILD = fileURLToPath(new URL('./device-child.mjs', import.meta.url))
const built = existsSync(new URL('../../../../dist/sync/filesystem.mjs', import.meta.url))
const SEEDED = 3_000
const BODY_FILLER = 'harbour lights over the quay '.repeat(60)
const LATER_DOCUMENTS = 2_000
const QUEUED_WRITES = 60
const KILL_AFTER_DOWNSTREAM_BYTES = 2.5 * 1024 * 1024
const THROTTLED_BYTES_PER_SECOND = 4 * 1024 * 1024
const KILL_AFTER_ENTRY_BYTES = 64 * 1024
const CHILD_TIMEOUT_MS = 90_000

type Write = [string, string | null]

interface Child {
  process: ChildProcess
  lines: string[]
  exited: Promise<number | null>
}

function seededNote(at: number): Note {
  return { title: `seeded ${at}`, body: `${BODY_FILLER}${at}` }
}

function spawnDevice(url: string, directory: string, writes: Write[]): Child {
  const child = spawn(process.execPath, [CHILD], {
    env: { ...process.env, NARSIL_URL: url, NARSIL_DIR: directory, NARSIL_WRITES: JSON.stringify(writes) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const lines: string[] = []
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (text: string) => lines.push(...text.split('\n').filter(line => line.length > 0)))
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  return { process: child, lines, exited }
}

async function until(description: string, check: () => boolean, timeoutMs = CHILD_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

async function killed(child: Child): Promise<void> {
  child.process.kill('SIGKILL')
  await child.exited
}

describe.skipIf(!built)('a synced device process that a crash kills', () => {
  let directory: { path: string; remove(): Promise<void> } | null = null
  let server: SyncServer | null = null
  const children: Child[] = []

  function serving(): SyncServer {
    if (server === null) throw new Error('The server has not started')
    return server
  }

  function device(path: string, writes: Write[] = []): Child {
    const child = spawnDevice(serving().proxy.url, path, writes)
    children.push(child)
    return child
  }

  async function finishCleanly(path: string): Promise<void> {
    const child = device(path)
    expect(await child.exited).toBe(0)
    expect(child.lines).toContain('settled')
  }

  async function heldOnDisk(path: string): Promise<Map<string, Note>> {
    const engine = await createNarsil({ durability: { directory: join(path, 'engine') }, workers: { enabled: false } })
    try {
      return await documentsOf(engine, INDEX)
    } finally {
      await engine.shutdown()
    }
  }

  beforeEach(async () => {
    directory = await temporaryDirectory('crash')
    server = await startSyncServer(join(directory.path, 'server'))
    await serving().admin.createIndex(INDEX, SCHEMA)
  })

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.process.exitCode === null) await killed(child)
    }
    await server?.stop()
    server = null
    await directory?.remove()
    directory = null
  })

  async function seed(): Promise<Map<string, Note>> {
    const oracle = new Map<string, Note>()
    for (let at = 0; at < SEEDED; at += 500) {
      const batch = []
      for (let offset = at; offset < at + 500; offset++) {
        oracle.set(`s${offset}`, seededNote(offset))
        batch.push({ id: `s${offset}`, ...seededNote(offset) })
      }
      await serving().admin.insertBatch(INDEX, batch)
    }
    await serving().admin.updateSync(INDEX, { enabled: true })
    return oracle
  }

  it(
    'resumes a snapshot download, survives a kill while it applies the feed and while it uploads, and holds the server copy',
    async () => {
      if (directory === null) throw new Error('No directory')
      const path = join(directory.path, 'device')
      const oracle = await seed()

      serving().proxy.throttle(THROTTLED_BYTES_PER_SECOND)
      const downloading = device(path)
      const startBytes = serving().proxy.downstreamBytes()
      await until(
        'part of the snapshot',
        () => serving().proxy.downstreamBytes() - startBytes > KILL_AFTER_DOWNSTREAM_BYTES,
      )
      await killed(downloading)
      serving().proxy.throttle(null)
      await finishCleanly(path)
      expect(serving().proxy.rangeRequests()).toBeGreaterThan(0)
      expect(sorted(await heldOnDisk(path))).toEqual(sorted(oracle))

      for (let at = 0; at < LATER_DOCUMENTS; at += 250) {
        const batch = []
        for (let offset = at; offset < at + 250; offset++) {
          const later = { title: `later ${offset}`, body: `later body ${offset}` }
          oracle.set(`later${offset}`, later)
          batch.push({ id: `later${offset}`, ...later })
        }
        await serving().admin.insertBatch(INDEX, batch)
      }
      for (let at = 0; at < SEEDED; at += 7) {
        await serving().admin.remove(INDEX, `s${at}`)
        oracle.delete(`s${at}`)
      }
      const applying = device(path)
      await until('the device to start', () => applying.lines.includes('started'))
      const applyBytes = serving().proxy.downstreamBytes()
      await until('feed entries', () => serving().proxy.downstreamBytes() - applyBytes > KILL_AFTER_ENTRY_BYTES)
      await killed(applying)
      await finishCleanly(path)
      expect(sorted(await heldOnDisk(path))).toEqual(sorted(oracle))

      const writes: Write[] = []
      for (let at = 0; at < QUEUED_WRITES; at++) {
        const title = at % 5 === 0 ? null : `queued ${at}`
        const documentId = at % 3 === 0 ? `later${at}` : `queued${at}`
        writes.push([documentId, title])
        if (title === null) oracle.delete(documentId)
        else oracle.set(documentId, { title, body: `body of ${documentId}` })
      }
      const uploading = device(path, writes)
      await until('the queue', () => uploading.lines.includes('queued'))
      await killed(uploading)
      await finishCleanly(path)

      expect(sorted(await documentsOf(serving().running.engine, INDEX))).toEqual(sorted(oracle))
      expect(sorted(await heldOnDisk(path))).toEqual(sorted(oracle))
    },
    CHILD_TIMEOUT_MS * 4,
  )
})
