#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort_order.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
  SORT_ORDINALS = 8,
  SORT_UNITS = 2,
  SORT_COUNTS = 2,
  UPPERCASE_ORDINAL = 5,
  DISTINCT_VALUES = 5,
  PRESENT_VALUES = 6
};

typedef struct {
  uint8_t kinds[SORT_ORDINALS];
  double numbers[SORT_ORDINALS];
  uint32_t starts[SORT_ORDINALS];
  uint32_t lengths[SORT_ORDINALS];
  uint16_t units[SORT_UNITS];
  uint32_t live[1];
  uint8_t out_kinds[SORT_ORDINALS];
  double out_numbers[SORT_ORDINALS];
  uint32_t out_starts[SORT_ORDINALS];
  uint32_t out_lengths[SORT_ORDINALS];
  uint16_t out_units[SORT_UNITS];
  int32_t ranks[SORT_ORDINALS];
  uint32_t ordered[SORT_ORDINALS];
  uint32_t dirty[1];
  uint32_t counts[SORT_COUNTS];
  narsil_sort_values current;
  narsil_sort_order_output output;
} order_fixture;

static void prepare(order_fixture *fixture) {
  memset(fixture, 0, sizeof *fixture);
  const uint8_t kinds[] = {1, 1, 1, 1, 2, 2, 3, 0};
  memcpy(fixture->kinds, kinds, sizeof kinds);
  fixture->numbers[0] = -0.0;
  fixture->numbers[1] = 3;
  fixture->numbers[2] = NAN;
  fixture->starts[UPPERCASE_ORDINAL] = 1;
  fixture->lengths[4] = 1;
  fixture->lengths[UPPERCASE_ORDINAL] = 1;
  fixture->units[0] = 'a';
  fixture->units[1] = 'A';
  fixture->live[0] = UINT32_C(0xfffffffb);
  fixture->dirty[0] = UINT32_MAX;
  fixture->current =
      (narsil_sort_values){fixture->kinds, SORT_ORDINALS,    fixture->numbers, SORT_ORDINALS,  fixture->starts,
                           SORT_ORDINALS,  fixture->lengths, SORT_ORDINALS,    fixture->units, SORT_UNITS};
  fixture->output = (narsil_sort_order_output){{fixture->out_kinds, SORT_ORDINALS, fixture->out_numbers, SORT_ORDINALS,
                                                fixture->out_starts, SORT_ORDINALS, fixture->out_lengths, SORT_ORDINALS,
                                                fixture->out_units, SORT_UNITS},
                                               fixture->ranks,
                                               SORT_ORDINALS,
                                               fixture->ordered,
                                               SORT_ORDINALS,
                                               fixture->dirty,
                                               1,
                                               fixture->counts,
                                               SORT_COUNTS};
}

static void *prepare_refused_sort_order(void) {
  order_fixture *fixture = calloc(1, sizeof *fixture);
  if (fixture != NULL) { prepare(fixture); }
  return fixture;
}

static narsil_status refused_sort_order(narsil_workspace *workspace, void *opaque) {
  order_fixture *fixture = opaque;
  return narsil_build_sort_order(workspace, &fixture->current, fixture->live, 1, &fixture->output);
}

static uint64_t digest_refused_sort_order(const void *opaque) {
  return digest_bytes(DIGEST_START, opaque, offsetof(order_fixture, current));
}

void sort_order_allocation_failures(void) {
  const failing_call call = {"a sort order", prepare_refused_sort_order, refused_sort_order, digest_refused_sort_order,
                             free};
  refuse_each_allocation(&call);
}

static void refusal(narsil_workspace *workspace, order_fixture *fixture, narsil_status expected) {
  unsigned char before[sizeof *fixture];
  memcpy(before, fixture, sizeof before);
  check(narsil_build_sort_order(workspace, &fixture->current, fixture->live, 1, &fixture->output) == expected,
        "sort order refuses malformed or undersized output regions");
  unsigned char after[sizeof *fixture];
  memcpy(after, fixture, sizeof after);
  check(memcmp(before, after, sizeof before) == 0, "sort order refusal preserves every caller byte");
}

