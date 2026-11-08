#include "segments.h"

#include "../include/narsil_segments.h"
#include "terms.h"
#include "values.h"

#include <js_native_api_types.h>
#include <stddef.h>
#include <stdint.h>

static int read_surface(napi_env env, const surface_handles *handles, narsil_surface_table *table) {
  void *token = NULL;
  void *count = NULL;
  size_t tokens = 0;
  size_t counts = 0;
  if (!read_term_table(env, handles->strings, &table->strings) ||
      !possibly_empty_typed_data(env, handles->token, napi_uint32_array, &token, &tokens) ||
      !possibly_empty_typed_data(env, handles->count, napi_uint32_array, &count, &counts) ||
      tokens != table->strings.offset_count || counts != tokens) {
    return 0;
  }
  table->token = token;
  table->count = count;
  table->capacity = tokens;
  return 1;
}

static int read_runs(napi_env env, const segment_handles *handles, narsil_run_table *runs) {
  enum { HEADER, SLOTS, RUNS, START, LENGTH, CLASS, MEMBERS, ALLOCATION, HEADS, SIZES };
  enum { HEADER_WORDS = 8, POINTS_PER_RUN = 3 };
  const napi_typedarray_type types[SEGMENT_RUN_HANDLES] = {
      napi_uint32_array, napi_int32_array,  napi_uint32_array, napi_uint32_array, napi_uint32_array,
      napi_uint8_array,  napi_uint32_array, napi_uint32_array, napi_uint32_array, napi_uint32_array,
  };
  void *data[SEGMENT_RUN_HANDLES] = {0};
  size_t lengths[SEGMENT_RUN_HANDLES] = {0};
  if (!read_segment_arrays(env, handles->runs, types, SEGMENT_RUN_HANDLES, data, lengths)) { return 0; }
  size_t count = lengths[START];
  if (lengths[HEADER] != HEADER_WORDS || count > SIZE_MAX / POINTS_PER_RUN || lengths[RUNS] != count * POINTS_PER_RUN ||
      lengths[LENGTH] != count || lengths[CLASS] != count || lengths[ALLOCATION] != 2 ||
      lengths[HEADS] != lengths[SIZES]) {
    return 0;
  }
  *runs = (narsil_run_table){data[HEADER],
                             data[SLOTS],
                             lengths[SLOTS],
                             data[RUNS],
                             data[START],
                             data[LENGTH],
                             data[CLASS],
                             count,
                             data[MEMBERS],
                             lengths[MEMBERS],
                             {data[ALLOCATION], data[HEADS], data[SIZES], lengths[SIZES]}};
  return 1;
}

static int read_positions(napi_env env, const segment_handles *handles, narsil_position_pool *pool) {
  void *values = NULL;
  void *allocation = NULL;
  size_t count = 0;
  if (!possibly_empty_typed_data(env, handles->positions, napi_uint32_array, &values, &pool->capacity) ||
      !possibly_empty_typed_data(env, handles->position_allocation, napi_uint32_array, &allocation, &count) ||
      count != 2) {
    return 0;
  }
  pool->values = values;
  pool->allocation = allocation;
  return 1;
}

int read_segment_optional(napi_env env, const segment_handles *handles, node_segment *segment) {
  if (handles->has_positions) {
    if (!read_positions(env, handles, &segment->positions)) { return 0; }
    segment->growing.positions = &segment->positions;
  }
  if (handles->has_surfaces) {
    if (!read_surface(env, &handles->surfaces, &segment->surfaces)) { return 0; }
    segment->growing.surfaces = &segment->surfaces;
  }
  if (handles->has_spellings) {
    void *points = NULL;
    size_t count = 0;
    if (!read_surface(env, &handles->spellings, &segment->spellings.entries) ||
        !possibly_empty_typed_data(env, handles->code_points, napi_uint32_array, &points, &count) ||
        count != segment->spellings.entries.capacity || !read_runs(env, handles, &segment->spellings.runs)) {
      return 0;
    }
    segment->spellings.code_points = points;
    segment->growing.spellings = &segment->spellings;
  }
  return 1;
}
