#ifndef NARSIL_MATH_H
#define NARSIL_MATH_H

#include "narsil_core.h"

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  NARSIL_MATH_LOG = 0,
  NARSIL_MATH_SIN = 1,
  NARSIL_MATH_COS = 2,
  NARSIL_MATH_TAN = 3,
  NARSIL_MATH_ASIN = 4,
  NARSIL_MATH_ATAN = 5,
  NARSIL_MATH_ATAN2 = 6,
  NARSIL_MATH_FUNCTION_COUNT = 7,
} narsil_math_function;

typedef struct {
  const double *first;
  const double *second;
  double *results;
  size_t count;
} narsil_math_batch;

narsil_status narsil_math_apply(narsil_math_function function, const narsil_math_batch *batch);

#ifdef __cplusplus
}
#endif

#endif
