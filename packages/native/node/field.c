#include "field.h"

#include "values.h"

#include "../include/narsil_core.h"

#include <js_native_api.h>
#include <js_native_api_types.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  size_t node_levels;
  size_t level0;
  size_t upper_base;
  size_t upper;
  size_t locks;
  size_t tombstones;
  size_t held_locks;
} graph_lengths;

typedef struct {
  size_t code_present;
  size_t magnitudes;
  size_t present;
} store_lengths;

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

static int covers(size_t length, uint64_t required) { return (uint64_t)length >= required; }

static int32_t header_word(const int32_t *words, uint32_t index) {
  return atomic_load((const _Atomic(int32_t) *)(words + index));
}

typedef struct {
  uint64_t slots;
  uint64_t entries_per_block;
  uint64_t entry_bytes;
  size_t alignment;
} block_layout;

static uint64_t bytes_in_use(const block_layout *layout, uint32_t index) {
  uint64_t first = (uint64_t)index * layout->entries_per_block;
  if (first >= layout->slots) { return 0; }
  uint64_t remaining = layout->slots - first;
  uint64_t entries = remaining < layout->entries_per_block ? remaining : layout->entries_per_block;
  return entries * layout->entry_bytes;
}

static int read_blocks(napi_env env, napi_value memory, const char *name, const block_layout *layout,
                       const void ***blocks, uint32_t *block_count) {
  napi_value list = NULL;
  uint32_t count = 0;
  if (!property(env, memory, name, &list) || napi_get_array_length(env, list, &count) != napi_ok) { return 0; }
  const void **pointers = (const void **)calloc(count == 0 ? 1 : count, sizeof *pointers);
  if (pointers == NULL) { return 0; }
  *blocks = pointers;
  *block_count = count;
  for (uint32_t index = 0; index < count; index++) {
    napi_value entry = NULL;
    napi_valuetype kind = napi_undefined;
    if (napi_get_element(env, list, index, &entry) != napi_ok || napi_typeof(env, entry, &kind) != napi_ok) {
      return 0;
    }
    if (kind == napi_null || kind == napi_undefined) { continue; }
    void *data = NULL;
    size_t length = 0;
    if (!typed_data(env, entry, napi_uint8_array, &data, &length)) { return 0; }
    if ((uintptr_t)data % layout->alignment != 0 || !covers(length, bytes_in_use(layout, index))) { return 0; }
    pointers[index] = data;
  }
  return 1;
}

static int read_graph(napi_env env, napi_value memory, narsil_graph *graph, graph_lengths *lengths) {
  void *data = NULL;
  size_t length = 0;
  if (!typed_property(env, memory, "graphHeader", napi_int32_array, &data, &length)) { return 0; }
  if (length < NARSIL_GRAPH_HEADER_WORDS) { return 0; }
  graph->header = data;
  if (!typed_property(env, memory, "nodeLevels", napi_uint8_array, &data, &lengths->node_levels)) { return 0; }
  graph->node_levels = data;
  if (!typed_property(env, memory, "level0", napi_int32_array, &data, &lengths->level0)) { return 0; }
  graph->level0 = data;
  if (!typed_property(env, memory, "upperBase", napi_int32_array, &data, &lengths->upper_base)) { return 0; }
  graph->upper_base = data;
  if (!typed_property(env, memory, "upper", napi_int32_array, &data, &lengths->upper)) { return 0; }
  graph->upper = data;
  if (!typed_property(env, memory, "locks", napi_int32_array, &data, &lengths->locks)) { return 0; }
  graph->locks = data;
  if (!typed_property(env, memory, "tombstones", napi_uint8_array, &data, &lengths->tombstones)) { return 0; }
  graph->tombstones = data;
  if (!typed_property(env, memory, "heldLocks", napi_int32_array, &data, &lengths->held_locks)) { return 0; }
  graph->held_locks = data;
  graph->thread_slots = clamped_count(lengths->held_locks / NARSIL_HELD_WORDS_PER_THREAD);
  return graph->thread_slots > 0;
}

