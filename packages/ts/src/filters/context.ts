import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../core/field-index'
import type { TextRangeBounds } from '../core/partition/sort-columns/range'
import type { PatternFilterContext } from '../core/pattern-index/types'
import type { GeoIndexReader } from '../geo/geo-index'
import type { FieldType } from '../types/schema'

export interface FilterContext extends PatternFilterContext {
  readonly fieldTypes: Readonly<Record<string, FieldType>>
  numericIndex(fieldPath: string): NumericFieldIndexReader | undefined
  booleanIndex(fieldPath: string): BooleanFieldIndexReader | undefined
  enumIndex(fieldPath: string): EnumFieldIndexReader | undefined
  geoIndex(fieldPath: string): GeoIndexReader | undefined
  sizeIndex(fieldPath: string): NumericFieldIndexReader | undefined
  textRangeBitset(fieldPath: string, bounds: TextRangeBounds): Uint32Array
}