static void range_checks(narsil_workspace *workspace) {
  order_fixture fixture;
  prepare(&fixture);
  check(narsil_build_sort_order(workspace, &fixture.current, fixture.live, 1, &fixture.output) == NARSIL_OK,
        "range checks build the sort dictionary");
  narsil_sort_values dictionary = {fixture.out_kinds,  DISTINCT_VALUES, fixture.out_numbers, DISTINCT_VALUES,
                                   fixture.out_starts, DISTINCT_VALUES, fixture.out_lengths, DISTINCT_VALUES,
                                   fixture.out_units,  SORT_UNITS};
  narsil_sort_column column = {fixture.current, dictionary,     fixture.ranks, SORT_ORDINALS,
                               fixture.ordered, PRESENT_VALUES, fixture.dirty, 1};
  const uint16_t lower[] = {'A'};
  const uint16_t upper[] = {'a'};
  uint32_t output[] = {UINT32_MAX};
  narsil_text_range_request request = {{lower, 1, 1, 1}, {upper, 1, 1, 1}, fixture.live, 1, output, 1};
  check(narsil_text_range(&column, &request) == NARSIL_OK && output[0] == UINT32_C(0x30),
        "text bounds preserve folded and raw order");
  output[0] = UINT32_MAX;
  request.output_words = 0;
  check(narsil_text_range(&column, &request) == NARSIL_NEEDS_ROOM && output[0] == UINT32_MAX,
        "short range output stays unchanged");
  request.output_words = 1;
  request.output = fixture.live;
  uint32_t before = fixture.live[0];
  check(narsil_text_range(&column, &request) == NARSIL_INVALID_ARGUMENT && fixture.live[0] == before,
        "range output cannot overwrite a live input");
}

void sort_order_checks(narsil_workspace *workspace) {
  range_checks(workspace);
  order_fixture fixture;
  prepare(&fixture);
  check(narsil_build_sort_order(workspace, &fixture.current, fixture.live, 1, &fixture.output) == NARSIL_OK,
        "sort order accepts sparse live values and ignores bitmap padding");
  const int32_t ranks[] = {2, 4, -1, 2, 8, 6, 10, -1};
  const uint32_t ordered[] = {0, 3, 1, 5, 4, 6};
  check(memcmp(fixture.ranks, ranks, sizeof ranks) == 0 && memcmp(fixture.ordered, ordered, sizeof ordered) == 0 &&
            fixture.counts[0] == DISTINCT_VALUES && fixture.counts[1] == PRESENT_VALUES && fixture.dirty[0] == 0,
        "sort order returns the numeric, folded text, and boolean ranks with stable ties");
  check(fixture.out_numbers[0] == 0 && !signbit(fixture.out_numbers[0]) && signbit(fixture.numbers[0]),
        "sort dictionaries canonicalise zero without changing stored numeric bits");
  prepare(&fixture);
  fixture.output.values.unit_capacity = 1;
  refusal(workspace, &fixture, NARSIL_NEEDS_ROOM);
  prepare(&fixture);
  fixture.output.ranks = (int32_t *)fixture.starts;
  refusal(workspace, &fixture, NARSIL_INVALID_ARGUMENT);
  prepare(&fixture);
  fixture.output.counts = fixture.output.ordered;
  refusal(workspace, &fixture, NARSIL_INVALID_ARGUMENT);
  prepare(&fixture);
  fixture.current.number_count--;
  refusal(workspace, &fixture, NARSIL_INVALID_ARGUMENT);
  prepare(&fixture);
  fixture.live[0] = UINT32_MAX;
  refusal(workspace, &fixture, NARSIL_INVALID_ARGUMENT);
  prepare(&fixture);
  fixture.lengths[4] = UINT32_MAX;
  refusal(workspace, &fixture, NARSIL_INVALID_ARGUMENT);
}
