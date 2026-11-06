import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { clusterNodeEngine } from '../../../distribution/cluster-node/server-engine'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator, NodeRole } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport, type InMemoryNetwork } from '../../../distribution/transport'
import type { NodeTransport, TransportMessage } from '../../../distribution/transport/types'
import { querySuggestions } from '../../../query-suggestions'
import type { NarsilConfig } from '../../../types/config'

const KEY = new Uint8Array(32).fill(11)
const SOURCE = 'catalogue'
const PHRASE = 'trail shoes'
const COUNTS_MESSAGE = 'suggestions.counts'
const HISTORY_FILE_LIMIT_BYTES = 16_777_216
const HEADER_BYTES = 32
const LEADING_HEADER_BYTES = 8
const CHECKSUM_FLAG = 0x0008
const SCRAMBLED_ID_BYTES = 16
const DAY_MS = 86_400_000
const CRC32_POLYNOMIAL = 0xedb88320
const SETTING = { enabled: true, fields: ['title'], minPeople: 2, minResults: 1, schedule: 'off' }

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? CRC32_POLYNOMIAL ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function payloadOf(file: Uint8Array): Uint8Array {
  const length = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint32(8)
  return file.subarray(HEADER_BYTES, HEADER_BYTES + length)
}

function envelopeLike(template: Uint8Array, payload: Uint8Array): Uint8Array {
  const file = new Uint8Array(HEADER_BYTES + payload.byteLength)
  file.set(template.subarray(0, LEADING_HEADER_BYTES))
  const view = new DataView(file.buffer)
  view.setUint32(8, payload.byteLength)
  view.setUint16(12, CHECKSUM_FLAG)
  view.setUint32(14, crc32(payload))
  file.set(payload, HEADER_BYTES)
  return file
}

function dayOf(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10)
}

function joined(parts: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

function frame(keyBytes: Uint8Array, declaredLength: number, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(2 + keyBytes.byteLength + 4)
  const view = new DataView(header.buffer)
  view.setUint16(0, keyBytes.byteLength)
  header.set(keyBytes, 2)
  view.setUint32(2 + keyBytes.byteLength, declaredLength)
  return joined([header, body])
}

function textFrame(key: string, body: Uint8Array): Uint8Array {
  return frame(new TextEncoder().encode(key), body.byteLength, body)
}

function admittedInOrder(files: Array<{ nodeId: string; key: string; groups: string[] }>, maxGroups: number) {
  const admitted: string[] = []
  const ordered = [...files].sort((left, right) =>
    left.nodeId === right.nodeId ? (left.key < right.key ? -1 : 1) : left.nodeId < right.nodeId ? -1 : 1,
  )
  for (const file of ordered) {
    for (const group of file.groups) {
      if (!admitted.includes(group) && admitted.length < maxGroups) admitted.push(group)
    }
  }
  return admitted
}

interface Cluster {
  coordinator: ClusterCoordinator
  network: InMemoryNetwork
  nodes: ClusterNode[]
  transports: NodeTransport[]
  directories: string[]
}

let cluster: Cluster | null = null

async function startNode(nodeId: string, roles: NodeRole[], engine: NarsilConfig): Promise<ClusterNode> {
  if (cluster === null) throw new Error('The cluster has not started')
  const transport = createInMemoryTransport(nodeId, cluster.network)
  const node = await createClusterNode({
    coordinator: cluster.coordinator,
    transport,
    address: nodeId,
    nodeId,
    roles,
    engine: { querySuggestions: { key: KEY }, ...engine },
  })
  await node.start()
  cluster.nodes.push(node)
  cluster.transports.push(transport)
  return node
}

async function sourceIndexOn(node: ClusterNode): Promise<void> {
  await node.createIndex(SOURCE, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 0 })
  await node.insert(SOURCE, { title: `${PHRASE} for wet ground` }, 'shoe-1')
}

