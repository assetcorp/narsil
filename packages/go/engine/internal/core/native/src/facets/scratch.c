#include "scratch.h"

#include "../../include/narsil_core.h"
#include "../internal.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

narsil_status reserve_facet_scratch(facet_scratch *scratch, uint32_t count, size_t words) {
  if (words > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
  if (count <= scratch->capacity && words <= scratch->words) { return NARSIL_OK; }
  size_t capacity = grown_capacity(scratch->capacity == 0 ? 1 : scratch->capacity, count);
  size_t held_words = grown_capacity(scratch->words == 0 ? 1 : scratch->words, (uint32_t)words);
  size_t entry_bytes = sizeof(double) + sizeof(uint32_t);
  if (capacity > SIZE_MAX / entry_bytes || held_words > (SIZE_MAX - (capacity * entry_bytes)) / sizeof(uint32_t)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t bytes = (capacity * entry_bytes) + (held_words * sizeof(uint32_t));
  void *allocation = malloc(bytes);
  if (allocation == NULL) { return NARSIL_OUT_OF_MEMORY; }
  free(scratch->allocation);
  scratch->allocation = allocation;
  scratch->values = allocation;
  scratch->positions = allocation;
  scratch->spare = scratch->positions + capacity;
  scratch->counts = (uint32_t *)(scratch->values + capacity);
  scratch->seen = scratch->counts + capacity;
  scratch->capacity = (uint32_t)capacity;
  scratch->words = (uint32_t)held_words;
  scratch->bytes = bytes;
  memset(scratch->seen, 0, held_words * sizeof *scratch->seen);
  return NARSIL_OK;
}
