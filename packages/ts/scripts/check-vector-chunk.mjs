import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const SEARCH_FUNCTIONS = [
  'searchLayer',
  'rescoreWithFullPrecision',
  'osqEstimate',
  'distanceFrom',
  'centroidDotNow',
  'simdQueryProducts',
  'arenaFloat32Distance',
  'magnitude',
]

const files = readdirSync(dist)
  .filter(name => name.endsWith('.mjs'))
  .map(name => ({ name, text: readFileSync(resolve(dist, name), 'utf8') }))

const holders = new Map()
for (const search of SEARCH_FUNCTIONS) {
  const declaration = `function ${search}(`
  holders.set(
    search,
    files.filter(file => file.text.includes(declaration)).map(file => file.name),
  )
}

const chunks = new Set([...holders.values()].flat())
if (chunks.size !== 1 || [...holders.values()].some(names => names.length !== 1)) {
  console.error('FAIL the functions that every vector search calls must share one chunk of dist/:')
  for (const [search, names] of holders) console.error(`  ${search}: ${names.join(', ') || 'in no chunk'}`)
  console.error(
    'A later search measures slower when they split. A module that a dynamic import reaches, such as src/persistence/paged/cold-module.ts, must reach all of them or none, and only src/persistence/paged/cold-module.ts may import vector code for on-disk search.',
  )
  process.exit(1)
}

console.log(`ok  the functions that every vector search calls share ${[...chunks][0]}`)
