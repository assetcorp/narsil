#include "segments.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_segments.h"
#include "segment_merge.h"
#include "terms.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SEGMENT, ORDINAL, FIELDS, ARGUMENTS };
enum { STACK_FIELDS = 8, TOKEN_WORDS = sizeof(narsil_token) / sizeof(uint32_t) };

int prepare_segment_fields(napi_env env, napi_value list, field_handles *fields, uint32_t count) {
  for (uint32_t index = 0; index < count; index++) {
    napi_value field = NULL;
    napi_value ordinal = NULL;
    field_handles *handles = fields + index;
    if (napi_get_element(env, list, index, &field) != napi_ok ||
        napi_get_named_property(env, field, "field", &ordinal) != napi_ok ||
        !segment_uint_argument(env, ordinal, &handles->field) || handles->field > UINT16_MAX ||
        napi_get_named_property(env, field, "tokens", &handles->tokens) != napi_ok ||
        napi_get_named_property(env, field, "units", &handles->units) != napi_ok) {
      return 0;
    }
  }
  return 1;
}

int read_segment_fields(napi_env env, const field_handles *handles, narsil_field_tokens *fields, uint32_t count) {
  for (uint32_t index = 0; index < count; index++) {
    void *tokens = NULL;
    void *units = NULL;
    size_t words = 0;
    size_t text = 0;
    if (!possibly_empty_typed_data(env, handles[index].tokens, napi_uint32_array, &tokens, &words) ||
        !possibly_empty_typed_data(env, handles[index].units, napi_uint16_array, &units, &text) ||
        words % TOKEN_WORDS != 0 || words / TOKEN_WORDS > UINT32_MAX || text > UINT32_MAX) {
      return 0;
    }
    fields[index] = (narsil_field_tokens){(uint16_t)handles[index].field,
                                          {tokens, (uint32_t)(words / TOKEN_WORDS), units, (uint32_t)text}};
  }
  return 1;
}

static void place_segment_view(const node_segment *source, node_segment *target) {
  *target = *source;
  if (source->growing.positions != NULL) { target->growing.positions = &target->positions; }
  if (source->growing.surfaces != NULL) { target->growing.surfaces = &target->surfaces; }
  if (source->growing.spellings != NULL) { target->growing.spellings = &target->spellings; }
}

static size_t append_handles(napi_value *arrays, size_t count, const napi_value *handles, size_t length) {
  for (size_t index = 0; index < length; index++) { arrays[count++] = handles[index]; }
  return count;
}

static size_t append_surface(napi_value *arrays, size_t count, const surface_handles *surface) {
  count = append_handles(arrays, count, surface->strings, TERM_HANDLES);
  arrays[count++] = surface->token;
  arrays[count++] = surface->count;
  return count;
}

static size_t segment_view_arrays(const segment_handles *handles, napi_value arrays[SEGMENT_VIEW_ARRAYS]) {
  size_t count = append_handles(arrays, 0, handles->terms, TERM_HANDLES);
  count = append_handles(arrays, count, handles->columns, SEGMENT_COLUMN_HANDLES);
  count = append_handles(arrays, count, handles->postings, SEGMENT_POSTING_HANDLES);
  count = append_handles(arrays, count, handles->values, SEGMENT_VALUE_HANDLES);
  if (handles->has_positions) {
    arrays[count++] = handles->positions;
    arrays[count++] = handles->position_allocation;
  }
  if (handles->has_surfaces) { count = append_surface(arrays, count, &handles->surfaces); }
  if (handles->has_spellings) {
    count = append_surface(arrays, count, &handles->spellings);
    arrays[count++] = handles->code_points;
    count = append_handles(arrays, count, handles->runs, SEGMENT_RUN_HANDLES);
  }
  return count;
}

typedef struct {
  napi_ref reference;
  void *data;
  size_t length;
} held_array;

struct segment_view {
  napi_ref regions;
  held_array arrays[SEGMENT_VIEW_ARRAYS];
  size_t array_count;
  node_segment segment;
};

static void forget_segment_view(napi_env env, struct segment_view *view) {
  if (view->regions != NULL) { (void)napi_delete_reference(env, view->regions); }
  for (size_t index = 0; index < view->array_count; index++) {
    if (view->arrays[index].reference != NULL) { (void)napi_delete_reference(env, view->arrays[index].reference); }
    view->arrays[index] = (held_array){NULL, NULL, 0};
  }
  view->regions = NULL;
  view->array_count = 0;
}

static int array_extent(napi_env env, napi_value value, void **data, size_t *length) {
  napi_typedarray_type type = napi_uint8_array;
  napi_value buffer = NULL;
  size_t offset = 0;
  *data = NULL;
  *length = 0;
  if (napi_get_typedarray_info(env, value, &type, length, data, &buffer, &offset) == napi_ok) { return 1; }
  *data = NULL;
  *length = 0;
  bool typed = true;
  return napi_is_typedarray(env, value, &typed) == napi_ok && !typed;
}

static int holds_array(napi_env env, const held_array *array) {
  napi_value value = NULL;
  void *data = NULL;
  size_t length = 0;
  if (array->reference == NULL) { return 1; }
  return napi_get_reference_value(env, array->reference, &value) == napi_ok && value != NULL &&
         array_extent(env, value, &data, &length) && data == array->data && length == array->length;
}

static int holds_segment_view(napi_env env, const struct segment_view *view, napi_value value) {
  napi_value held = NULL;
  bool same = false;
  if (view == NULL || view->regions == NULL || napi_get_reference_value(env, view->regions, &held) != napi_ok ||
      held == NULL || napi_strict_equals(env, held, value, &same) != napi_ok || !same) {
    return 0;
  }
  for (size_t index = 0; index < view->array_count; index++) {
    if (!holds_array(env, &view->arrays[index])) { return 0; }
  }
  return 1;
}

