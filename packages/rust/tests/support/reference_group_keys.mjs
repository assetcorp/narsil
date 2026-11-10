import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const documents = JSON.parse(readFileSync(spec.documentsPath, 'utf8'))

function groupsOf(result) {
  return result.groups.map(group => ({ values: group.values, ids: group.hits.map(hit => hit.id) }))
}

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  await narsil.createIndex(spec.index, spec.config)
  const inserted = await narsil.insertBatch(spec.index, documents)
  if (inserted.failed.length > 0) {
    throw new Error(`the reference refused ${inserted.failed.length} documents: ${JSON.stringify(inserted.failed[0])}`)
  }
  const inserts = groupsOf(await narsil.query(spec.index, spec.query))
  for (const id of spec.rewritten) {
    const held = await narsil.get(spec.index, id)
    if (held === undefined) throw new Error(`the reference holds no document "${id}"`)
    await narsil.update(spec.index, id, { ...held, [spec.rewrittenField]: spec.rewrittenValue })
  }
  const rewrites = groupsOf(await narsil.query(spec.index, spec.query))
  process.stdout.write(JSON.stringify({ inserts, rewrites }))
} finally {
  await narsil.shutdown()
}
