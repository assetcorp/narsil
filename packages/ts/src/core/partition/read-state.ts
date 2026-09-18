import type { GeoIndexReader } from '../../geo/geo-index'
import type { FieldNameTable } from '../../types/internal'
import type { FieldType, SchemaDefinition } from '../../types/schema'
import type { DocumentStoreReader } from '../document-store'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../field-index'
import type { InvertedIndexReader } from '../inverted-index'
import type { PartitionStatsView } from '../statistics'
import type { SurfaceRegistryReader } from '../surface-registry'
import type { ScoreBuffer } from './score-buffer'
import type { SortColumnSet } from './sort-columns'

export interface PartitionReadState {
  readonly invertedIdx: InvertedIndexReader
  readonly docStore: DocumentStoreReader
  readonly stats: PartitionStatsView
  readonly surfaceRegistry: SurfaceRegistryReader
  readonly numericIndexes: ReadonlyMap<string, NumericFieldIndexReader>
  readonly booleanIndexes: ReadonlyMap<string, BooleanFieldIndexReader>
  readonly enumIndexes: ReadonlyMap<string, EnumFieldIndexReader>
  readonly geoIndexes: ReadonlyMap<string, GeoIndexReader>
  readonly fieldNameTable: FieldNameTable
  readonly trackPositions: boolean
  flatSchemaCache: Record<string, FieldType> | null
  lastSchemaRef: SchemaDefinition | null
  sortColumns: SortColumnSet | null
  scoreBuffer: ScoreBuffer | null
}