async function streamCounts(probe: NodeTransport, target: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const message: TransportMessage = {
    type: COUNTS_MESSAGE,
    sourceId: 'probe',
    requestId: 'probe-1',
    payload: encode({ indexName: SOURCE }),
  }
  await probe.stream(target, message, chunk => chunks.push(new Uint8Array(chunk)))
  return joined(chunks)
}

afterEach(async () => {
  const current = cluster
  cluster = null
  if (current === null) return
  for (const node of current.nodes.reverse()) await node.shutdown().catch(() => undefined)
  for (const transport of current.transports) await transport.shutdown().catch(() => undefined)
  await current.coordinator.shutdown()
  for (const directory of current.directories) await rm(directory, { recursive: true, force: true })
})

function newCluster(): Cluster {
  cluster = {
    coordinator: createInMemoryCoordinator(),
    network: createInMemoryNetwork(),
    nodes: [],
    transports: [],
    directories: [],
  }
  return cluster
}

describe('popular query suggestions read the counts of every node in a cluster', () => {
  it('merges nothing from a peer whose counts stream breaks the frame rules', async () => {
    const { coordinator, network } = newCluster()
    const controller = await startNode('node-a', ['data', 'coordinator', 'controller'], {})
    await sourceIndexOn(controller)
    await querySuggestions(clusterNodeEngine(controller)).updateSetting(SOURCE, SETTING)

    const counter = await startNode('node-b', ['coordinator'], {})
    const counting = querySuggestions(clusterNodeEngine(counter))
    for (const person of ['person-1', 'person-2']) {
      expect(await counting.recordQuery(SOURCE, { query: PHRASE, person, group: 'shoppers' })).toEqual({
        recorded: true,
        outcome: 'recorded',
      })
    }
    const probe = createInMemoryTransport('probe', network)
    cluster?.transports.push(probe)
    const honest = await streamCounts(probe, 'node-b')
    expect(honest.byteLength).toBeGreaterThan(0)
    await counter.shutdown()
    cluster?.nodes.splice(cluster.nodes.indexOf(counter), 1)

    let answer: Uint8Array[] = []
    const peer = createInMemoryTransport('node-c', network)
    cluster?.transports.push(peer)
    await peer.listen(async (message, respond) => {
      if (message.type !== COUNTS_MESSAGE) return
      for (const chunk of answer) {
        await respond({ type: message.type, sourceId: 'node-c', requestId: message.requestId, payload: chunk })
      }
    })
    await coordinator.registerNode({
      nodeId: 'node-c',
      address: 'node-c',
      roles: ['coordinator'],
      capacity: { memoryBytes: 1_000_000_000, cpuCores: 1, diskBytes: null },
      startedAt: new Date().toISOString(),
      version: '1.4',
    })

    const previewOnController = async () =>
      (await querySuggestions(clusterNodeEngine(controller)).preview(SOURCE)).entries
    answer = [honest]
    expect(await previewOnController()).toEqual([{ group: 'shoppers', query: PHRASE, count: 2 }])

    const dayKey = `${dayOf(Date.now())}.nrsl`
    const hostileTails: Record<string, Uint8Array> = {
      'a 65-byte key': frame(new Uint8Array(65).fill(0x61), 0, new Uint8Array(0)),
      'a path out of the folder': textFrame('../x', honest.subarray(0, 8)),
      'the build record': textFrame('build.nrsl', honest.subarray(0, 8)),
      'a file over the limit': frame(new TextEncoder().encode(dayKey), HISTORY_FILE_LIMIT_BYTES + 1, new Uint8Array(0)),
      'a frame cut off part way': frame(new TextEncoder().encode(dayKey), 100, new Uint8Array(10)),
    }
    for (const [hostility, tail] of Object.entries(hostileTails)) {
      answer = [honest, tail]
      expect({ hostility, entries: await previewOnController() }).toEqual({ hostility, entries: [] })
    }

    answer = [new Uint8Array(0)]
    expect(await previewOnController()).toEqual([])
    answer = [honest]
    expect(await previewOnController()).toEqual([{ group: 'shoppers', query: PHRASE, count: 2 }])
  }, 60_000)

  it('caps the groups of a build at maxGroups across two nodes and two days, in node and key order', async () => {
    const current = newCluster()
    const directory = await mkdtemp(join(tmpdir(), 'narsil-suggestions-'))
    current.directories.push(directory)
    const maxGroups = 3
    const now = Date.now()
    const today = dayOf(now)
    const yesterday = dayOf(now - DAY_MS)

    const controller = await startNode('node-a', ['data', 'coordinator', 'controller'], {})
    await sourceIndexOn(controller)
    const onController = querySuggestions(clusterNodeEngine(controller))
    await onController.updateSetting(SOURCE, { ...SETTING, maxGroups })
    for (const person of ['person-1', 'person-2']) {
      await onController.recordQuery(SOURCE, { query: PHRASE, person, group: 'alpha' })
    }

    const counter = await startNode('node-b', ['coordinator'], { durability: { directory } })
    const onCounter = querySuggestions(clusterNodeEngine(counter))
    for (const person of ['person-1', 'person-2']) {
      expect(await onCounter.recordQuery(SOURCE, { query: PHRASE, person, group: 'beta' })).toEqual({
        recorded: true,
        outcome: 'recorded',
      })
    }
    await onCounter.preview(SOURCE)
    const todayPath = join(directory, '_query-counts', SOURCE, `${today}.nrsl`)
    const todayFile = new Uint8Array(await readFile(todayPath))
    const template = decode(payloadOf(todayFile)) as Record<string, unknown>
    const people = () => [
      globalThis.crypto.getRandomValues(new Uint8Array(SCRAMBLED_ID_BYTES)),
      globalThis.crypto.getRandomValues(new Uint8Array(SCRAMBLED_ID_BYTES)),
    ]
    const earlierDay = encode({
      ...template,
      day: yesterday,
      savedAt: now - DAY_MS,
      groups: {
        yankee: [{ phrase: PHRASE, count: 2, people: people() }],
        zulu: [{ phrase: PHRASE, count: 2, people: people() }],
      },
    })
    const yesterdayPath = join(directory, '_query-counts', SOURCE, `${yesterday}.nrsl`)
    await mkdir(dirname(yesterdayPath), { recursive: true })
    await writeFile(yesterdayPath, envelopeLike(todayFile, earlierDay))

    const build = await onCounter.build(SOURCE)
    expect(build.status).toBe('completed')

    const expected = admittedInOrder(
      [
        { nodeId: 'node-a', key: `${today}.nrsl`, groups: ['alpha'] },
        { nodeId: 'node-b', key: `${yesterday}.nrsl`, groups: ['yankee', 'zulu'] },
        { nodeId: 'node-b', key: `${today}.nrsl`, groups: ['beta'] },
      ],
      maxGroups,
    )
    expect(expected).toEqual(['alpha', 'yankee', 'zulu'])
    const suggestionIndexes = (await controller.listIndexes())
      .map(index => index.name)
      .filter(name => name.startsWith(`${SOURCE}.suggestions.`))
      .sort()
    expect(suggestionIndexes).toEqual(expected.map(group => `${SOURCE}.suggestions.${group}`).sort())
    expect((await onCounter.status(SOURCE)).suggestionIndexes).toEqual(suggestionIndexes)

    const found = await controller.query(`${SOURCE}.suggestions.yankee`, { term: 'trail', prefix: true })
    expect(found.hits.map(hit => hit.id)).toEqual([PHRASE])

    await counter.dropIndex(SOURCE)
    expect((await controller.listIndexes()).map(index => index.name)).toEqual([])
    expect(await current.coordinator.get(`_narsil/query-suggestions/${SOURCE}/build`)).toBeNull()
    await expect(readFile(todayPath)).rejects.toThrow()
    await expect(readFile(yesterdayPath)).rejects.toThrow()
  }, 60_000)
})
