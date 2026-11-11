import { openCountsFile, SCRAMBLED_ID_BYTES } from '#platform/suggestions-host'

export interface MergeSettings {
  minPeople: number
  maxMergePhrases: number
  maxGroups: number
  markedGroups: readonly string[]
  fingerprint: Uint8Array
  indexUuid: string | null
  clustered: boolean
  banned: readonly string[]
}

export type FileOutcome =
  | { kind: 'merged'; day: string; savedAt: number }
  | { kind: 'damaged'; reason: string }
  | { kind: 'other-key' }
  | { kind: 'other-index' }

export interface DuePhrase {
  phrase: string
  count: number
}

export interface MergeResult {
  groups: Record<string, DuePhrase[]>
  discarded: number
}

interface Entry {
  count: number
  people: Set<string> | null
}

const SEPARATOR = '\u0000'

function idKey(source: Uint8Array, offset: number): string {
  let key = ''
  for (let i = 0; i < SCRAMBLED_ID_BYTES; i++) key += String.fromCharCode(source[offset + i])
  return key
}

export class Merger {
  private readonly settings: MergeSettings
  private readonly banned: Set<string>
  private readonly entries = new Map<string, Entry>()
  private readonly groups: Set<string>
  private discarded = 0

  constructor(settings: MergeSettings) {
    this.settings = settings
    this.banned = new Set(settings.banned)
    this.groups = new Set(settings.markedGroups)
  }

  async addFile(bytes: Uint8Array, expectedDay: string): Promise<FileOutcome> {
    const opened = await openCountsFile(bytes, expectedDay, this.settings.fingerprint)
    if (opened.kind !== 'counts') return opened
    if (this.settings.clustered && (opened.indexUuid === null || opened.indexUuid !== this.settings.indexUuid)) {
      return { kind: 'other-index' }
    }
    const { minPeople, maxMergePhrases, maxGroups } = this.settings
    opened.visit((group, phrase, count, people) => {
      if (this.banned.has(phrase)) return
      const key = `${group}${SEPARATOR}${phrase}`
      let entry = this.entries.get(key)
      if (entry === undefined) {
        const newGroup = !this.groups.has(group)
        if ((newGroup && this.groups.size >= maxGroups) || this.entries.size >= maxMergePhrases) {
          this.discarded += 1
          return
        }
        if (newGroup) this.groups.add(group)
        entry = { count: 0, people: new Set<string>() }
        this.entries.set(key, entry)
      }
      entry.count += count
      if (entry.people === null) return
      for (const offset of people.offsets) {
        entry.people.add(idKey(people.source, offset))
        if (entry.people.size >= minPeople) {
          entry.people = null
          return
        }
      }
    })
    return { kind: 'merged', day: opened.day, savedAt: opened.savedAt }
  }

  result(): MergeResult {
    const groups: Record<string, DuePhrase[]> = {}
    for (const [key, entry] of this.entries) {
      if (entry.people !== null) continue
      const split = key.indexOf(SEPARATOR)
      const group = key.slice(0, split)
      const list = groups[group] ?? []
      list.push({ phrase: key.slice(split + 1), count: entry.count })
      groups[group] = list
    }
    for (const list of Object.values(groups)) {
      list.sort((left, right) => right.count - left.count || (left.phrase < right.phrase ? -1 : 1))
    }
    return { groups, discarded: this.discarded }
  }
}
