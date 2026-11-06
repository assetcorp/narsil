#include "stop_words.h"

#include "../../include/narsil_core.h"
#include "text.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define FNV_OFFSET_BASIS 2166136261U
#define FNV_PRIME 16777619U
#define MIN_SLOTS 8U
#define MAX_STOP_WORDS (1U << 28)
#define EMPTY_SLOT 0U

static uint32_t hash_units(const uint16_t *units, size_t length) {
  uint32_t hash = FNV_OFFSET_BASIS;
  for (size_t i = 0; i < length; i++) {
    hash ^= units[i];
    hash *= FNV_PRIME;
  }
  return hash;
}

static uint32_t word_length(const narsil_stop_words *set, uint32_t word) {
  return set->offsets[word + 1] - set->offsets[word];
}

static int slot_holds(const narsil_stop_words *set, uint32_t slot, const uint16_t *units, size_t length) {
  uint32_t word = set->slots[slot] - 1;
  return narsil_units_equal(set->units + set->offsets[word], word_length(set, word), units, length);
}

void narsil_stop_words_release(narsil_stop_words *set) {
  free(set->units);
  free(set->offsets);
  free(set->slots);
  memset(set, 0, sizeof(*set));
}

int narsil_stop_words_build(narsil_stop_words *set, const uint16_t *units, const uint32_t *offsets, uint32_t count) {
  memset(set, 0, sizeof(*set));
  if (count > MAX_STOP_WORDS) { return NARSIL_INVALID_ARGUMENT; }
  for (uint32_t word = 0; word < count; word++) {
    if (offsets[word + 1] < offsets[word]) { return NARSIL_INVALID_ARGUMENT; }
  }
  size_t total = offsets[count];
  uint32_t slots = MIN_SLOTS;
  while (slots < count * 2U) { slots *= 2U; }
  set->units = malloc((total == 0 ? 1 : total) * sizeof(uint16_t));
  set->offsets = malloc(((size_t)count + 1) * sizeof(uint32_t));
  set->slots = calloc(slots, sizeof(uint32_t));
  if (set->units == NULL || set->offsets == NULL || set->slots == NULL) {
    narsil_stop_words_release(set);
    return NARSIL_OUT_OF_MEMORY;
  }
  if (total > 0) { memcpy(set->units, units, total * sizeof(uint16_t)); }
  memcpy(set->offsets, offsets, ((size_t)count + 1) * sizeof(uint32_t));
  set->count = count;
  set->slot_mask = slots - 1U;
  for (uint32_t word = 0; word < count; word++) {
    const uint16_t *word_units = set->units + offsets[word];
    uint32_t length = word_length(set, word);
    uint32_t slot = hash_units(word_units, length) & set->slot_mask;
    while (set->slots[slot] != EMPTY_SLOT && !slot_holds(set, slot, word_units, length)) {
      slot = (slot + 1U) & set->slot_mask;
    }
    set->slots[slot] = word + 1U;
  }
  return NARSIL_OK;
}

int narsil_stop_words_contains(const narsil_stop_words *set, const uint16_t *units, size_t length) {
  if (set->slots == NULL) { return 0; }
  uint32_t slot = hash_units(units, length) & set->slot_mask;
  while (set->slots[slot] != EMPTY_SLOT) {
    if (slot_holds(set, slot, units, length)) { return 1; }
    slot = (slot + 1U) & set->slot_mask;
  }
  return 0;
}
