#ifndef NARSIL_FIELD_MERGE_H
#define NARSIL_FIELD_MERGE_H

#include "narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  NARSIL_MERGE_NUMERIC = 1,
  NARSIL_MERGE_BOOLEAN,
  NARSIL_MERGE_ENUM,
  NARSIL_MERGE_GEO,
  NARSIL_MERGE_STORED,
  NARSIL_MERGE_PATTERN,
  NARSIL_FIELD_MERGE_REGIONS = 8
};

typedef struct {
  const void *data;
  size_t length;
} narsil_field_merge_region;

typedef struct {
  const uint32_t *mapping;
  size_t document_count;
  narsil_field_merge_region regions[NARSIL_FIELD_MERGE_REGIONS];
} narsil_field_merge_source;

typedef struct {
  uint32_t kind;
  uint32_t document_count;
  const narsil_field_merge_source *sources;
  size_t source_count;
} narsil_field_merge_request;

typedef struct {
  uint32_t lengths[NARSIL_FIELD_MERGE_REGIONS];
} narsil_field_merge_sizes;

typedef struct {
  void *data;
  size_t capacity;
} narsil_field_merge_target;

typedef struct {
  narsil_field_merge_target regions[NARSIL_FIELD_MERGE_REGIONS];
} narsil_field_merge_output;

narsil_status narsil_measure_field_merge(narsil_workspace *workspace, const narsil_field_merge_request *request,
                                         narsil_field_merge_sizes *sizes);
narsil_status narsil_write_field_merge(narsil_workspace *workspace, const narsil_field_merge_request *request,
                                       const narsil_field_merge_output *output);

#ifdef __cplusplus
}
#endif

#endif
