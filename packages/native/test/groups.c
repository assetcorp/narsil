#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_groups.h"
#include "../include/narsil_stored_values.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { ORDINAL_COUNT = 16, VALUE_COUNT = 13, HIT_COUNT = 16, GROUP_COUNT = 10, FIRST_NAN = 3, SECOND_NAN = 4 };

typedef struct {
  uint8_t shapes[ORDINAL_COUNT];
  uint32_t starts[ORDINAL_COUNT + 1];
  uint8_t kinds[VALUE_COUNT];
  double numbers[VALUE_COUNT];
  uint32_t text_start[VALUE_COUNT];
  uint32_t text_length[VALUE_COUNT];
  uint16_t units[1];
  uint8_t bytes[1];
  uint32_t ordinals[HIT_COUNT];
  double scores[HIT_COUNT];
  uint32_t ranks[HIT_COUNT];
  uint32_t heads[HIT_COUNT];
  uint32_t offsets[HIT_COUNT + 1];
  uint32_t hits[HIT_COUNT];
  uint32_t members[HIT_COUNT];
  narsil_stored_values values;
  narsil_group_request request;
  narsil_group_output output;
} group_fixture;

static void prepare(group_fixture *fixture) {
  memset(fixture, 0, sizeof *fixture);
  const uint8_t shapes[] = {0, 1, 2, 1, 1, 1, 1, 1, 1, 2, 2, 1, 2, 1, 1, 0};
  const uint32_t starts[] = {0, 0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13};
  const uint8_t kinds[] = {0, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 5, 5};
  const double numbers[] = {0, 0, -0.0, NAN, NAN, HUGE_VAL, -HUGE_VAL, NAN, NAN, 0, 0, 0, 0};
  const uint32_t ordinals[] = {5, 1, 0, 6, 10, 9, 4, 3, 7, 8, 2, 11, 12, 13, 14, UINT32_MAX};
  const double scores[] = {NAN, 10, 1, NAN, 0, 0, -0.0, 0, HUGE_VAL, -HUGE_VAL, 2, 3, 3, 4, 4, 0};
  const uint32_t lengths[] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1};
  memcpy(fixture->shapes, shapes, sizeof shapes);
  memcpy(fixture->starts, starts, sizeof starts);
  memcpy(fixture->kinds, kinds, sizeof kinds);
  memcpy(fixture->numbers, numbers, sizeof numbers);
  memcpy(fixture->ordinals, ordinals, sizeof ordinals);
  memcpy(fixture->scores, scores, sizeof scores);
  memcpy(fixture->text_length, lengths, sizeof lengths);
  const uint64_t first_nan = UINT64_C(0x7ff8000000000001);
  const uint64_t second_nan = UINT64_C(0xfff8000000000042);
  memcpy(fixture->numbers + FIRST_NAN, &first_nan, sizeof first_nan);
  memcpy(fixture->numbers + SECOND_NAN, &second_nan, sizeof second_nan);
  fixture->units[0] = 'x';
  fixture->bytes[0] = UINT8_C(0x80);
  for (uint32_t at = 0; at < HIT_COUNT; at++) { fixture->ranks[at] = at; }
  fixture->values = (narsil_stored_values){fixture->shapes,      ORDINAL_COUNT,
                                           fixture->starts,      ORDINAL_COUNT + 1,
                                           fixture->kinds,       VALUE_COUNT,
                                           fixture->numbers,     VALUE_COUNT,
                                           fixture->text_start,  VALUE_COUNT,
                                           fixture->text_length, VALUE_COUNT,
                                           fixture->units,       1,
                                           fixture->bytes,       1};
  fixture->request = (narsil_group_request){&fixture->values,
                                            1,
                                            fixture->ordinals,
                                            HIT_COUNT,
                                            fixture->scores,
                                            HIT_COUNT,
                                            fixture->ranks,
                                            HIT_COUNT,
                                            1,
                                            0,
                                            0};
  fixture->output =
      (narsil_group_output){fixture->heads, HIT_COUNT,        fixture->offsets, HIT_COUNT + 1, fixture->hits,
                            HIT_COUNT,      fixture->members, HIT_COUNT,        UINT32_MAX};
}

