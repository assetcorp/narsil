#ifndef NARSIL_FIELD_MERGE_INTERNAL_H
#define NARSIL_FIELD_MERGE_INTERNAL_H

#include "../../include/narsil_field_merge.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

enum { FIELD_MERGE_WORD_BITS = 32 };
enum {
  FIELD_SHAPES,
  FIELD_STARTS,
  FIELD_KINDS,
  FIELD_NUMBERS,
  FIELD_TEXT_STARTS,
  FIELD_TEXT_LENGTHS,
  FIELD_UNITS,
  FIELD_BYTES
};

typedef struct {
  const narsil_field_merge_source *source;
  uint32_t ordinal;
  uint8_t present;
} field_merge_document;

typedef struct {
  double value;
  double longitude;
  uint64_t code;
  uint32_t ordinal;
  uint32_t key;
  size_t source;
  uint32_t index;
} field_merge_row;

typedef struct {
  const void *text;
  size_t length;
  size_t source;
  uint32_t index;
  uint32_t target;
} field_merge_key;

typedef struct {
  field_merge_document *documents;
  size_t document_capacity;
  field_merge_row *rows;
  size_t row_capacity;
  size_t row_count;
  field_merge_key *keys;
  size_t key_capacity;
  size_t key_count;
  field_merge_key *suffixes;
  size_t suffix_capacity;
  uint32_t *key_targets;
  size_t key_target_capacity;
  narsil_field_merge_sizes sizes;
} field_merge_scratch;

field_merge_scratch *workspace_field_merge_scratch(narsil_workspace *workspace);
void field_merge_release(field_merge_scratch *scratch);
size_t field_merge_bytes(const field_merge_scratch *scratch);
size_t field_merge_width(uint32_t kind, size_t region);
int field_merge_inputs(const narsil_field_merge_request *request, const segment_regions *outputs);
int field_merge_outputs(const narsil_field_merge_request *request, const narsil_field_merge_output *output,
                        segment_regions *regions);
narsil_status field_merge_prepare(field_merge_scratch *scratch, const narsil_field_merge_request *request);
narsil_status field_merge_rows(field_merge_scratch *scratch, const narsil_field_merge_request *request);
narsil_status field_merge_dictionary(field_merge_scratch *scratch, const narsil_field_merge_request *request);
narsil_status field_merge_stored(field_merge_scratch *scratch, const narsil_field_merge_request *request);
void field_merge_publish(const field_merge_scratch *scratch, const narsil_field_merge_request *request,
                         const narsil_field_merge_output *output);
void field_merge_publish_dictionary(const field_merge_scratch *scratch, const narsil_field_merge_request *request,
                                    const narsil_field_merge_output *output);
void field_merge_publish_stored(const field_merge_scratch *scratch, const narsil_field_merge_request *request,
                                const narsil_field_merge_output *output);

#endif
