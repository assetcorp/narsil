#include "input.h"

#include "../include/narsil_core.h"
#include "../include/narsil_filters.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_FIELDS = 4,
  MAX_INSTRUCTIONS = 24,
  INSTRUCTION_WORDS = 4,
  OPCODE_CHOICES = NARSIL_FILTER_BITSET + 2,
  OPERATOR_CHOICES = NARSIL_FILTER_POLYGON + 2,
  KIND_CHOICES = NARSIL_FILTER_GEO + 2,
  MAX_OPERAND = 48,
  MAX_NUMBERS = 64,
  MAX_UNITS = 128,
  MAX_OFFSETS = 24,
  MAX_LIST_WORDS = 16,
  MAX_BITSETS = 3,
  MAX_REGION_ENTRIES = 48,
  MAX_LIVE_WORDS = 8,
  MAX_OUTPUT_WORDS = 10,
  RADIUS_NUMBERS = 4,
  MIN_POLYGON_POINTS = 3,
  DEGREE_STEPS = 3600
};

#define MAX_LATITUDE 90.0
#define MAX_LONGITUDE 180.0

static const size_t REGION_COUNTS[] = {1, 3, 3, 6, 5};
static const size_t REGION_WIDTHS[][NARSIL_FILTER_FIELD_REGIONS] = {
    {4}, {4, 8, 4}, {4, 4, 4}, {4, 2, 4, 4, 4, 4}, {4, 8, 8, 8, 4}};

static void shape_lengths(uint32_t kind, size_t *lengths) {
  if (kind == NARSIL_FILTER_NUMERIC) { lengths[2] = lengths[1]; }
  if (kind == NARSIL_FILTER_BOOLEAN) {
    lengths[1] += lengths[1] == 0;
    lengths[2] += lengths[2] == 0;
  }
  if (kind == NARSIL_FILTER_ENUM) {
    lengths[2] += lengths[2] == 0;
    lengths[3] = lengths[2];
    lengths[NARSIL_FILTER_FIELD_REGIONS - 1] = lengths[2] - 1;
  }
  if (kind == NARSIL_FILTER_GEO) { lengths[2] = lengths[3] = lengths[4] = lengths[1]; }
  lengths[0] += lengths[0] == 0;
}

static narsil_filter_field fuzz_field(fuzz_input *input) {
  narsil_filter_field field = {fuzz_below(input, KIND_CHOICES), 0, {{NULL, 0}}};
  int shaped = (fuzz_byte(input) & 1U) == 0 && field.kind <= NARSIL_FILTER_GEO;
  field.region_count = shaped ? REGION_COUNTS[field.kind] : fuzz_below(input, NARSIL_FILTER_FIELD_REGIONS + 1);
  size_t lengths[NARSIL_FILTER_FIELD_REGIONS] = {0};
  for (size_t at = 0; at < field.region_count; at++) { lengths[at] = fuzz_below(input, MAX_REGION_ENTRIES + 1); }
  if (shaped) { shape_lengths(field.kind, lengths); }
  for (size_t at = 0; at < field.region_count; at++) {
    size_t width = field.kind <= NARSIL_FILTER_GEO && REGION_WIDTHS[field.kind][at] != 0 ? REGION_WIDTHS[field.kind][at]
                                                                                         : sizeof(uint32_t);
    void *data =
        width == sizeof(double) ? (void *)fuzz_numbers(input, lengths[at]) : fuzz_array(input, lengths[at], width);
    field.regions[at] = (narsil_filter_region){data, lengths[at]};
  }
  return field;
}

static uint32_t *fuzz_plan(fuzz_input *input, size_t *words) {
  size_t instructions = fuzz_below(input, MAX_INSTRUCTIONS + 1);
  *words = instructions * INSTRUCTION_WORDS;
  uint32_t *plan = FUZZ_ROOM(input, uint32_t, *words);
  for (size_t at = 0; plan != NULL && at < instructions; at++) {
    uint32_t *instruction = plan + (at * INSTRUCTION_WORDS);
    instruction[0] = fuzz_below(input, OPCODE_CHOICES);
    instruction[1] = fuzz_below(input, MAX_FIELDS + 1);
    instruction[2] = fuzz_below(input, OPERATOR_CHOICES);
    instruction[3] = (fuzz_byte(input) & 1U) == 0 ? fuzz_below(input, MAX_OPERAND) : fuzz_u32(input);
  }
  return plan;
}

static double fuzz_degrees(fuzz_input *input, double limit) {
  return ((double)fuzz_below(input, DEGREE_STEPS + 1) / (double)DEGREE_STEPS * 2 * limit) - limit;
}

