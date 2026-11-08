#include "analysis.h"

#include "values.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"
#include "../include/narsil_packed_tokens.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define STOP_WORD_SET_KIND 0x4E535750U
#define MIN_TEXT_CAPACITY 256U

enum {
  RECORD_POSITION,
  RECORD_TERM_OFFSET,
  RECORD_TERM_LENGTH,
  RECORD_SURFACE_OFFSET,
  RECORD_SURFACE_LENGTH,
  RECORD_ORIGINAL_OFFSET,
  RECORD_ORIGINAL_LENGTH,
  RECORD_TERM_SLOT,
  TOKEN_RECORD_WORDS
};

enum { ANALYSE_LANGUAGE, ANALYSE_FLAGS, ANALYSE_TEXT, ANALYSE_STOP_WORDS, ANALYSE_RECORDS, ANALYSE_ARGUMENT_COUNT };
enum { TRANSFORM_LANGUAGE, TRANSFORM_FLAGS, TRANSFORM_TEXT, TRANSFORM_ARGUMENT_COUNT };
enum { LANGUAGE_INDEX, LANGUAGE_ARGUMENT_COUNT };
enum { STOP_WORDS_LIST, STOP_WORDS_ARGUMENT_COUNT };

typedef struct {
  uint32_t kind;
  narsil_stop_word_set *set;
} attached_stop_words;

typedef struct {
  uint16_t *units;
  size_t length;
  size_t capacity;
} unit_buffer;

static int reserve_units(unit_buffer *buffer, size_t needed) {
  if (needed <= buffer->capacity) { return 1; }
  size_t capacity = buffer->capacity < MIN_TEXT_CAPACITY ? MIN_TEXT_CAPACITY : buffer->capacity;
  while (capacity < needed) {
    if (capacity > SIZE_MAX / 2 / sizeof(uint16_t)) { return 0; }
    capacity *= 2;
  }
  uint16_t *grown = realloc(buffer->units, capacity * sizeof(uint16_t));
  if (grown == NULL) { return 0; }
  buffer->units = grown;
  buffer->capacity = capacity;
  return 1;
}

static int string_length(napi_env env, napi_value value, size_t *length) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) { return 0; }
  return napi_get_value_string_utf16(env, value, NULL, 0, length) == napi_ok;
}

static int append_string(napi_env env, napi_value value, unit_buffer *buffer) {
  size_t length = 0;
  if (!string_length(env, value, &length) || length > NARSIL_MAX_ANALYSED_UNITS) { return 0; }
  if (buffer->length > SIZE_MAX - length - 1 || !reserve_units(buffer, buffer->length + length + 1)) { return 0; }
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, buffer->units + buffer->length, length + 1, &copied) != napi_ok ||
      copied != length) {
    return 0;
  }
  buffer->length += length;
  return 1;
}

static int read_text(napi_env env, thread_state *state, napi_value value, uint32_t *length) {
  unit_buffer buffer = {state->text_units, 0, state->text_capacity};
  int read = append_string(env, value, &buffer);
  state->text_units = buffer.units;
  state->text_capacity = buffer.capacity;
  *length = (uint32_t)buffer.length;
  return read;
}

static narsil_analyser *analyser_of(thread_state *state) {
  if (state->analyser == NULL && narsil_analyser_create(&state->analyser) != NARSIL_OK) { state->analyser = NULL; }
  return state->analyser;
}

static void release_stop_words(napi_env env, void *finalize_data, void *finalize_hint) {
  (void)env;
  (void)finalize_hint;
  attached_stop_words *attached = finalize_data;
  narsil_stop_word_set_destroy(attached->set);
  free(attached);
}

static int read_stop_words(napi_env env, napi_value value, const narsil_stop_word_set **set) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok) { return 0; }
  if (type == napi_null) {
    *set = NULL;
    return 1;
  }
  void *data = NULL;
  if (type != napi_external || napi_get_value_external(env, value, &data) != napi_ok || data == NULL) { return 0; }
  attached_stop_words *attached = data;
  if (attached->kind != STOP_WORD_SET_KIND) { return 0; }
  *set = attached->set;
  return 1;
}

