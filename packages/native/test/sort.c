#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort.h"
#include "../include/narsil_stored_values.h"

#include <stdint.h>
#include <string.h>

enum {
  ELEMENTS = 4,
  TEXT_UNITS = 520,
  NUMBER_SENTINEL = 123,
  NUMBER_TAIL = 456,
  TEXT_START_SENTINEL = 91,
  TEXT_LENGTH_SENTINEL = 92,
  TEXT_TAIL = 93,
  OTHER_KIND = 5
};
static const double ORDINARY_MEAN = 2.5;

static uint64_t bits_of(double value) {
  uint64_t bits;
  memcpy(&bits, &value, sizeof bits);
  return bits;
}

typedef struct {
  uint8_t shapes[1];
  uint32_t starts[2];
  uint8_t kinds[ELEMENTS];
  double numbers[ELEMENTS];
  uint32_t text_start[ELEMENTS];
  uint32_t text_length[ELEMENTS];
  uint16_t units[TEXT_UNITS];
  uint8_t bytes[1];
  double number[2];
  uint32_t text[3];
  narsil_stored_values values;
  narsil_sort_value_output output;
} sort_fixture;

static void prepare(sort_fixture *fixture) {
  memset(fixture, 0, sizeof *fixture);
  fixture->shapes[0] = 2;
  fixture->starts[1] = ELEMENTS;
  for (uint32_t index = 0; index < ELEMENTS; index++) {
    fixture->kinds[index] = 3;
    fixture->numbers[index] = index + 1;
  }
  fixture->number[0] = -NUMBER_SENTINEL;
  fixture->number[1] = -NUMBER_TAIL;
  fixture->text[0] = TEXT_START_SENTINEL;
  fixture->text[1] = TEXT_LENGTH_SENTINEL;
  fixture->text[2] = TEXT_TAIL;
  fixture->values = (narsil_stored_values){fixture->shapes,     1,          fixture->starts,      2,
                                           fixture->kinds,      ELEMENTS,   fixture->numbers,     ELEMENTS,
                                           fixture->text_start, ELEMENTS,   fixture->text_length, ELEMENTS,
                                           fixture->units,      TEXT_UNITS, fixture->bytes,       1};
  fixture->output = (narsil_sort_value_output){fixture->number, 2, fixture->text, 3, UINT32_MAX};
}

static void number_result(narsil_workspace *workspace, sort_fixture *fixture, uint32_t mode, double expected) {
  check(narsil_sort_value(workspace, &fixture->values, 0, mode, &fixture->output) == NARSIL_OK &&
            fixture->output.kind == NARSIL_SORT_NUMBER && bits_of(fixture->number[0]) == bits_of(expected),
        "numeric sorting preserves the expected binary64 bits");
  check(fixture->number[1] == -NUMBER_TAIL && fixture->text[0] == TEXT_START_SENTINEL &&
            fixture->text[1] == TEXT_LENGTH_SENTINEL && fixture->text[2] == TEXT_TAIL,
        "numeric sorting changes only its first numeric output");
}

static void numeric_values(narsil_workspace *workspace, sort_fixture *fixture) {
  number_result(workspace, fixture, NARSIL_SORT_MEDIAN, ORDINARY_MEAN);
}

static void refusal(narsil_workspace *workspace, sort_fixture *fixture, uint32_t ordinal, uint32_t mode,
                    narsil_status status) {
  uint8_t before[sizeof *fixture];
  memcpy(before, fixture, sizeof before);
  check(narsil_sort_value(workspace, &fixture->values, ordinal, mode, &fixture->output) == status,
        "malformed sort requests return the required refusal");
  check(memcmp((const uint8_t *)fixture, before, sizeof before) == 0,
        "a sort refusal preserves every input and output byte");
}

static void refusals(narsil_workspace *workspace, sort_fixture *fixture) {
  prepare(fixture);
  refusal(workspace, fixture, 1, 0, NARSIL_INVALID_ARGUMENT);
  refusal(workspace, fixture, 0, 4, NARSIL_INVALID_ARGUMENT);
  fixture->output.number_capacity = 0;
  refusal(workspace, fixture, 0, 0, NARSIL_NEEDS_ROOM);
  fixture->output.number_capacity = 2;
  fixture->values.start_count--;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  fixture->values.start_count++;
  fixture->shapes[0] = UINT8_MAX;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  fixture->shapes[0] = 2;
  fixture->starts[0] = UINT32_MAX;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  fixture->starts[0] = 0;
  fixture->kinds[0] = UINT8_MAX;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  fixture->kinds[0] = 4;
  fixture->text_length[0] = UINT32_MAX;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  fixture->kinds[0] = OTHER_KIND;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  prepare(fixture);
  fixture->output.number = fixture->numbers;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
  fixture->output.number = fixture->number;
  fixture->output.text = (uint32_t *)fixture->number;
  refusal(workspace, fixture, 0, 0, NARSIL_INVALID_ARGUMENT);
}

void sort_value_checks(narsil_workspace *workspace) {
  sort_fixture fixture;
  prepare(&fixture);
  numeric_values(workspace, &fixture);
  refusals(workspace, &fixture);
}
