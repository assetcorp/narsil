import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [repositoryRoot, specPath] = process.argv.slice(2)
const { createNarsil } = await import(pathToFileURL(join(repositoryRoot, 'packages/ts/dist/index.mjs')).href)
const spec = JSON.parse(readFileSync(specPath, 'utf8'))
const documents = readFileSync(spec.documentsPath, 'utf8')
  .split('\n')
  .filter(line => line.length > 0)
  .map(line => JSON.parse(line))

const reducers = {
  scoreSum: {
    initialValue: () => 0,
    reducer: (accumulator, _document, score) => accumulator + score,
  },
  yearList: {
    initialValue: () => [],
    reducer: (accumulator, document) => [...accumulator, document.year ?? null],
  },
  failsOnOddYear: {
    initialValue: () => 0,
    reducer: (accumulator, document) => {
      if (typeof document.year === 'number' && document.year % 2 === 1) {
        throw new Error(`the year ${document.year} is odd`)
      }
      return accumulator + 1
    },
  },
}

function withReducer(params) {
  const reduce = params.group?.reduce
  if (typeof reduce !== 'string') return params
  return { ...params, group: { ...params.group, reduce: reducers[reduce] } }
}

function outcomeOf(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return { error: { code: error.code, message: error.message } }
  }
  throw error
}

function hitOf(hit) {
  return {
    id: hit.id,
    score: hit.score ?? null,
    document: hit.document,
    scoreComponents: hit.scoreComponents ?? null,
    highlights: hit.highlights ?? null,
  }
}

function groupOf(group) {
  return {
    values: group.values,
    hits: group.hits.map(hitOf),
    reduced: group.reduced === undefined ? null : group.reduced,
    reducerError: group.reducerError ?? null,
  }
}

function pageOf(result) {
  return {
    count: result.count,
    countExact: result.countExact,
    cursor: result.cursor ?? null,
    hits: result.hits.map(hitOf),
    facets: result.facets ?? null,
    groups: result.groups === undefined ? null : result.groups.map(groupOf),
  }
}

const narsil = await createNarsil({ workers: { enabled: false } })
try {
  await narsil.createIndex(spec.index, spec.config)
  for (let start = 0; start < documents.length; start += spec.batch) {
    const result = await narsil.insertBatch(spec.index, documents.slice(start, start + spec.batch))
    if (result.failed.length > 0) {
      throw new Error(`the reference refused ${result.failed.length} documents: ${JSON.stringify(result.failed[0])}`)
    }
  }
  const late = await narsil.insertBatch(spec.index, spec.lateDocuments)
  if (late.failed.length > 0) {
    throw new Error(`the reference refused ${late.failed.length} late documents: ${JSON.stringify(late.failed[0])}`)
  }
  for (const id of spec.removals) await narsil.remove(spec.index, id)
  for (const [id, document] of spec.updates) await narsil.update(spec.index, id, document)
  const results = []
  for (const step of spec.queries) {
    const pages = []
    const { $next, ...first } = step.params
    let params = withReducer(first)
    for (let page = 0; page < step.pages; page++) {
      try {
        const result = await narsil.query(spec.index, params)
        pages.push(pageOf(result))
        if (result.cursor === undefined) break
        params = { ...withReducer({ ...first, ...($next ?? {}) }), searchAfter: result.cursor }
      } catch (error) {
        pages.push(outcomeOf(error))
        break
      }
    }
    results.push(pages)
  }
  process.stdout.write(JSON.stringify({ results }))
} finally {
  await narsil.shutdown()
}
