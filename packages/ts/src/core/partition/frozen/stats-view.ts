import type { PartitionStatsView } from '../../statistics'
import type { FrozenLiveCounts } from './live-counts'

export function buildStatsView(counts: FrozenLiveCounts): PartitionStatsView {
  return {
    get totalDocuments(): number {
      return counts.totalDocuments()
    },
    get totalFieldLengths(): Readonly<Record<string, number>> {
      return counts.totalFieldLengths()
    },
    get averageFieldLengths(): Record<string, number> {
      const documents = counts.totalDocuments()
      const averages: Record<string, number> = {}
      if (documents > 0) {
        for (const [fieldName, total] of Object.entries(counts.totalFieldLengths())) {
          averages[fieldName] = total / documents
        }
      }
      return averages
    },
    get docFrequencies(): Readonly<Record<string, number>> {
      return counts.docFrequencies()
    },
    addDocumentFrequencies(into: Record<string, number>): number {
      const frequencies = counts.docFrequencies()
      let added = 0
      for (const term in frequencies) {
        const held = into[term]
        if (held === undefined) {
          into[term] = frequencies[term]
          added++
        } else into[term] = held + frequencies[term]
      }
      return added
    },
  }
}
