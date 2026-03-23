import { createReadStream, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const TIERS = [1_000, 5_000, 10_000, 50_000, 100_000] as const

interface TmdbMovie {
  id: string
  title: string
  overview: string
  tagline: string
  genres: string[]
  original_language: string
  vote_average: number
  popularity: number
  runtime: number
  revenue: number
  release_year: number
  production_countries: string[]
  status: string
}

interface CsvRow {
  id: string
  title: string
  overview: string
  tagline: string
  genres: string
  original_language: string
  vote_average: string
  popularity: string
  runtime: string
  revenue: string
  release_date: string
  production_countries: string
  status: string
  adult: string
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

function splitList(value: string): string[] {
  if (!value.trim()) return []
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

function parseFloat0(value: string): number {
  const n = parseFloat(value)
  return Number.isFinite(n) ? n : 0
}

function parseInt0(value: string): number {
  const n = parseInt(value, 10)
  return Number.isFinite(n) ? n : 0
}

function extractYear(releaseDate: string): number {
  const match = releaseDate.match(/^(\d{4})/)
  if (!match) return 0
  return parseInt(match[1], 10)
}

function transformRow(row: CsvRow): TmdbMovie | null {
  const title = row.title.trim()
  const overview = row.overview.trim()
  const genres = splitList(row.genres)
  const releaseYear = extractYear(row.release_date.trim())
  const adult = row.adult.trim()
  const status = row.status.trim()

  if (!title || overview.length < 20 || genres.length === 0 || releaseYear === 0) return null
  if (adult === 'True' || status !== 'Released') return null

  return {
    id: row.id.trim(),
    title,
    overview,
    tagline: row.tagline.trim(),
    genres,
    original_language: row.original_language.trim(),
    vote_average: Math.round(parseFloat0(row.vote_average) * 10) / 10,
    popularity: Math.round(parseFloat0(row.popularity) * 100) / 100,
    runtime: parseInt0(row.runtime),
    revenue: parseInt0(row.revenue),
    release_year: releaseYear,
    production_countries: splitList(row.production_countries),
    status,
  }
}

async function main(): Promise<void> {
  const csvPath = process.argv[2]
  if (!csvPath) {
    console.error('Usage: npx tsx scripts/convert-tmdb.ts <csv-path>')
    console.error('  <csv-path>: path to TMDB_movie_dataset_v11.csv')
    process.exit(1)
  }

  const outputDir = resolve(__dirname, '..', '..', '..', 'data', 'processed', 'tmdb')
  mkdirSync(outputDir, { recursive: true })

  console.log('Reading and filtering TMDB dataset...')

  const rl = createInterface({
    input: createReadStream(resolve(csvPath)),
    crlfDelay: Infinity,
  })

  let headers: string[] = []
  let lineNumber = 0
  const movies: TmdbMovie[] = []

  for await (const line of rl) {
    lineNumber++
    if (lineNumber === 1) {
      headers = parseCsvLine(line)
      continue
    }

    const fields = parseCsvLine(line)
    if (fields.length !== headers.length) continue

    const row: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = fields[i]
    }

    const movie = transformRow(row as unknown as CsvRow)
    if (movie) {
      movies.push(movie)
    }
  }

  console.log(`  ${lineNumber - 1} rows read, ${movies.length} passed quality filter`)

  movies.sort((a, b) => b.popularity - a.popularity)
  console.log(`  sorted by popularity (descending)`)

  const genreCounts = new Map<string, number>()
  const languageCounts = new Map<string, number>()
  for (const m of movies) {
    for (const g of m.genres) genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1)
    languageCounts.set(m.original_language, (languageCounts.get(m.original_language) ?? 0) + 1)
  }

  console.log('\n  Top genres:')
  for (const [g, c] of [...genreCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`    ${g}: ${c}`)
  }

  console.log('\n  Top languages:')
  for (const [l, c] of [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`    ${l}: ${c}`)
  }

  const yearRange = movies.reduce(
    (acc, m) => ({ min: Math.min(acc.min, m.release_year), max: Math.max(acc.max, m.release_year) }),
    { min: Infinity, max: -Infinity },
  )
  console.log(`\n  Year range: ${yearRange.min} - ${yearRange.max}`)

  console.log('\nWriting tier files...')
  for (const tier of TIERS) {
    if (tier > movies.length) {
      console.log(`  skipping ${tier} tier (only ${movies.length} movies available)`)
      continue
    }
    const slice = movies.slice(0, tier)
    const path = resolve(outputDir, `movies-${tier}.json`)
    writeFileSync(path, `${JSON.stringify(slice)}\n`)
    const sizeMB = (Buffer.byteLength(JSON.stringify(slice)) / 1024 / 1024).toFixed(1)
    console.log(`  ${path} (${tier} movies, ${sizeMB} MB)`)
  }

  const allPath = resolve(outputDir, 'movies-all.json')
  writeFileSync(allPath, `${JSON.stringify(movies)}\n`)
  const allSizeMB = (Buffer.byteLength(JSON.stringify(movies)) / 1024 / 1024).toFixed(1)
  console.log(`  ${allPath} (${movies.length} movies, ${allSizeMB} MB)`)

  console.log('\nDone.')
}

main()
