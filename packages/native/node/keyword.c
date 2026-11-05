#include "keyword.h"

#include "values.h"

#include "../include/narsil_core.h"
#include "../include/narsil_keyword.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum {
  ARGUMENT_POOL_DOC_IDS,
  ARGUMENT_POOL_FREQUENCIES,
  ARGUMENT_POOL_FIELDS,
  ARGUMENT_ROW_DOC_IDS,
  ARGUMENT_ROW_FREQUENCIES,
  ARGUMENT_ROW_FIELDS,
  ARGUMENT_SLOTS,
  ARGUMENT_LISTS,
  ARGUMENT_LIST_VALUES,
  ARGUMENT_SLOT_VALUES,
  ARGUMENT_SEARCHABLE,
  ARGUMENT_PARTIAL_MARKS,
  ARGUMENT_NAME_RANKS,
  ARGUMENT_FIELD_NUMBERS,
  ARGUMENT_LENGTHS,
  ARGUMENT_FILTER,
  ARGUMENT_LIVE,
  ARGUMENT_REMOVED,
  ARGUMENT_SETTINGS,
  ARGUMENT_ORDINALS,
  ARGUMENT_SCORES,
  ARGUMENT_MATCHED,
  ARGUMENT_OUTCOME,
  ARGUMENT_COUNT
};

enum {
  SETTING_SLOTS,
  SETTING_TERMS,
  SETTING_CAPACITY,
  SETTING_TOTAL_DOCUMENTS,
  SETTING_TERM_MATCH,
  SETTING_ANCHOR,
  SETTING_LIMIT,
  SETTING_MIN_SCORE,
  SETTING_COLLECT,
  SETTING_COUNT
};

enum { OUTCOME_COUNT, OUTCOME_TOTAL_MATCHED, OUTCOME_SCORING_PATH };

#define OUTCOME_MIN_LENGTH OUTCOME_SCORING_PATH

typedef struct {
  napi_env env;
  napi_value *argv;
} arguments;

static int array_of(const arguments *read, uint32_t index, napi_typedarray_type type, void **data, uint32_t *length) {
  size_t size = 0;
  if (!possibly_empty_typed_data(read->env, read->argv[index], type, data, &size) || size > UINT32_MAX) { return 0; }
  *length = (uint32_t)size;
  return 1;
}

enum { ROW_DOC_IDS, ROW_FREQUENCIES, ROW_FIELDS, ROW_COLUMNS };

typedef struct {
  void *data[ROW_COLUMNS];
  uint32_t length;
} row_set;

static int whole_count(double value, uint32_t *count) {
  if (!(value >= 0) || value > (double)UINT32_MAX) { return 0; }
  *count = (uint32_t)value;
  return (double)*count == value;
}

static int read_row_set(const arguments *read, uint32_t first, napi_typedarray_type frequency_type, row_set *rows) {
  napi_typedarray_type types[ROW_COLUMNS] = {napi_uint32_array, frequency_type, napi_uint16_array};
  rows->length = UINT32_MAX;
  for (uint32_t column = 0; column < ROW_COLUMNS; column++) {
    uint32_t length = 0;
    if (!array_of(read, first + column, types[column], &rows->data[column], &length)) { return 0; }
    if (length < rows->length) { rows->length = length; }
  }
  return 1;
}

static int read_rows(const arguments *read, narsil_keyword_request *request) {
  row_set pool = {{NULL, NULL, NULL}, 0};
  row_set rows = {{NULL, NULL, NULL}, 0};
  if (!read_row_set(read, ARGUMENT_POOL_DOC_IDS, napi_uint16_array, &pool) ||
      !read_row_set(read, ARGUMENT_ROW_DOC_IDS, napi_float64_array, &rows)) {
    return 0;
  }
  request->pool_doc_ids = pool.data[ROW_DOC_IDS];
  request->pool_frequencies = pool.data[ROW_FREQUENCIES];
  request->pool_fields = pool.data[ROW_FIELDS];
  request->pool_length = pool.length;
  request->row_doc_ids = rows.data[ROW_DOC_IDS];
  request->row_frequencies = rows.data[ROW_FREQUENCIES];
  request->row_fields = rows.data[ROW_FIELDS];
  request->row_length = rows.length;
  return 1;
}

