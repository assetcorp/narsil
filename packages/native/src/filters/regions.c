#include "../regions.h"
#include "../../include/narsil_filters.h"
#include "constants.h"
#include "internal.h"

#include <stddef.h>
#include <stdint.h>

static int input_valid(const void *data, size_t length, size_t width, memory_region output) {
  memory_region region;
  return length <= UINT32_MAX && region_of(data, length, width, &region) &&
         (length == 0 || (uintptr_t)data % width == 0) && !overlaps(region, output);
}

static int field_valid(const narsil_filter_field *field, memory_region output) {
  static const size_t counts[] = {1, 3, 3, 6, 5};
  static const size_t widths[][6] = {{4}, {4, 8, 4}, {4, 4, 4}, {4, 2, 4, 4, 4, 4}, {4, 8, 8, 8, 4}};
  if (field->kind > NARSIL_FILTER_GEO || field->region_count != counts[field->kind] || field->regions[0].length == 0) {
    return 0;
  }
  for (size_t at = 0; at < field->region_count; at++) {
    if (!input_valid(field->regions[at].data, field->regions[at].length, widths[field->kind][at], output)) { return 0; }
  }
  const narsil_filter_region *regions = field->regions;
  if (field->kind == NARSIL_FILTER_NUMERIC) { return regions[1].length == regions[2].length; }
  if (field->kind == NARSIL_FILTER_BOOLEAN) { return regions[1].length > 0 && regions[2].length > 0; }
  if (field->kind == NARSIL_FILTER_ENUM) {
    return regions[2].length > 0 && regions[2].length - 1 == regions[NARSIL_FILTER_FIELD_REGIONS - 1].length &&
           regions[3].length == regions[2].length;
  }
  if (field->kind == NARSIL_FILTER_GEO) {
    return regions[1].length == regions[2].length && regions[1].length == regions[3].length &&
           regions[1].length == regions[4].length;
  }
  return 1;
}

int filter_regions_valid(const narsil_filter_program *program, memory_region output) {
  memory_region metadata;
  if (program == NULL || (uintptr_t)program % _Alignof(narsil_filter_program) != 0 ||
      !region_of(program, 1, sizeof *program, &metadata) || overlaps(metadata, output) ||
      program->plan_words % 4 != 0 || program->plan_words / 4 > FILTER_MAX_INSTRUCTIONS || program->offset_count == 0 ||
      program->list_words % 2 != 0 || program->live.count == 0 || program->live.count > FILTER_MAX_WORDS ||
      !input_valid(program->plan, program->plan_words, sizeof *program->plan, output) ||
      !input_valid(program->numbers, program->number_count, sizeof *program->numbers, output) ||
      !input_valid(program->units, program->unit_count, sizeof *program->units, output) ||
      !input_valid(program->offsets, program->offset_count, sizeof *program->offsets, output) ||
      !input_valid(program->lists, program->list_words, sizeof *program->lists, output) ||
      !input_valid(program->live.words, program->live.count, sizeof *program->live.words, output) ||
      program->field_count > UINT32_MAX || (uintptr_t)program->fields % _Alignof(narsil_filter_field) != 0 ||
      !region_of(program->fields, program->field_count, sizeof *program->fields, &metadata) ||
      overlaps(metadata, output) || program->bitset_count > UINT32_MAX ||
      (uintptr_t)program->bitsets % _Alignof(narsil_filter_bits) != 0 ||
      !region_of(program->bitsets, program->bitset_count, sizeof *program->bitsets, &metadata) ||
      overlaps(metadata, output)) {
    return 0;
  }
  for (size_t at = 0; at < program->field_count; at++) {
    if (!field_valid(&program->fields[at], output)) { return 0; }
  }
  for (size_t at = 0; at < program->bitset_count; at++) {
    const narsil_filter_bits *bits = &program->bitsets[at];
    if (bits->count == 0 || !input_valid(bits->words, bits->count, sizeof *bits->words, output)) { return 0; }
  }
  return 1;
}
