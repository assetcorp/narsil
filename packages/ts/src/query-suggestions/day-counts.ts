import {
  MIN_PHRASE_TABLE_CAPACITY,
  PAIR_BLOCK_SLOTS,
  PAIR_PAGE_BLOCKS,
  PERSON_TABLE_MIN_SLOTS,
  SCRAMBLED_ID_BYTES,
} from './constants'

export interface DayLimits {
  minPeople: number
  maxPhrasesPerDay: number
  maxPhrasesPerPerson: number
  maxPeoplePerDay: number
  maxGroups: number
}

export type CountOutcome = 'recorded' | 'repeat' | 'person-limit' | 'phrase-limit' | 'people-limit' | 'group-limit'

const EMPTY_SLOT = -1
const NO_BLOCK = -1

function nextPowerOfTwo(value: number): number {
  let power = 1
  while (power < value) power *= 2
  return power
}

function idsEqual(left: Uint8Array, leftOffset: number, right: Uint8Array, rightOffset: number): boolean {
  for (let i = 0; i < SCRAMBLED_ID_BYTES; i++) {
    if (left[leftOffset + i] !== right[rightOffset + i]) return false
  }
  return true
}

function hashOfId(id: Uint8Array, offset: number): number {
  return (id[offset] | (id[offset + 1] << 8) | (id[offset + 2] << 16) | (id[offset + 3] << 24)) >>> 0
}

export class DayCounts {
  readonly day: string
  readonly limits: DayLimits
  private readonly groups = new Map<string, Map<string, number>>()
  private phraseCount = 0
  private phraseTexts: string[] = []
  private phraseGroups: string[] = []
  private phraseCounts = new Uint32Array(0)
  private phrasePeopleLengths = new Uint16Array(0)
  private phrasePeople = new Uint8Array(0)
  private personCount = 0
  private personIds = new Uint8Array(0)
  private personPairs = new Uint16Array(0)
  private personHeads = new Int32Array(0)
  private personTails = new Int32Array(0)
  private personSlots = new Int32Array(0)
  private readonly pairPages: Uint16Array[] = []
  private readonly linkPages: Int32Array[] = []
  private blockCount = 0
  private changed = false

  constructor(day: string, limits: DayLimits) {
    this.day = day
    this.limits = limits
  }

  get phrases(): number {
    return this.phraseCount
  }

  get people(): number {
    return this.personCount
  }

  get groupNames(): IterableIterator<string> {
    return this.groups.keys()
  }

  get isChanged(): boolean {
    return this.changed
  }

  markSaved(): void {
    this.changed = false
  }

  markChanged(): void {
    this.changed = true
  }

  get groupTables(): ReadonlyMap<string, ReadonlyMap<string, number>> {
    return this.groups
  }

  get peopleBytes(): Uint8Array {
    return this.phrasePeople
  }

  countOf(phraseNumber: number): number {
    return this.phraseCounts[phraseNumber]
  }

  peopleLengthOf(phraseNumber: number): number {
    return this.phrasePeopleLengths[phraseNumber]
  }

  peopleOffsetOf(phraseNumber: number): number {
    return phraseNumber * this.limits.minPeople * SCRAMBLED_ID_BYTES
  }

  hasGroup(group: string): boolean {
    return this.groups.has(group)
  }

  count(group: string, phrase: string, scrambledId: Uint8Array, groupAllowed: boolean): CountOutcome {
    const groupPhrases = this.groups.get(group)
    const existingPhrase = groupPhrases?.get(phrase)
    const person = this.findPerson(scrambledId)
    if (person !== EMPTY_SLOT && existingPhrase !== undefined && this.personHasPhrase(person, existingPhrase)) {
      return 'repeat'
    }
    if (person !== EMPTY_SLOT && this.personPairs[person] >= this.limits.maxPhrasesPerPerson) return 'person-limit'
    if (existingPhrase === undefined && this.phraseCount >= this.limits.maxPhrasesPerDay) return 'phrase-limit'
    if (person === EMPTY_SLOT && this.personCount >= this.limits.maxPeoplePerDay) return 'people-limit'
    if (groupPhrases === undefined && (!groupAllowed || this.groups.size >= this.limits.maxGroups)) {
      return 'group-limit'
    }
    const phraseNumber = existingPhrase ?? this.addPhrase(group, phrase, groupPhrases)
    const personNumber = person === EMPTY_SLOT ? this.addPerson(scrambledId) : person
    this.appendPair(personNumber, phraseNumber)
    this.phraseCounts[phraseNumber] += 1
    this.addToPeople(phraseNumber, scrambledId, 0)
    this.changed = true
    return 'recorded'
  }

  restorePhrase(group: string, phrase: string, count: number, people: Uint8Array, peopleCount: number): boolean {
    const groupPhrases = this.groups.get(group)
    if (groupPhrases?.has(phrase) === true) return false
    if (this.phraseCount >= this.limits.maxPhrasesPerDay) return false
    if (groupPhrases === undefined && this.groups.size >= this.limits.maxGroups) return false
    const phraseNumber = this.addPhrase(group, phrase, groupPhrases)
    for (let i = 0; i < peopleCount; i++) this.addToPeople(phraseNumber, people, i * SCRAMBLED_ID_BYTES)
    this.phraseCounts[phraseNumber] = Math.max(count, this.phrasePeopleLengths[phraseNumber])
    return true
  }

  private addPhrase(group: string, phrase: string, existing: Map<string, number> | undefined): number {
    const groupPhrases = existing ?? new Map<string, number>()
    if (existing === undefined) this.groups.set(group, groupPhrases)
    if (this.phraseCount === this.phraseCounts.length) this.growPhrases()
    const number = this.phraseCount
    this.phraseCount += 1
    groupPhrases.set(phrase, number)
    this.phraseTexts.push(phrase)
    this.phraseGroups.push(group)
    return number
  }

