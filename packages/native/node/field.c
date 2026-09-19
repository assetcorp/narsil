#include "field.h"

#include "values.h"

#include "../include/narsil_core.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static int property(napi_env env, napi_value object, const char *name, napi_value *out) {
  return napi_get_named_property(env, object, name, out) == napi_ok;
}

static int typed_property(napi_env env, napi_value object, const char *name, napi_typedarray_type expected, void **data,
                          size_t *length) {
  napi_value value = NULL;
  return property(env, object, name, &value) && typed_data(env, value, expected, data, length);
}

static int uint32_property(napi_env env, napi_value object, const char *name, uint32_t *out) {
  napi_value value = NULL;
  return property(env, object, name, &value) && napi_get_value_uint32(env, value, out) == napi_ok;
}

static int block_list(napi_env env, napi_value object, const char *name, napi_value *list, uint32_t *count) {
  return property(env, object, name, list) && napi_get_array_length(env, *list, count) == napi_ok;
}

static int block_at(napi_env env, napi_value list, uint32_t index, void **data) {
  napi_value entry = NULL;
  napi_valuetype kind = napi_undefined;
  *data = NULL;
  if (napi_get_element(env, list, index, &entry) != napi_ok || napi_typeof(env, entry, &kind) != napi_ok) { return 0; }
  if (kind == napi_null || kind == napi_undefined) { return 1; }
  size_t length = 0;
  return typed_data(env, entry, napi_uint8_array, data, &length);
}

static int read_code_blocks(napi_env env, napi_value memory, attached_field *field) {
  napi_value list = NULL;
  uint32_t count = 0;
  if (!block_list(env, memory, "codeBlocks", &list, &count)) { return 0; }
  field->code_blocks = (const uint8_t **)calloc(count == 0 ? 1 : count, sizeof(const uint8_t *));
  if (field->code_blocks == NULL) { return 0; }
  for (uint32_t i = 0; i < count; i++) {
    void *data = NULL;
    if (!block_at(env, list, i, &data)) { return 0; }
    field->code_blocks[i] = data;
  }
  field->store.code_blocks = field->code_blocks;
  field->store.code_block_count = count;
  return 1;
}

static int read_vector_blocks(napi_env env, napi_value memory, attached_field *field) {
  napi_value list = NULL;
  uint32_t count = 0;
  if (!block_list(env, memory, "vectorBlocks", &list, &count)) { return 0; }
  field->vector_blocks = (const float **)calloc(count == 0 ? 1 : count, sizeof(const float *));
  if (field->vector_blocks == NULL) { return 0; }
  for (uint32_t i = 0; i < count; i++) {
    void *data = NULL;
    if (!block_at(env, list, i, &data)) { return 0; }
    if ((uintptr_t)data % _Alignof(float) != 0) { return 0; }
    field->vector_blocks[i] = data;
  }
  field->store.vector_blocks = field->vector_blocks;
  field->store.vector_block_count = count;
  return 1;
}

static int read_graph(napi_env env, napi_value memory, narsil_graph *graph) {
  void *data = NULL;
  size_t length = 0;
  if (!typed_property(env, memory, "graphHeader", napi_int32_array, &data, &length)) { return 0; }
  if (length < NARSIL_GRAPH_HEADER_WORDS) { return 0; }
  graph->header = data;
  if (!typed_property(env, memory, "nodeLevels", napi_uint8_array, &data, &length)) { return 0; }
  graph->node_levels = data;
  if (!typed_property(env, memory, "level0", napi_int32_array, &data, &length)) { return 0; }
  graph->level0 = data;
  if (!typed_property(env, memory, "upperBase", napi_int32_array, &data, &length)) { return 0; }
  graph->upper_base = data;
  if (!typed_property(env, memory, "upper", napi_int32_array, &data, &length)) { return 0; }
  graph->upper = data;
  if (!typed_property(env, memory, "locks", napi_int32_array, &data, &length)) { return 0; }
  graph->locks = data;
  if (!typed_property(env, memory, "tombstones", napi_uint8_array, &data, &length)) { return 0; }
  graph->tombstones = data;
  if (!typed_property(env, memory, "heldLocks", napi_int32_array, &data, &length)) { return 0; }
  graph->held_locks = data;
  graph->thread_slots = clamped_count(length / NARSIL_HELD_WORDS_PER_THREAD);
  return 1;
}

static int read_vector_layout(napi_env env, napi_value memory, narsil_store *store) {
  uint32_t stride_bytes = 0;
  if (!uint32_property(env, memory, "vectorsPerBlock", &store->vectors_per_block)) { return 0; }
  if (!uint32_property(env, memory, "vectorStrideBytes", &stride_bytes)) { return 0; }
  if (stride_bytes % sizeof(float) != 0) { return 0; }
  store->vector_stride_floats = (uint32_t)(stride_bytes / sizeof(float));
  return store->vector_stride_floats >= store->dimension;
}

static int read_store(napi_env env, napi_value memory, attached_field *field) {
  narsil_store *store = &field->store;
  void *data = NULL;
  size_t length = 0;
  if (!typed_property(env, memory, "storeHeader", napi_int32_array, &data, &length)) { return 0; }
  if (length < NARSIL_STORE_HEADER_WORDS) { return 0; }
  store->header = data;
  if (!uint32_property(env, memory, "dimension", &store->dimension)) { return 0; }
  if (!uint32_property(env, memory, "bits", &store->bits)) { return 0; }
  if (!uint32_property(env, memory, "recordsPerBlock", &store->records_per_block)) { return 0; }
  if (!read_vector_layout(env, memory, store)) { return 0; }
  if (!typed_property(env, memory, "codePresent", napi_uint8_array, &data, &length)) { return 0; }
  store->code_present = data;
  if (!typed_property(env, memory, "centroid", napi_float32_array, &data, &length)) { return 0; }
  if (length < store->dimension) { return 0; }
  store->centroid = data;
  if (!typed_property(env, memory, "magnitudes", napi_float64_array, &data, &length)) { return 0; }
  store->magnitudes = data;
  if (!typed_property(env, memory, "present", napi_uint8_array, &data, &length)) { return 0; }
  store->present = data;
  return read_code_blocks(env, memory, field) && read_vector_blocks(env, memory, field);
}

void release_field(napi_env env, void *finalize_data, void *finalize_hint) {
  (void)finalize_hint;
  attached_field *field = finalize_data;
  if (field->memory != NULL) { (void)napi_delete_reference(env, field->memory); }
  free((void *)field->code_blocks);
  free((void *)field->vector_blocks);
  free(field);
}

attached_field *read_field(napi_env env, napi_value memory) {
  attached_field *field = calloc(1, sizeof *field);
  if (field == NULL) { return NULL; }
  if (!read_graph(env, memory, &field->graph) || !read_store(env, memory, field)) {
    release_field(env, field, NULL);
    return NULL;
  }
  return field;
}
