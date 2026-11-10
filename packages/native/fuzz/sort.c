#include "input.h"

#include "../include/narsil_core.h"
#include "../include/narsil_sort.h"
#include "../include/narsil_sort_order.h"
#include "../include/narsil_sort_select.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_DOCUMENTS = 64,
  MAX_UNITS = 256,
  MAX_BOUND_UNITS = 24,
  MAX_COLUMNS = 3,
  MAX_CHANGES = 6,
  SORT_KINDS = NARSIL_SORT_TRUE + 1,
  WORD_BITS = 32,
  ORDER_COUNTS = 2
};

typedef struct {
  uint8_t *kinds;
  double *numbers;
  uint32_t *text_start;
  uint32_t *text_length;
  uint16_t *units;
  narsil_sort_values values;
} fuzz_sort_values;

static void shape_sort_values(fuzz_sort_values *built, fuzz_span units) {
  for (size_t at = 0; at < units.count; at++) {
    built->kinds[at] %= SORT_KINDS;
    built->text_start[at] %= units.limit + 1;
    built->text_length[at] %= (units.limit - built->text_start[at]) + 1;
  }
}

static fuzz_sort_values fuzz_values(fuzz_input *input, size_t count) {
  fuzz_sort_values built = {NULL, NULL, NULL, NULL, NULL, {NULL, 0, NULL, 0, NULL, 0, NULL, 0, NULL, 0}};
  int loose = fuzz_raw(input);
  size_t unit_count = fuzz_count(input, MAX_UNITS);
  size_t number_count = loose ? fuzz_count(input, count + 1) : count;
  built.kinds = FUZZ_ARRAY(input, uint8_t, count);
  built.numbers = fuzz_numbers(input, number_count);
  built.text_start = FUZZ_ARRAY(input, uint32_t, count);
  built.text_length = FUZZ_ARRAY(input, uint32_t, count);
  built.units = FUZZ_ARRAY(input, uint16_t, unit_count);
  if (input->exhausted_memory) { return built; }
  if (!loose) { shape_sort_values(&built, (fuzz_span){count, (uint32_t)unit_count}); }
  built.values = (narsil_sort_values){built.kinds,       count, built.numbers, number_count, built.text_start, count,
                                      built.text_length, count, built.units,   unit_count};
  return built;
}

static size_t string_units(const fuzz_sort_values *built) {
  size_t units = 0;
  for (size_t at = 0; at < built->values.count; at++) {
    if (built->kinds[at] != NARSIL_SORT_STRING) { continue; }
    size_t length = built->text_length[at];
    units += length < built->values.unit_count ? length : built->values.unit_count;
  }
  return units;
}

static narsil_sort_order_output order_room(fuzz_input *input, const fuzz_sort_values *built) {
  size_t count = built->values.count;
  int loose = fuzz_raw(input);
  size_t values = loose ? fuzz_count(input, count) : count;
  size_t units = loose ? fuzz_count(input, MAX_UNITS) : string_units(built);
  size_t words = loose ? fuzz_count(input, fuzz_nonempty_bit_words(count)) : fuzz_nonempty_bit_words(count);
  narsil_sort_values_output output_values = {
      FUZZ_ROOM(input, uint8_t, values),  values, FUZZ_ROOM(input, double, values),   values,
      FUZZ_ROOM(input, uint32_t, values), values, FUZZ_ROOM(input, uint32_t, values), values,
      FUZZ_ROOM(input, uint16_t, units),  units};
  return (narsil_sort_order_output){
      output_values, FUZZ_ROOM(input, int32_t, count),  count, FUZZ_ROOM(input, uint32_t, count),
      count,         FUZZ_ROOM(input, uint32_t, words), words, FUZZ_ROOM(input, uint32_t, ORDER_COUNTS),
      ORDER_COUNTS};
}

static narsil_sort_column column_from(const fuzz_sort_values *current, const narsil_sort_order_output *output) {
  uint32_t distinct = output->counts[0];
  narsil_sort_values values = {output->values.kinds,       distinct,
                               output->values.numbers,     distinct,
                               output->values.text_start,  distinct,
                               output->values.text_length, distinct,
                               output->values.units,       output->values.unit_capacity};
  return (narsil_sort_column){
      current->values,   values,        output->ranks,         output->rank_capacity, output->ordered,
      output->counts[1], output->dirty, output->dirty_capacity};
}

static narsil_sort_column loose_column(fuzz_input *input, const fuzz_sort_values *current) {
  size_t count = current->values.count;
  fuzz_sort_values values = fuzz_values(input, fuzz_count(input, count));
  size_t rank_count = fuzz_count(input, count);
  size_t ordered_count = fuzz_count(input, count);
  size_t dirty_words = fuzz_count(input, fuzz_nonempty_bit_words(count));
  return (narsil_sort_column){current->values,
                              values.values,
                              FUZZ_ARRAY(input, int32_t, rank_count),
                              rank_count,
                              FUZZ_ARRAY(input, uint32_t, ordered_count),
                              ordered_count,
                              FUZZ_ARRAY(input, uint32_t, dirty_words),
                              dirty_words};
}

static void edit_values(fuzz_input *input, fuzz_sort_values *current, narsil_sort_column *column, uint32_t *dirty) {
  size_t count = current->values.count;
  uint32_t edits = fuzz_below(input, MAX_CHANGES);
  for (uint32_t edit = 0; edit < edits && count > 0; edit++) {
    uint32_t ordinal = fuzz_below(input, (uint32_t)count);
    current->kinds[ordinal] = (uint8_t)fuzz_below(input, SORT_KINDS);
    if (ordinal < current->values.number_count) { current->numbers[ordinal] = fuzz_number(input); }
    if ((size_t)(ordinal / WORD_BITS) < column->dirty_words) {
      dirty[ordinal / WORD_BITS] |= UINT32_C(1) << (ordinal % WORD_BITS);
    }
  }
  column->current = current->values;
}