  private growPhrases(): void {
    const capacity = Math.min(
      this.limits.maxPhrasesPerDay,
      Math.max(MIN_PHRASE_TABLE_CAPACITY, this.phraseCounts.length * 2),
    )
    const counts = new Uint32Array(capacity)
    counts.set(this.phraseCounts)
    this.phraseCounts = counts
    const lengths = new Uint16Array(capacity)
    lengths.set(this.phrasePeopleLengths)
    this.phrasePeopleLengths = lengths
    const people = new Uint8Array(capacity * this.limits.minPeople * SCRAMBLED_ID_BYTES)
    people.set(this.phrasePeople)
    this.phrasePeople = people
  }

  private addToPeople(phraseNumber: number, id: Uint8Array, idOffset: number): void {
    const length = this.phrasePeopleLengths[phraseNumber]
    if (length >= this.limits.minPeople) return
    const base = phraseNumber * this.limits.minPeople * SCRAMBLED_ID_BYTES
    for (let i = 0; i < length; i++) {
      if (idsEqual(this.phrasePeople, base + i * SCRAMBLED_ID_BYTES, id, idOffset)) return
    }
    this.phrasePeople.set(id.subarray(idOffset, idOffset + SCRAMBLED_ID_BYTES), base + length * SCRAMBLED_ID_BYTES)
    this.phrasePeopleLengths[phraseNumber] = length + 1
  }

  private findPerson(id: Uint8Array): number {
    if (this.personSlots.length === 0) return EMPTY_SLOT
    const mask = this.personSlots.length - 1
    let slot = hashOfId(id, 0) & mask
    for (;;) {
      const person = this.personSlots[slot]
      if (person === EMPTY_SLOT) return EMPTY_SLOT
      if (idsEqual(this.personIds, person * SCRAMBLED_ID_BYTES, id, 0)) return person
      slot = (slot + 1) & mask
    }
  }

  private addPerson(id: Uint8Array): number {
    if (this.personCount === this.personPairs.length) this.growPeople()
    const person = this.personCount
    this.personCount += 1
    this.personIds.set(id.subarray(0, SCRAMBLED_ID_BYTES), person * SCRAMBLED_ID_BYTES)
    this.personHeads[person] = NO_BLOCK
    this.personTails[person] = NO_BLOCK
    this.insertSlot(person)
    return person
  }

  private insertSlot(person: number): void {
    const mask = this.personSlots.length - 1
    let slot = hashOfId(this.personIds, person * SCRAMBLED_ID_BYTES) & mask
    while (this.personSlots[slot] !== EMPTY_SLOT) slot = (slot + 1) & mask
    this.personSlots[slot] = person
  }

  private growPeople(): void {
    const capacity = Math.min(
      this.limits.maxPeoplePerDay,
      Math.max(PERSON_TABLE_MIN_SLOTS / 2, this.personPairs.length * 2),
    )
    const ids = new Uint8Array(capacity * SCRAMBLED_ID_BYTES)
    ids.set(this.personIds)
    this.personIds = ids
    const pairs = new Uint16Array(capacity)
    pairs.set(this.personPairs)
    this.personPairs = pairs
    const heads = new Int32Array(capacity)
    heads.set(this.personHeads)
    this.personHeads = heads
    const tails = new Int32Array(capacity)
    tails.set(this.personTails)
    this.personTails = tails
    this.personSlots = new Int32Array(nextPowerOfTwo(capacity * 2)).fill(EMPTY_SLOT)
    for (let person = 0; person < this.personCount; person++) this.insertSlot(person)
  }

  private personHasPhrase(person: number, phraseNumber: number): boolean {
    let remaining = this.personPairs[person]
    let block = this.personHeads[person]
    while (block !== NO_BLOCK && remaining > 0) {
      const page = this.pairPages[Math.floor(block / PAIR_PAGE_BLOCKS)]
      const start = (block % PAIR_PAGE_BLOCKS) * PAIR_BLOCK_SLOTS
      const used = Math.min(remaining, PAIR_BLOCK_SLOTS)
      for (let i = 0; i < used; i++) {
        if (page[start + i] === phraseNumber) return true
      }
      remaining -= used
      block = this.linkPages[Math.floor(block / PAIR_PAGE_BLOCKS)][block % PAIR_PAGE_BLOCKS]
    }
    return false
  }

  private appendPair(person: number, phraseNumber: number): void {
    const pairs = this.personPairs[person]
    const slot = pairs % PAIR_BLOCK_SLOTS
    let block = this.personTails[person]
    if (slot === 0) {
      const fresh = this.allocateBlock()
      if (block === NO_BLOCK) this.personHeads[person] = fresh
      else this.linkPages[Math.floor(block / PAIR_PAGE_BLOCKS)][block % PAIR_PAGE_BLOCKS] = fresh
      this.personTails[person] = fresh
      block = fresh
    }
    const page = this.pairPages[Math.floor(block / PAIR_PAGE_BLOCKS)]
    page[(block % PAIR_PAGE_BLOCKS) * PAIR_BLOCK_SLOTS + slot] = phraseNumber
    this.personPairs[person] = pairs + 1
  }

  private allocateBlock(): number {
    const block = this.blockCount
    if (block % PAIR_PAGE_BLOCKS === 0) {
      this.pairPages.push(new Uint16Array(PAIR_PAGE_BLOCKS * PAIR_BLOCK_SLOTS))
      this.linkPages.push(new Int32Array(PAIR_PAGE_BLOCKS).fill(NO_BLOCK))
    }
    this.blockCount += 1
    return block
  }
}
