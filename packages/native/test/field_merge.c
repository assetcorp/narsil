#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_field_merge.h"
#include "../src/stored_values/values.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { FIELD_SENTINEL = 73, FIELD_ROWS = 4, STORED_INPUT_ENTRIES = 5 };
static const double FIELD_VALUE = 9;
static const double FIELD_VALUE_SENTINEL = 73;

static int same_number_bits(const double *values, const uint64_t *expected, size_t count) {
  for (size_t at = 0; at < count; at++) {
    uint64_t bits = 0;
    memcpy(&bits, values + at, sizeof bits);
    if (bits != expected[at]) { return 0; }
  }
  return 1;
}

static void numeric(narsil_workspace *workspace) {
  uint32_t mapping[] = {1, UINT32_MAX, 0};
  double values[] = {FIELD_VALUE, -0.0, 2, FIELD_VALUE};
  uint32_t ordinals[] = {0, 2, 1, 0};
  narsil_field_merge_source source = {mapping, 3, {{values, FIELD_ROWS}, {ordinals, FIELD_ROWS}}};
  narsil_field_merge_request request = {NARSIL_MERGE_NUMERIC, 2, &source, 1};
  narsil_field_merge_sizes sizes = {0};
  double out_values[FIELD_ROWS] = {FIELD_VALUE_SENTINEL, FIELD_VALUE_SENTINEL, FIELD_VALUE_SENTINEL,
                                   FIELD_VALUE_SENTINEL};
  uint32_t out_ordinals[FIELD_ROWS] = {FIELD_SENTINEL, FIELD_SENTINEL, FIELD_SENTINEL, FIELD_SENTINEL};
  narsil_field_merge_output output = {{{out_values, FIELD_ROWS}, {out_ordinals, FIELD_ROWS}}};
  check(narsil_measure_field_merge(workspace, &request, &sizes) == NARSIL_OK && sizes.lengths[0] == 3 &&
            sizes.lengths[1] == 3 && narsil_write_field_merge(workspace, &request, &output) == NARSIL_OK &&
            signbit(out_values[0]) && out_values[1] == FIELD_VALUE && out_values[2] == FIELD_VALUE &&
            out_values[3] == FIELD_VALUE_SENTINEL && out_ordinals[0] == 0 && out_ordinals[1] == 1 &&
            out_ordinals[2] == 1,
        "field merge remaps duplicate numeric elements and preserves signed zero and output tails");
  uint64_t before_values[FIELD_ROWS];
  uint32_t before_ordinals[FIELD_ROWS];
  memcpy(before_values, out_values, sizeof out_values);
  memcpy(before_ordinals, out_ordinals, sizeof out_ordinals);
  output.regions[1].capacity = 2;
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_NEEDS_ROOM &&
            same_number_bits(out_values, before_values, FIELD_ROWS) &&
            memcmp(before_ordinals, out_ordinals, sizeof out_ordinals) == 0,
        "a short field merge output refuses before changing any region");
  output.regions[1].capacity = FIELD_ROWS;
  values[2] = NAN;
  narsil_field_merge_sizes prior = sizes;
  check(narsil_measure_field_merge(workspace, &request, &sizes) == NARSIL_FILE_UNREADABLE &&
            memcmp(&sizes, &prior, sizeof sizes) == 0 &&
            narsil_write_field_merge(workspace, &request, &output) == NARSIL_FILE_UNREADABLE &&
            same_number_bits(out_values, before_values, FIELD_ROWS) &&
            memcmp(before_ordinals, out_ordinals, sizeof out_ordinals) == 0,
        "a dropped corrupt numeric entry refuses measurement and publication atomically");
  values[2] = 2;
  output.regions[0].data = values;
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT && values[0] == FIELD_VALUE,
        "field merge outputs cannot overwrite live source values");
  output.regions[0].data = out_values;
  output.regions[1].data = out_values;
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT &&
            same_number_bits(out_values, before_values, FIELD_ROWS),
        "field merge outputs cannot overlap each other");
  output.regions[1].data = out_ordinals;
  mapping[0] = 0;
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_INVALID_ARGUMENT &&
            same_number_bits(out_values, before_values, FIELD_ROWS),
        "field merge refuses duplicate target ordinals before publication");
  mapping[0] = 1;
  ordinals[0] = 3;
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_FILE_UNREADABLE,
        "field merge refuses source ordinals beyond the mapping");
}