static napi_value utf16_string(napi_env env, const uint16_t *units, size_t length) {
  static const uint16_t no_units[1] = {0};
  napi_value result = NULL;
  if (napi_create_string_utf16(env, length == 0 ? no_units : units, length, &result) != napi_ok) { return NULL; }
  return result;
}

static napi_value ascii_string(napi_env env, const char *text) {
  napi_value result = NULL;
  if (text == NULL || napi_create_string_utf8(env, text, strlen(text), &result) != napi_ok) { return NULL; }
  return result;
}

static napi_value language_count(napi_env env, napi_callback_info info) {
  (void)info;
  return number_of(env, (int32_t)narsil_language_count());
}

static int language_argument(napi_env env, napi_callback_info info, uint32_t *language) {
  napi_value argv[LANGUAGE_ARGUMENT_COUNT];
  return callback_arguments(env, info, LANGUAGE_ARGUMENT_COUNT, argv) &&
         napi_get_value_uint32(env, argv[LANGUAGE_INDEX], language) == napi_ok && *language < narsil_language_count();
}

static napi_value language_name(napi_env env, napi_callback_info info) {
  uint32_t language = 0;
  if (!language_argument(env, info, &language)) { return throw_error(env, "languageName takes a language index"); }
  return ascii_string(env, narsil_language_name(language));
}

static napi_value language_revision(napi_env env, napi_callback_info info) {
  uint32_t language = 0;
  if (!language_argument(env, info, &language)) { return throw_error(env, "languageRevision takes a language index"); }
  return ascii_string(env, narsil_language_revision(language));
}

static napi_value language_stop_words(napi_env env, napi_callback_info info) {
  uint32_t language = 0;
  if (!language_argument(env, info, &language)) { return throw_error(env, "languageStopWords takes a language index"); }
  narsil_word_list list = {NULL, NULL, 0};
  napi_value words = NULL;
  if (narsil_language_stop_words(language, &list) != NARSIL_OK ||
      napi_create_array_with_length(env, list.count, &words) != napi_ok) {
    return NULL;
  }
  for (uint32_t index = 0; index < list.count; index++) {
    uint32_t start = list.offsets[index];
    napi_value value = utf16_string(env, list.units + start, list.offsets[index + 1] - start);
    if (value == NULL || napi_set_element(env, words, index, value) != napi_ok) { return NULL; }
  }
  return words;
}

static int read_word_list(napi_env env, napi_value list, unit_buffer *units, uint32_t **offsets, uint32_t *count) {
  bool is_array = false;
  if (napi_is_array(env, list, &is_array) != napi_ok || !is_array ||
      napi_get_array_length(env, list, count) != napi_ok || *count == UINT32_MAX) {
    return 0;
  }
  *offsets = malloc(((size_t)*count + 1) * sizeof(uint32_t));
  if (*offsets == NULL) { return 0; }
  (*offsets)[0] = 0;
  for (uint32_t index = 0; index < *count; index++) {
    napi_value word = NULL;
    if (napi_get_element(env, list, index, &word) != napi_ok || !append_string(env, word, units) ||
        units->length > UINT32_MAX) {
      return 0;
    }
    (*offsets)[index + 1] = (uint32_t)units->length;
  }
  return 1;
}

static napi_value create_stop_word_set(napi_env env, napi_callback_info info) {
  napi_value argv[STOP_WORDS_ARGUMENT_COUNT];
  if (!callback_arguments(env, info, STOP_WORDS_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "createStopWordSet takes one list of words");
  }
  unit_buffer units = {NULL, 0, 0};
  uint32_t *offsets = NULL;
  uint32_t count = 0;
  int read = read_word_list(env, argv[STOP_WORDS_LIST], &units, &offsets, &count);
  attached_stop_words *attached = read ? calloc(1, sizeof *attached) : NULL;
  narsil_status status = NARSIL_INVALID_ARGUMENT;
  if (attached != NULL) {
    attached->kind = STOP_WORD_SET_KIND;
    status = narsil_stop_word_set_create(units.units, offsets, count, &attached->set);
  }
  free(units.units);
  free(offsets);
  if (status != NARSIL_OK) {
    free(attached);
    return throw_error(env, "createStopWordSet takes a list of strings, and the core must be able to hold them");
  }
  napi_value handle = NULL;
  if (napi_create_external(env, attached, release_stop_words, NULL, &handle) != napi_ok) {
    release_stop_words(env, attached, NULL);
    return throw_error(env, "createStopWordSet cannot create the stop word handle");
  }
  return handle;
}