static int graph_regions_hold_the_graph(const narsil_graph *graph, const graph_lengths *lengths) {
  int32_t slots = header_word(graph->header, NARSIL_GRAPH_WORD_SLOTS);
  int32_t upper_used = header_word(graph->header, NARSIL_GRAPH_WORD_UPPER_USED);
  int32_t max_base_neighbours = header_word(graph->header, NARSIL_GRAPH_WORD_MMAX0);
  if (slots < 0 || upper_used < 0 || max_base_neighbours <= 0) { return 0; }
  uint64_t ordinals = (uint64_t)slots;
  uint64_t base_stride = (uint64_t)max_base_neighbours + NARSIL_LIST_WORDS_OVER_NEIGHBOURS;
  return covers(lengths->node_levels, ordinals) && covers(lengths->level0, ordinals * base_stride) &&
         covers(lengths->upper_base, ordinals) && covers(lengths->locks, ordinals) &&
         covers(lengths->tombstones, ordinals) && covers(lengths->upper, (uint64_t)upper_used);
}

static int read_vector_layout(napi_env env, napi_value memory, narsil_store *store, uint32_t *stride_bytes) {
  if (!uint32_property(env, memory, "vectorsPerBlock", &store->vectors_per_block)) { return 0; }
  if (!uint32_property(env, memory, "vectorStrideBytes", stride_bytes)) { return 0; }
  if (*stride_bytes % sizeof(float) != 0) { return 0; }
  store->vector_stride_floats = (uint32_t)(*stride_bytes / sizeof(float));
  return store->vector_stride_floats >= store->dimension;
}

static int read_store(napi_env env, napi_value memory, attached_field *field, store_lengths *lengths) {
  narsil_store *store = &field->store;
  void *data = NULL;
  size_t length = 0;
  uint32_t stride_bytes = 0;
  if (!typed_property(env, memory, "storeHeader", napi_int32_array, &data, &length)) { return 0; }
  if (length < NARSIL_STORE_HEADER_WORDS) { return 0; }
  store->header = data;
  if (!uint32_property(env, memory, "dimension", &store->dimension)) { return 0; }
  if (!uint32_property(env, memory, "bits", &store->bits)) { return 0; }
  if (!uint32_property(env, memory, "recordsPerBlock", &store->records_per_block)) { return 0; }
  if (!read_vector_layout(env, memory, store, &stride_bytes)) { return 0; }
  if (!typed_property(env, memory, "codePresent", napi_uint8_array, &data, &lengths->code_present)) { return 0; }
  store->code_present = data;
  if (!typed_property(env, memory, "centroid", napi_float32_array, &data, &length)) { return 0; }
  if (length < store->dimension) { return 0; }
  store->centroid = data;
  if (!typed_property(env, memory, "magnitudes", napi_float64_array, &data, &lengths->magnitudes)) { return 0; }
  store->magnitudes = data;
  if (!typed_property(env, memory, "present", napi_uint8_array, &data, &lengths->present)) { return 0; }
  store->present = data;

  int32_t stored_slots = header_word(store->header, NARSIL_STORE_WORD_SLOTS);
  uint64_t slots = stored_slots < 0 ? 0 : (uint64_t)stored_slots;
  block_layout codes = {slots, store->records_per_block, narsil_record_bytes(store->dimension, store->bits), 1};
  if (!read_blocks(env, memory, "codeBlocks", &codes, &field->code_blocks, &store->code_block_count)) { return 0; }
  store->code_blocks = (const uint8_t *const *)field->code_blocks;
  block_layout vectors = {slots, store->vectors_per_block, stride_bytes, _Alignof(float)};
  if (!read_blocks(env, memory, "vectorBlocks", &vectors, &field->vector_blocks, &store->vector_block_count)) {
    return 0;
  }
  store->vector_blocks = (const float *const *)field->vector_blocks;
  return 1;
}

static int store_regions_hold_the_vectors(const narsil_store *store, const store_lengths *lengths) {
  int32_t slots = header_word(store->header, NARSIL_STORE_WORD_SLOTS);
  if (slots < 0 || store->dimension == 0) { return 0; }
  uint64_t ordinals = (uint64_t)slots;
  return covers(lengths->code_present, ordinals) && covers(lengths->magnitudes, ordinals) &&
         covers(lengths->present, ordinals);
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
  graph_lengths graph_held = {0, 0, 0, 0, 0, 0, 0};
  store_lengths store_held = {0, 0, 0};
  if (!read_graph(env, memory, &field->graph, &graph_held) || !read_store(env, memory, field, &store_held) ||
      !graph_regions_hold_the_graph(&field->graph, &graph_held) ||
      !store_regions_hold_the_vectors(&field->store, &store_held)) {
    release_field(env, field, NULL);
    return NULL;
  }
  return field;
}
