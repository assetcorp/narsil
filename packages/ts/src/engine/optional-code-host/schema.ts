import { undeclaredFieldOnStrictIndex } from '../../filters/operands'
import { validQueryFilter } from '../../filters/query'
import { flattenSchema } from '../../schema/validator'
import { isListBase, isStringValuedBase, parsedTypeOf, withSortableOption } from '../../schema/validator/field-type'
import { isGeopointOrVectorType, VECTOR_PATTERN } from '../../schema/validator/shared'

export function schemaHostPart() {
  return {
    flattenSchema,
    isGeopointOrVectorType,
    isListBase,
    isStringValuedBase,
    parsedTypeOf,
    undeclaredFieldOnStrictIndex,
    validQueryFilter,
    VECTOR_PATTERN,
    withSortableOption,
  }
}
