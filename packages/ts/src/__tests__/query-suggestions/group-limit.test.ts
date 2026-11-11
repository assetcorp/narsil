import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../narsil'
import { createMemoryPersistence } from '../../persistence/memory'
import { querySuggestions } from '../../query-suggestions'
import type { PersistenceAdapter } from '../../types/adapters'
import type { Narsil } from '../../types/engine'

const KEY = new Uint8Array(32).fill(7)
const SOURCE = 'articles'
const PHRASE = 'desk lamp'
const MAX_GROUPS = 3
const HEADER_BYTES = 32
const LEADING_HEADER_BYTES = 8
const CHECKSUM_FLAG = 0x0008
const NRSL_MAGIC = [0x4e, 0x52, 0x53, 0x4c]
const SCRAMBLED_ID_BYTES = 16
const DAY_MS = 86_400_000
const CRC32_POLYNOMIAL = 0xedb88320

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
  expect([...file.subarray(0, NRSL_MAGIC.length)]).toEqual(NRSL_MAGIC)
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

function historyKey(day: string): string {
  return `_query-counts/${SOURCE}/${day}.nrsl`
}

function scrambledId(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(SCRAMBLED_ID_BYTES))
}

function groupsOfFile(file: Uint8Array): string[] {
  const payload = decode(payloadOf(file)) as { groups: Record<string, unknown> }
  return Object.keys(payload.groups)
}

function admittedInKeyOrder(files: Array<{ key: string; groups: string[] }>, maxGroups: number): string[] {
  const admitted: string[] = []
  for (const file of [...files].sort((left, right) => (left.key < right.key ? -1 : 1))) {
    for (const group of file.groups) {
      if (!admitted.includes(group) && admitted.length < maxGroups) admitted.push(group)
    }
  }
  return admitted
}

async function loaded(storage: PersistenceAdapter, key: string): Promise<Uint8Array> {
  const bytes = await storage.load(key)
  if (bytes === null) throw new Error(`The engine wrote no file at ${key}`)
  return bytes
}

function openEngine(storage: PersistenceAdapter): Promise<Narsil> {
  return createNarsil({ persistence: storage, durability: { tier: 'snapshot' }, querySuggestions: { key: KEY } })
}

function suggestionIndexesOf(engine: Narsil): string[] {
  return engine
    .listIndexes()
    .map(index => index.name)
    .filter(name => name.startsWith(`${SOURCE}.suggestions.`))
    .sort()
}

describe('the group limit of popular query suggestions across days of history', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  it('refuses a new group that earlier days already fill, and builds no more suggestions indexes than maxGroups', async () => {
    const storage = createMemoryPersistence()
    const now = Date.now()
    const today = dayOf(now)
    const yesterday = dayOf(now - DAY_MS)

    engine = await openEngine(storage)
    await engine.createIndex(SOURCE, { schema: { title: 'string' } })
    await engine.insert(SOURCE, { title: PHRASE }, 'lamp')
    await querySuggestions(engine).updateSetting(SOURCE, {
      enabled: true,
      fields: ['title'],
      minPeople: 2,
      minResults: 1,
      maxGroups: MAX_GROUPS,
      schedule: 'off',
    })
    for (const group of ['alpha', 'beta']) {
      for (const person of ['person-1', 'person-2']) {
        const recorded = await querySuggestions(engine).recordQuery(SOURCE, { query: PHRASE, person, group })
        expect(recorded).toEqual({ recorded: true, outcome: 'recorded' })
      }
    }
    await engine.shutdown()
    engine = null

    const todayFile = await loaded(storage, historyKey(today))
    const { keyFingerprint } = decode(payloadOf(todayFile)) as { keyFingerprint: Uint8Array }
    const earlierDay = encode({
      day: yesterday,
      keyFingerprint,
      savedAt: now - DAY_MS,
      groups: {
        yankee: [{ phrase: PHRASE, count: 2, people: [scrambledId(), scrambledId()] }],
        zulu: [{ phrase: PHRASE, count: 2, people: [scrambledId(), scrambledId()] }],
      },
    })
    await storage.save(historyKey(yesterday), envelopeLike(todayFile, earlierDay))

    engine = await openEngine(storage)
    const suggestions = querySuggestions(engine)
    const refused = await suggestions.recordQuery(SOURCE, { query: PHRASE, person: 'person-3', group: 'centre' })
    expect(refused).toEqual({ recorded: false, outcome: 'group-limit' })
    const known = await suggestions.recordQuery(SOURCE, { query: PHRASE, person: 'person-3', group: 'zulu' })
    expect(known).toEqual({ recorded: true, outcome: 'recorded' })

    const build = await suggestions.build(SOURCE)
    expect(build.status).toBe('completed')
    const expected = admittedInKeyOrder(
      [
        { key: historyKey(yesterday), groups: groupsOfFile(await loaded(storage, historyKey(yesterday))) },
        { key: historyKey(today), groups: groupsOfFile(await loaded(storage, historyKey(today))) },
      ],
      MAX_GROUPS,
    )
    expect(expected).toEqual(['yankee', 'zulu', 'alpha'])
    expect(suggestionIndexesOf(engine)).toEqual(expected.map(group => `${SOURCE}.suggestions.${group}`).sort())

    const afterBuild = await suggestions.recordQuery(SOURCE, { query: PHRASE, person: 'person-4', group: 'beta' })
    expect(afterBuild).toEqual({ recorded: true, outcome: 'recorded' })
    const rebuilt = await suggestions.build(SOURCE)
    expect(rebuilt.status).toBe('completed')
    expect(suggestionIndexesOf(engine).length).toBeLessThanOrEqual(MAX_GROUPS)
    expect(suggestionIndexesOf(engine)).toEqual(expected.map(group => `${SOURCE}.suggestions.${group}`).sort())
  })
})
