import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const distEntry = new URL('../../../ts/dist/index.mjs', import.meta.url)
const { createNarsil } = await import(distEntry.href)

async function bytesOf(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function started() {
  return createNarsil({ workers: { enabled: false } })
}

function valueKindDocuments() {
  return [
    {
      id: 'integers',
      title: 'kinds',
      note: 'first',
      small: 7,
      negative: -3,
      wide: 2 ** 40,
      limit: Number.MAX_SAFE_INTEGER,
    },
    { id: 'floats', title: 'kinds', note: 'first', half: 1.5, tiny: 5e-324, huge: 1.7976931348623157e308 },
    { id: 'negative-zero', title: 'kinds', note: 'first', zero: -0, beside: 4, nested: { count: 9, list: [2, -0] } },
    {
      id: 'strings',
      title: 'kinds',
      note: 'first',
      empty: '',
      accented: 'naïve',
      surrogatePair: String.fromCodePoint(0x20000),
      long: 'x'.repeat(70000),
    },
    { id: 'binary', title: 'kinds', note: 'first', bytes: new Uint8Array([0, 255, 1, 128]), empty: new Uint8Array(0) },
    {
      id: 'dates',
      title: 'kinds',
      note: 'first',
      recent: new Date(1700000000123),
      early: new Date(-1),
      epoch: new Date(0),
    },
    {
      id: 'nested',
      title: 'kinds',
      note: 'first',
      outer: { z: 1, a: { m: [1, 'x', { q: true, b: null }], c: 2.5 }, 7: 'seven', 2: 'two' },
      list: [[3, 1], [], {}],
    },
  ]
}

async function groupsOf(engine, request) {
  const result = await engine.query(request.index, request.query)
  return result.groups.map(group => ({
    keys: Object.keys(group.values[request.field]),
    ids: group.hits.map(hit => hit.id),
  }))
}

async function groups(request) {
  const engine = await started()
  try {
    await engine.createIndex(request.index, request.config)
    for (const document of request.documents) await engine.insert(request.index, document)
    writeFileSync(join(request.directory, 'groups.json'), JSON.stringify(await groupsOf(engine, request)))
    writeFileSync(join(request.directory, 'snapshot.nrsl'), await bytesOf(await engine.snapshot(request.index)))
    for (const update of request.updates) {
      const held = await engine.get(request.index, update.id)
      await engine.update(request.index, update.id, { ...held, title: update.title })
    }
    writeFileSync(join(request.directory, 'groups-updated.json'), JSON.stringify(await groupsOf(engine, request)))
  } finally {
    await engine.shutdown()
  }
}

async function kinds(request) {
  const documents = valueKindDocuments()
  const inserting = await started()
  try {
    await inserting.createIndex(request.index, request.config)
    for (const document of documents) await inserting.insert(request.index, document)
    writeFileSync(join(request.directory, 'inserted.nrsl'), await bytesOf(await inserting.snapshot(request.index)))
  } finally {
    await inserting.shutdown()
  }
  const updating = await started()
  try {
    await updating.restore(request.index, new Uint8Array(readFileSync(join(request.directory, 'inserted.nrsl'))))
    for (const { id } of documents) {
      const held = await updating.get(request.index, id)
      await updating.update(request.index, id, { ...held, note: request.note })
    }
    writeFileSync(join(request.directory, 'updated.nrsl'), await bytesOf(await updating.snapshot(request.index)))
    writeFileSync(join(request.directory, 'ids.json'), JSON.stringify(documents.map(document => document.id)))
  } finally {
    await updating.shutdown()
  }
}

const request = JSON.parse(readFileSync(process.argv[2], 'utf8'))
if (request.mode === 'groups') await groups(request)
else if (request.mode === 'kinds') await kinds(request)
else throw new Error(`unknown mode ${request.mode}`)
