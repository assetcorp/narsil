#ifndef NARSIL_SEGMENT_REGIONS_H
#define NARSIL_SEGMENT_REGIONS_H

#include "../../include/narsil_segments.h"
#include "../regions.h"

#include <stddef.h>

enum { SEGMENT_WRITE_REGIONS = 80, SEGMENT_READ_REGIONS = 16 };

typedef struct {
  memory_region writes[SEGMENT_WRITE_REGIONS];
  memory_region reads[SEGMENT_READ_REGIONS];
  size_t write_count;
  size_t read_count;
} segment_regions;

int segment_region_read(segment_regions *regions, const void *pointer, size_t count, size_t width);
int segment_region_write(segment_regions *regions, const void *pointer, size_t count, size_t width);
int segment_region_input(const segment_regions *regions, const void *pointer, size_t count, size_t width);
int segment_valid_tokens(const segment_regions *regions, const narsil_tokens *tokens);
int segment_write_regions(segment_regions *regions, const narsil_growing_segment *segment);
narsil_status segment_request_regions(segment_regions *regions, const narsil_index_terms_request *request,
                                      size_t *token_count);

#endif
