#include "table.h"

#include "../../include/narsil_terms.h"
#include "../regions.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define FNV_OFFSET UINT32_C(0x811c9dc5)
enum { FNV_PRIME = 0x01000193U, BYTE_SHIFT = 8, BYTE_MASK = 255 };

int term_table_regions(const narsil_term_table *table, memory_region regions[TERM_TABLE_REGIONS]) {
  if (table == NULL || table->header_words != TERM_HEADER_WORDS || table->head_count != TERM_HEAD_COUNT ||
      table->slot_count < 2 || table->slot_count > (size_t)INT32_MAX + 1 ||
      (table->slot_count & (table->slot_count - 1)) != 0 || table->offset_count > INT32_MAX ||
      table->length_count != table->offset_count || table->next_count != table->offset_count ||
      table->unit_count > UINT32_MAX) {
    return 0;
  }
  enum { NEXT_REGION = 5, HEAD_REGION, UNITS_REGION };
  if (!region_of(table, 1, sizeof *table, &regions[0]) ||
      !region_of(table->header, table->header_words, sizeof *table->header, &regions[1]) ||
      !region_of(table->slots, table->slot_count, sizeof *table->slots, &regions[2]) ||
      !region_of(table->term_offset, table->offset_count, sizeof *table->term_offset, &regions[3]) ||
      !region_of(table->term_length, table->length_count, sizeof *table->term_length, &regions[4]) ||
      !region_of(table->first_unit_next, table->next_count, sizeof *table->first_unit_next, &regions[NEXT_REGION]) ||
      !region_of(table->first_unit_head, table->head_count, sizeof *table->first_unit_head, &regions[HEAD_REGION]) ||
      !region_of(table->units, table->unit_count, sizeof *table->units, &regions[UNITS_REGION])) {
    return 0;
  }
  return table->header[TERM_COUNT] <= table->offset_count &&
         table->header[TERM_LIVE_COUNT] <= table->header[TERM_COUNT] &&
         table->header[TERM_SLOT_CAPACITY] == table->slot_count && table->header[TERM_UNITS_USED] <= table->unit_count;
}

uint32_t term_hash(const uint16_t *units, size_t length) {
  uint32_t hash = FNV_OFFSET;
  for (size_t at = 0; at < length; at++) {
    hash = (hash ^ (units[at] & BYTE_MASK)) * FNV_PRIME;
    hash = (hash ^ (units[at] >> BYTE_SHIFT)) * FNV_PRIME;
  }
  return hash;
}

static int equal_term(const narsil_term_table *table, uint32_t ordinal, const uint16_t *units, size_t length) {
  if (ordinal >= table->header[TERM_COUNT] || table->term_length[ordinal] != length) { return 0; }
  uint32_t start = table->term_offset[ordinal];
  uint32_t used = table->header[TERM_UNITS_USED];
  if (start > used || length > used - start) { return 0; }
  return length == 0 || memcmp(table->units + start, units, length * sizeof *units) == 0;
}

int64_t term_table_find_hashed(const narsil_term_table *table, uint32_t hash, const uint16_t *units, size_t length) {
  size_t mask = table->slot_count - 1;
  size_t slot = hash & mask;
  for (size_t scanned = 0; scanned < table->slot_count; scanned++) {
    int32_t entry = table->slots[slot];
    if (entry == 0) { return -1; }
    if (entry > 0 && equal_term(table, (uint32_t)entry - 1, units, length)) { return entry - 1; }
    slot = (slot + 1) & mask;
  }
  return -1;
}

int64_t term_table_find(const narsil_term_table *table, const uint16_t *units, size_t length) {
  return term_table_find_hashed(table, term_hash(units, length), units, length);
}
