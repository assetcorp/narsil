#include "input.h"

#include "../include/narsil_core.h"
#include "../include/narsil_keyword.h"

#include <stddef.h>
#include <stdint.h>

enum {
  MAX_CAPACITY = 96,
  MAX_FIELDS = 4,
  MAX_POOL = 64,
  MAX_ROWS = 32,
  MAX_SLOTS = 6,
  MAX_LISTS = 12,
  MAX_SLOT_VALUES = 12,
  MAX_FREQUENCY = 5,
  SLOT_KINDS = NARSIL_KEYWORD_PHRASE_SLOT + 1,
  LIST_FLAG_CHOICES = 4,
  MAX_TERMS = 6
};

typedef struct {
  uint32_t capacity;
  uint32_t field_count;
} keyword_shape;

static void fill_rows(fuzz_input *input, narsil_keyword_request *request, keyword_shape shape) {
  uint32_t *pool_ids = FUZZ_ARRAY(input, uint32_t, request->pool_length);
  uint16_t *pool_frequencies = FUZZ_ARRAY(input, uint16_t, request->pool_length);
  uint16_t *pool_fields = FUZZ_ARRAY(input, uint16_t, request->pool_length);
  uint32_t *row_ids = FUZZ_ARRAY(input, uint32_t, request->row_length);
  uint16_t *row_fields = FUZZ_ARRAY(input, uint16_t, request->row_length);
  request->pool_doc_ids = pool_ids;
  request->pool_frequencies = pool_frequencies;
  request->pool_fields = pool_fields;
  request->row_doc_ids = row_ids;
  request->row_frequencies = fuzz_numbers(input, request->row_length);
  request->row_fields = row_fields;
  if (input->exhausted_memory || fuzz_raw(input)) { return; }
  for (uint32_t at = 0; at < request->pool_length; at++) {
    pool_ids[at] %= shape.capacity + 1;
    pool_frequencies[at] = (uint16_t)(pool_frequencies[at] % MAX_FREQUENCY);
    pool_fields[at] = (uint16_t)(pool_fields[at] % (shape.field_count + 1));
  }
  for (uint32_t at = 0; at < request->row_length; at++) {
    row_ids[at] %= shape.capacity + 1;
    row_fields[at] = (uint16_t)(row_fields[at] % (shape.field_count + 1));
  }
}

typedef struct {
  uint32_t list_from;
  uint32_t value_from;
} slot_cursor;

static void shape_slot(fuzz_input *input, uint32_t *words, slot_cursor *cursor, const narsil_keyword_request *request) {
  words[NARSIL_KEYWORD_SLOT_KIND] %= SLOT_KINDS;
  words[NARSIL_KEYWORD_SLOT_TERM] %= MAX_TERMS;
  cursor->list_from += fuzz_below(input, request->list_capacity - cursor->list_from + 1);
  words[NARSIL_KEYWORD_SLOT_LIST_END] = cursor->list_from;
  uint32_t room = request->slot_value_capacity - cursor->value_from;
  uint32_t step = fuzz_below(input, room + 1);
  if (words[NARSIL_KEYWORD_SLOT_KIND] == NARSIL_KEYWORD_GROUP_SLOT && step == 0 && room > 0) { step = 1; }
  cursor->value_from += step;
  words[NARSIL_KEYWORD_SLOT_VALUE_END] = cursor->value_from;
}

static void fill_slots(fuzz_input *input, narsil_keyword_request *request) {
  size_t words = (size_t)request->slot_count * NARSIL_KEYWORD_SLOT_STRIDE;
  uint32_t *slots = FUZZ_ARRAY(input, uint32_t, words);
  request->slots = slots;
  request->slot_values = fuzz_numbers(input, request->slot_value_capacity);
  if (slots == NULL || fuzz_raw(input)) { return; }
  slot_cursor cursor = {0, 0};
  for (uint32_t slot = 0; slot < request->slot_count; slot++) {
    shape_slot(input, slots + ((size_t)slot * NARSIL_KEYWORD_SLOT_STRIDE), &cursor, request);
  }
}

static void fill_lists(fuzz_input *input, narsil_keyword_request *request) {
  uint32_t *lists = FUZZ_ARRAY(input, uint32_t, (size_t)request->list_capacity *NARSIL_KEYWORD_LIST_STRIDE);
  request->lists = lists;
  request->list_values = fuzz_numbers(input, (size_t)request->list_capacity * NARSIL_KEYWORD_LIST_VALUE_STRIDE);
  if (lists == NULL || fuzz_raw(input)) { return; }
  for (uint32_t list = 0; list < request->list_capacity; list++) {
    uint32_t *words = lists + ((size_t)list * NARSIL_KEYWORD_LIST_STRIDE);
    uint32_t flags = words[NARSIL_KEYWORD_LIST_FLAGS] % LIST_FLAG_CHOICES;
    uint32_t rows = (flags & NARSIL_KEYWORD_LIST_FROM_ROWS) != 0 ? request->row_length : request->pool_length;
    words[NARSIL_KEYWORD_LIST_FLAGS] = flags;
    words[NARSIL_KEYWORD_LIST_START] %= rows + 1;
    words[NARSIL_KEYWORD_LIST_LENGTH] %= rows - words[NARSIL_KEYWORD_LIST_START] + 1;
  }
}

