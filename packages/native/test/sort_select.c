#include "fixture.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort_order.h"
#include "../include/narsil_sort_select.h"

#include <stdint.h>
#include <string.h>

enum { ORDINALS = 4, FIELDS = 2, FIRST_UPPER = 10, SECOND_UPPER = 100, SELECTED_BITS = 10, LAST_BIT = 8 };

typedef struct {
  uint8_t kinds[ORDINALS];
  double numbers[ORDINALS];
  uint32_t zero[ORDINALS];
  uint8_t dictionary_kinds[FIELDS];
  double dictionary_numbers[FIELDS];
  int32_t ranks[ORDINALS];
  uint32_t ordered[ORDINALS];
  uint32_t dirty[1];
  narsil_sort_column column;
} select_fixture;

static void initialise(select_fixture *fixture, double upper) {
  memset(fixture, 0, sizeof *fixture);
  for (uint32_t at = 0; at < ORDINALS; at++) {
    fixture->kinds[at] = 1;
    fixture->numbers[at] = (at & 1U) ? upper : 0;
    fixture->ranks[at] = (at & 1U) ? 4 : 2;
  }
  fixture->dictionary_kinds[0] = 1;
  fixture->dictionary_kinds[1] = 1;
  fixture->dictionary_numbers[1] = upper;
  fixture->ordered[0] = 0;
  fixture->ordered[1] = 2;
  fixture->ordered[2] = 1;
  fixture->ordered[3] = 3;
  fixture->column.current = (narsil_sort_values){
      fixture->kinds, ORDINALS, fixture->numbers, ORDINALS, fixture->zero, ORDINALS, fixture->zero, ORDINALS, NULL, 0};
  fixture->column.values = (narsil_sort_values){fixture->dictionary_kinds,
                                                FIELDS,
                                                fixture->dictionary_numbers,
                                                FIELDS,
                                                fixture->zero,
                                                FIELDS,
                                                fixture->zero,
                                                FIELDS,
                                                NULL,
                                                0};
  fixture->column.ranks = fixture->ranks;
  fixture->column.rank_count = ORDINALS;
  fixture->column.ordered = fixture->ordered;
  fixture->column.ordered_count = ORDINALS;
  fixture->column.dirty = fixture->dirty;
  fixture->column.dirty_words = 1;
}

void sort_select_checks(narsil_workspace *workspace) {
  select_fixture first;
  select_fixture second;
  initialise(&first, FIRST_UPPER);
  initialise(&second, SECOND_UPPER);
  first.numbers[1] = 3;
  first.numbers[3] = 4;
  first.dirty[0] = SELECTED_BITS;
  second.numbers[3] = 0;
  second.dirty[0] = LAST_BIT;
  narsil_sort_column columns[] = {first.column, second.column};
  uint8_t directions[] = {0, 0};
  uint32_t filter[] = {SELECTED_BITS};
  uint32_t live[] = {UINT32_MAX};
  uint32_t output[ORDINALS] = {UINT32_MAX, UINT32_MAX, UINT32_MAX, UINT32_MAX};
  uint32_t count = UINT32_MAX;
  narsil_sort_select_request request = {columns, FIELDS, directions, FIELDS, filter, 1,      live,
                                        1,       1,      NULL,       0,      NULL,   output, ORDINALS};
  uint8_t anchor_kinds[] = {1, 1};
  double anchor_numbers[] = {3, SECOND_UPPER};
  uint32_t anchor_zero[] = {0, 0};
  int32_t anchor_ranks[] = {3, 4};
  narsil_sort_values anchor = {anchor_kinds, FIELDS,      anchor_numbers, FIELDS, anchor_zero,
                               FIELDS,       anchor_zero, FIELDS,         NULL,   0};
  request.anchor_ranks = anchor_ranks;
  request.anchor_rank_count = FIELDS;
  request.anchor_values = &anchor;
  request.limit = 2;
  first.numbers[3] = 3;
  second.numbers[3] = SECOND_UPPER;
  request.limit = 1;
  check(narsil_sort_select(workspace, &request, &count) == NARSIL_OK && count == 2,
        "sort selection retains every complete-key cutoff tie");
  request.output_capacity = 1;
  output[0] = UINT32_MAX;
  count = UINT32_MAX;
  check(narsil_sort_select(workspace, &request, &count) == NARSIL_NEEDS_ROOM && count == UINT32_MAX &&
            output[0] == UINT32_MAX,
        "a short cutoff-tie output preserves both output and count");
  request.output_capacity = ORDINALS;
  check(narsil_sort_select(workspace, &request, output) == NARSIL_INVALID_ARGUMENT && output[0] == UINT32_MAX,
        "sort count cannot overlap the ordinal output");
  request.output = first.ordered;
  check(narsil_sort_select(workspace, &request, &count) == NARSIL_INVALID_ARGUMENT && first.ordered[0] == 0,
        "sort selection refuses an output over a live input");
  request.output = output;
  request.limit = 0;
  columns[0].current.number_count--;
  check(narsil_sort_select(workspace, &request, &count) == NARSIL_INVALID_ARGUMENT && count == UINT32_MAX,
        "zero-limit sort selection validates region shapes before returning");
}
