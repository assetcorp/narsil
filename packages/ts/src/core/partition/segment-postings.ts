import { MAX_TERM_FREQUENCY } from '../constants'
import {
  SEGMENT_FIELD_SCRATCH_START,
  SEGMENT_POSITION_POOL_START,
  SEGMENT_POSTING_LOG_START,
  SEGMENT_TOKEN_TABLE_START,
} from './constants'
import { GrowableUint32 } from './growable-uint32'
import type { SegmentPayload } from './segment-payload'

export class TextPostings {
  readonly tokens: string[] = []
  readonly fieldNames: string[] = []
  private readonly tokenIds = new Map<string, number>()
  private readonly fieldNameIndexes = new Map<string, number>()
  private readonly postingsPerToken = new GrowableUint32(SEGMENT_TOKEN_TABLE_START)
  private readonly docFrequencyPerToken = new GrowableUint32(SEGMENT_TOKEN_TABLE_START)
  private readonly lastDocPerToken = new GrowableUint32(SEGMENT_TOKEN_TABLE_START)
  private readonly fieldStampPerToken = new GrowableUint32(SEGMENT_TOKEN_TABLE_START)
  private readonly fieldSlotPerToken = new GrowableUint32(SEGMENT_TOKEN_TABLE_START)
  private readonly logToken = new GrowableUint32(SEGMENT_POSTING_LOG_START)
  private readonly logDoc = new GrowableUint32(SEGMENT_POSTING_LOG_START)
  private readonly logFrequency = new GrowableUint32(SEGMENT_POSTING_LOG_START)
  private readonly logField = new GrowableUint32(SEGMENT_POSTING_LOG_START)
  private readonly logPositionStart = new GrowableUint32(SEGMENT_POSTING_LOG_START)
  private readonly positionPool = new GrowableUint32(SEGMENT_POSITION_POOL_START)
  private readonly slotToken = new GrowableUint32(SEGMENT_FIELD_SCRATCH_START)
  private readonly slotCount = new GrowableUint32(SEGMENT_FIELD_SCRATCH_START)
  private readonly slotCursor = new GrowableUint32(SEGMENT_FIELD_SCRATCH_START)
  private readonly eventSlot = new GrowableUint32(SEGMENT_FIELD_SCRATCH_START)
  private readonly eventPosition = new GrowableUint32(SEGMENT_FIELD_SCRATCH_START)
  private fieldStamp = 0

  constructor(private readonly trackPositions: boolean) {}

  beginField(): void {
    this.fieldStamp++
    this.slotToken.clear()
    this.slotCount.clear()
    this.eventSlot.clear()
    this.eventPosition.clear()
  }

  get fieldLength(): number {
    return this.eventSlot.length
  }

  private tokenIdOf(token: string): number {
    const known = this.tokenIds.get(token)
    if (known !== undefined) return known
    const id = this.tokens.length
    this.tokenIds.set(token, id)
    this.tokens.push(token)
    this.postingsPerToken.ensureIndex(id)
    this.docFrequencyPerToken.ensureIndex(id)
    this.lastDocPerToken.ensureIndex(id)
    this.fieldStampPerToken.ensureIndex(id)
    this.fieldSlotPerToken.ensureIndex(id)
    return id
  }

  addToken(token: string, position: number): void {
    const id = this.tokenIdOf(token)
    let slot: number
    if (this.fieldStampPerToken.values[id] === this.fieldStamp) {
      slot = this.fieldSlotPerToken.values[id]
      this.slotCount.values[slot]++
    } else {
      slot = this.slotToken.length
      this.fieldStampPerToken.values[id] = this.fieldStamp
      this.fieldSlotPerToken.values[id] = slot
      this.slotToken.push(id)
      this.slotCount.push(1)
    }
    this.eventSlot.push(slot)
    this.eventPosition.push(position)
  }

