import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createGunzip } from 'node:zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(__dirname, '..', '.cache')
const CACHE_PATH = resolve(CACHE_DIR, 'wiki-abstracts.json')
const DUMP_URL = 'https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-abstract.xml.gz'

export interface WikiArticle {
  title: string
  body: string
}

export async function downloadWikiAbstracts(maxCount: number): Promise<WikiArticle[]> {
  console.log('  downloading Simple English Wikipedia abstracts from dumps.wikimedia.org...')
  console.log('  this may take a few minutes on first run')

  const response = await fetch(DUMP_URL)
  if (!response.ok || !response.body) {
    throw new Error(`failed to download: ${response.status} ${response.statusText}`)
  }

  const gunzip = createGunzip()
  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  nodeStream.pipe(gunzip)

  const MAX_BUFFER_SIZE = 10 * 1024 * 1024

  let buffer = ''
  const articles: WikiArticle[] = []
  let inDoc = false

  try {
    for await (const chunk of gunzip) {
      buffer += chunk.toString('utf-8')

      if (!inDoc && buffer.length > MAX_BUFFER_SIZE) {
        buffer = buffer.slice(-1024)
      }

      while (articles.length < maxCount) {
        if (!inDoc) {
          const docStart = buffer.indexOf('<doc>')
          if (docStart === -1) {
            if (buffer.length > 1024) buffer = buffer.slice(-1024)
            break
          }
          buffer = buffer.slice(docStart)
          inDoc = true
        }

        const docEnd = buffer.indexOf('</doc>')
        if (docEnd === -1) break

        const docContent = buffer.slice(0, docEnd + 6)
        buffer = buffer.slice(docEnd + 6)
        inDoc = false

        const titleMatch = docContent.match(/<title>Wikipedia:\s*(.*?)<\/title>/)
        const abstractMatch = docContent.match(/<abstract>([\s\S]*?)<\/abstract>/)

        if (titleMatch && abstractMatch) {
          const title = titleMatch[1].trim()
          const body = abstractMatch[1].trim()
          if (title.length > 0 && body.length > 0) {
            articles.push({ title, body })
          }
        }
      }

      if (articles.length >= maxCount) break
    }
  } finally {
    nodeStream.destroy()
    gunzip.destroy()
  }

  return articles.slice(0, maxCount)
}

export async function loadWikiArticles(maxCount = 100_000): Promise<WikiArticle[] | null> {
  if (existsSync(CACHE_PATH)) {
    console.log(`  loading cached wiki abstracts from ${CACHE_PATH}`)
    const raw = await readFile(CACHE_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.log('  cache file has invalid format, ignoring')
      return null
    }
    const articles = parsed as WikiArticle[]
    console.log(`  loaded ${articles.length} articles from cache`)
    return articles.slice(0, maxCount)
  }

  console.log(`  wiki cache not found at ${CACHE_PATH}`)
  console.log('  run with --download-wiki to download and cache the dataset')
  return null
}

export async function downloadAndCacheWiki(maxCount = 100_000): Promise<WikiArticle[]> {
  const articles = await downloadWikiAbstracts(maxCount)

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_PATH, JSON.stringify(articles))
  console.log(`  cached ${articles.length} articles to ${CACHE_PATH}`)

  return articles
}

export function generateWikiQueries(articles: WikiArticle[], count: number, seed: number): string[] {
  let s = seed | 0
  const rng = () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const article = articles[Math.floor(rng() * articles.length)]
    const words = article.title.split(/\s+/).filter(w => w.length > 2)
    if (words.length === 0) {
      queries.push(article.title)
      continue
    }
    const wordCount = 1 + Math.floor(rng() * Math.min(3, words.length))
    const startIdx = Math.floor(rng() * Math.max(1, words.length - wordCount + 1))
    queries.push(words.slice(startIdx, startIdx + wordCount).join(' '))
  }
  return queries
}

export function generateWikiMultiTermQueries(articles: WikiArticle[], count: number, seed: number): string[] {
  let s = seed | 0
  const rng = () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const queries: string[] = []
  for (let i = 0; i < count; i++) {
    const article = articles[Math.floor(rng() * articles.length)]
    const bodyWords = article.body.split(/\s+/).filter(w => w.length > 3)
    if (bodyWords.length < 2) {
      queries.push(article.title)
      continue
    }
    const wordCount = 2 + Math.floor(rng() * 2)
    const selected: string[] = []
    for (let j = 0; j < wordCount && j < bodyWords.length; j++) {
      const idx = Math.floor(rng() * bodyWords.length)
      selected.push(bodyWords[idx])
    }
    queries.push(selected.join(' '))
  }
  return queries
}
