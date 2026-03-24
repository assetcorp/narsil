import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LANGUAGES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  ha: 'Hausa',
  yo: 'Yoruba',
  ig: 'Igbo',
  sw: 'Swahili',
  ee: 'Ewe',
  tw: 'Twi',
  zu: 'Zulu',
  dag: 'Dagbani',
}

const DEFAULT_LIMIT = 10_000
const API_BATCH_SIZE = 50
const RATE_LIMIT_MS = 100

interface WikiArticle {
  id: string
  title: string
  text: string
  language: string
  length: number
  categories: string[]
}

interface WikiApiPage {
  pageid: number
  title: string
  extract?: string
  categories?: Array<{ title: string }>
}

interface WikiApiResponse {
  query?: {
    pages?: Record<string, WikiApiPage>
  }
  continue?: {
    gapcontinue?: string
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchArticles(langCode: string, limit: number): Promise<WikiArticle[]> {
  const articles: WikiArticle[] = []
  let continueFrom = ''
  const seenIds = new Set<string>()

  console.log(`  Fetching up to ${limit} articles from ${langCode}.wikipedia.org...`)

  while (articles.length < limit) {
    const remaining = Math.min(API_BATCH_SIZE, limit - articles.length)
    const params = new URLSearchParams({
      action: 'query',
      format: 'json',
      generator: 'allpages',
      gapnamespace: '0',
      gaplimit: String(remaining),
      prop: 'extracts|categories',
      exintro: '0',
      explaintext: '1',
      exlimit: String(remaining),
      cllimit: '20',
      clshow: '!hidden',
    })

    if (continueFrom) {
      params.set('gapcontinue', continueFrom)
    }

    const url = `https://${langCode}.wikipedia.org/w/api.php?${params.toString()}`

    let data: WikiApiResponse
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'NarsilSearchDemo/1.0 (https://github.com/delali/narsil)' },
      })
      if (!response.ok) {
        console.error(`    HTTP ${response.status} from ${langCode}.wikipedia.org`)
        break
      }
      data = (await response.json()) as WikiApiResponse
    } catch (err) {
      console.error(`    Fetch error: ${err}`)
      break
    }

    const pages = data.query?.pages
    if (!pages) {
      console.log('    No more pages returned')
      break
    }

    for (const page of Object.values(pages)) {
      const id = String(page.pageid)
      if (seenIds.has(id)) continue
      seenIds.add(id)

      const text = page.extract ?? ''
      if (text.length < 50) continue

      const categories = (page.categories ?? [])
        .map(c => c.title.replace(/^[^:]+:/, '').trim())
        .filter(c => c.length > 0)

      articles.push({
        id,
        title: page.title,
        text,
        language: langCode,
        length: text.length,
        categories,
      })
    }

    if (!data.continue?.gapcontinue) {
      console.log(`    Exhausted available articles at ${articles.length}`)
      break
    }
    continueFrom = data.continue.gapcontinue

    if (articles.length % 500 === 0 || articles.length >= limit) {
      console.log(`    ${articles.length} / ${limit}`)
    }

    await sleep(RATE_LIMIT_MS)
  }

  return articles
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  const langArg = args.find(a => a.startsWith('--lang='))
  const limitArg = args.find(a => a.startsWith('--limit='))

  const selectedLangs = langArg
    ? langArg
        .replace('--lang=', '')
        .split(',')
        .filter(l => l in LANGUAGES)
    : Object.keys(LANGUAGES)

  const limit = limitArg ? parseInt(limitArg.replace('--limit=', ''), 10) : DEFAULT_LIMIT

  if (selectedLangs.length === 0) {
    console.error('No valid languages selected.')
    console.error(`Available: ${Object.keys(LANGUAGES).join(', ')}`)
    process.exit(1)
  }

  console.log('Wikipedia article fetcher for Narsil examples')
  console.log(`Languages: ${selectedLangs.map(l => `${l} (${LANGUAGES[l]})`).join(', ')}`)
  console.log(`Limit per language: ${limit}`)

  const outputDir = resolve(__dirname, '..', '..', '..', 'data', 'processed', 'wikipedia')
  mkdirSync(outputDir, { recursive: true })

  for (const lang of selectedLangs) {
    console.log(`\n[${lang}] ${LANGUAGES[lang]}`)
    const articles = await fetchArticles(lang, limit)

    if (articles.length === 0) {
      console.log(`  No articles fetched, skipping`)
      continue
    }

    const path = resolve(outputDir, `wikipedia-${lang}.json`)
    writeFileSync(path, JSON.stringify(articles) + '\n')
    const sizeMB = (Buffer.byteLength(JSON.stringify(articles)) / 1024 / 1024).toFixed(1)
    console.log(`  Written: ${path} (${articles.length} articles, ${sizeMB} MB)`)

    const avgLength = Math.round(articles.reduce((s, a) => s + a.length, 0) / articles.length)
    const totalCategories = articles.reduce((s, a) => s + a.categories.length, 0)
    console.log(`  Avg article length: ${avgLength} chars`)
    console.log(
      `  Total categories: ${totalCategories} (avg ${(totalCategories / articles.length).toFixed(1)} per article)`,
    )
  }

  console.log('\nDone.')
}

main()
