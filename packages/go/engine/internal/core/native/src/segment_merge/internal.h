#ifndef NARSIL_SEGMENT_MERGE_INTERNAL_H
#define NARSIL_SEGMENT_MERGE_INTERNAL_H

#include "../../include/narsil_segment_merge.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  const uint8_t *bytes;
  size_t length;
} merge_text;

typedef struct {
  merge_text text;
  const narsil_keyword_merge_input *input;
  uint32_t ordinal;
  size_t source;
  uint32_t target;
  uint32_t start;
  uint32_t end;
} merge_term;

typedef struct {
  const narsil_keyword_merge_input *input;
  uint32_t row;
  uint32_t target;
  size_t source;
  uint32_t position_start;
  uint32_t position_count;
  uint16_t frequency;
  uint16_t field;
  const uint32_t *positions;
} merge_posting;

typedef struct {
  merge_text spelling;
  merge_text token;
  uint32_t count;
  size_t source;
  uint32_t ordinal;
} merge_string;

typedef struct {
  merge_term *terms;
  size_t term_count;
  size_t term_capacity;
  merge_posting *rows;
  size_t row_count;
  size_t row_capacity;
  merge_string *surfaces;
  size_t surface_count;
  size_t surface_capacity;
  merge_string *spellings;
  size_t spelling_count;
  size_t spelling_capacity;
  uint32_t *mapped;
  size_t mapped_capacity;
  uint8_t *text;
  size_t text_capacity;
  size_t text_used;
  narsil_keyword_merge_sizes sizes;
} segment_merge_scratch;

segment_merge_scratch *workspace_segment_merge_scratch(narsil_workspace *workspace);
void segment_merge_release(segment_merge_scratch *scratch);
size_t segment_merge_bytes(const segment_merge_scratch *scratch);
narsil_status segment_merge_reserve(void **allocation, size_t count, size_t *held, size_t width);
int segment_merge_text(const narsil_frozen_strings *strings, size_t offset, merge_text *text);
int segment_merge_compare_text(merge_text left, merge_text right);
uint32_t segment_merge_term_count(const narsil_keyword_merge_input *input);
narsil_status segment_merge_reserve_text(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request);
int segment_merge_source_term(segment_merge_scratch *scratch, const narsil_keyword_merge_input *input, uint32_t ordinal,
                              merge_term *term);
int segment_merge_source_posting(const merge_term *term, uint32_t row, merge_posting *posting);
int segment_merge_inputs(const narsil_keyword_merge_request *request, const segment_regions *regions);
int segment_merge_outputs(const narsil_keyword_merge_request *request, const narsil_keyword_merge_output *output,
                          segment_regions *regions);
narsil_status segment_merge_prepare(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request);
narsil_status segment_merge_rows(segment_merge_scratch *scratch, size_t start, size_t end);
narsil_status segment_merge_fill_rows(segment_merge_scratch *scratch, size_t start, size_t end);
narsil_status segment_merge_strings(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request);
narsil_status segment_merge_retained(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request);
void segment_merge_publish(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request,
                           const narsil_keyword_merge_output *output);

#endif
