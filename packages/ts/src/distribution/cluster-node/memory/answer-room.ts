import { NarsilError, ServerErrorCodes } from '../../../errors'
import {
  admitHeapBytes,
  collectGarbageBeforeRefusal,
  collectYoungGenerationBeforeRefusal,
  reservedHeapBytes,
} from '../../../runtime/thread-heap'
import { ANSWER_ENCODE_BYTES_PER_ESTIMATED_BYTE, ANSWER_MEMORY_BLOCK_FRACTION } from '../constants'
import { type MemoryFigures, readMemoryFigures, readRecentMemoryFigures } from './measure'
import { estimateDocumentBytes } from './write-pressure'

const RESPONSE_WOULD_FILL_MEMORY_REASON = 'response_would_fill_memory'

function heapRoomIn(figures: MemoryFigures): number {
  return ANSWER_MEMORY_BLOCK_FRACTION * figures.heapLimitBytes - figures.heapBytes - figures.youngHeapBytes
}

function processRoomIn(figures: MemoryFigures): number {
  return ANSWER_MEMORY_BLOCK_FRACTION * figures.processLimitBytes - figures.processBytes
}

function roomIn(figures: MemoryFigures): number {
  return Math.min(heapRoomIn(figures), processRoomIn(figures)) - reservedHeapBytes()
}

function refusal(answerBytes: number, figures: MemoryFigures, collectedGarbage: boolean): NarsilError {
  const heapBound = heapRoomIn(figures) <= processRoomIn(figures)
  const blockBytes = Math.floor(
    ANSWER_MEMORY_BLOCK_FRACTION * (heapBound ? figures.heapLimitBytes : figures.processLimitBytes),
  )
  const usedBytes = heapBound ? figures.heapBytes + figures.youngHeapBytes : figures.processBytes
  return new NarsilError(
    ServerErrorCodes.TOO_MANY_REQUESTS,
    `Building the next ${answerBytes} bytes of this answer would take the ${usedBytes} bytes already in use past the limit of ${blockBytes} bytes. Retry once the requests in progress finish, or ask for fewer documents.`,
    {
      reason: RESPONSE_WOULD_FILL_MEMORY_REASON,
      answerBytes,
      heapBytes: figures.heapBytes,
      youngHeapBytes: figures.youngHeapBytes,
      processBytes: figures.processBytes,
      reservedBytes: reservedHeapBytes(),
      blockBytes,
      collectedGarbage,
    },
  )
}

function admitted(answerBytes: number): null {
  admitHeapBytes(answerBytes)
  return null
}

export function answerRefusalOf(answerBytes: number): NarsilError | null {
  const recent = readRecentMemoryFigures()
  if (recent === null || answerBytes <= roomIn(recent)) return admitted(answerBytes)
  const figures = readMemoryFigures() ?? recent
  if (answerBytes <= roomIn(figures)) return admitted(answerBytes)
  const collectedGarbage = collectGarbageBeforeRefusal()
  const collectedYoung = !collectedGarbage && collectYoungGenerationBeforeRefusal()
  const settled = collectedGarbage || collectedYoung ? (readMemoryFigures() ?? figures) : figures
  if (answerBytes <= roomIn(settled)) return admitted(answerBytes)
  return refusal(answerBytes, settled, collectedGarbage)
}

export function refuseEncodeWithoutRoom(documents: Iterable<Record<string, unknown>>): void {
  let estimatedBytes = 0
  for (const document of documents) estimatedBytes += estimateDocumentBytes(document)
  const refusal = answerRefusalOf(estimatedBytes * ANSWER_ENCODE_BYTES_PER_ESTIMATED_BYTE)
  if (refusal !== null) throw refusal
}
