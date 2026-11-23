import { type ChunkBudget, chunkByBudget } from '../chunking'
import { WIRE_BATCH_BUDGET } from '../constants'
import { entryByteEstimate } from './entry-checksum'
import type { ReplicationLogEntry } from './types'

function continuesRun(entry: ReplicationLogEntry, previous: ReplicationLogEntry): boolean {
  return entry.seqNo === previous.seqNo + 1 && entry.primaryTerm === previous.primaryTerm
}

export const LOG_ENTRY_BATCH_BUDGET: ChunkBudget<ReplicationLogEntry> = {
  ...WIRE_BATCH_BUDGET,
  payloadBytesOf: entryByteEstimate,
  breaksRun: (entry, previous) => !continuesRun(entry, previous),
}

export function chunkLogEntries<T>(items: T[], entryOf: (item: T) => ReplicationLogEntry): T[][] {
  return chunkByBudget(items, {
    ...WIRE_BATCH_BUDGET,
    payloadBytesOf: item => entryByteEstimate(entryOf(item)),
    breaksRun: (item, previous) => !continuesRun(entryOf(item), entryOf(previous)),
  })
}