static int weak_reference(napi_env env, napi_value value, napi_ref *reference) {
  napi_valuetype type = napi_undefined;
  *reference = NULL;
  if (napi_typeof(env, value, &type) != napi_ok) { return 0; }
  return type != napi_object || napi_create_reference(env, value, 0, reference) == napi_ok;
}

static int hold_array(napi_env env, napi_value value, held_array *array) {
  return weak_reference(env, value, &array->reference) &&
         (array->reference == NULL || array_extent(env, value, &array->data, &array->length));
}

static void remember_segment_view(napi_env env, thread_state *state, napi_value value, const segment_handles *handles,
                                  const node_segment *segment) {
  if (state->segment_view == NULL) { state->segment_view = calloc(1, sizeof *state->segment_view); }
  struct segment_view *view = state->segment_view;
  if (view == NULL) { return; }
  napi_value arrays[SEGMENT_VIEW_ARRAYS] = {0};
  size_t count = segment_view_arrays(handles, arrays);
  forget_segment_view(env, view);
  for (size_t index = 0; index < count; index++) {
    view->array_count = index + 1;
    if (!hold_array(env, arrays[index], &view->arrays[index])) {
      forget_segment_view(env, view);
      return;
    }
  }
  if (!weak_reference(env, value, &view->regions) || view->regions == NULL) {
    forget_segment_view(env, view);
    return;
  }
  place_segment_view(segment, &view->segment);
}

static int read_segment_view(napi_env env, thread_state *state, napi_value value, node_segment *segment) {
  if (holds_segment_view(env, state->segment_view, value)) {
    place_segment_view(&state->segment_view->segment, segment);
    return 1;
  }
  segment_handles handles = {0};
  if (!prepare_segment(env, value, &handles) || !read_segment(env, &handles, segment)) { return 0; }
  remember_segment_view(env, state, value, &handles, segment);
  return 1;
}

static narsil_status index_fields(napi_env env, thread_state *state, const napi_value argv[ARGUMENTS], uint32_t count,
                                  field_handles *handles, narsil_field_tokens *fields, int removing) {
  node_segment segment = {0};
  uint32_t ordinal = 0;
  if (!segment_uint_argument(env, argv[ORDINAL], &ordinal) ||
      !prepare_segment_fields(env, argv[FIELDS], handles, count) ||
      !read_segment_view(env, state, argv[SEGMENT], &segment) || !read_segment_fields(env, handles, fields, count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_index_terms_request request = {&segment.growing, ordinal, fields, count};
  return removing ? narsil_remove_document(state->workspace, &request) : narsil_index_terms(state->workspace, &request);
}

static napi_value mutate_document(napi_env env, napi_callback_info info, int removing) {
  napi_value argv[ARGUMENTS];
  thread_state *state = thread_state_of(env);
  uint32_t count = 0;
  bool array = false;
  if (state == NULL || !callback_arguments(env, info, ARGUMENTS, argv) ||
      napi_is_array(env, argv[FIELDS], &array) != napi_ok || !array ||
      napi_get_array_length(env, argv[FIELDS], &count) != napi_ok || count > (uint32_t)UINT16_MAX + 1) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  field_handles local_handles[STACK_FIELDS] = {0};
  narsil_field_tokens local_fields[STACK_FIELDS] = {0};
  field_handles *handles = local_handles;
  narsil_field_tokens *fields = local_fields;
  if (count > STACK_FIELDS) {
    handles = calloc(count, sizeof *handles);
    fields = calloc(count, sizeof *fields);
    if (handles == NULL || fields == NULL) {
      free(handles);
      free(fields);
      return status_of(env, NARSIL_OUT_OF_MEMORY);
    }
  }
  narsil_status status = index_fields(env, state, argv, count, handles, fields, removing);
  if (count > STACK_FIELDS) {
    free(handles);
    free(fields);
  }
  report_workspace_memory(env, state);
  return status_of(env, status);
}

static napi_value index_terms(napi_env env, napi_callback_info info) { return mutate_document(env, info, 0); }

static napi_value remove_document(napi_env env, napi_callback_info info) { return mutate_document(env, info, 1); }

static napi_value batch(napi_env env, napi_callback_info info, int ending) {
  napi_value argv[1];
  thread_state *state = thread_state_of(env);
  node_segment segment = {0};
  if (state == NULL || !callback_arguments(env, info, 1, argv) || !read_segment_view(env, state, argv[0], &segment)) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = ending ? narsil_end_batch(state->workspace, &segment.growing)
                                : narsil_begin_batch(state->workspace, &segment.growing);
  report_workspace_memory(env, state);
  return status_of(env, status);
}

static napi_value begin_batch(napi_env env, napi_callback_info info) { return batch(env, info, 0); }
static napi_value end_batch(napi_env env, napi_callback_info info) { return batch(env, info, 1); }

int define_segments(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"indexTerms", NULL, index_terms, NULL, NULL, NULL, napi_default_method, NULL},
      {"removeDocument", NULL, remove_document, NULL, NULL, NULL, napi_default_method, NULL},
      {"removeFrozenDocument", NULL, remove_frozen_document, NULL, NULL, NULL, napi_default_method, NULL},
      {"prepareFrozenRemoval", NULL, prepare_frozen_removal, NULL, NULL, NULL, napi_default_method, NULL},
      {"settleFrozenState", NULL, settle_frozen_state, NULL, NULL, NULL, napi_default_method, NULL},
      {"beginBatch", NULL, begin_batch, NULL, NULL, NULL, napi_default_method, NULL},
      {"endBatch", NULL, end_batch, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok &&
         define_segment_merges(env, exports) && define_field_merges(env, exports);
}
