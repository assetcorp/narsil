#include "input.h"
#include "stored_values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_field_merge.h"
#include "../include/narsil_stored_values.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_SOURCES = 3,
  MAX_DOCUMENTS = 16,
  MAX_ROWS = 24,
  MAX_KEYS = 8,
  MAX_KEY_UNITS = 4,
  RUN_POINTS = 3,
  LETTERS = 4,
  FIRST_LETTER = 'a',
  DROP_CHOICES = 4,
  KIND_COUNT = NARSIL_MERGE_PATTERN,
  SIGNED_BYTE_SPAN = 128,
  MAX_LATITUDE = 90,
  MAX_LONGITUDE = 180
};

#define DROPPED_DOCUMENT UINT32_MAX

static const uint8_t REGION_WIDTHS[KIND_COUNT + 1][NARSIL_FIELD_MERGE_REGIONS] = {
    {0}, {8, 4}, {4, 4}, {2, 4, 4, 4, 4}, {8, 8, 8, 4}, {1, 4, 1, 8, 4, 4, 2, 1}, {4, 4, 4, 4}};

static narsil_field_merge_region region(const void *data, size_t length) {
  return (narsil_field_merge_region){data, length};
}

static narsil_field_merge_region document_ordinals(fuzz_input *input, const narsil_field_merge_source *source,
                                                   size_t rows) {
  return region(fuzz_below_each(input, (fuzz_span){rows, (uint32_t)source->document_count}), rows);
}

static void spell(fuzz_input *input, uint16_t *units, size_t count) {
  if (units == NULL || fuzz_raw(input)) { return; }
  for (size_t at = 0; at < count; at++) { units[at] = (uint16_t)(FIRST_LETTER + (units[at] % LETTERS)); }
}

static void numeric(fuzz_input *input, narsil_field_merge_source *source) {
  size_t rows = fuzz_below(input, MAX_ROWS + 1);
  source->regions[0] = region(fuzz_numbers(input, rows), rows);
  source->regions[1] = document_ordinals(input, source, rows);
}

static void boolean(fuzz_input *input, narsil_field_merge_source *source) {
  size_t words = fuzz_nonempty_bit_words(source->document_count);
  source->regions[0] = region(FUZZ_ARRAY(input, uint32_t, words), words);
  source->regions[1] = region(FUZZ_ARRAY(input, uint32_t, words), words);
}

static double coordinate(fuzz_input *input, int raw, double limit) {
  return raw ? fuzz_double(input) : (double)(int8_t)fuzz_byte(input) * (limit / (double)SIGNED_BYTE_SPAN);
}

static void geo(fuzz_input *input, narsil_field_merge_source *source) {
  size_t rows = fuzz_below(input, MAX_ROWS + 1);
  double *latitudes = FUZZ_ROOM(input, double, rows);
  double *longitudes = FUZZ_ROOM(input, double, rows);
  int raw = fuzz_raw(input);
  for (size_t at = 0; latitudes != NULL && longitudes != NULL && at < rows; at++) {
    latitudes[at] = coordinate(input, raw, MAX_LATITUDE);
    longitudes[at] = coordinate(input, raw, MAX_LONGITUDE);
  }
  source->regions[0] = region(FUZZ_ARRAY(input, uint64_t, rows), rows);
  source->regions[1] = region(latitudes, rows);
  source->regions[2] = region(longitudes, rows);
  source->regions[3] = document_ordinals(input, source, rows);
}

static void postings(fuzz_input *input, narsil_field_merge_source *source, size_t keys) {
  size_t rows = fuzz_below(input, MAX_ROWS + 1);
  source->regions[2] = region(fuzz_offsets(input, keys, (uint32_t)rows), keys + 1);
  source->regions[3] = document_ordinals(input, source, rows);
}

static void enumerated(fuzz_input *input, narsil_field_merge_source *source) {
  size_t keys = fuzz_below(input, MAX_KEYS + 1);
  size_t units = fuzz_below(input, (uint32_t)(keys * MAX_KEY_UNITS) + 1);
  uint16_t *text = FUZZ_ARRAY(input, uint16_t, units);
  spell(input, text, units);
  source->regions[0] = region(text, units);
  source->regions[1] = region(fuzz_offsets(input, keys, (uint32_t)units), keys + 1);
  postings(input, source, keys);
  source->regions[4] = region(fuzz_below_each(input, (fuzz_span){keys, (uint32_t)keys}), keys);
}

