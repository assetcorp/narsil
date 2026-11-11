#include "../include/narsil_core.h"
#include "../include/narsil_filters.h"
#include "fixture.h"

#include <stdint.h>
#include <string.h>

void filter_checks(narsil_workspace *workspace) {
  enum { WORD_END = 31, NEXT_WORD = 32 };
  uint32_t live[] = {UINT32_C(0x80000007), 1};
  uint32_t present[] = {UINT32_MAX};
  double values[] = {-2, 0, 0, 2};
  uint32_t ordinals[] = {0, 1, WORD_END, NEXT_WORD};
  narsil_filter_field field = {NARSIL_FILTER_NUMERIC, 3, {{present, 1}, {values, 4}, {ordinals, 4}}};
  double numbers[] = {0, 2, -2, 2};
  uint32_t offsets[] = {0};
  uint32_t plan[] = {NARSIL_FILTER_TEST, 0, NARSIL_FILTER_EQ, 0, NARSIL_FILTER_NOT, 0, 0, 0};
  uint32_t output[] = {UINT32_MAX, UINT32_MAX, UINT32_MAX};
  narsil_filter_program program = {plan, 4, numbers, 4, NULL, 0, offsets, 1, NULL, 0, NULL, 0, &field, 1, {live, 2}};
  check(narsil_evaluate_filter(workspace, &program, output, 3) == NARSIL_OK && output[0] == UINT32_C(0x80000002) &&
            output[1] == 0 && output[2] == UINT32_MAX,
        "numeric filter ties cross bitmap words and leave unused output unchanged");
  uint32_t saved[3];
  memcpy(saved, output, sizeof saved);
  check(narsil_evaluate_filter(workspace, &program, output, 1) == NARSIL_NEEDS_ROOM &&
            memcmp(saved, output, sizeof saved) == 0,
        "a short filter output stays unchanged");
  check(narsil_evaluate_filter(workspace, &program, live, 2) == NARSIL_INVALID_ARGUMENT &&
            live[0] == UINT32_C(0x80000007) && live[1] == 1,
        "filter output cannot overwrite live admission");
  field.regions[2].length = 3;
  check(narsil_evaluate_filter(workspace, &program, output, 3) == NARSIL_INVALID_ARGUMENT,
        "a filter refuses mismatched numeric regions");
  field.regions[2].length = 4;
  plan[2] = NARSIL_FILTER_ANY;
  plan[3] = 3;
  check(narsil_evaluate_filter(workspace, &program, output, 3) == NARSIL_INVALID_ARGUMENT,
        "a filter refuses a list that extends beyond its operand region");
  plan[0] = NARSIL_FILTER_AND;
  plan[3] = 1;
  check(narsil_evaluate_filter(workspace, &program, output, 3) == NARSIL_INVALID_ARGUMENT,
        "a filter refuses an empty stack before writing");
  check(memcmp(saved, output, sizeof saved) == 0, "malformed filters preserve every output word");
}
