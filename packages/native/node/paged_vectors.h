#ifndef NARSIL_NODE_PAGED_VECTORS_H
#define NARSIL_NODE_PAGED_VECTORS_H

#include "../include/narsil_paged_vectors.h"
#include "paged.h"

#include <js_native_api.h>
#include <stddef.h>
#include <stdint.h>

enum {
  FIELD_DIMENSION,
  FIELD_METRIC,
  FIELD_TOTAL,
  FIELD_ENTRY,
  FIELD_LAYER,
  FIELD_CODES,
  FIELD_FILES,
  FIELD_PARTS,
  FIELD_PROPERTIES
};
enum { FILE_FIRST, FILE_COUNT, FILE_DEAD, FILE_VECTORS, FILE_RECORDS, FILE_PROPERTIES };
enum { PART_FIRST, PART_COUNT, PART_LEVELS, PART_OFFSETS, PART_NEIGHBOURS, PART_PROPERTIES };
enum {
  QUERY_VECTOR,
  QUERY_K,
  QUERY_EF,
  QUERY_DEPTH,
  QUERY_EXPLICIT,
  QUERY_FLOOR,
  QUERY_ACCEPTED,
  QUERY_EXCLUDED,
  QUERY_PROPERTIES
};

typedef struct {
  napi_value values[FILE_PROPERTIES];
  page_handles vectors;
  page_handles records;
  narsil_page_section record_section;
  int has_records;
  int has_dead;
} vector_file_handles;

typedef struct {
  napi_value values[PART_PROPERTIES];
  page_handles neighbours;
} graph_part_handles;

typedef struct {
  napi_value values[FIELD_PROPERTIES];
  napi_value centroid;
  vector_file_handles *file_handles;
  graph_part_handles *part_handles;
  narsil_paged_vector_field field;
  narsil_paged_vector_file *files;
  narsil_paged_graph_part *parts;
} paged_field_handles;

typedef struct {
  napi_value values[QUERY_PROPERTIES];
  narsil_paged_vector_request request;
  int accepted;
  int excluded;
} paged_query_handles;

int paged_uint32(napi_env env, napi_value value, uint32_t *number);
int paged_nullable(napi_env env, napi_value value, int *present);
int paged_properties(napi_env env, napi_value object, const char *const *keys, napi_value *values, size_t count);
narsil_status prepare_paged_field(napi_env env, napi_value value, paged_field_handles *handles);
int read_paged_field(napi_env env, paged_field_handles *handles);
void release_paged_field(paged_field_handles *handles);
int prepare_paged_query(napi_env env, napi_value value, paged_query_handles *handles);
int read_paged_query(napi_env env, paged_query_handles *handles);
int define_paged_vectors(napi_env env, napi_value exports);

#endif
