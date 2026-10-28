import { type ChildProcess, spawn } from 'node:child_process'
import { readdir, rm } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { fileURLToPath } from 'node:url'
import { crc32 } from 'node:zlib'
import { encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsilClient, type NarsilClient } from '../../../client'
import { createNarsil } from '../../../narsil'
import { httpStatusForNarsilError } from '../../../server'
import { archiveBytes, newDirectory } from '../../engine/snapshot/restore-fixtures'
import { envelopePayload } from '../../integration/saved-graph-walk'

const SERVER_SCRIPT = fileURLToPath(new URL('./restore-server-process.mjs', import.meta.url))
const built = await readdir(new URL('../../../../dist/', import.meta.url)).then(
  entries => entries.includes('server.mjs'),
  () => false,
)

const LIVE = 'live'
const FRESH = 'fresh'
const SOURCE = 'source'
const SERVER_HEAP_MEGABYTES = 64
const HEAP_REFUSAL_FILES = 2
const MEGABYTE_BYTES = 1_048_576
const HEAP_HEADROOM_PER_CODE_BYTE = 4
const FORGED_DIMENSION = 1_536
const FORGED_VECTORS_PER_FILE = 65_536
const OSQ4_CODE_BYTES_PER_DIMENSION = 0.5
const TAR_BLOCK_BYTES = 512
const TAR_CHECKSUM_OFFSET = 148
const TAR_CHECKSUM_BYTES = 8
const ENVELOPE_HEADER_BYTES = 32
const MANIFEST_ENVELOPE_VERSION = 2
const CHECKSUM_PRESENT_FLAG = 0b1000
const FILE_ID_DIGITS = 16
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

function ustarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(TAR_BLOCK_BYTES)
  const put = (text: string, offset: number) => header.set(new TextEncoder().encode(text), offset)
  put(name, 0)
  put('0000644\0', 100)
  put('0000000\0', 108)
  put('0000000\0', 116)
  put(`${size.toString(8).padStart(11, '0')}\0`, 124)
  put('00000000000\0', 136)
  header.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES)
  put('0', 156)
  put('ustar\0', 257)
  put('00', 263)
  const sum = header.reduce((total, byte) => total + byte, 0)
  put(`${sum.toString(8).padStart(6, '0')}\0 `, TAR_CHECKSUM_OFFSET)
  return header
}

function tarOf(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const { name, body } of entries) {
    const padding = (TAR_BLOCK_BYTES - (body.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES
    parts.push(ustarHeader(name, body.byteLength), body, new Uint8Array(padding))
  }
  parts.push(new Uint8Array(TAR_BLOCK_BYTES * 2))
  return joined(parts)
}

function manifestEnvelope(manifest: unknown): Uint8Array {
  const payload = encode(manifest)
  const file = new Uint8Array(ENVELOPE_HEADER_BYTES + payload.byteLength)
  file.set(new TextEncoder().encode('NRSL'), 0)
  file[4] = MANIFEST_ENVELOPE_VERSION
  const view = new DataView(file.buffer)
  view.setUint32(8, payload.byteLength, false)
  view.setUint16(12, CHECKSUM_PRESENT_FLAG, false)
  view.setUint32(14, crc32(payload), false)
  file.set(payload, ENVELOPE_HEADER_BYTES)
  return file
}

interface VectorFileRef {
  id: number
  key: string
  count: number
  dead: Uint8Array | null
  bytes: number
  checksum: number
}

interface VectorFieldRef {
  fieldPath: string
  nextFileId: number
  files: VectorFileRef[]
  graphParts: unknown[]
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
    const manifest = envelopePayload(manifestEntry.body) as { vectors: VectorFieldRef[] }
    const [field] = manifest.vectors
    const [file] = field.files
    const keyPrefix = file.key.slice(0, -FILE_ID_DIGITS)
    const files = Array.from({ length: fileCount }, (_, id) => ({
      ...file,
      id,
      key: `${keyPrefix}${String(id).padStart(FILE_ID_DIGITS, '0')}`,
      count: FORGED_VECTORS_PER_FILE,
      dead: null,
    }))
    const forged = { ...manifest, vectors: [{ ...field, nextFileId: fileCount, files, graphParts: [] }] }
    return tarOf([config, { name: 'manifest', body: manifestEnvelope(forged) }])
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
    const archive = await forgedVectorArchive(HEAP_REFUSAL_FILES)
    const server = await startServerProcess(await newDirectory(roots), SERVER_HEAP_MEGABYTES)
    const client = await liveIndexOn(server)

    const task = await client.waitForTask((await client.restore(LIVE, archive)).id)

    expect(task).toMatchObject({
      status: 'failed',
      error: { code: 'RESTORE_MEMORY_EXCEEDED', details: { indexName: LIVE, budget: 'heap' } },
    })
    expect(httpStatusForNarsilError(task.error?.code ?? '')).toBe(507)
    expect(task.error?.details?.neededBytes).toBeGreaterThan(SERVER_HEAP_MEGABYTES * MEGABYTE_BYTES)
    expect(server.exited()).toBe(false)
    await expectOldIndexServing(client)
  }, 120_000)

  it('refuses an archive whose manifest lists more vectors than the machine holds, before it reads a file', async () => {
    const vectorBytesAtLeast = FORGED_VECTORS_PER_FILE * FORGED_DIMENSION * OSQ4_CODE_BYTES_PER_DIMENSION
    const fileCount = Math.ceil((2 * totalmem()) / vectorBytesAtLeast)
    const archive = await forgedVectorArchive(fileCount)
    const heapMegabytes = Math.ceil((HEAP_HEADROOM_PER_CODE_BYTE * fileCount * vectorBytesAtLeast) / MEGABYTE_BYTES)
    const server = await startServerProcess(await newDirectory(roots), heapMegabytes)
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

  it('refuses an archive into a new index whose manifest lists more vectors than the machine holds, and creates no index', async () => {
    const vectorBytesAtLeast = FORGED_VECTORS_PER_FILE * FORGED_DIMENSION * OSQ4_CODE_BYTES_PER_DIMENSION
    const fileCount = Math.ceil((2 * totalmem()) / vectorBytesAtLeast)
    const archive = await forgedVectorArchive(fileCount)
    const heapMegabytes = Math.ceil((HEAP_HEADROOM_PER_CODE_BYTE * fileCount * vectorBytesAtLeast) / MEGABYTE_BYTES)
    const server = await startServerProcess(await newDirectory(roots), heapMegabytes)
    const client = await liveIndexOn(server)

    const task = await client.waitForTask((await client.restore(FRESH, archive)).id)

    expect(task).toMatchObject({
      status: 'failed',
      error: { code: 'RESTORE_MEMORY_EXCEEDED', details: { indexName: FRESH, budget: 'process' } },
    })
    expect(task.error?.details?.neededBytes).toBeGreaterThan(fileCount * vectorBytesAtLeast)
    expect(server.exited()).toBe(false)
    expect((await client.listIndexes()).map(index => index.name)).toEqual([LIVE])
    await expectOldIndexServing(client)
  }, 120_000)
})
