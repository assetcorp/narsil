#ifndef NARSIL_SORT_H
#define NARSIL_SORT_H

#include "narsil_core.h"
#include "narsil_stored_values.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { NARSIL_SORT_MIN, NARSIL_SORT_MAX, NARSIL_SORT_AVG, NARSIL_SORT_MEDIAN };
enum { NARSIL_SORT_MISSING, NARSIL_SORT_NUMBER, NARSIL_SORT_STRING, NARSIL_SORT_FALSE, NARSIL_SORT_TRUE };

typedef struct {
  double *number;
  size_t number_capacity;
  uint32_t *text;
  size_t text_capacity;
  uint32_t kind;
} narsil_sort_value_output;

narsil_status narsil_sort_value(narsil_workspace *workspace, const narsil_stored_values *values, uint32_t ordinal,
                                uint32_t mode, narsil_sort_value_output *output);

#ifdef __cplusplus
}
#endif

#endif
