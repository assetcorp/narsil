#include "strings.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_terms.h"
#include "../terms/table.h"

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { MIN_STRING_CAPACITY = 16, STRING_SLOT_FACTOR = 2 };

narsil_status segment_strings_reserve(segment_strings *strings, size_t capacity) {
  if (capacity <= strings->capacity) { return NARSIL_OK; }
  if (capacity > UINT32_MAX || capacity > SIZE_MAX / sizeof(segment_string)) { return NARSIL_OUT_OF_MEMORY; }
  size_t held = strings->capacity == 0 ? MIN_STRING_CAPACITY : strings->capacity;
  while (held < capacity) {
    if (held > UINT32_MAX / STRING_SLOT_FACTOR) {
      held = capacity;
      break;
    }
    held *= STRING_SLOT_FACTOR;
  }
  size_t slots = STRING_SLOT_FACTOR;
  while (slots <= held) {
    if (slots > SIZE_MAX / STRING_SLOT_FACTOR) { return NARSIL_OUT_OF_MEMORY; }
    slots *= STRING_SLOT_FACTOR;
  }
  if (held > SIZE_MAX / sizeof(segment_string) ||
      slots > (SIZE_MAX - (held * sizeof(segment_string))) / (2 * sizeof(uint32_t))) {
    return NARSIL_OUT_OF_MEMORY;
  }
  segment_string *entries = malloc(held * sizeof *entries);
  uint32_t *table = calloc(slots, sizeof *table);
  uint32_t *placements = malloc(slots * sizeof *placements);
  if (entries == NULL || table == NULL || placements == NULL) {
    free(entries);
    free(table);
    free(placements);
    return NARSIL_OUT_OF_MEMORY;
  }
  if (strings->count > 0) { memcpy(entries, strings->entries, strings->count * sizeof *entries); }
  for (size_t index = 0; index < strings->count; index++) {
    const segment_string *entry = entries + index;
    size_t slot = entry->hash & (slots - 1);
    while (table[slot] != 0) { slot = (slot + 1) & (slots - 1); }
    table[slot] = (uint32_t)index + 1;
  }
  free(strings->entries);
  free(strings->slots);
  free(strings->placements);
  strings->entries = entries;
  strings->slots = table;
  strings->placements = placements;
  strings->capacity = held;
  strings->slot_capacity = slots;
  return NARSIL_OK;
}

void segment_strings_reset(segment_strings *strings) {
  strings->count = 0;
  strings->added = 0;
  strings->units = 0;
  if (strings->slot_capacity > 0) { memset(strings->slots, 0, strings->slot_capacity * sizeof *strings->slots); }
}

void segment_strings_release(segment_strings *strings) {
  free(strings->entries);
  free(strings->slots);
  free(strings->placements);
  memset(strings, 0, sizeof *strings);
}

size_t segment_strings_bytes(const segment_strings *strings) {
  return (strings->capacity * sizeof *strings->entries) +
         (strings->slot_capacity * (sizeof *strings->slots + sizeof *strings->placements));
}

static int equal_text(const segment_string *entry, const uint16_t *text, size_t length) {
  return entry->length == length && (length == 0 || memcmp(entry->text, text, length * sizeof *text) == 0);
}

segment_string *segment_string_find(segment_strings *strings, const uint16_t *text, size_t length) {
  if (strings->slot_capacity == 0) { return NULL; }
  size_t mask = strings->slot_capacity - 1;
  size_t slot = term_hash(text, length) & mask;
  while (strings->slots[slot] != 0) {
    segment_string *entry = strings->entries + strings->slots[slot] - 1;
    if (equal_text(entry, text, length)) { return entry; }
    slot = (slot + 1) & mask;
  }
  return NULL;
}

static size_t probe_prepared(const segment_strings *strings, uint32_t hash, const uint16_t *text, size_t length,
                             segment_string **held) {
  size_t mask = strings->slot_capacity - 1;
  size_t slot = hash & mask;
  while (strings->slots[slot] != 0) {
    segment_string *entry = strings->entries + strings->slots[slot] - 1;
    if (entry->hash == hash && equal_text(entry, text, length)) {
      *held = entry;
      return slot;
    }
    slot = (slot + 1) & mask;
  }
  *held = NULL;
  return slot;
}

static narsil_status prepare_string(segment_strings *strings, const narsil_term_table *table, int existing,
                                    const uint16_t *text, size_t length, segment_string **entry) {
  if (length > UINT32_MAX || (length > 0 && text == NULL)) { return NARSIL_INVALID_ARGUMENT; }
  if (strings->slot_capacity == 0) {
    narsil_status status = segment_strings_reserve(strings, MIN_STRING_CAPACITY);
    if (status != NARSIL_OK) { return status; }
  }
  uint32_t hash = term_hash(text, length);
  segment_string *held = NULL;
  size_t slot = probe_prepared(strings, hash, text, length, &held);
  if (held != NULL) {
    *entry = held;
    return NARSIL_OK;
  }
  int64_t found = table == NULL ? -1 : term_table_find_hashed(table, hash, text, length);
  if (existing && found < 0) {
    *entry = NULL;
    return NARSIL_OK;
  }
  if (strings->count == strings->capacity) {
    narsil_status status = segment_strings_reserve(strings, strings->count + 1);
    if (status != NARSIL_OK) { return status; }
    slot = probe_prepared(strings, hash, text, length, &held);
  }
  size_t stored = table == NULL ? 0 : table->header[TERM_COUNT];
  size_t ordinal = found < 0 ? stored + strings->added : (size_t)found;
  if (table != NULL && (ordinal >= INT32_MAX || (found < 0 && length > UINT32_MAX - strings->units))) {
    return NARSIL_NEEDS_ROOM;
  }
  segment_string *prepared = strings->entries + strings->count;
  *prepared =
      (segment_string){.text = text, .length = length, .ordinal = (uint32_t)ordinal, .added = found < 0, .hash = hash};
  strings->slots[slot] = (uint32_t)++strings->count;
  if (found < 0) {
    strings->added++;
    if (table != NULL) { strings->units += length; }
  }
  *entry = prepared;
  return NARSIL_OK;
}