static narsil_sort_column fuzz_column(narsil_workspace *workspace, fuzz_input *input, size_t count) {
  fuzz_sort_values current = fuzz_values(input, count);
  size_t live_words = 0;
  uint32_t *live = fuzz_bits(input, (uint32_t)count, &live_words);
  narsil_sort_order_output output = order_room(input, &current);
  if (input->exhausted_memory) { return loose_column(input, &current); }
  narsil_status status = narsil_build_sort_order(workspace, &current.values, live, live_words, &output);
  if (status != NARSIL_OK || fuzz_raw(input)) { return loose_column(input, &current); }
  narsil_sort_column column = column_from(&current, &output);
  edit_values(input, &current, &column, output.dirty);
  fuzz_disturb(input, output.ranks, output.rank_capacity * sizeof *output.ranks);
  fuzz_disturb(input, output.ordered, output.ordered_capacity * sizeof *output.ordered);
  fuzz_disturb(input, output.values.units, output.values.unit_capacity * sizeof *output.values.units);
  fuzz_disturb(input, output.values.text_start, output.values.text_start_capacity * sizeof *output.values.text_start);
  return column;
}

static narsil_sort_bound fuzz_bound(fuzz_input *input) {
  size_t length = fuzz_count(input, MAX_BOUND_UNITS);
  uint32_t present = fuzz_raw(input) ? fuzz_below(input, 3) : fuzz_below(input, 2);
  uint32_t inclusive = fuzz_raw(input) ? fuzz_below(input, 3) : fuzz_below(input, 2);
  if (present == 0 && !fuzz_raw(input)) { length = 0; }
  return (narsil_sort_bound){FUZZ_ARRAY(input, uint16_t, length), length, present, inclusive};
}

static void text_range(fuzz_input *input, const narsil_sort_column *column) {
  size_t live_words = 0;
  uint32_t *live = fuzz_bits(input, (uint32_t)column->current.count, &live_words);
  size_t output_words =
      fuzz_raw(input) ? fuzz_count(input, live_words + 1) : fuzz_nonempty_bit_words(column->current.count);
  narsil_text_range_request request = {
      fuzz_bound(input), fuzz_bound(input), live, live_words, FUZZ_ROOM(input, uint32_t, output_words), output_words};
  if (input->exhausted_memory) { return; }
  (void)narsil_text_range(column, &request);
}

static void shape_anchor(fuzz_input *input, int32_t *ranks, const narsil_sort_column *columns, size_t count) {
  for (size_t at = 0; at < count; at++) {
    uint32_t limit = (uint32_t)(columns[at].values.count * 2) + 2;
    uint32_t drawn = fuzz_below(input, limit + 1);
    ranks[at] = drawn == 0 ? -1 : (int32_t)drawn;
  }
}

static void sort_select(narsil_workspace *workspace, fuzz_input *input, size_t count) {
  size_t column_count = 1 + fuzz_count(input, MAX_COLUMNS - 1);
  narsil_sort_column *columns = FUZZ_ROOM(input, narsil_sort_column, column_count);
  for (size_t at = 0; columns != NULL && at < column_count; at++) {
    columns[at] = fuzz_column(workspace, input, count);
  }
  uint8_t *directions = FUZZ_ARRAY(input, uint8_t, column_count);
  size_t filter_words = 0;
  uint32_t *filter = fuzz_bits(input, (uint32_t)count, &filter_words);
  size_t live_words = 0;
  uint32_t *live = fuzz_bits(input, (uint32_t)count, &live_words);
  int anchored = (fuzz_byte(input) & 1U) == 1U;
  size_t anchor_count = 0;
  if (anchored) { anchor_count = fuzz_raw(input) ? fuzz_count(input, MAX_COLUMNS) : column_count; }
  int32_t *anchor_ranks = anchored ? FUZZ_ARRAY(input, int32_t, anchor_count) : NULL;
  fuzz_sort_values anchor_values = fuzz_values(input, anchor_count);
  size_t capacity = fuzz_count(input, count + 1);
  narsil_sort_select_request request = {columns,
                                        column_count,
                                        directions,
                                        column_count,
                                        filter,
                                        filter_words,
                                        live,
                                        live_words,
                                        fuzz_below(input, (uint32_t)count + 2),
                                        anchor_ranks,
                                        anchor_count,
                                        anchored ? &anchor_values.values : NULL,
                                        FUZZ_ROOM(input, uint32_t, capacity),
                                        capacity};
  uint32_t *selected = FUZZ_ROOM(input, uint32_t, 1);
  if (input->exhausted_memory) { return; }
  if (!fuzz_raw(input)) {
    for (size_t at = 0; at < column_count; at++) { directions[at] &= 1U; }
    if (anchored && anchor_count == column_count) { shape_anchor(input, anchor_ranks, columns, column_count); }
  }
  (void)narsil_sort_select(workspace, &request, selected);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  size_t count = fuzz_count(&input, MAX_DOCUMENTS);
  if ((fuzz_byte(&input) & 1U) == 0) {
    narsil_sort_column column = fuzz_column(workspace, &input, count);
    if (!input.exhausted_memory) { text_range(&input, &column); }
  } else {
    sort_select(workspace, &input, count);
  }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
