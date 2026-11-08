export interface PartitionStatsView {
  readonly totalDocuments: number
  readonly totalFieldLengths: Readonly<Record<string, number>>
  readonly averageFieldLengths: Readonly<Record<string, number>>
  readonly docFrequencies: Readonly<Record<string, number>>
}

export interface PartitionStats {
  totalDocuments: number
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
  docFrequencies: Record<string, number>

  addDocument(fieldLengths: Readonly<Record<string, number>>, tokens: ReadonlySet<string>): void
  removeDocument(fieldLengths: Readonly<Record<string, number>>, tokens: ReadonlySet<string>): void
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

function applyUniqueTokens(
  tokens: ReadonlySet<string>,
  docFrequencies: Record<string, number>,
  increment: 1 | -1,
): void {
  if (increment === 1) {
    for (const tok of tokens) {
      docFrequencies[tok] = (docFrequencies[tok] ?? 0) + 1
    }
  } else {
    for (const tok of tokens) {
      if (tok in docFrequencies) {
        docFrequencies[tok]--
        if (docFrequencies[tok] <= 0) {
          delete docFrequencies[tok]
        }
      }
    }
  }
}

export function createPartitionStats(): PartitionStats {
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
    docFrequencies: Object.create(null) as Record<string, number>,

    addDocument(fieldLengths: Readonly<Record<string, number>>, tokens: ReadonlySet<string>): void {
      stats.totalDocuments++

      const fields = Object.keys(fieldLengths)
      for (let i = 0; i < fields.length; i++) {
        const field = fields[i]
        stats.totalFieldLengths[field] = (stats.totalFieldLengths[field] ?? 0) + fieldLengths[field]
      }

      applyUniqueTokens(tokens, stats.docFrequencies, 1)

      averagesDirty = true
    },

    removeDocument(fieldLengths: Readonly<Record<string, number>>, tokens: ReadonlySet<string>): void {
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

      applyUniqueTokens(tokens, stats.docFrequencies, -1)

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
      const tfl = Object.create(null) as Record<string, number>
      for (const key of Object.keys(stats.totalFieldLengths)) {
        tfl[key] = stats.totalFieldLengths[key]
      }
      const afl = Object.create(null) as Record<string, number>
      for (const key of Object.keys(stats.averageFieldLengths)) {
        afl[key] = stats.averageFieldLengths[key]
      }
      const df = Object.create(null) as Record<string, number>
      for (const key of Object.keys(stats.docFrequencies)) {
        df[key] = stats.docFrequencies[key]
      }
      return {
        totalDocuments: stats.totalDocuments,
        totalFieldLengths: tfl,
        averageFieldLengths: afl,
        docFrequencies: df,
      }
    },

    deserialize(data: SerializedPartitionStats): void {
      stats.totalDocuments = data.totalDocuments
      const tfl = Object.create(null) as Record<string, number>
      for (const key of Object.keys(data.totalFieldLengths)) {
        tfl[key] = data.totalFieldLengths[key]
      }
      stats.totalFieldLengths = tfl
      const afl = Object.create(null) as Record<string, number>
      for (const key of Object.keys(data.averageFieldLengths)) {
        afl[key] = data.averageFieldLengths[key]
      }
      stats.averageFieldLengths = afl
      const df = Object.create(null) as Record<string, number>
      for (const key of Object.keys(data.docFrequencies)) {
        df[key] = data.docFrequencies[key]
      }
      stats.docFrequencies = df
    },
  }

  return stats
}
