#include "fdlibm.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_math.h"

#include <stddef.h>

typedef double (*unary_function)(double value);

static unary_function unary_of(narsil_math_function function) {
  switch (function) {
    case NARSIL_MATH_LOG:
      return fdlibm_log;
    case NARSIL_MATH_SIN:
      return fdlibm_sin;
    case NARSIL_MATH_COS:
      return fdlibm_cos;
    case NARSIL_MATH_TAN:
      return fdlibm_tan;
    case NARSIL_MATH_ASIN:
      return fdlibm_asin;
    case NARSIL_MATH_ATAN:
      return fdlibm_atan;
    default:
      return NULL;
  }
}

narsil_status narsil_math_apply(narsil_math_function function, const narsil_math_batch *batch) {
  if (batch == NULL || (batch->count > 0 && (batch->first == NULL || batch->results == NULL))) {
    return NARSIL_INVALID_ARGUMENT;
  }
  if (function == NARSIL_MATH_ATAN2) {
    if (batch->count > 0 && batch->second == NULL) { return NARSIL_INVALID_ARGUMENT; }
    for (size_t index = 0; index < batch->count; index++) {
      batch->results[index] = fdlibm_atan2(batch->first[index], batch->second[index]);
    }
    return NARSIL_OK;
  }
  unary_function apply = unary_of(function);
  if (apply == NULL) { return NARSIL_INVALID_ARGUMENT; }
  for (size_t index = 0; index < batch->count; index++) { batch->results[index] = apply(batch->first[index]); }
  return NARSIL_OK;
}
