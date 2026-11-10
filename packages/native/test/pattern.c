#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_pattern.h"
#include "../include/narsil_stored_values.h"
#include "../include/narsil_work.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
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

static const uint16_t REFUSED_TEXT[] = u"Abc cde cdf abcde CDEF xyz";

static pattern_case folded_case(const uint16_t *query, uint32_t operator_kind) {
  return (pattern_case){query, REFUSED_TEXT, operator_kind, 1, 1, 0, "a refused allocation"};
}

static void *prepare_refused_pattern(pattern_case sample, uint32_t tolerance) {
  pattern_fixture *fixture = calloc(1, sizeof *fixture);
  if (fixture == NULL) { return NULL; }
  prepare(fixture, &sample);
  fixture->test.tolerance = tolerance;
  return fixture;
}

static void *prepare_refused_regex(void) {
  return prepare_refused_pattern(folded_case(u"^(ab|c[d-f]+|\\s)*.*abcde.*x[yz]{1,2}$", NARSIL_PATTERN_REGEX), 0);
}

static void *prepare_refused_wildcard(void) {
  return prepare_refused_pattern(folded_case(u"*cd?*cdef*x?z", NARSIL_PATTERN_WILDCARD), 0);
}

static void *prepare_refused_contains(void) {
  return prepare_refused_pattern(folded_case(u"cdef", NARSIL_PATTERN_CONTAINS), 0);
}

static void *prepare_refused_typo(void) {
  return prepare_refused_pattern(folded_case(u"abc cde cdf abcde cdef xyy", NARSIL_PATTERN_EQ), 2);
}

static narsil_status refused_pattern(narsil_workspace *workspace, void *opaque) { return execute(workspace, opaque); }

static uint64_t digest_refused_pattern(const void *opaque) {
  const pattern_fixture *fixture = opaque;
  uint64_t digest = digest_bytes(DIGEST_START, fixture->output, sizeof fixture->output);
  return digest_word(digest_word(digest, (uint64_t)fixture->spent), fixture->stop);
}

void pattern_allocation_failures(void) {
  const failing_call calls[] = {
      {"a folded expression", prepare_refused_regex, refused_pattern, digest_refused_pattern, free},
      {"a folded wildcard", prepare_refused_wildcard, refused_pattern, digest_refused_pattern, free},
      {"a folded substring", prepare_refused_contains, refused_pattern, digest_refused_pattern, free},
      {"a folded match within two typos", prepare_refused_typo, refused_pattern, digest_refused_pattern, free},
  };
  for (size_t at = 0; at < sizeof calls / sizeof calls[0]; at++) { refuse_each_allocation(&calls[at]); }
}

void pattern_checks(narsil_workspace *workspace) {
  matching_checks(workspace);
  refusal_checks(workspace);
  case_fold_checks();
}
