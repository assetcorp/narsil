import { type ChildProcess, spawn } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { createNarsil } from '../../../narsil'
import { tarEnd, tarEntryHeaders, tarPadding } from '../../../persistence/archive/tar'
import { vectorFileKey } from '../../../persistence/durability/segment/layout'
import { encodeSegmentManifest } from '../../../persistence/durability/segment/manifest'
import { decodeManifestPayload, openManifestPayload } from '../../../persistence/durability/segment/manifest-decode'
import { httpStatusForNarsilError } from '../../../server/errors'
import { archiveBytes, newDirectory } from '../../engine/snapshot/restore-fixtures'

const SERVER_SCRIPT = fileURLToPath(new URL('./restore-server-process.mjs', import.meta.url))
const built = await readdir(new URL('../../../../dist/', import.meta.url)).then(
  entries => entries.includes('server.mjs'),
  () => false,
)

const LIVE = 'live'
const SOURCE = 'source'
const SERVER_HEAP_MEGABYTES = 64
const ARCHIVE_DOCUMENTS = 50_000
const FORGED_DIMENSION = 1_536
const FORGED_VECTORS_PER_FILE = 65_536
const OSQ4_CODE_BYTES_PER_DIMENSION = 0.5
const OLD_DOCUMENTS = Array.from({ length: 300 }, (_, n) => ({
  id: `old-${n}`,
  body: n % 3 === 0 ? `the lantern by quay ${n}` : `the ferry by quay ${n}`,
}))
const OLD_LANTERN_HITS = OLD_DOCUMENTS.filter(document => document.body.includes('lantern'))
  .map(document => document.id)
  .sort()

interface ServerProcess {
  base: string
  exited(): boolean
  stop(): Promise<void>
}

const roots: string[] = []
const servers: ServerProcess[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function startServerProcess(directory: string, heapMegabytes?: number): Promise<ServerProcess> {
  const flags = heapMegabytes === undefined ? [] : [`--max-old-space-size=${heapMegabytes}`]
  const child: ChildProcess = spawn(process.execPath, [...flags, SERVER_SCRIPT], {
    env: { ...process.env, NODE_OPTIONS: '', NARSIL_DIR: directory, NARSIL_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let hasExited = false
  const exitedPromise = new Promise<void>(resolve => {
    child.once('exit', () => {
      hasExited = true
      resolve()
    })
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      const ready = /READY (\d+)/.exec(output)
      if (ready !== null) resolve(Number(ready[1]))
    })
    child.once('exit', code => reject(new Error(`the server exited with code ${code}: ${output}`)))
  })
  const server: ServerProcess = {
    base: `http://127.0.0.1:${port}`,
    exited: () => hasExited,
    async stop() {
      if (hasExited) return
      child.kill('SIGKILL')
      await exitedPromise
    },
  }
  servers.push(server)
  return server
}

function wordsArchiveDocuments() {
  let state = 3
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
  const word = () => `w${Math.floor(random() * 20_000).toString(36)}`
  return Array.from({ length: ARCHIVE_DOCUMENTS }, (_, n) => ({
    id: `new-${n}`,
    body: Array.from({ length: 40 }, word).join(' '),
  }))
}

interface TarEntry {
  name: string
  body: Uint8Array
}

function tarEntriesOf(archive: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/s, '')
    const size = Number.parseInt(new TextDecoder().decode(header.subarray(124, 136)).replace(/\0/g, '').trim(), 8)
    const body = offset + 512
    entries.push({ name, body: archive.slice(body, body + size) })
    offset = body + Math.ceil(size / 512) * 512
  }
  return entries
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let at = 0
  for (const part of parts) {
    whole.set(part, at)
    at += part.byteLength
  }
  return whole
}

function tarOf(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const { name, body } of entries) {
    parts.push(...tarEntryHeaders(name, body.byteLength), body, tarPadding(body.byteLength))
  }
  parts.push(tarEnd())
  return joined(parts)
}

