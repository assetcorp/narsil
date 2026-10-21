import { codePointsOf, UNICODE_FOLDS } from './case-folding'

const CLASS_MEMBERS: Record<string, number[]> = {
  d: range(0x30, 0x39),
  w: [...range(0x30, 0x39), ...range(0x41, 0x5a), 0x5f, ...range(0x61, 0x7a)],
  s: [0x09, 0x0a, 0x0c, 0x0d, 0x20],
}
const PUNCTUATION = /^[!-/:-@[-`{-~]$/u
const RESERVED = new Set(['\\', '.', '|', '*', '+', '?', '{', '}', '(', ')', '[', ']', '^', '$', '<', '>'])

function range(low: number, high: number): number[] {
  return Array.from({ length: high - low + 1 }, (_, at) => low + at)
}

function escaped(codePoints: readonly number[]): string {
  return codePoints.map(codePoint => `\\u{${codePoint.toString(16)}}`).join('')
}

function foldOf(codePoint: number): number[] {
  return UNICODE_FOLDS.get(codePoint) ?? [codePoint]
}

interface TrieNode {
  end: boolean
  next: Map<string, TrieNode>
}

function trieSource(words: readonly string[]): string {
  const root: TrieNode = { end: false, next: new Map() }
  for (const word of words) {
    let node = root
    for (const digit of word) {
      let child = node.next.get(digit)
      if (child === undefined) {
        child = { end: false, next: new Map() }
        node.next.set(digit, child)
      }
      node = child
    }
    node.end = true
  }
  const render = (node: TrieNode): string => {
    const branches = [...node.next].map(([digit, child]) => digit + render(child))
    if (branches.length === 0) return ''
    const body = branches.length === 1 ? branches[0] : `(?:${branches.join('|')})`
    return node.end ? `(?:${body})?` : body
  }
  return `(?:${render(root)})`
}

const MAX_ENUMERATED_NUMBERS = 200_000

function numberRangeSource(low: string, high: string): string {
  if (Number(high) - Number(low) > MAX_ENUMERATED_NUMBERS) throw new Error(`The oracle enumerates no <${low}-${high}>`)
  const words: string[] = []
  for (let value = Number(low); value <= Number(high); value++) {
    words.push(low.length === high.length ? String(value).padStart(low.length, '0') : String(value))
  }
  return trieSource(words)
}

class Translator {
  private at = 0

  constructor(
    private readonly characters: readonly string[],
    private readonly caseFold: boolean,
  ) {}

  translate(): string {
    const source = this.alternatives()
    if (this.at !== this.characters.length) throw new Error(`The oracle reads no ${this.characters[this.at]}`)
    return source
  }

  private alternatives(): string {
    const branches = [this.branch()]
    while (this.characters[this.at] === '|') {
      this.at++
      branches.push(this.branch())
    }
    return branches.join('|')
  }

  private branch(): string {
    let source = ''
    while (this.at < this.characters.length && this.characters[this.at] !== '|' && this.characters[this.at] !== ')') {
      source += this.atom() + this.repeat()
    }
    return source
  }

  private repeat(): string {
    const character = this.characters[this.at]
    if (character === '*' || character === '+' || character === '?') {
      this.at++
      return character
    }
    if (character !== '{') return ''
    let source = ''
    while (this.characters[this.at] !== '}') source += this.characters[this.at++]
    this.at++
    return `${source}}`
  }

  private literal(codePoint: number): string {
    return `(?:${escaped(this.caseFold ? foldOf(codePoint) : [codePoint])})`
  }

  private atom(): string {
    const character = this.characters[this.at++]
    if (character === '\\') {
      const next = this.characters[this.at++]
      if (next === 'd' || next === 'w' || next === 's') return `[${escaped(CLASS_MEMBERS[next])}]`
      if (next === 'b') return '(?:\\b)'
      if (!PUNCTUATION.test(next)) throw new Error(`The oracle reads no \\${next}`)
      return this.literal(next.codePointAt(0) ?? 0)
    }
    if (character === '.') return '[\\s\\S]'
    if (character === '^' || character === '$') return `(?:${character})`
    if (character === '(') {
      const inner = this.alternatives()
      this.at++
      return `(?:${inner})`
    }
    if (character === '[') return this.set()
    if (character === '<') return this.numberRange()
    if (RESERVED.has(character)) throw new Error(`The oracle reads no ${character}`)
    return this.literal(character.codePointAt(0) ?? 0)
  }

  private setMember(): number {
    const character = this.characters[this.at++]
    if (character !== '\\') return character.codePointAt(0) ?? 0
    return this.characters[this.at++].codePointAt(0) ?? 0
  }

  private set(): string {
    const negated = this.characters[this.at] === '^'
    if (negated) this.at++
    const members: number[] = []
    const alone: number[] = []
    while (this.characters[this.at] !== ']') {
      const character = this.characters[this.at]
      const next = this.characters[this.at + 1]
      if (character === '\\' && (next === 'd' || next === 'w' || next === 's')) {
        this.at += 2
        members.push(...CLASS_MEMBERS[next])
        continue
      }
      const low = this.setMember()
      if (this.characters[this.at] === '-' && this.characters[this.at + 1] !== ']') {
        this.at++
        members.push(...range(low, this.setMember()))
      } else {
        members.push(low)
        alone.push(low)
      }
    }
    this.at++
    if (!this.caseFold) return `[${negated ? '^' : ''}${escaped(members)}]`
    const singles = new Set<number>()
    for (const member of members) {
      const fold = foldOf(member)
      if (fold.length === 1) singles.add(fold[0])
    }
    const single = `[${negated ? '^' : ''}${escaped([...singles])}]`
    if (negated) return single
    const sequences = new Set<string>()
    for (const member of alone) {
      const fold = foldOf(member)
      if (fold.length > 1) sequences.add(escaped(fold))
    }
    return `(?:${[single, ...sequences].join('|')})`
  }

  private numberRange(): string {
    let low = ''
    while (this.characters[this.at] !== '-') low += this.characters[this.at++]
    this.at++
    let high = ''
    while (this.characters[this.at] !== '>') high += this.characters[this.at++]
    this.at++
    return numberRangeSource(low, high)
  }
}

function wildcardSource(pattern: string, caseFold: boolean): string {
  const characters = Array.from(pattern)
  let source = '^'
  for (let at = 0; at < characters.length; at++) {
    const character = characters[at]
    if (character === '*') source += '[\\s\\S]*'
    else if (character === '?') source += '[\\s\\S]'
    else {
      const literal = character === '\\' ? characters[++at] : character
      const codePoint = literal.codePointAt(0) ?? 0
      source += escaped(caseFold ? foldOf(codePoint) : [codePoint])
    }
  }
  return `${source}$`
}

export type ExpressionOperator = 'wildcard' | 'regex'

const compiled = new Map<string, RegExp>()

function oracleOf(operator: ExpressionOperator, pattern: string, caseFold: boolean): RegExp {
  const key = `${operator}\u0000${caseFold}\u0000${pattern}`
  let expression = compiled.get(key)
  if (expression === undefined) {
    const source =
      operator === 'wildcard'
        ? wildcardSource(pattern, caseFold)
        : new Translator(Array.from(pattern), caseFold).translate()
    expression = new RegExp(source, 'su')
    compiled.set(key, expression)
  }
  return expression
}

export function expressionPasses(
  value: string,
  operator: ExpressionOperator,
  pattern: string,
  caseFold: boolean,
): boolean {
  const subject = caseFold ? String.fromCodePoint(...codePointsOf(value, true)) : value
  return oracleOf(operator, pattern, caseFold).test(subject)
}
