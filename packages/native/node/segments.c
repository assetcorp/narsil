#include "segments.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_segments.h"
#include "segment_merge.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { SEGMENT = 0, GENERATION = SEGMENT + 1, ORDINAL = GENERATION + 1, FIRST_FIELD = ORDINAL + 1 };
enum {
  FIELD_ORDINAL = 0,
  FIELD_TOKENS = FIELD_ORDINAL + 1,
  FIELD_UNITS = FIELD_TOKENS + 1,
  FIELD_VALUES = FIELD_UNITS + 1
};
enum {
  STACK_FIELDS = 8,
  STACK_ARGUMENTS = FIRST_FIELD + (STACK_FIELDS * FIELD_VALUES),
  BATCH_ARGUMENTS = GENERATION + 1,
  TOKEN_WORDS = sizeof(narsil_token) / sizeof(uint32_t)
};

static const double LARGEST_GENERATION = 9007199254740991.0;
static const uint32_t MAX_FIELDS = (uint32_t)UINT16_MAX + 1;

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

static int prepare_positional_fields(napi_env env, const napi_value *argv, field_handles *fields, uint32_t count) {
  for (uint32_t index = 0; index < count; index++) {
    const napi_value *field = argv + FIRST_FIELD + ((size_t)index * FIELD_VALUES);
    field_handles *handles = fields + index;
    if (!segment_uint_argument(env, field[FIELD_ORDINAL], &handles->field) || handles->field > UINT16_MAX) { return 0; }
    handles->tokens = field[FIELD_TOKENS];
    handles->units = field[FIELD_UNITS];
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

struct segment_view {
  napi_ref regions;
  uint64_t generation;
  node_segment segment;
};

static void forget_segment_view(napi_env env, struct segment_view *view) {
  if (view->regions != NULL) { (void)napi_delete_reference(env, view->regions); }
  view->regions = NULL;
  view->generation = 0;
}

static int generation_argument(napi_env env, napi_value value, uint64_t *generation) {
  double number = 0;
  if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 1 && number <= LARGEST_GENERATION)) {
    return 0;
  }
  *generation = (uint64_t)number;
  return (double)*generation == number;
}

static int holds_segment_view(napi_env env, const struct segment_view *view, napi_value value, uint64_t generation) {
  napi_value held = NULL;
  bool same = false;
  return view != NULL && view->regions != NULL && view->generation == generation &&
         napi_get_reference_value(env, view->regions, &held) == napi_ok && held != NULL &&
         napi_strict_equals(env, held, value, &same) == napi_ok && same;
}

static void remember_segment_view(napi_env env, thread_state *state, napi_value value, uint64_t generation,
                                  const node_segment *segment) {
  if (state->segment_view == NULL) { state->segment_view = calloc(1, sizeof *state->segment_view); }
  struct segment_view *view = state->segment_view;
  if (view == NULL) { return; }
  forget_segment_view(env, view);
  if (napi_create_reference(env, value, 0, &view->regions) != napi_ok) {
    view->regions = NULL;
    return;
  }
  view->generation = generation;
  place_segment_view(segment, &view->segment);
}

static int read_segment_view(napi_env env, thread_state *state, const napi_value *argv, node_segment *segment) {
  uint64_t generation = 0;
  if (!generation_argument(env, argv[GENERATION], &generation)) { return 0; }
  if (holds_segment_view(env, state->segment_view, argv[SEGMENT], generation)) {
    place_segment_view(&state->segment_view->segment, segment);
    return 1;
  }
  segment_handles handles = {0};
  if (!prepare_segment(env, argv[SEGMENT], &handles) || !read_segment(env, &handles, segment)) { return 0; }
  remember_segment_view(env, state, argv[SEGMENT], generation, segment);
  return 1;
}

static narsil_status index_fields(napi_env env, thread_state *state, const napi_value *argv, uint32_t count,
                                  field_handles *handles, narsil_field_tokens *fields, int removing) {
  node_segment segment = {0};
  uint32_t ordinal = 0;
  if (!segment_uint_argument(env, argv[ORDINAL], &ordinal) || !prepare_positional_fields(env, argv, handles, count) ||
      !read_segment_view(env, state, argv, &segment) || !read_segment_fields(env, handles, fields, count)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_index_terms_request request = {&segment.growing, ordinal, fields, count};
  return removing ? narsil_remove_document(state->workspace, &request) : narsil_index_terms(state->workspace, &request);
}

static narsil_status index_arguments(napi_env env, thread_state *state, int removing, const napi_value *argv,
                                     size_t argc) {
  if (argc < FIRST_FIELD || (argc - FIRST_FIELD) % FIELD_VALUES != 0 ||
      (argc - FIRST_FIELD) / FIELD_VALUES > MAX_FIELDS) {
    return NARSIL_INVALID_ARGUMENT;
  }
  uint32_t count = (uint32_t)((argc - FIRST_FIELD) / FIELD_VALUES);
  field_handles local_handles[STACK_FIELDS] = {0};
  narsil_field_tokens local_fields[STACK_FIELDS] = {0};
  if (count <= STACK_FIELDS) { return index_fields(env, state, argv, count, local_handles, local_fields, removing); }
  field_handles *handles = calloc(count, sizeof *handles);
  narsil_field_tokens *fields = calloc(count, sizeof *fields);
  narsil_status status = handles == NULL || fields == NULL
                             ? NARSIL_OUT_OF_MEMORY
                             : index_fields(env, state, argv, count, handles, fields, removing);
  free(handles);
  free(fields);
  return status;
}

static napi_value mutate_document(napi_env env, napi_callback_info info, int removing) {
  napi_value local_argv[STACK_ARGUMENTS];
  size_t argc = STACK_ARGUMENTS;
  thread_state *state = thread_state_of(env);
  if (state == NULL || napi_get_cb_info(env, info, &argc, local_argv, NULL, NULL) != napi_ok) {
    return status_of(env, NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = NARSIL_INVALID_ARGUMENT;
  if (argc <= STACK_ARGUMENTS) {
    status = index_arguments(env, state, removing, local_argv, argc);
  } else if (argc - FIRST_FIELD <= (size_t)MAX_FIELDS * FIELD_VALUES) {
    napi_value *argv = (napi_value *)calloc(argc, sizeof *argv);
    size_t held = argc;
    if (argv == NULL) {
      status = NARSIL_OUT_OF_MEMORY;
    } else if (napi_get_cb_info(env, info, &held, argv, NULL, NULL) == napi_ok && held == argc) {
      status = index_arguments(env, state, removing, argv, argc);
    }
    free((void *)argv);
  }
  report_workspace_memory(env, state);
  return status_of(env, status);
}

static napi_value index_terms(napi_env env, napi_callback_info info) { return mutate_document(env, info, 0); }

static napi_value remove_document(napi_env env, napi_callback_info info) { return mutate_document(env, info, 1); }

static napi_value batch(napi_env env, napi_callback_info info, int ending) {
  napi_value argv[BATCH_ARGUMENTS];
  thread_state *state = thread_state_of(env);
  node_segment segment = {0};
  if (state == NULL || !callback_arguments(env, info, BATCH_ARGUMENTS, argv) ||
      !read_segment_view(env, state, argv, &segment)) {
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