static void fill_fields(fuzz_input *input, narsil_keyword_request *request, keyword_shape shape) {
  uint32_t count = request->field_count;
  uint8_t *searchable = FUZZ_ARRAY(input, uint8_t, count);
  uint8_t *partial = FUZZ_ARRAY(input, uint8_t, count);
  narsil_keyword_column *lengths = FUZZ_ROOM(input, narsil_keyword_column, count);
  request->searchable = searchable;
  request->partial_marks = partial;
  request->name_ranks = FUZZ_ARRAY(input, uint16_t, count);
  request->field_numbers = fuzz_numbers(input, (size_t)count * NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS);
  request->lengths = lengths;
  for (uint32_t field = 0; lengths != NULL && field < count; field++) {
    uint32_t length = (uint32_t)fuzz_count(input, shape.capacity);
    lengths[field] = (narsil_keyword_column){FUZZ_ARRAY(input, uint32_t, length), length};
  }
  if (input->exhausted_memory || fuzz_raw(input)) { return; }
  for (uint32_t field = 0; field < count; field++) {
    searchable[field] &= 1U;
    partial[field] &= 1U;
  }
}

static void fill_bitsets(fuzz_input *input, narsil_keyword_request *request, keyword_shape shape) {
  uint32_t words = (uint32_t)fuzz_bit_words(shape.capacity);
  int loose = fuzz_raw(input);
  request->has_filter = (int)(fuzz_byte(input) & 1U);
  request->filter_words = loose ? (uint32_t)fuzz_count(input, words + 1) : words;
  request->live_words = loose ? (uint32_t)fuzz_count(input, words + 1) : words;
  request->removed_words = loose ? (uint32_t)fuzz_count(input, words + 1) : words;
  request->filter = FUZZ_ARRAY(input, uint32_t, request->filter_words);
  request->live = FUZZ_ARRAY(input, uint32_t, request->live_words);
  request->removed = FUZZ_ARRAY(input, uint32_t, request->removed_words);
}

static double fuzz_limit(fuzz_input *input) {
  uint8_t mode = fuzz_byte(input) % 4U;
  if (mode == 0) { return NARSIL_KEYWORD_NO_LIMIT; }
  if (mode == 1) { return fuzz_number(input); }
  return (double)fuzz_below(input, MAX_CAPACITY);
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  narsil_workspace *workspace = NULL;
  if (narsil_workspace_create(&workspace) != NARSIL_OK) { return 0; }
  fuzz_input input = fuzz_begin(data, size);
  keyword_shape shape = {fuzz_below(&input, MAX_CAPACITY + 1), fuzz_below(&input, MAX_FIELDS + 1)};
  narsil_keyword_request request = {0};
  request.pool_length = (uint32_t)fuzz_count(&input, MAX_POOL);
  request.row_length = (uint32_t)fuzz_count(&input, MAX_ROWS);
  request.slot_count = (uint32_t)fuzz_count(&input, MAX_SLOTS);
  request.slot_capacity = request.slot_count + fuzz_below(&input, 2);
  request.list_capacity = (uint32_t)fuzz_count(&input, MAX_LISTS);
  request.slot_value_capacity = (uint32_t)fuzz_count(&input, MAX_SLOT_VALUES);
  request.field_count = shape.field_count;
  request.capacity = shape.capacity;
  fill_rows(&input, &request, shape);
  fill_slots(&input, &request);
  fill_lists(&input, &request);
  fill_fields(&input, &request, shape);
  fill_bitsets(&input, &request, shape);
  request.terms = (double)fuzz_below(&input, MAX_TERMS + 1);
  request.total_documents = fuzz_number(&input);
  request.term_match = fuzz_number(&input);
  request.limit = fuzz_limit(&input);
  request.min_score = fuzz_number(&input);
  request.collect = (int)(fuzz_byte(&input) & 1U);
  uint32_t length = fuzz_raw(&input) ? (uint32_t)fuzz_count(&input, MAX_CAPACITY) : shape.capacity;
  uint32_t matched_words = (uint32_t)fuzz_bit_words(shape.capacity) + fuzz_below(&input, 2);
  narsil_keyword_output output = {FUZZ_ROOM(&input, int32_t, length),
                                  FUZZ_ROOM(&input, double, length),
                                  length,
                                  FUZZ_ROOM(&input, uint32_t, matched_words),
                                  matched_words,
                                  0,
                                  0,
                                  0};
  if (!input.exhausted_memory) { (void)narsil_keyword_score(workspace, &request, &output); }
  narsil_workspace_destroy(workspace);
  fuzz_release(&input);
  return 0;
}
