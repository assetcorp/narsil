#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_facets.h"
#include "../include/narsil_stored_values.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

static void stored_range_checks(narsil_stored_values *values) {
  enum { RANGE_COUNT = 5, RANGE_WORDS = RANGE_COUNT * 2 };
  uint32_t matched = UINT32_MAX;
  double ranges[RANGE_WORDS] = {-HUGE_VAL, 0, -0.0, 1, -HUGE_VAL, HUGE_VAL, NAN, 1, 0, NAN};
  uint32_t counts[RANGE_COUNT + 1];
  for (size_t at = 0; at < RANGE_COUNT + 1; at++) { counts[at] = UINT32_MAX; }
  const uint32_t expected[] = {1, 1, 2, 0, 0, UINT32_MAX};
  check(narsil_stored_range_facet(values, &matched, 1, ranges, RANGE_WORDS, counts, RANGE_COUNT) == NARSIL_OK &&
            memcmp(counts, expected, sizeof expected) == 0,
        "stored ranges count numeric documents once, skip NaNs, and preserve the output tail");
  check(narsil_stored_range_facet(values, &matched, 1, ranges, RANGE_WORDS, counts, RANGE_COUNT - 1) ==
                NARSIL_NEEDS_ROOM &&
            memcmp(counts, expected, sizeof expected) == 0,
        "short stored range output remains unchanged");
  check(narsil_stored_range_facet(values, &matched, 1, ranges, RANGE_WORDS - 1, counts, RANGE_COUNT) ==
                NARSIL_INVALID_ARGUMENT &&
            memcmp(counts, expected, sizeof expected) == 0,
        "an incomplete stored range pair is refused before output");
  check(narsil_stored_range_facet(values, &matched, 1, ranges, RANGE_WORDS, &matched, 1) == NARSIL_INVALID_ARGUMENT &&
            matched == UINT32_MAX,
        "stored range output cannot overwrite the match bitmap");
  values->number_count--;
  check(narsil_stored_range_facet(values, &matched, 1, NULL, 0, counts, RANGE_COUNT) == NARSIL_INVALID_ARGUMENT &&
            memcmp(counts, expected, sizeof expected) == 0,
        "empty stored range requests validate every descriptor region");
  values->number_count++;
}

void value_facet_checks(narsil_workspace *workspace) {
  enum {
    DOCUMENTS = 5,
    ELEMENTS = 12,
    BUCKETS = 7,
    SECOND_TEXT = 7,
    SCALAR_NUMBER = 8,
    NUMBER_ARRAY = 9,
    OTHER_KIND = 5
  };
  uint8_t shapes[] = {2, 1, 1, 0, 2};
  uint32_t starts[] = {0, SECOND_TEXT, SCALAR_NUMBER, NUMBER_ARRAY, NUMBER_ARRAY, ELEMENTS};
  uint8_t kinds[] = {3, 3, 4, 0, OTHER_KIND, 1, 2, 4, 3, 3, 3, 3};
  double numbers[] = {0, -0.0, 0, 0, 0, 0, 0, 0, NAN, NAN, HUGE_VAL, -HUGE_VAL};
  uint32_t text_start[ELEMENTS] = {0};
  uint32_t text_length[ELEMENTS] = {0};
  uint16_t units[] = {'0'};
  uint32_t matched = UINT32_MAX;
  uint32_t positions[ELEMENTS] = {0};
  uint32_t counts[ELEMENTS] = {0};
  uint32_t count = UINT32_MAX;
  text_length[2] = 1;
  text_length[SECOND_TEXT] = 1;
  narsil_stored_values values = {shapes,     DOCUMENTS, starts,      DOCUMENTS + 1, kinds, ELEMENTS, numbers, ELEMENTS,
                                 text_start, ELEMENTS,  text_length, ELEMENTS,      units, 1,        NULL,    0};
  narsil_value_facet_output output = {positions, ELEMENTS, counts, ELEMENTS};
  stored_range_checks(&values);
  const uint32_t expected_positions[] = {5, 6, 11, 0, 10, 8, 2};
  const uint32_t expected_counts[] = {1, 1, 1, 2, 1, 2, 2};
  unsigned char saved_numbers[sizeof numbers];
  memcpy(saved_numbers, numbers, sizeof numbers);
  check(narsil_value_facet(workspace, &values, &matched, 1, &output, &count) == NARSIL_OK && count == BUCKETS &&
            memcmp(positions, expected_positions, sizeof expected_positions) == 0 &&
            memcmp(counts, expected_counts, sizeof expected_counts) == 0 &&
            memcmp((const unsigned char *)numbers, saved_numbers, sizeof numbers) == 0,
        "stored facets count repeated elements, preserve numeric bytes, and retain separate typed values");
  uint32_t saved_positions[ELEMENTS];
  uint32_t saved_counts[ELEMENTS];
  memcpy(saved_positions, positions, sizeof positions);
  memcpy(saved_counts, counts, sizeof counts);
  count = UINT32_MAX;
  output.count_capacity = BUCKETS - 1;
  check(narsil_value_facet(workspace, &values, &matched, 1, &output, &count) == NARSIL_NEEDS_ROOM &&
            count == UINT32_MAX && memcmp(positions, saved_positions, sizeof positions) == 0 &&
            memcmp(counts, saved_counts, sizeof counts) == 0,
        "short stored facet output leaves every region unchanged");
  output.count_capacity = ELEMENTS;
  output.values = text_start;
  check(narsil_value_facet(workspace, &values, &matched, 1, &output, &count) == NARSIL_INVALID_ARGUMENT,
        "stored facet output cannot overwrite field regions");
  output.values = positions;
  check(narsil_value_facet(workspace, &values, &matched, 1, &output, counts) == NARSIL_INVALID_ARGUMENT,
        "stored facet count metadata cannot overlap output");
  values.start_count--;
  check(narsil_value_facet(workspace, &values, &matched, 1, &output, &count) == NARSIL_INVALID_ARGUMENT &&
            count == UINT32_MAX,
        "stored facet requests require a terminal offset");
  values.start_count++;
  text_length[SECOND_TEXT] = UINT32_MAX;
  kinds[0] = UINT8_MAX;
  check(narsil_value_facet(workspace, &values, &matched, 1, &output, &count) == NARSIL_OK && count == BUCKETS &&
            counts[BUCKETS - 1] == 1 && positions[3] == 1,
        "stored facets skip corrupt embedded elements without dropping their valid neighbours");
}
