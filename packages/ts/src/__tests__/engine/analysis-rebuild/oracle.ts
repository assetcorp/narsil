import { registerLanguage } from '../../../languages/registry'

export const LANGUAGE = 'switch-fixture'
export const FIRST_REVISION = '1'
export const SECOND_REVISION = '2'
export const PROBES = ['jump', 'jumping', 'run', 'running', 'water', 'stone']

const VOCABULARY = ['jumping', 'jump', 'running', 'run', 'water', 'stone', 'river', 'jumps']

export type Revision = typeof FIRST_REVISION | typeof SECOND_REVISION

export function registerRevision(revision: Revision): void {
  registerLanguage({
    name: LANGUAGE,
    revision,
    stemmer: revision === FIRST_REVISION ? null : stripProgressive,
    stopWords: new Set<string>(),
  })
}

export function stripProgressive(token: string): string {
  return token.endsWith('ing') ? token.slice(0, -3) : token
}

export function bootstrapSource(packageHref: string, revision: Revision): string {
  const stemmer = revision === FIRST_REVISION ? 'null' : "token => (token.endsWith('ing') ? token.slice(0, -3) : token)"
  return `import { registerLanguage } from ${JSON.stringify(packageHref)}
registerLanguage({ name: ${JSON.stringify(LANGUAGE)}, revision: ${JSON.stringify(revision)}, stemmer: ${stemmer}, stopWords: new Set() })`
}

function wordsOf(text: string, revision: Revision): Set<string> {
  const words = new Set<string>()
  for (const word of text.toLowerCase().split(/[^a-z]+/)) {
    if (word.length === 0) continue
    words.add(revision === FIRST_REVISION ? word : stripProgressive(word))
  }
  return words
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function sentence(random: () => number): string {
  const length = 2 + Math.floor(random() * 3)
  const words: string[] = []
  for (let i = 0; i < length; i++) words.push(VOCABULARY[Math.floor(random() * VOCABULARY.length)])
  return words.join(' ')
}

interface OracleDocument {
  title: string
  writtenUnder: Revision
}

export type TermsState = 'old' | 'new'

export class OracleCorpus {
  private readonly documents = new Map<string, OracleDocument>()

  write(id: string, title: string, writtenUnder: Revision): void {
    this.documents.set(id, { title, writtenUnder })
  }

  remove(id: string): void {
    this.documents.delete(id)
  }

  ids(): string[] {
    return [...this.documents.keys()]
  }

  get size(): number {
    return this.documents.size
  }

  matches(probe: string, state: TermsState): string[] {
    const wanted = stripProgressive(probe.toLowerCase())
    const matched: string[] = []
    for (const [id, document] of this.documents) {
      const revision = state === 'new' ? SECOND_REVISION : document.writtenUnder
      if (wordsOf(document.title, revision).has(wanted)) matched.push(id)
    }
    return matched.sort()
  }

  statesMatching(probe: string, hits: readonly string[]): TermsState[] {
    const found = [...hits].sort().join('\n')
    const states: TermsState[] = []
    if (this.matches(probe, 'old').join('\n') === found) states.push('old')
    if (this.matches(probe, 'new').join('\n') === found) states.push('new')
    return states
  }
}