  private recordFieldPositions(): void {
    const events = this.eventSlot.length
    const poolBase = this.positionPool.length
    this.positionPool.reserve(events)
    this.slotCursor.clear()
    let cursor = poolBase
    for (let slot = 0; slot < this.slotToken.length; slot++) {
      this.slotCursor.push(cursor)
      this.logPositionStart.push(cursor)
      cursor += this.slotCount.values[slot]
    }
    for (let event = 0; event < events; event++) {
      const slot = this.eventSlot.values[event]
      this.positionPool.values[this.slotCursor.values[slot]++] = this.eventPosition.values[event]
    }
    this.positionPool.length = poolBase + events
  }

  endField(ordinal: number, fieldPath: string): void {
    let fieldIndex = this.fieldNameIndexes.get(fieldPath)
    if (fieldIndex === undefined) {
      fieldIndex = this.fieldNames.length
      this.fieldNames.push(fieldPath)
      this.fieldNameIndexes.set(fieldPath, fieldIndex)
    }
    if (this.trackPositions) this.recordFieldPositions()
    for (let slot = 0; slot < this.slotToken.length; slot++) {
      const id = this.slotToken.values[slot]
      this.logToken.push(id)
      this.logDoc.push(ordinal)
      this.logFrequency.push(this.slotCount.values[slot])
      this.logField.push(fieldIndex)
      this.postingsPerToken.values[id]++
      if (this.lastDocPerToken.values[id] !== ordinal + 1) {
        this.lastDocPerToken.values[id] = ordinal + 1
        this.docFrequencyPerToken.values[id]++
      }
    }
  }

  encode(): Pick<
    SegmentPayload,
    | 'tokens'
    | 'fieldNames'
    | 'postingOffsets'
    | 'postingDocIds'
    | 'postingFrequencies'
    | 'postingFieldIndices'
    | 'positionOffsets'
    | 'positionValues'
    | 'docFrequencies'
  > {
    const tokenCount = this.tokens.length
    const postings = this.logToken.length
    const postingOffsets = new Uint32Array(tokenCount + 1)
    for (let t = 0; t < tokenCount; t++) postingOffsets[t + 1] = postingOffsets[t] + this.postingsPerToken.values[t]
    const writeCursor = postingOffsets.slice(0, tokenCount)
    const postingDocIds = new Uint32Array(postings)
    const postingFrequencies = new Uint16Array(postings)
    const postingFieldIndices = new Uint16Array(postings)
    const logRowOfPosting = new Uint32Array(postings)
    for (let row = 0; row < postings; row++) {
      const target = writeCursor[this.logToken.values[row]]++
      const frequency = this.logFrequency.values[row]
      postingDocIds[target] = this.logDoc.values[row]
      postingFrequencies[target] = frequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : frequency
      postingFieldIndices[target] = this.logField.values[row]
      logRowOfPosting[target] = row
    }

    let positionOffsets: Uint32Array | null = null
    let positionValues: Uint32Array | null = null
    if (this.trackPositions && postings > 0) {
      positionOffsets = new Uint32Array(postings + 1)
      positionValues = new Uint32Array(this.positionPool.length)
      let cursor = 0
      for (let target = 0; target < postings; target++) {
        const row = logRowOfPosting[target]
        const start = this.logPositionStart.values[row]
        const count = this.logFrequency.values[row]
        positionOffsets[target] = cursor
        positionValues.set(this.positionPool.values.subarray(start, start + count), cursor)
        cursor += count
      }
      positionOffsets[postings] = cursor
    }

    const docFrequencies: Record<string, number> = Object.create(null)
    for (let t = 0; t < tokenCount; t++) docFrequencies[this.tokens[t]] = this.docFrequencyPerToken.values[t]

    return {
      tokens: this.tokens,
      fieldNames: this.fieldNames,
      postingOffsets,
      postingDocIds,
      postingFrequencies,
      postingFieldIndices,
      positionOffsets,
      positionValues,
      docFrequencies,
    }
  }
}