narsil_status segment_string_prepare(segment_strings *strings, const narsil_term_table *table, const uint16_t *text,
                                     size_t length, segment_string **entry) {
  return prepare_string(strings, table, 0, text, length, entry);
}

narsil_status segment_string_prepare_existing(segment_strings *strings, const narsil_term_table *table,
                                              const uint16_t *text, size_t length, segment_string **entry) {
  return prepare_string(strings, table, 1, text, length, entry);
}

static size_t placement_slot(const segment_strings *strings, size_t slot) {
  size_t position = slot & (strings->slot_capacity - 1);
  while (strings->placements[position] != 0 && strings->entries[strings->placements[position] - 1].slot != slot) {
    position = (position + 1) & (strings->slot_capacity - 1);
  }
  return position;
}

static narsil_status place_string(segment_strings *strings, const narsil_term_table *table, size_t index) {
  segment_string *entry = strings->entries + index;
  size_t mask = table->slot_count - 1;
  size_t slot = entry->hash & mask;
  size_t chosen = SIZE_MAX;
  for (size_t scanned = 0; scanned < table->slot_count; scanned++) {
    size_t placed = placement_slot(strings, slot);
    if (strings->placements[placed] == 0 && table->slots[slot] <= 0) {
      if (chosen == SIZE_MAX) {
        chosen = slot;
      } else if (table->slots[slot] == 0) {
        entry->slot = (uint32_t)chosen;
        strings->placements[placement_slot(strings, chosen)] = (uint32_t)index + 1;
        return NARSIL_OK;
      }
    }
    slot = (slot + 1) & mask;
  }
  return NARSIL_NEEDS_ROOM;
}

narsil_status segment_strings_check(segment_strings *strings, const narsil_term_table *table) {
  if (strings->added > table->offset_count - table->header[TERM_COUNT] ||
      strings->units > table->unit_count - table->header[TERM_UNITS_USED] ||
      strings->added >= table->slot_count - table->header[TERM_LIVE_COUNT]) {
    return NARSIL_NEEDS_ROOM;
  }
  if (strings->added == 0) { return NARSIL_OK; }
  memset(strings->placements, 0, strings->slot_capacity * sizeof *strings->placements);
  for (size_t at = 0; at < strings->count; at++) {
    if (!strings->entries[at].added) { continue; }
    narsil_status status = place_string(strings, table, at);
    if (status != NARSIL_OK) { return status; }
  }
  return NARSIL_OK;
}

void segment_strings_publish(const segment_strings *strings, narsil_term_table *table) {
  uint32_t offset = table->header[TERM_UNITS_USED];
  for (size_t at = 0; at < strings->count; at++) {
    const segment_string *entry = strings->entries + at;
    if (!entry->added) { continue; }
    uint32_t ordinal = entry->ordinal;
    if (entry->length > 0) {
      memcpy(table->units + offset, entry->text, entry->length * sizeof *entry->text);
      uint16_t first = entry->text[0];
      table->first_unit_next[ordinal] = table->first_unit_head[first];
      table->first_unit_head[first] = ordinal + 1;
    } else {
      table->first_unit_next[ordinal] = 0;
    }
    table->term_offset[ordinal] = offset;
    table->term_length[ordinal] = (uint32_t)entry->length;
    table->slots[entry->slot] = (int32_t)ordinal + 1;
    offset += (uint32_t)entry->length;
  }
  table->header[TERM_COUNT] += (uint32_t)strings->added;
  table->header[TERM_LIVE_COUNT] += (uint32_t)strings->added;
  table->header[TERM_UNITS_USED] = offset;
}

narsil_status segment_string_add_count(segment_string *entry, uint32_t current, uint32_t added) {
  uint64_t count = (uint64_t)current + entry->count + added;
  if (count > UINT32_MAX) { return NARSIL_SEGMENT_FULL; }
  entry->count += added;
  return NARSIL_OK;
}

void segment_string_remove(narsil_term_table *table, const segment_string *entry) {
  size_t mask = table->slot_count - 1;
  size_t slot = entry->hash & mask;
  for (size_t scanned = 0; scanned < table->slot_count; scanned++) {
    int32_t held = table->slots[slot];
    if (held == 0) { return; }
    if (held > 0 && (uint32_t)held - 1 == entry->ordinal) {
      table->slots[slot] = -1;
      if (table->header[TERM_LIVE_COUNT] > 0) { table->header[TERM_LIVE_COUNT]--; }
      return;
    }
    slot = (slot + 1) & mask;
  }
}
