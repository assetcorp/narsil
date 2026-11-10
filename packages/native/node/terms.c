#include "terms.h"

#include "../include/narsil_core.h"
#include "../include/narsil_terms.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <math.h>
#include <stddef.h>
#include <stdint.h>

enum { DICTIONARY, TEXT, THIRD, FOURTH, FIFTH, MAX_ARGUMENTS };

static int uint_argument(napi_env env, napi_value value, uint32_t *number) {
  double read = 0;
  if (napi_get_value_double(env, value, &read) != napi_ok || !isfinite(read) || read < 0 || read > UINT32_MAX ||
      read != floor(read)) {
    return 0;
  }
  *number = (uint32_t)read;
  return 1;
}

static napi_value lookup(napi_env env, napi_callback_info info, uint32_t operation) {
  napi_value argv[MAX_ARGUMENTS];
  size_t arguments = THIRD + 1;
  if (operation == NARSIL_LOOKUP_PREFIX) { arguments = FOURTH + 1; }
  if (operation == NARSIL_LOOKUP_TYPO) { arguments = FIFTH + 1; }
  thread_state *state = thread_state_of(env);
  term_handles handles = {0};
  narsil_term_table table = {0};
  narsil_term_dictionary dictionary = {0};
  narsil_term_lookup request = {0};
  request.operation = operation;
  if (state == NULL || !callback_arguments(env, info, arguments, argv) ||
      !prepare_term_dictionary(env, argv[DICTIONARY], &handles)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  if (operation == NARSIL_LOOKUP_PREFIX && !uint_argument(env, argv[THIRD], &request.limit)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  if (operation == NARSIL_LOOKUP_TYPO && (!uint_argument(env, argv[THIRD], &request.tolerance) ||
                                          !uint_argument(env, argv[FOURTH], &request.prefix_length))) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  void *text = NULL;
  void *output = NULL;
  size_t capacity = 0;
  if (!read_term_dictionary(env, &handles, &table, &dictionary) ||
      !possibly_empty_typed_data(env, argv[TEXT], napi_uint16_array, &text, &request.text_length) ||
      !possibly_empty_typed_data(env, argv[arguments - 1], napi_uint32_array, &output, &capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  request.dictionary = &dictionary;
  request.text = text;
  uint32_t count = 0;
  narsil_status status = narsil_lookup_terms(state->workspace, &request, output, capacity, &count);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, count, &result) != napi_ok) { return NULL; }
  return result;
}

static napi_value lookup_exact(napi_env env, napi_callback_info info) { return lookup(env, info, NARSIL_LOOKUP_EXACT); }
static napi_value lookup_prefix(napi_env env, napi_callback_info info) {
  return lookup(env, info, NARSIL_LOOKUP_PREFIX);
}
static napi_value lookup_typo(napi_env env, napi_callback_info info) { return lookup(env, info, NARSIL_LOOKUP_TYPO); }

static napi_value lookup_exact_batch(napi_env env, napi_callback_info info) {
  enum { OFFSETS = 2, OUTPUT, ARGUMENT_COUNT };
  napi_value argv[ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  term_handles handles = {0};
  narsil_term_table table = {0};
  narsil_term_dictionary dictionary = {0};
  void *units = NULL;
  void *offsets = NULL;
  void *output = NULL;
  size_t unit_count = 0;
  size_t offset_count = 0;
  size_t capacity = 0;
  if (state == NULL || !callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !prepare_term_dictionary(env, argv[DICTIONARY], &handles) ||
      !read_term_dictionary(env, &handles, &table, &dictionary) ||
      !possibly_empty_typed_data(env, argv[TEXT], napi_uint16_array, &units, &unit_count) ||
      !possibly_empty_typed_data(env, argv[OFFSETS], napi_uint32_array, &offsets, &offset_count) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &output, &capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_status status = narsil_lookup_exact_batch(state->workspace, &dictionary, units, unit_count, offsets,
                                                   offset_count, output, capacity);
  report_workspace_memory(env, state);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  napi_value result = NULL;
  if (napi_create_uint32(env, (uint32_t)(offset_count - 1), &result) != napi_ok) { return NULL; }
  return result;
}

static napi_value document_frequency(napi_env env, napi_callback_info info) {
  enum { ORDINAL = 1, OUTPUT, ARGUMENT_COUNT };
  napi_value argv[ARGUMENT_COUNT];
  term_handles handles = {0};
  narsil_term_table table = {0};
  narsil_term_dictionary dictionary = {0};
  uint32_t ordinal = 0;
  void *output = NULL;
  size_t capacity = 0;
  if (!callback_arguments(env, info, ARGUMENT_COUNT, argv) ||
      !prepare_term_dictionary(env, argv[DICTIONARY], &handles) || !uint_argument(env, argv[ORDINAL], &ordinal) ||
      !read_term_dictionary(env, &handles, &table, &dictionary) ||
      !possibly_empty_typed_data(env, argv[OUTPUT], napi_uint32_array, &output, &capacity)) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  return number_of(env, -(int32_t)narsil_document_frequency(&dictionary, ordinal, output, capacity));
}

int define_terms(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"lookupExact", NULL, lookup_exact, NULL, NULL, NULL, napi_default_method, NULL},
      {"lookupExactBatch", NULL, lookup_exact_batch, NULL, NULL, NULL, napi_default_method, NULL},
      {"lookupPrefix", NULL, lookup_prefix, NULL, NULL, NULL, napi_default_method, NULL},
      {"lookupTypo", NULL, lookup_typo, NULL, NULL, NULL, napi_default_method, NULL},
      {"documentFrequency", NULL, document_frequency, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
