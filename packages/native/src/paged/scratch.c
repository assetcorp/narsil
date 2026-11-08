#include "cache.h"

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdlib.h>

narsil_status paged_reserve_values(paged_scratch *scratch, size_t bytes) {
  if (bytes <= scratch->value_capacity) { return NARSIL_OK; }
  void *grown = realloc(scratch->values, bytes);
  if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
  scratch->values = grown;
  scratch->value_capacity = bytes;
  return NARSIL_OK;
}