static void group_values(narsil_workspace *workspace, group_fixture *fixture) {
  const uint32_t heads[] = {8, 1, 13, 11, 12, 10, 4, 6, 9, 0};
  const uint32_t members[] = {1, 2, 2, 1, 1, 1, 2, 2, 1, 2};
  uint64_t numbers[VALUE_COUNT];
  memcpy(numbers, fixture->numbers, sizeof numbers);
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_OK &&
            fixture->output.count == GROUP_COUNT,
        "grouping preserves stored shapes and skips an invalid ordinal");
  check(memcmp(heads, fixture->heads, sizeof heads) == 0 && memcmp(members, fixture->members, sizeof members) == 0 &&
            memcmp(heads, fixture->hits, sizeof heads) == 0,
        "groups keep original heads and full member counts");
  uint64_t remaining[VALUE_COUNT];
  memcpy(remaining, fixture->numbers, sizeof remaining);
  check(memcmp(numbers, remaining, sizeof numbers) == 0,
        "grouping preserves numeric bytes including different NaN signs and payloads");
}

static void group_refusals(narsil_workspace *workspace, group_fixture *fixture) {
  prepare(fixture);
  group_fixture saved = *fixture;
  fixture->output.hit_capacity = 0;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_NEEDS_ROOM,
        "short group output refuses before any output changes");
  fixture->output.hit_capacity = HIT_COUNT;
  fixture->request.has_limit = 1;
  fixture->request.limit = 0;
  fixture->values.number_count--;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_INVALID_ARGUMENT,
        "zero-limit groups validate descriptor region lengths");
  fixture->values.number_count++;
  fixture->values.start_count--;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_INVALID_ARGUMENT,
        "stored starts require a terminal word");
  fixture->values.start_count++;
  fixture->request.score_count--;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_INVALID_ARGUMENT,
        "group scores index every input position");
  fixture->request.score_count++;
  fixture->output.heads = fixture->ordinals;
  fixture->output.head_capacity = 1;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_INVALID_ARGUMENT,
        "group outputs cannot overwrite input ordinals");
  fixture->output.heads = fixture->members;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_INVALID_ARGUMENT,
        "group outputs cannot overwrite other outputs");
  check(fixture->output.count == saved.output.count && memcmp(fixture->heads, saved.heads, sizeof saved.heads) == 0 &&
            memcmp(fixture->hits, saved.hits, sizeof saved.hits) == 0 &&
            memcmp(fixture->offsets, saved.offsets, sizeof saved.offsets) == 0 &&
            memcmp(fixture->members, saved.members, sizeof saved.members) == 0,
        "every refused group request preserves every output and its count");
}

static void corrupt_group_values(narsil_workspace *workspace, group_fixture *fixture) {
  prepare(fixture);
  fixture->text_length[VALUE_COUNT - 1] = UINT32_MAX;
  fixture->starts[0] = UINT32_MAX;
  fixture->kinds[FIRST_NAN] = UINT8_MAX;
  fixture->shapes[ORDINAL_COUNT - 1] = UINT8_MAX;
  check(narsil_group_hits(workspace, &fixture->request, &fixture->output) == NARSIL_OK,
        "corrupt embedded values are skipped without an out-of-region read");
  for (uint32_t at = 0; at < fixture->output.count; at++) {
    check(fixture->heads[at] != 0, "a corrupt first member cannot supply a group head");
  }
}

static void *prepare_refused_groups(void) {
  group_fixture *fixture = calloc(1, sizeof *fixture);
  if (fixture != NULL) { prepare(fixture); }
  return fixture;
}

static narsil_status group_refused_hits(narsil_workspace *workspace, void *opaque) {
  group_fixture *fixture = opaque;
  return narsil_group_hits(workspace, &fixture->request, &fixture->output);
}

static uint64_t digest_refused_groups(const void *opaque) {
  const group_fixture *fixture = opaque;
  return digest_word(digest_bytes(DIGEST_START, fixture, offsetof(group_fixture, values)), fixture->output.count);
}

void group_allocation_failures(void) {
  const failing_call call = {"grouped hits", prepare_refused_groups, group_refused_hits, digest_refused_groups, free};
  refuse_each_allocation(&call);
}

void group_checks(narsil_workspace *workspace) {
  group_fixture fixture = {0};
  prepare(&fixture);
  group_values(workspace, &fixture);
  group_refusals(workspace, &fixture);
  corrupt_group_values(workspace, &fixture);
}