static int read_slots(const arguments *read, narsil_keyword_request *request) {
  void *data[4] = {NULL, NULL, NULL, NULL};
  uint32_t lengths[4] = {0, 0, 0, 0};
  if (!array_of(read, ARGUMENT_SLOTS, napi_uint32_array, &data[0], &lengths[0]) ||
      !array_of(read, ARGUMENT_LISTS, napi_uint32_array, &data[1], &lengths[1]) ||
      !array_of(read, ARGUMENT_LIST_VALUES, napi_float64_array, &data[2], &lengths[2]) ||
      !array_of(read, ARGUMENT_SLOT_VALUES, napi_float64_array, &data[3], &lengths[3])) {
    return 0;
  }
  uint32_t list_rows = lengths[1] / NARSIL_KEYWORD_LIST_STRIDE;
  uint32_t value_rows = lengths[2] / NARSIL_KEYWORD_LIST_VALUE_STRIDE;
  request->slots = data[0];
  request->slot_capacity = lengths[0] / NARSIL_KEYWORD_SLOT_STRIDE;
  request->lists = data[1];
  request->list_values = data[2];
  request->list_capacity = list_rows < value_rows ? list_rows : value_rows;
  request->slot_values = data[3];
  request->slot_value_capacity = lengths[3];
  return 1;
}

static int reserve_lengths(thread_state *state, uint32_t count) {
  if (count <= state->keyword_length_capacity) { return 1; }
  narsil_keyword_column *grown = realloc(state->keyword_lengths, (size_t)count * sizeof *grown);
  if (grown == NULL) { return 0; }
  state->keyword_lengths = grown;
  state->keyword_length_capacity = count;
  return 1;
}

static int read_length_columns(const arguments *read, narsil_keyword_column *columns, uint32_t count) {
  napi_value array = read->argv[ARGUMENT_LENGTHS];
  uint32_t length = 0;
  if (napi_get_array_length(read->env, array, &length) != napi_ok || length != count) { return 0; }
  for (uint32_t field = 0; field < count; field++) {
    napi_value value = NULL;
    napi_valuetype type = napi_undefined;
    if (napi_get_element(read->env, array, field, &value) != napi_ok ||
        napi_typeof(read->env, value, &type) != napi_ok) {
      return 0;
    }
    columns[field].values = NULL;
    columns[field].length = 0;
    if (type == napi_null) { continue; }
    void *data = NULL;
    size_t size = 0;
    if (!possibly_empty_typed_data(read->env, value, napi_uint32_array, &data, &size) || size > UINT32_MAX) {
      return 0;
    }
    columns[field].values = data;
    columns[field].length = (uint32_t)size;
  }
  return 1;
}

static int read_fields(const arguments *read, narsil_keyword_request *request) {
  void *data[4] = {NULL, NULL, NULL, NULL};
  uint32_t lengths[4] = {0, 0, 0, 0};
  if (!array_of(read, ARGUMENT_SEARCHABLE, napi_uint8_array, &data[0], &lengths[0]) ||
      !array_of(read, ARGUMENT_PARTIAL_MARKS, napi_uint8_array, &data[1], &lengths[1]) ||
      !array_of(read, ARGUMENT_NAME_RANKS, napi_uint16_array, &data[2], &lengths[2]) ||
      !array_of(read, ARGUMENT_FIELD_NUMBERS, napi_float64_array, &data[3], &lengths[3])) {
    return 0;
  }
  uint32_t count = lengths[0];
  if (count > NARSIL_KEYWORD_MAX_FIELDS || lengths[1] != count || lengths[2] != count ||
      (uint64_t)lengths[3] != (uint64_t)count * NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS) {
    return 0;
  }
  request->field_count = count;
  request->searchable = data[0];
  request->partial_marks = data[1];
  request->name_ranks = data[2];
  request->field_numbers = data[3];
  return 1;
}

