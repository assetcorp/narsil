export interface PartitionStatsView {
  readonly totalDocuments: number
  readonly totalFieldLengths: Readonly<Record<string, number>>
  readonly averageFieldLengths: Readonly<Record<string, number>>
  readonly docFrequencies: Readonly<Record<string, number>>
  addDocumentFrequencies(into: Record<string, number>): number
}

export type DocumentFrequencyWalk = (into: Record<string, number>) => number

export interface PartitionStats {
  totalDocuments: number
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
  readonly docFrequencies: Readonly<Record<string, number>>
  addDocumentFrequencies(into: Record<string, number>): number

  addDocument(fieldLengths: Readonly<Record<string, number>>): void
  removeDocument(fieldLengths: Readonly<Record<string, number>>): void
  recalculateAverages(): void
  serialize(): SerializedPartitionStats
  deserialize(data: SerializedPartitionStats): void
}

export interface SerializedPartitionStats {
  totalDocuments: number
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
  docFrequencies: Record<string, number>
}

function copyOf(source: Readonly<Record<string, number>>): Record<string, number> {
  const copy = Object.create(null) as Record<string, number>
  for (const key of Object.keys(source)) copy[key] = source[key]
  return copy
}

function walkedFrequencies(walk: DocumentFrequencyWalk): Record<string, number> {
  const frequencies = Object.create(null) as Record<string, number>
  walk(frequencies)
  return frequencies
}

export function createPartitionStats(addDocumentFrequencies: DocumentFrequencyWalk): PartitionStats {
  let averages = Object.create(null) as Record<string, number>
  let averagesDirty = false
  const stats: PartitionStats = {
    totalDocuments: 0,
    totalFieldLengths: Object.create(null) as Record<string, number>,
    get averageFieldLengths() {
      if (averagesDirty) stats.recalculateAverages()
      return averages
    },
    set averageFieldLengths(value) {
      averages = value
      averagesDirty = false
    },
    get docFrequencies() {
      return walkedFrequencies(addDocumentFrequencies)
    },
    addDocumentFrequencies,

    addDocument(fieldLengths: Readonly<Record<string, number>>): void {
      stats.totalDocuments++

      const fields = Object.keys(fieldLengths)
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        stats.totalFieldLengths[field] = (stats.totalFieldLengths[field] ?? 0) + fieldLengths[field]
      }

      averagesDirty = true
    },

    removeDocument(fieldLengths: Readonly<Record<string, number>>): void {
      if (stats.totalDocuments === 0) return
      stats.totalDocuments--

      const fields = Object.keys(fieldLengths)
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        if (field in stats.totalFieldLengths) {
          stats.totalFieldLengths[field] -= fieldLengths[field]
          if (stats.totalFieldLengths[field] <= 0) {
            delete stats.totalFieldLengths[field]
          }
        }
      }

      averagesDirty = true
    },

    recalculateAverages(): void {
      const fields = Object.keys(stats.totalFieldLengths)
      const newAverages = Object.create(null) as Record<string, number>
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        newAverages[field] = stats.totalDocuments > 0 ? stats.totalFieldLengths[field] / stats.totalDocuments : 0
      }
      stats.averageFieldLengths = newAverages
    },

    serialize(): SerializedPartitionStats {
      return {
        totalDocuments: stats.totalDocuments,
        totalFieldLengths: copyOf(stats.totalFieldLengths),
        averageFieldLengths: copyOf(stats.averageFieldLengths),
        docFrequencies: walkedFrequencies(addDocumentFrequencies),
      }
    },

    deserialize(data: SerializedPartitionStats): void {
      stats.totalDocuments = data.totalDocuments
      stats.totalFieldLengths = copyOf(data.totalFieldLengths)
      stats.averageFieldLengths = copyOf(data.averageFieldLengths)
    },
  }

  return stats
}
