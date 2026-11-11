#include "synonyms.h"

#include "../include/narsil_core.h"
#include "../include/narsil_synonyms.h"
#include "values.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

enum { TABLE, QUERY_UNITS, QUERY_STARTS, OUT_QUERIES, OUT_STARTS, OUT_TOKENS, ARGUMENT_COUNT };
enum { TOKENS, OFFSETS, RULE_START, RULE_SOURCE, RULE_TOKENS, TOKEN_START, TOKEN_RULES, TABLE_REGIONS };
enum { REGIONS = TABLE_REGIONS + ARGUMENT_COUNT - 1 };

static napi_value expand(napi_env env, napi_callback_info info) {
  napi_value argv[ARGUMENT_COUNT];
  napi_value handles[REGIONS];
  static const char *const properties[TABLE_REGIONS] = {"tokens",     "offsets",    "ruleStart", "ruleSource",
                                                        "ruleTokens", "tokenStart", "tokenRules"};
  if (!callback_arguments(env, info, ARGUMENT_COUNT, argv)) { return number_of(env, -NARSIL_INVALID_ARGUMENT); }
  for (size_t at = 0; at < TABLE_REGIONS; at++) {
    if (napi_get_named_property(env, argv[TABLE], properties[at], handles + at) != napi_ok) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  for (size_t at = 1; at < ARGUMENT_COUNT; at++) { handles[TABLE_REGIONS + at - 1] = argv[at]; }
  void *data[REGIONS];
  size_t lengths[REGIONS];
  for (size_t at = 0; at < REGIONS; at++) {
    napi_typedarray_type type = napi_uint32_array;
    if (at == TOKENS) { type = napi_uint8_array; }
    if (at == RULE_SOURCE) { type = napi_int32_array; }
    if (at == TABLE_REGIONS + QUERY_UNITS - 1) { type = napi_uint16_array; }
    if (!possibly_empty_typed_data(env, handles[at], type, data + at, lengths + at)) {
      return number_of(env, -NARSIL_INVALID_ARGUMENT);
    }
  }
  if (lengths[OFFSETS] == 0 || lengths[RULE_START] != lengths[RULE_SOURCE] + 1 ||
      lengths[TOKEN_START] != lengths[OFFSETS] || lengths[TABLE_REGIONS + QUERY_STARTS - 1] == 0) {
    return number_of(env, -NARSIL_INVALID_ARGUMENT);
  }
  narsil_synonym_table table = {data[TOKENS],         lengths[TOKENS],   data[OFFSETS],        lengths[OFFSETS] - 1,
                                data[RULE_START],     data[RULE_SOURCE], lengths[RULE_SOURCE], data[RULE_TOKENS],
                                lengths[RULE_TOKENS], data[TOKEN_START], data[TOKEN_RULES],    lengths[TOKEN_RULES]};
  narsil_synonym_request request = {&table, data[TABLE_REGIONS + QUERY_UNITS - 1],
                                    lengths[TABLE_REGIONS + QUERY_UNITS - 1], data[TABLE_REGIONS + QUERY_STARTS - 1],
                                    lengths[TABLE_REGIONS + QUERY_STARTS - 1] - 1};
  narsil_synonym_output output = {data[TABLE_REGIONS + OUT_QUERIES - 1], lengths[TABLE_REGIONS + OUT_QUERIES - 1],
                                  data[TABLE_REGIONS + OUT_STARTS - 1],  lengths[TABLE_REGIONS + OUT_STARTS - 1],
                                  data[TABLE_REGIONS + OUT_TOKENS - 1],  lengths[TABLE_REGIONS + OUT_TOKENS - 1]};
  uint32_t count = 0;
  narsil_status status = narsil_expand_synonyms(&request, &output, &count);
  return number_of(env, status == NARSIL_OK ? (int32_t)count : -(int32_t)status);
}

int define_synonyms(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"expandSynonyms", NULL, expand, NULL, NULL, NULL, napi_default_method, NULL};
  return napi_define_properties(env, exports, 1, &property) == napi_ok;
}