static int write_records(const narsil_tokens *tokens, uint32_t *records, size_t capacity) {
  records[0] = tokens->token_count;
  if (capacity < 1 + ((size_t)tokens->token_count * TOKEN_RECORD_WORDS)) { return 0; }
  uint32_t *record = records + 1;
  for (uint32_t index = 0; index < tokens->token_count; index++) {
    const narsil_token *token = &tokens->tokens[index];
    record[RECORD_POSITION] = token->position;
    record[RECORD_TERM_OFFSET] = token->term_offset;
    record[RECORD_TERM_LENGTH] = token->term_length;
    record[RECORD_SURFACE_OFFSET] = token->surface_offset;
    record[RECORD_SURFACE_LENGTH] = token->surface_length;
    record[RECORD_ORIGINAL_OFFSET] = token->original_offset;
    record[RECORD_ORIGINAL_LENGTH] = token->original_length;
    record[RECORD_TERM_SLOT] = token->term_slot;
    record += TOKEN_RECORD_WORDS;
  }
  return 1;
}

static napi_value analyse(napi_env env, napi_callback_info info) {
  napi_value argv[ANALYSE_ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ANALYSE_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "analyse takes a language, flags, a text, a stop word set or null, and a record array");
  }
  narsil_analysis_request request = {0, NULL, 0, NULL, 0};
  void *records = NULL;
  size_t capacity = 0;
  if (napi_get_value_uint32(env, argv[ANALYSE_LANGUAGE], &request.language) != napi_ok ||
      napi_get_value_uint32(env, argv[ANALYSE_FLAGS], &request.flags) != napi_ok ||
      !read_stop_words(env, argv[ANALYSE_STOP_WORDS], &request.stop_words) ||
      !typed_data(env, argv[ANALYSE_RECORDS], napi_uint32_array, &records, &capacity) || capacity == 0 ||
      !read_text(env, state, argv[ANALYSE_TEXT], &request.length)) {
    return throw_error(env, "an argument to analyse has the wrong type, or the text is too long");
  }
  narsil_analyser *analyser = analyser_of(state);
  if (analyser == NULL) { return number_of(env, -(int32_t)NARSIL_OUT_OF_MEMORY); }
  request.text = state->text_units;
  narsil_tokens tokens;
  narsil_status status = narsil_analyse(analyser, &request, &tokens);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  if (!write_records(&tokens, records, capacity)) {
    napi_value none = NULL;
    return napi_get_null(env, &none) == napi_ok ? none : NULL;
  }
  return utf16_string(env, tokens.units, tokens.unit_count);
}

static napi_value packed_result(napi_env env, const narsil_tokens *tokens) {
  uint32_t probe = 0;
  uint32_t needed = 0;
  narsil_status status = narsil_pack_tokens(tokens, &probe, 1, NULL, 0, &needed);
  if (status != NARSIL_OK && status != NARSIL_NEEDS_ROOM) { return number_of(env, -(int32_t)status); }
  uint64_t record_words = 1 + ((uint64_t)tokens->token_count * TOKEN_RECORD_WORDS);
  if (record_words > SIZE_MAX / sizeof(uint32_t)) { return number_of(env, -(int32_t)NARSIL_OUT_OF_MEMORY); }
  size_t words = (size_t)record_words;
  size_t record_bytes = words * sizeof(uint32_t);
  if (needed > (SIZE_MAX - record_bytes) / sizeof(uint16_t)) { return number_of(env, -(int32_t)NARSIL_OUT_OF_MEMORY); }
  void *data = NULL;
  napi_value buffer = NULL;
  napi_value units = NULL;
  if (napi_create_arraybuffer(env, record_bytes + ((size_t)needed * sizeof(uint16_t)), &data, &buffer) != napi_ok) {
    return NULL;
  }
  uint32_t packed = 0;
  status = narsil_pack_tokens(tokens, data, words, (uint16_t *)((uint32_t *)data + words), needed, &packed);
  if (status != NARSIL_OK || packed != needed) {
    return number_of(env, -(int32_t)(status == NARSIL_OK ? NARSIL_INVALID_ARGUMENT : status));
  }
  return napi_create_typedarray(env, napi_uint16_array, needed, buffer, record_bytes, &units) == napi_ok ? units : NULL;
}

