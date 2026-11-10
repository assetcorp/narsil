import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))

function failureOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: { code: error.code, message: error.message } }
  }
  throw error
}

function hitsOf(hits) {
  return hits.map(hit => ({ id: hit.id, score: hit.score ?? null }))
}

async function everyPage(narsil, params) {
  const hits = []
  const cursors = []
  let page = await narsil.listDocuments(spec.index, params)
  for (;;) {
    for (const document of page.documents) hits.push({ id: document.id, score: null })
    if (page.cursor === null || page.cursor === undefined) break
    cursors.push(page.cursor)
    page = await narsil.listDocuments(spec.index, { ...params, cursor: page.cursor })
  }
  return { count: page.total, hits, cursor: cursors.length === 0 ? null : cursors[0] }
}

async function answer(narsil, operation) {
  if (operation.kind === 'listAll') return everyPage(narsil, operation.params)
  if (operation.kind === 'list') {
    const page = await narsil.listDocuments(spec.index, operation.params)
    return {
      count: page.total,
      hits: page.documents.map(document => ({ id: document.id, score: null })),
      cursor: page.cursor ?? null,
    }
  }
  if (operation.kind === 'preflight') {
    const counted = await narsil.preflight(spec.index, operation.params)
    return { count: counted.count, hits: [] }
  }
  const result = await narsil.query(spec.index, operation.params)
  return { count: result.count, hits: hitsOf(result.hits) }
}

async function engineOf() {
  try {
    return { narsil: await createNarsil({ workers: { enabled: false }, ...(spec.engine ?? {}) }) }
  } catch (error) {
    return { refused: failureOf(error) }
  }
}

const opened = await engineOf()
if (opened.refused !== undefined) {
  process.stdout.write(JSON.stringify({ refused: opened.refused.error, results: [] }))
} else {
  const { narsil } = opened
  try {
    await narsil.createIndex(spec.index, spec.config)
    for (const step of spec.writes) {
      if (step.kind === 'insert') {
        const result = await narsil.insertBatch(spec.index, step.documents)
        if (result.failed.length > 0) throw new Error(`the reference refused ${JSON.stringify(result.failed[0])}`)
      } else if (step.kind === 'remove') {
        for (const id of step.ids) await narsil.remove(spec.index, id)
      } else if (step.kind === 'update') {
        for (const [id, document] of step.documents) await narsil.update(spec.index, id, document)
      }
    }
    const results = []
    for (const operation of spec.operations) {
      try {
        results.push(await answer(narsil, operation))
      } catch (error) {
        results.push(failureOf(error))
      }
    }
    process.stdout.write(JSON.stringify({ results }))
  } finally {
    await narsil.shutdown()
  }
}
