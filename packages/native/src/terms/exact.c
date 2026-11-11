#include "../../include/narsil_terms.h"

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "../regions.h"
#include "dictionary.h"
#include "matching.h"
#include "table.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { UTF8_TWO_BYTE_END = 0x800, UTF8_BMP_BYTES = 3, UTF8_PAIR_BYTES = 4 };

static int token_hash(const narsil_term_dictionary *dictionary, uint32_t ordinal, uint32_t *hash) {
  term_cursor cursor;
  if (!dictionary_cursor(dictionary, ordinal, &cursor)) { return 0; }
  uint32_t value = TERM_HASH_OFFSET;
  size_t units = 0;
  uint32_t point = 0;
  int next = 0;
  while ((next = term_next(&cursor, &point)) > 0) {
    if (point < NARSIL_SUPPLEMENTARY_FIRST) {
      value = term_hash_unit(value, (uint16_t)point);
      units++;
    } else {
      uint32_t payload = point - NARSIL_SUPPLEMENTARY_FIRST;
      value =
          term_hash_unit(value, (uint16_t)(NARSIL_HIGH_SURROGATE_FIRST + (payload >> NARSIL_SURROGATE_PAYLOAD_BITS)));
      value = term_hash_unit(value, (uint16_t)(NARSIL_LOW_SURROGATE_FIRST + (payload & NARSIL_SURROGATE_PAYLOAD_MASK)));
      units += 2;
    }
    if (units > TERM_TEXT_LIMIT) { return 0; }
  }
  *hash = value;
  return next == 0;
}

narsil_status narsil_build_exact_terms(const narsil_term_dictionary *dictionary, int32_t *slots, size_t slot_count) {
  memory_region inputs[DICTIONARY_REGIONS];
  memory_region output;
  if (dictionary == NULL || dictionary->growing != NULL || !dictionary_regions(dictionary, inputs) ||
      (uintptr_t)slots % _Alignof(int32_t) != 0 ||
      !dictionary_exact_capacity(slot_count, dictionary->frequency_count) ||
      !region_of(slots, slot_count, sizeof *slots, &output)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < DICTIONARY_REGIONS; at++) {
    if (overlaps(inputs[at], output)) { return NARSIL_INVALID_ARGUMENT; }
  }
  memset(slots, 0, slot_count * sizeof *slots);
  size_t mask = slot_count - 1;
  uint32_t count = dictionary_count(dictionary);
  for (uint32_t ordinal = 0; ordinal < count; ordinal++) {
    uint32_t hash = 0;
    if (!token_hash(dictionary, ordinal, &hash)) { continue; }
    size_t slot = hash & mask;
    while (slots[slot] != 0) { slot = (slot + 1) & mask; }
    slots[slot] = (int32_t)ordinal + 1;
  }
  return NARSIL_OK;
}

static int utf8_length(const uint16_t *units, size_t length, size_t *bytes) {
  size_t total = 0;
  for (size_t at = 0; at < length; at++) {
    uint32_t unit = units[at];
    if (unit < NARSIL_ASCII_END) {
      total++;
    } else if (unit < UTF8_TWO_BYTE_END) {
      total += 2;
    } else if (unit < NARSIL_HIGH_SURROGATE_FIRST || unit >= NARSIL_SURROGATE_END) {
      total += UTF8_BMP_BYTES;
    } else if (unit < NARSIL_LOW_SURROGATE_FIRST && at + 1 < length && units[at + 1] >= NARSIL_LOW_SURROGATE_FIRST &&
               units[at + 1] < NARSIL_SURROGATE_END) {
      total += UTF8_PAIR_BYTES;
      at++;
    } else {
      return 0;
    }
  }
  *bytes = total;
  return 1;
}

int64_t dictionary_find_exact(const narsil_term_dictionary *dictionary, const uint16_t *units, size_t count) {
  size_t length = 0;
  if (!utf8_length(units, count, &length)) { return -1; }
  uint32_t terms = dictionary_count(dictionary);
  size_t mask = dictionary->exact_slot_count - 1;
  size_t slot = term_hash(units, count) & mask;
  for (size_t scanned = 0; scanned < dictionary->exact_slot_count; scanned++) {
    int32_t entry = dictionary->exact_slots[slot];
    if (entry == 0) { return -1; }
    if (entry > 0 && (uint32_t)entry <= terms) {
      uint32_t ordinal = (uint32_t)entry - 1;
      uint32_t start = dictionary->offsets[ordinal];
      uint32_t end = dictionary->offsets[(size_t)ordinal + 1];
      if (start <= end && end <= dictionary->token_bytes && end - start == length &&
          (length == 0 || term_compare_units(dictionary->tokens + start, length, units, count) == 0)) {
        return dictionary_frequency(dictionary, ordinal) > 0 ? (int64_t)ordinal : -1;
      }
    }
    slot = (slot + 1) & mask;
  }
  return -1;
}