static void pattern(fuzz_input *input, narsil_field_merge_source *source) {
  size_t keys = fuzz_below(input, MAX_KEYS + 1);
  uint32_t *runs = FUZZ_ARRAY(input, uint32_t, keys *RUN_POINTS);
  for (size_t at = 0; runs != NULL && !fuzz_raw(input) && at < keys * RUN_POINTS; at++) {
    runs[at] = FIRST_LETTER + (runs[at] % LETTERS);
  }
  source->regions[1] = region(runs, keys * RUN_POINTS);
  postings(input, source, keys);
  size_t present = fuzz_below(input, MAX_ROWS + 1);
  source->regions[0] = document_ordinals(input, source, present);
}

enum {
  STORED_SHAPES,
  STORED_STARTS,
  STORED_KINDS,
  STORED_NUMBERS,
  STORED_TEXT_STARTS,
  STORED_TEXT_LENGTHS,
  STORED_UNITS,
  STORED_BYTES
};

static void stored(fuzz_input *input, narsil_field_merge_source *source) {
  narsil_stored_values values = fuzz_stored_values(input, (uint32_t)source->document_count);
  source->regions[STORED_SHAPES] = region(values.shapes, values.shape_count);
  source->regions[STORED_STARTS] = region(values.starts, values.start_count);
  source->regions[STORED_KINDS] = region(values.kinds, values.kind_count);
  source->regions[STORED_NUMBERS] = region(values.numbers, values.number_count);
  source->regions[STORED_TEXT_STARTS] = region(values.text_start, values.text_start_count);
  source->regions[STORED_TEXT_LENGTHS] = region(values.text_length, values.text_length_count);
  source->regions[STORED_UNITS] = region(values.units, values.unit_count);
  source->regions[STORED_BYTES] = region(values.bytes, values.byte_count);
}

static void fill_source(fuzz_input *input, uint32_t kind, narsil_field_merge_source *source, uint32_t *target) {
  source->document_count = fuzz_below(input, MAX_DOCUMENTS + 1);
  uint32_t *mapping = FUZZ_ARRAY(input, uint32_t, source->document_count);
  for (size_t at = 0; mapping != NULL && !fuzz_raw(input) && at < source->document_count; at++) {
    mapping[at] = mapping[at] % DROP_CHOICES == 0 ? DROPPED_DOCUMENT : (*target)++;
  }
  source->mapping = mapping;
  switch (kind) {
    case NARSIL_MERGE_NUMERIC:
      numeric(input, source);
      break;
    case NARSIL_MERGE_BOOLEAN:
      boolean(input, source);
      break;
    case NARSIL_MERGE_ENUM:
      enumerated(input, source);
      break;
    case NARSIL_MERGE_GEO:
      geo(input, source);
      break;
    case NARSIL_MERGE_STORED:
      stored(input, source);
      break;
    default:
      pattern(input, source);
      break;
  }
}

static void write_merge(narsil_workspace *workspace, fuzz_input *input, const narsil_field_merge_request *request,
                        const narsil_field_merge_sizes *sizes) {
  narsil_field_merge_output output = {{{NULL, 0}}};
  uint32_t kind = request->kind <= KIND_COUNT ? request->kind : 0;
  int short_region = fuzz_raw(input);
  uint32_t shortened = fuzz_below(input, NARSIL_FIELD_MERGE_REGIONS);
  for (uint32_t at = 0; at < NARSIL_FIELD_MERGE_REGIONS; at++) {
    size_t width = REGION_WIDTHS[kind][at];
    size_t capacity = width == 0 ? 0 : sizes->lengths[at];
    if (short_region && at == shortened && capacity > 0) { capacity--; }
    output.regions[at] = (narsil_field_merge_target){width == 0 ? NULL : fuzz_room(input, capacity, width), capacity};
  }
  if (input->exhausted_memory) { return; }
  (void)narsil_write_field_merge(workspace, request, &output);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  uint32_t kind = fuzz_raw(&input) ? fuzz_u32(&input) : NARSIL_MERGE_NUMERIC + fuzz_below(&input, KIND_COUNT);
  size_t count = fuzz_below(&input, MAX_SOURCES + 1);
  narsil_field_merge_source *sources = FUZZ_ZEROED(&input, narsil_field_merge_source, count);
  uint32_t target = 0;
  for (size_t at = 0; sources != NULL && at < count; at++) {
    fill_source(&input, kind < NARSIL_MERGE_NUMERIC || kind > KIND_COUNT ? NARSIL_MERGE_NUMERIC : kind, &sources[at],
                &target);
  }
  uint32_t documents = fuzz_raw(&input) ? fuzz_below(&input, MAX_DOCUMENTS * MAX_SOURCES) : target;
  narsil_field_merge_request request = {kind, documents, sources, count};
  narsil_field_merge_sizes sizes = {{0}};
  if (!input.exhausted_memory && narsil_measure_field_merge(workspace, &request, &sizes) == NARSIL_OK) {
    write_merge(workspace, &input, &request, &sizes);
  }
  (void)narsil_workspace_bytes(workspace);
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