static napi_value analyse_packed(napi_env env, napi_callback_info info) {
  napi_value argv[ANALYSE_RECORDS];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, ANALYSE_RECORDS, argv)) {
    return throw_error(env, "analysePacked takes a language, flags, a text, and a stop word set or null");
  }
  narsil_analysis_request request = {0, NULL, 0, NULL, 0};
  if (napi_get_value_uint32(env, argv[ANALYSE_LANGUAGE], &request.language) != napi_ok ||
      napi_get_value_uint32(env, argv[ANALYSE_FLAGS], &request.flags) != napi_ok ||
      !read_stop_words(env, argv[ANALYSE_STOP_WORDS], &request.stop_words) ||
      !read_text(env, state, argv[ANALYSE_TEXT], &request.length)) {
    return throw_error(env, "an argument to analysePacked has the wrong type, or the text is too long");
  }
  narsil_analyser *analyser = analyser_of(state);
  if (analyser == NULL) { return number_of(env, -(int32_t)NARSIL_OUT_OF_MEMORY); }
  request.text = state->text_units;
  narsil_tokens tokens;
  narsil_status status = narsil_analyse(analyser, &request, &tokens);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  return packed_result(env, &tokens);
}

static napi_value transform(napi_env env, napi_callback_info info) {
  napi_value argv[TRANSFORM_ARGUMENT_COUNT];
  thread_state *state = thread_state_of(env);
  if (state == NULL || !callback_arguments(env, info, TRANSFORM_ARGUMENT_COUNT, argv)) {
    return throw_error(env, "transform takes a language, flags, and a token");
  }
  narsil_analysis_request request = {0, NULL, 0, NULL, 0};
  if (napi_get_value_uint32(env, argv[TRANSFORM_LANGUAGE], &request.language) != napi_ok ||
      napi_get_value_uint32(env, argv[TRANSFORM_FLAGS], &request.flags) != napi_ok ||
      !read_text(env, state, argv[TRANSFORM_TEXT], &request.length)) {
    return throw_error(env, "an argument to transform has the wrong type, or the token is too long");
  }
  narsil_analyser *analyser = analyser_of(state);
  if (analyser == NULL) { return number_of(env, -(int32_t)NARSIL_OUT_OF_MEMORY); }
  request.text = state->text_units;
  narsil_term term = {NULL, 0};
  narsil_status status = narsil_transform(analyser, &request, &term);
  if (status != NARSIL_OK) { return number_of(env, -(int32_t)status); }
  return utf16_string(env, term.units, term.length);
}

int define_analysis(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"languageCount", NULL, language_count, NULL, NULL, NULL, napi_default_method, NULL},
      {"languageName", NULL, language_name, NULL, NULL, NULL, napi_default_method, NULL},
      {"languageRevision", NULL, language_revision, NULL, NULL, NULL, napi_default_method, NULL},
      {"languageStopWords", NULL, language_stop_words, NULL, NULL, NULL, napi_default_method, NULL},
      {"createStopWordSet", NULL, create_stop_word_set, NULL, NULL, NULL, napi_default_method, NULL},
      {"analyse", NULL, analyse, NULL, NULL, NULL, napi_default_method, NULL},
      {"analysePacked", NULL, analyse_packed, NULL, NULL, NULL, napi_default_method, NULL},
      {"transform", NULL, transform, NULL, NULL, NULL, napi_default_method, NULL},
  };
  return napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties) == napi_ok;
}