static void stored(narsil_workspace *workspace) {
  uint32_t mapping[] = {2, UINT32_MAX, 0, 1};
  uint8_t shapes[] = {2, 1, 0, 2};
  uint32_t starts[] = {0, 2, 3, 3, STORED_INPUT_ENTRIES};
  uint8_t kinds[] = {STORED_NUMBER, STORED_NUMBER, STORED_NULL, STORED_STRING, STORED_OTHER};
  uint64_t number_bits[] = {UINT64_C(0x7ff8000000001234), UINT64_C(0x8000000000000000), 0, 0, 0};
  double numbers[STORED_INPUT_ENTRIES];
  memcpy(numbers, number_bits, sizeof numbers);
  uint32_t text_start[] = {0, 0, 0, 0, 0};
  uint32_t text_length[] = {0, 0, 0, 2, 3};
  uint16_t units[] = {UINT16_C(0xfeff), 'a'};
  uint8_t bytes[] = {UINT8_C(0x91), UINT8_C(0xc0), 1};
  narsil_field_merge_source source = {mapping,
                                      4,
                                      {{shapes, 4},
                                       {starts, STORED_INPUT_ENTRIES},
                                       {kinds, STORED_INPUT_ENTRIES},
                                       {numbers, STORED_INPUT_ENTRIES},
                                       {text_start, STORED_INPUT_ENTRIES},
                                       {text_length, STORED_INPUT_ENTRIES},
                                       {units, 2},
                                       {bytes, 3}}};
  narsil_field_merge_request request = {NARSIL_MERGE_STORED, 3, &source, 1};
  uint8_t out_shapes[3] = {0};
  uint32_t out_starts[4] = {0};
  uint8_t out_kinds[4] = {0};
  double out_numbers[4] = {0};
  uint32_t out_text_start[4] = {0};
  uint32_t out_text_length[4] = {0};
  uint16_t out_units[2] = {0};
  uint8_t out_bytes[3] = {0};
  narsil_field_merge_output output = {{{out_shapes, 3},
                                       {out_starts, 4},
                                       {out_kinds, 4},
                                       {out_numbers, 4},
                                       {out_text_start, 4},
                                       {out_text_length, 4},
                                       {out_units, 2},
                                       {out_bytes, 3}}};
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_OK && out_shapes[0] == 0 &&
            out_shapes[1] == 2 && out_shapes[2] == 2 && out_starts[1] == 0 && out_starts[2] == 2 &&
            out_starts[3] == 4 && out_kinds[0] == STORED_STRING && out_kinds[1] == STORED_OTHER &&
            out_kinds[2] == STORED_NUMBER && out_kinds[3] == STORED_NUMBER &&
            same_number_bits(out_numbers + 2, number_bits, 2) && memcmp(out_units, units, sizeof units) == 0 &&
            memcmp(out_bytes, bytes, sizeof bytes) == 0,
        "stored field merge preserves shapes, NaN payloads, signed zero, UTF-16, and encoded bytes");
  uint8_t before_shapes[3];
  memcpy(before_shapes, out_shapes, sizeof out_shapes);
  text_length[4] = 4;
  check(narsil_write_field_merge(workspace, &request, &output) == NARSIL_FILE_UNREADABLE &&
            memcmp(before_shapes, out_shapes, sizeof out_shapes) == 0 && out_starts[3] == 4 &&
            same_number_bits(out_numbers + 2, number_bits, 2),
        "a malformed stored byte span refuses before publication");
}

void field_merge_checks(narsil_workspace *workspace) {
  numeric(workspace);
  stored(workspace);
}
