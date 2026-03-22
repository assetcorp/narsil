import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Readable, type Transform } from 'node:stream'
import { fileURLToPath } from 'node:url'

// @ts-expect-error no type declarations
import unbzip2 from 'unbzip2-stream'

import { CATEGORIES } from './data'
import type { BenchDocument } from './types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = resolve(__dirname, '..', '.cache')
const CACHE_PATH = resolve(CACHE_DIR, 'wiki-articles.json')
const DUMP_URL = 'https://dumps.wikimedia.org/simplewiki/latest/simplewiki-latest-pages-articles.xml.bz2'

export interface WikiArticle {
  title: string
  body: string
}

function stripWikiMarkup(text: string): string {
  let result = text
  result = result.replace(/\{\{[^}]*\}\}/g, '')
  result = result.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
  result = result.replace(/\[https?:\/\/[^\s\]]+ ([^\]]*)\]/g, '$1')
  result = result.replace(/\[https?:\/\/[^\]]*\]/g, '')
  result = result.replace(/'{2,3}/g, '')
  result = result.replace(/={2,}[^=]+={2,}/g, '')
  result = result.replace(/<ref[^>]*\/>/g, '')
  result = result.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
  result = result.replace(/<[^>]+>/g, '')
  result = result.replace(/\n{2,}/g, '\n')
  return result.trim()
}

function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function wikiToBenchDocuments(articles: WikiArticle[]): BenchDocument[] {
  return articles.map((article, i) => ({
    id: `wiki-${String(i).padStart(7, '0')}`,
    title: article.title,
    body: article.body,
    score: article.body.length % 100,
    category: CATEGORIES[fnv1aHash(article.title) % CATEGORIES.length],
  }))
}

export async function downloadWikiArticles(maxCount: number): Promise<WikiArticle[]> {
  console.log('  downloading Simple English Wikipedia articles from dumps.wikimedia.org...')
  console.log('  this may take a few minutes on first run')

  const response = await fetch(DUMP_URL)
  if (!response.ok || !response.body) {
    throw new Error(`failed to download: ${response.status} ${response.statusText}`)
  }

  const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  const decompressed = nodeStream.pipe(unbzip2() as Transform)

  const MAX_BUFFER_SIZE = 10 * 1024 * 1024
  let buffer = ''
  const articles: WikiArticle[] = []
  let inPage = false

  decompressed.on('error', () => {})
  nodeStream.on('error', () => {})

  for await (const chunk of decompressed) {
    buffer += chunk.toString('utf-8')

    if (!inPage && buffer.length > MAX_BUFFER_SIZE) {
      buffer = buffer.slice(-2048)
    }

    while (articles.length < maxCount) {
      if (!inPage) {
        const pageStart = buffer.indexOf('<page>')
        if (pageStart === -1) {
          if (buffer.length > 2048) buffer = buffer.slice(-2048)
          break
        }
        buffer = buffer.slice(pageStart)
        inPage = true
      }

      const pageEnd = buffer.indexOf('</page>')
      if (pageEnd === -1) break

      const pageContent = buffer.slice(0, pageEnd + 7)
      buffer = buffer.slice(pageEnd + 7)
      inPage = false

      if (pageContent.includes('<ns>0</ns>') && !pageContent.includes('<redirect')) {
        const titleMatch = pageContent.match(/<title>(.*?)<\/title>/)
        const textMatch = pageContent.match(/<text[^>]*>([\s\S]*?)<\/text>/)

        if (titleMatch && textMatch) {
          const title = titleMatch[1].trim()
          const rawText = textMatch[1]
          const body = stripWikiMarkup(rawText)
          if (title.length > 0 && body.length > 50) {
            articles.push({ title, body: body.slice(0, 2000) })
          }
        }
      }
    }

    if (articles.length >= maxCount) {
      nodeStream.destroy()
      break
    }
  }

  console.log(`  extracted ${articles.length} articles`)
  return articles.slice(0, maxCount)
}

export async function loadWikiArticles(maxCount = 100_000, options?: { noDownload?: boolean }): Promise<WikiArticle[]> {
  if (existsSync(CACHE_PATH)) {
    console.log(`  loading cached wiki articles from ${CACHE_PATH}`)
    const raw = await readFile(CACHE_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.log('  cache file has invalid format, ignoring')
      if (options?.noDownload) {
        throw new Error('wiki cache invalid and --no-download set')
      }
      return downloadAndCacheWiki(maxCount)
    }
    const articles = parsed as WikiArticle[]
    console.log(`  loaded ${articles.length} articles from cache`)
    return articles.slice(0, maxCount)
  }

  if (options?.noDownload) {
    throw new Error('wiki cache not found and --no-download set; download first with: pnpm bench -- --refresh-wiki')
  }

  console.log('  wiki cache not found, downloading automatically...')
  return downloadAndCacheWiki(maxCount)
}

export async function downloadAndCacheWiki(maxCount = 100_000): Promise<WikiArticle[]> {
  const articles = await downloadWikiArticles(maxCount)

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

export function generateWikiFilteredQueries(articles: WikiArticle[], count: number, seed: number): string[] {
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
    const wordCount = 1 + Math.floor(rng() * Math.min(2, words.length))
    const startIdx = Math.floor(rng() * Math.max(1, words.length - wordCount + 1))
    queries.push(words.slice(startIdx, startIdx + wordCount).join(' '))
  }
  return queries
}