static int read_bitsets(const arguments *read, narsil_keyword_request *request) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(read->env, read->argv[ARGUMENT_FILTER], &type) != napi_ok) { return 0; }
  void *data[3] = {NULL, NULL, NULL};
  request->has_filter = type != napi_null;
  if (request->has_filter && !array_of(read, ARGUMENT_FILTER, napi_uint32_array, &data[0], &request->filter_words)) {
    return 0;
  }
  if (!array_of(read, ARGUMENT_LIVE, napi_uint32_array, &data[1], &request->live_words) ||
      !array_of(read, ARGUMENT_REMOVED, napi_uint32_array, &data[2], &request->removed_words)) {
    return 0;
  }
  request->filter = data[0];
  request->live = data[1];
  request->removed = data[2];
  return 1;
}

static int read_settings(const arguments *read, narsil_keyword_request *request) {
  void *data = NULL;
  uint32_t length = 0;
  if (!array_of(read, ARGUMENT_SETTINGS, napi_float64_array, &data, &length) || length < SETTING_COUNT) { return 0; }
  const double *settings = data;
  request->terms = settings[SETTING_TERMS];
  request->total_documents = settings[SETTING_TOTAL_DOCUMENTS];
  request->term_match = settings[SETTING_TERM_MATCH];
  request->limit = settings[SETTING_LIMIT];
  request->min_score = settings[SETTING_MIN_SCORE];
  request->collect = settings[SETTING_COLLECT] != 0;
  return whole_count(settings[SETTING_SLOTS], &request->slot_count) &&
         whole_count(settings[SETTING_CAPACITY], &request->capacity);
}

static int read_output(const arguments *read, narsil_keyword_output *output, double **outcome,
                       uint32_t *outcome_length) {
  void *data[4] = {NULL, NULL, NULL, NULL};
  uint32_t lengths[4] = {0, 0, 0, 0};
  if (!array_of(read, ARGUMENT_ORDINALS, napi_int32_array, &data[0], &lengths[0]) ||
      !array_of(read, ARGUMENT_SCORES, napi_float64_array, &data[1], &lengths[1]) ||
      !array_of(read, ARGUMENT_MATCHED, napi_uint32_array, &data[2], &lengths[2]) ||
      !array_of(read, ARGUMENT_OUTCOME, napi_float64_array, &data[3], &lengths[3]) || lengths[3] < OUTCOME_MIN_LENGTH) {
    return 0;
  }
  output->ordinals = data[0];
  output->scores = data[1];
  output->length = lengths[0] < lengths[1] ? lengths[0] : lengths[1];
  output->matched = data[2];
  output->matched_words = lengths[2];
  *outcome = data[3];
  *outcome_length = lengths[3];
  return 1;
}

static napi_value keyword_score(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv)) {
    return throw_error(env, "keywordScore takes twenty-three arguments");
  }
  arguments read = {env, argv};
  narsil_keyword_request request = {0};
  narsil_keyword_output output = {0};
  double *outcome = NULL;
  uint32_t outcome_length = 0;
  if (!read_rows(&read, &request) || !read_slots(&read, &request) || !read_bitsets(&read, &request) ||
      !read_settings(&read, &request) || !read_output(&read, &output, &outcome, &outcome_length) ||
      !read_fields(&read, &request)) {
    return throw_error(env, "an argument to keywordScore has the wrong type");
  }
  if (!reserve_lengths(state, request.field_count)) { return status_of(env, NARSIL_OUT_OF_MEMORY); }
  request.lengths = state->keyword_lengths;
  if (!read_length_columns(&read, state->keyword_lengths, request.field_count)) {
    return throw_error(env, "an argument to keywordScore has the wrong type");
  }
  narsil_status status = narsil_keyword_score(state->workspace, &request, &output);
  report_workspace_memory(env, state);
  outcome[OUTCOME_COUNT] = (double)output.count;
  outcome[OUTCOME_TOTAL_MATCHED] = (double)output.total_matched;
  if (outcome_length > OUTCOME_SCORING_PATH) { outcome[OUTCOME_SCORING_PATH] = (double)output.scoring_path; }
  return status_of(env, status);
}

int define_keyword(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"keywordScore", NULL, keyword_score, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