static void write_geo_operand(fuzz_input *input, uint32_t *instruction, double *numbers, size_t number_count) {
  size_t needed = instruction[2] == NARSIL_FILTER_RADIUS ? RADIUS_NUMBERS : 1 + (2 * MIN_POLYGON_POINTS);
  if (number_count < needed) { return; }
  size_t operand = fuzz_below(input, (uint32_t)(number_count - needed + 1));
  instruction[3] = (uint32_t)operand;
  double *block = numbers + operand;
  if (instruction[2] == NARSIL_FILTER_RADIUS) {
    block[0] = fuzz_degrees(input, MAX_LATITUDE);
    block[1] = fuzz_degrees(input, MAX_LONGITUDE);
    block[2] = (double)fuzz_u32(input);
    block[3] = fuzz_byte(input) & 1U;
    return;
  }
  size_t points =
      MIN_POLYGON_POINTS + fuzz_below(input, (uint32_t)((number_count - operand - 1) / 2) - MIN_POLYGON_POINTS + 1);
  block[0] = (double)points;
  for (size_t at = 0; at < points; at++) {
    block[1 + (2 * at)] = fuzz_degrees(input, MAX_LATITUDE);
    block[2 + (2 * at)] = fuzz_degrees(input, MAX_LONGITUDE);
  }
}

static void shape_geo_tests(fuzz_input *input, uint32_t *plan, size_t words, const narsil_filter_field *fields,
                            size_t field_count, double *numbers, size_t number_count) {
  for (size_t at = 0; plan != NULL && numbers != NULL && at < words; at += INSTRUCTION_WORDS) {
    uint32_t *instruction = plan + at;
    if (instruction[0] != NARSIL_FILTER_TEST || instruction[1] >= field_count ||
        fields[instruction[1]].kind != NARSIL_FILTER_GEO || (fuzz_byte(input) & 1U) != 0) {
      continue;
    }
    instruction[2] = (fuzz_byte(input) & 1U) == 0 ? NARSIL_FILTER_RADIUS : NARSIL_FILTER_POLYGON;
    write_geo_operand(input, instruction, numbers, number_count);
  }
}

static uint32_t *string_starts(fuzz_input *input, fuzz_span strings) {
  uint32_t *offsets = FUZZ_ARRAY(input, uint32_t, strings.count);
  if ((fuzz_byte(input) & 1U) == 0 && offsets != NULL) { fuzz_ascend(offsets, strings); }
  return offsets;
}

static narsil_filter_bits fuzz_words(fuzz_input *input, size_t limit) {
  size_t count = fuzz_below(input, (uint32_t)limit + 1);
  return (narsil_filter_bits){FUZZ_ARRAY(input, uint32_t, count), count};
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  size_t field_count = fuzz_below(&input, MAX_FIELDS + 1);
  narsil_filter_field *fields = FUZZ_ROOM(&input, narsil_filter_field, field_count);
  for (size_t at = 0; fields != NULL && at < field_count; at++) { fields[at] = fuzz_field(&input); }
  size_t bitset_count = fuzz_below(&input, MAX_BITSETS + 1);
  narsil_filter_bits *bitsets = FUZZ_ROOM(&input, narsil_filter_bits, bitset_count);
  for (size_t at = 0; bitsets != NULL && at < bitset_count; at++) { bitsets[at] = fuzz_words(&input, MAX_LIVE_WORDS); }
  size_t plan_words = 0;
  uint32_t *plan = fuzz_plan(&input, &plan_words);
  size_t number_count = fuzz_below(&input, MAX_NUMBERS + 1);
  double *numbers = fuzz_numbers(&input, number_count);
  shape_geo_tests(&input, plan, plan_words, fields, fields == NULL ? 0 : field_count, numbers, number_count);
  size_t unit_count = fuzz_below(&input, MAX_UNITS + 1);
  const uint16_t *units = FUZZ_ARRAY(&input, uint16_t, unit_count);
  size_t offset_count = fuzz_below(&input, MAX_OFFSETS + 1);
  const uint32_t *offsets = string_starts(&input, (fuzz_span){offset_count, (uint32_t)unit_count});
  size_t list_words = fuzz_below(&input, MAX_LIST_WORDS + 1);
  narsil_filter_program program = {plan,         plan_words,   numbers,
                                   number_count, units,        unit_count,
                                   offsets,      offset_count, FUZZ_ARRAY(&input, uint32_t, list_words),
                                   list_words,   bitsets,      bitset_count,
                                   fields,       field_count,  fuzz_words(&input, MAX_LIVE_WORDS)};
  size_t into_words = fuzz_below(&input, MAX_OUTPUT_WORDS + 1);
  uint32_t *into = FUZZ_ROOM(&input, uint32_t, into_words);
  if (!input.exhausted_memory) { (void)narsil_evaluate_filter(workspace, &program, into, into_words); }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
