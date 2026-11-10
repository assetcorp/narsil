#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

void numeric_facet_checks(narsil_workspace *workspace) {
  enum { SPARSE_ORDINAL = 33, ENTRY_COUNT = 8, BOUND_COUNT = 12, RANGE_COUNT = 6, FIRST_WORD = 5 };
  double values[] = {-2, -0.0, 0, 0, 3, 3, 3, 4};
  uint32_t ordinals[] = {0, SPARSE_ORDINAL, SPARSE_ORDINAL, 2, 2, SPARSE_ORDINAL, 2, UINT32_MAX};
  uint32_t matched[] = {FIRST_WORD, 2};
  double buckets[ENTRY_COUNT] = {0};
  uint32_t counts[ENTRY_COUNT] = {0};
  uint32_t count = UINT32_MAX;
  narsil_numeric_facet_input input = {values, ENTRY_COUNT, ordinals, ENTRY_COUNT, matched, 2};
  narsil_number_facet_output output = {buckets, ENTRY_COUNT, counts, ENTRY_COUNT};
  check(narsil_number_facet(workspace, &input, &output, &count) == NARSIL_OK && count == 3 && buckets[0] == -2 &&
            buckets[1] == 0 && !signbit(buckets[1]) && buckets[2] == 3 && counts[0] == 1 && counts[1] == 2 &&
            counts[2] == 2,
        "numeric facets deduplicate unordered repeated ordinals and combine signed zeros");
  unsigned char saved_buckets[sizeof buckets];
  uint32_t saved_counts[ENTRY_COUNT];
  memcpy(saved_buckets, buckets, sizeof buckets);
  memcpy(saved_counts, counts, sizeof counts);
  count = UINT32_MAX;
  output.count_capacity = 2;
  check(narsil_number_facet(workspace, &input, &output, &count) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            memcmp((const unsigned char *)buckets, saved_buckets, sizeof buckets) == 0 &&
            memcmp(counts, saved_counts, sizeof counts) == 0,
        "a short numeric count output preserves every output");
  output.count_capacity = ENTRY_COUNT;
  output.values = values;
  check(narsil_number_facet(workspace, &input, &output, &count) == NARSIL_INVALID_ARGUMENT && values[0] == -2,
        "numeric facets refuse output over live input");
  output.values = buckets;
  output.counts = (uint32_t *)buckets;
  check(narsil_number_facet(workspace, &input, &output, &count) == NARSIL_INVALID_ARGUMENT,
        "numeric facet outputs cannot overlap one another");
  output.counts = counts;
  double ranges[] = {-2, 3, 0, 4, 3, 3, 4, -2, NAN, 4, -HUGE_VAL, HUGE_VAL};
  check(narsil_range_facet(workspace, &input, ranges, BOUND_COUNT, counts, ENTRY_COUNT) == NARSIL_OK &&
            counts[0] == 3 && counts[1] == 2 && counts[2] == 0 && counts[3] == 0 && counts[4] == 0 &&
            counts[RANGE_COUNT - 1] == 3,
        "numeric ranges count documents once with exclusive upper bounds and empty invalid ranges");
  memcpy(saved_counts, counts, sizeof counts);
  check(narsil_range_facet(workspace, &input, ranges, BOUND_COUNT, counts, RANGE_COUNT - 1) == NARSIL_NEEDS_ROOM &&
            memcmp(counts, saved_counts, sizeof counts) == 0,
        "short range output remains unchanged");
  check(narsil_range_facet(workspace, &input, ranges, BOUND_COUNT - 1, counts, ENTRY_COUNT) ==
                NARSIL_INVALID_ARGUMENT &&
            memcmp(counts, saved_counts, sizeof counts) == 0,
        "numeric ranges require complete bound pairs before writing");
  check(narsil_range_facet(workspace, &input, ranges, BOUND_COUNT, (uint32_t *)ranges, ENTRY_COUNT) ==
            NARSIL_INVALID_ARGUMENT,
        "range counts cannot overwrite bound values");
  input.ordinal_count--;
  check(narsil_range_facet(workspace, &input, NULL, 0, NULL, 0) == NARSIL_INVALID_ARGUMENT,
        "empty range requests validate numeric region lengths");
  input.matched_words = 0;
  input.ordinal_count++;
  count = UINT32_MAX;
  check(narsil_number_facet(workspace, &input, &output, &count) == NARSIL_INVALID_ARGUMENT && count == UINT32_MAX,
        "numeric facets require a matched bitmap word");
}
