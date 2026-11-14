import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { bytesOf } from '../e2e/portability/archive-oracle'

type Row = { id: string; title: string; value?: unknown; other: string }

function sameElement(left: unknown, right: unknown): boolean {
  return left === right || isDeepStrictEqual(left, right)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined || left === null) return right === undefined || right === null
  if (Array.isArray(left))
    return (
      Array.isArray(right) && left.length === right.length && left.every((value, at) => sameElement(value, right[at]))
    )
  return !Array.isArray(right) && sameElement(left, right)
}

function binaryValues(value: unknown): unknown {
  if (value instanceof Uint8Array) return Uint8Array.from(value)
  if (Array.isArray(value)) return value.map(binaryValues)
  if (value === null || typeof value !== 'object' || value instanceof Date) return value
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, binaryValues(entry)]))
}

async function checkGroups(engine: Narsil, rows: ReadonlyMap<string, Row>): Promise<void> {
  await engine.waitForWrites('catalogue')
  const expected: Row[][] = []
  for (const row of [...rows.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))) {
    const group = expected.find(group => sameValue(row.value, group[0].value) && row.other === group[0].other)
    if (group === undefined) expected.push([row])
    else group.push(row)
  }
  const answer = await engine.query('catalogue', {
    term: 'catalogue',
    fields: ['title'],
    bm25: { b: 0 },
    document: false,
    group: {
      fields: ['value', 'other'],
      maxPerGroup: 1,
      reduce: {
        initialValue: () => [],
        reducer: (members, row) => (Array.isArray(members) ? [...members, row.id] : []),
      },
    },
  })
  expect(answer.groups).toHaveLength(expected.length)
  for (let at = 0; at < expected.length; at++) {
    const found = answer.groups?.[at]
    const members = expected[at].slice(0, 1)
    expect(found?.hits.map(hit => hit.id)).toEqual(members.map(row => row.id))
    expect(found?.reduced).toEqual(expected[at].map(row => row.id))
    expect(binaryValues(found?.values)).toEqual({
      value: expected[at][0].value ?? null,
      other: expected[at][0].other ?? null,
    })
    expect(found?.hits.map(hit => binaryValues(hit.document))).toEqual(members.map(() => ({})))
  }
}

it('keeps group membership through stored-field changes, recovery, and restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-stored-groups-'))
  const options = {
    durability: { directory },
    workers: { enabled: false },
  }
  let engine = await createNarsil(options)
  const rows = new Map<string, Row>()
  const values: unknown[] = [
    undefined,
    null,
    [],
    [null],
    NaN,
    [NaN],
    Infinity,
    -Infinity,
    0,
    -0,
    `\ufeff${'x'.repeat(198)}`,
    { [`\ufeff${'key'.repeat(80)}`]: [new Date('2020-01-02T03:04:05.000Z'), new Uint8Array([0xef, 0xbb, 0xbf])] },
  ]
  try {
    await engine.createIndex('catalogue', { schema: { title: 'string' }, textStorage: 'disk' })
    for (let at = 0; at < 48; at++) {
      const row: Row = {
        id: `row-${String(at).padStart(3, '0')}`,
        title: 'catalogue',
        ...(values[at % values.length] === undefined ? {} : { value: values[at % values.length] }),
        other: String(at % 2),
      }
      rows.set(row.id, row)
    }
    expect((await engine.insertBatch('catalogue', [...rows.values()])).failed).toEqual([])
    await checkGroups(engine, rows)
    for (const row of rows.values()) {
      const at = Number(row.id.slice(4))
      row.value = at % 3 === 0 ? [0, 1, `\ufeff${'y'.repeat(300)}`] : values[(at + 1) % values.length]
      if (row.value === undefined) delete row.value
      row.title = at % 2 === 0 ? 'catalogue edition' : 'catalogue'
      if (at % 7 === 0) {
        await engine.remove('catalogue', row.id)
        await engine.insert('catalogue', row)
      } else await engine.update('catalogue', row.id, row)
    }
    await checkGroups(engine, rows)
    await engine.checkpoint('catalogue')
    await engine.shutdown()
    engine = await createNarsil(options)
    await checkGroups(engine, rows)
    const snapshot = await bytesOf(await engine.snapshot('catalogue'))
    await engine.dropIndex('catalogue')
    await engine.restore('catalogue', snapshot)
    await checkGroups(engine, rows)
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
