#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_pattern.h"
#include "../include/narsil_stored_values.h"
#include "../include/narsil_work.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { CACHE_BUDGET_BYTES = 1000000, EXTRA_OUTPUT_WORD = 17 };

typedef struct {
  const uint16_t *query;
  const uint16_t *text;
  uint32_t operator_kind;
  uint32_t fold;
  uint32_t expected;
  int64_t units;
  const char *label;
} pattern_case;

typedef struct {
  uint8_t shapes[1];
  uint32_t starts[2];
  uint8_t kinds[1];
  double numbers[1];
  uint32_t text_start[1];
  uint32_t text_length[1];
  uint32_t documents[1];
  uint32_t offsets[1];
  uint32_t output[2];
  int64_t spent;
  uint32_t stop;
  narsil_stored_values values;
  narsil_pattern_index index;
  narsil_pattern_test test;
  narsil_work_meter meter;
} pattern_fixture;

static size_t text_length(const uint16_t *text) {
  size_t length = 0;
  while (text[length] != 0) { length++; }
  return length;
}

static void prepare(pattern_fixture *fixture, const pattern_case *sample) {
  memset(fixture, 0, sizeof *fixture);
  fixture->shapes[0] = 1;
  fixture->starts[1] = 1;
  fixture->kinds[0] = 4;
  fixture->text_length[0] = (uint32_t)text_length(sample->text);
  fixture->output[1] = EXTRA_OUTPUT_WORD;
  fixture->values = (narsil_stored_values){fixture->shapes,
                                           1,
                                           fixture->starts,
                                           2,
                                           fixture->kinds,
                                           1,
                                           fixture->numbers,
                                           1,
                                           fixture->text_start,
                                           1,
                                           fixture->text_length,
                                           1,
                                           sample->text,
                                           fixture->text_length[0],
                                           NULL,
                                           0};
  fixture->index = (narsil_pattern_index){{fixture->documents, 1}, {NULL, 0}, {fixture->offsets, 1}, {NULL, 0}};
  fixture->test = (narsil_pattern_test){
      sample->query, text_length(sample->query), sample->operator_kind, sample->fold, 0, 1, CACHE_BUDGET_BYTES};
  fixture->meter = (narsil_work_meter){&fixture->spent, INT64_MAX, &fixture->stop, 0};
}

static narsil_status execute(narsil_workspace *workspace, pattern_fixture *fixture) {
  return narsil_pattern_match(workspace, &fixture->index, &fixture->values, &fixture->test, &fixture->meter,
                              fixture->output, 2);
}

static void matching_checks(narsil_workspace *workspace) {
  const pattern_case sample = {u"^a?b$", u"ab", NARSIL_PATTERN_REGEX, 0, 1, 4, "optional expression matching"};
  pattern_fixture fixture;
  prepare(&fixture, &sample);
  check(execute(workspace, &fixture) == NARSIL_OK && fixture.output[0] == sample.expected &&
            fixture.spent == sample.units && fixture.output[1] == EXTRA_OUTPUT_WORD,
        "pattern matching counts consumed positions and preserves output padding");
}

static void refusal_checks(narsil_workspace *workspace) {
  pattern_case sample = {u"ab", u"ab", NARSIL_PATTERN_EQ, 0, 1, 3, "equality"};
  pattern_fixture fixture;
  prepare(&fixture, &sample);
  fixture.output[0] = UINT32_MAX;
  check(narsil_pattern_match(workspace, &fixture.index, &fixture.values, &fixture.test, &fixture.meter, fixture.output,
                             0) == NARSIL_NEEDS_ROOM,
        "a short pattern bitmap refuses before publication");
  fixture.values.number_count = 0;
  check(execute(workspace, &fixture) == NARSIL_INVALID_ARGUMENT,
        "pattern matching validates every stored descriptor length");
  fixture.values.number_count = 1;
  fixture.test.case_fold = 2;
  check(execute(workspace, &fixture) == NARSIL_INVALID_ARGUMENT, "pattern matching refuses an invalid fold flag");
  fixture.test.case_fold = 0;
  fixture.test.text = u"(";
  fixture.test.length = 1;
  fixture.test.operator_kind = NARSIL_PATTERN_REGEX;
  check(execute(workspace, &fixture) == NARSIL_INVALID_ARGUMENT,
        "a malformed expression leaves outputs and work unchanged");
  fixture.test.text = sample.query;
  fixture.test.length = text_length(sample.query);
  fixture.test.operator_kind = NARSIL_PATTERN_EQ;
  check(narsil_pattern_match(workspace, &fixture.index, &fixture.values, &fixture.test, &fixture.meter,
                             fixture.documents, 1) == NARSIL_INVALID_ARGUMENT,
        "pattern output cannot overwrite input documents");
  check(fixture.output[0] == UINT32_MAX && fixture.output[1] == EXTRA_OUTPUT_WORD && fixture.spent == 0,
        "every pattern refusal preserves output words and work");
  fixture.output[0] = 0;
  fixture.text_length[0] = UINT32_MAX;
  check(execute(workspace, &fixture) == NARSIL_OK && fixture.output[0] == 0,
        "corrupt stored text spans cannot read beyond their region");
}

static void case_fold_checks(void) {
  const uint16_t text[] = {u'S', 0x00DF, 0x0149, 0x0390, 0xD801, 0xDC00, 0xD800, u'Z'};
  const uint32_t expected[] = {u's', u's', u's', 0x02BC, u'n', 0x03B9, 0x0308, 0x0301, 0x10428, 0xD800, u'z'};
  enum { UNITS = sizeof text / sizeof text[0], POINTS = sizeof expected / sizeof expected[0] };
  uint32_t folded[POINTS + 1];
  uint32_t count = 0;
  folded[POINTS] = EXTRA_OUTPUT_WORD;
  check(narsil_case_fold(text, UNITS, folded, POINTS, &count) == NARSIL_OK && count == POINTS &&
            memcmp(folded, expected, sizeof expected) == 0 && folded[POINTS] == EXTRA_OUTPUT_WORD,
        "a case fold expands each mapping, pairs surrogates, and keeps an unpaired surrogate");
  uint32_t short_output[2] = {0, EXTRA_OUTPUT_WORD};
  count = 0;
  check(narsil_case_fold(text, UNITS, short_output, 1, &count) == NARSIL_NEEDS_ROOM && count == POINTS &&
            short_output[0] == u's' && short_output[1] == EXTRA_OUTPUT_WORD,
        "a case fold reports the room that it needs and writes within the room that it has");
  count = EXTRA_OUTPUT_WORD;
  check(narsil_case_fold(NULL, 0, NULL, 0, &count) == NARSIL_OK && count == 0, "an empty text folds to no code point");
  uint32_t shared[UNITS];
  memcpy(shared, text, sizeof text);
  count = EXTRA_OUTPUT_WORD;
  check(narsil_case_fold((const uint16_t *)shared, UNITS, shared, UNITS, &count) == NARSIL_INVALID_ARGUMENT &&
            narsil_case_fold(text, UNITS, folded, POINTS, NULL) == NARSIL_INVALID_ARGUMENT &&
            narsil_case_fold(NULL, UNITS, folded, POINTS, &count) == NARSIL_INVALID_ARGUMENT &&
            narsil_case_fold(text, UNITS, folded, POINTS, folded) == NARSIL_INVALID_ARGUMENT &&
            count == EXTRA_OUTPUT_WORD,
        "a case fold refuses a missing region and an output that overlaps its text or its count");
}

void pattern_checks(narsil_workspace *workspace) {
  matching_checks(workspace);
  refusal_checks(workspace);
  case_fold_checks();
}