async function forgedVectorArchive(fileCount: number): Promise<Uint8Array> {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.createIndex(SOURCE, { schema: { body: 'string', embedding: `vector[${FORGED_DIMENSION}]` } })
    for (let n = 0; n < 3; n++) {
      const embedding = Array.from({ length: FORGED_DIMENSION }, (_, i) => Math.sin(n * 31 + i))
      await engine.insert(SOURCE, { body: `the pier ${n}`, embedding }, `forged-${n}`)
    }
    const entries = tarEntriesOf(await archiveBytes(engine, SOURCE))
    const config = entries.find(entry => entry.name === 'config')
    const manifestEntry = entries.find(entry => entry.name === 'manifest')
    if (config === undefined || manifestEntry === undefined) throw new Error('the archive holds no config or manifest')
    const decoded = decodeManifestPayload(await openManifestPayload(manifestEntry.body), SOURCE)
    if (decoded.kind !== 'current') throw new Error('the archive holds an earlier manifest')
    const [field] = decoded.manifest.vectors
    const [file] = field.files
    const files = Array.from({ length: fileCount }, (_, id) => ({
      ...file,
      id,
      key: vectorFileKey(SOURCE, field.fieldPath, id),
      count: FORGED_VECTORS_PER_FILE,
      dead: null,
    }))
    const manifest = { ...decoded.manifest, vectors: [{ ...field, nextFileId: fileCount, files, graphParts: [] }] }
    const packed = await encodeSegmentManifest(manifest)
    return tarOf([config, { name: 'manifest', body: joined(packed.chunks) }])
  } finally {
    await engine.shutdown()
  }
}

async function liveIndexOn(server: ServerProcess): Promise<NarsilClient> {
  const client = createNarsilClient({ url: server.base })
  await client.createIndex(LIVE, { schema: { body: 'string' } })
  await client.insertBatch(LIVE, OLD_DOCUMENTS)
  return client
}

async function expectOldIndexServing(client: NarsilClient): Promise<void> {
  const hits = (await client.query(LIVE, { term: 'lantern', limit: 1_000 })).hits.map(hit => hit.id).sort()
  expect(hits).toEqual(OLD_LANTERN_HITS)
  expect(await client.get(LIVE, 'old-3')).toMatchObject({ body: 'the lantern by quay 3' })
}

describe.skipIf(!built)('a restore that the server has no memory for', () => {
  it('refuses an archive that needs more heap than the server allows, and keeps the old index', async () => {
    const source = await createNarsil({ workers: { enabled: false } })
    await source.createIndex(SOURCE, { schema: { body: 'string' } })
    await source.insertBatch(SOURCE, wordsArchiveDocuments())
    const archive = await archiveBytes(source, SOURCE)
    await source.shutdown()
    const server = await startServerProcess(await newDirectory(roots), SERVER_HEAP_MEGABYTES)
    const client = await liveIndexOn(server)

    const task = await client.waitForTask((await client.restore(LIVE, archive)).id)

    expect(task).toMatchObject({
      status: 'failed',
      error: { code: 'RESTORE_MEMORY_EXCEEDED', details: { indexName: LIVE, budget: 'heap' } },
    })
    expect(httpStatusForNarsilError(task.error?.code ?? '')).toBe(507)
    expect(task.error?.details?.neededBytes).toBeGreaterThan(SERVER_HEAP_MEGABYTES * 1_048_576 * 0.5)
    expect(server.exited()).toBe(false)
    await expectOldIndexServing(client)
  }, 120_000)

  it('refuses an archive whose manifest lists more vectors than the machine holds, before it reads a file', async () => {
    const vectorBytesAtLeast = FORGED_VECTORS_PER_FILE * FORGED_DIMENSION * OSQ4_CODE_BYTES_PER_DIMENSION
    const fileCount = Math.ceil((2 * totalmem()) / vectorBytesAtLeast)
    const archive = await forgedVectorArchive(fileCount)
    const server = await startServerProcess(await newDirectory(roots))
    const client = await liveIndexOn(server)

    const task = await client.waitForTask((await client.restore(LIVE, archive)).id)

    expect(task).toMatchObject({
      status: 'failed',
      error: { code: 'RESTORE_MEMORY_EXCEEDED', details: { indexName: LIVE, budget: 'process' } },
    })
    expect(httpStatusForNarsilError(task.error?.code ?? '')).toBe(507)
    expect(task.error?.details?.neededBytes).toBeGreaterThan(fileCount * vectorBytesAtLeast)
    expect(server.exited()).toBe(false)
    await expectOldIndexServing(client)
  }, 120_000)
})
