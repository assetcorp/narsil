#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_field_merge.h"
#include "../segment_merge/internal.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static const double MAX_LATITUDE = 90;
static const double MAX_LONGITUDE = 180;

static int tie(const field_merge_row *left, const field_merge_row *right) {
  if (left->ordinal != right->ordinal) { return left->ordinal < right->ordinal ? -1 : 1; }
  if (left->source != right->source) { return left->source < right->source ? -1 : 1; }
  return left->index < right->index ? -1 : left->index > right->index;
}

static int numeric_compare(const void *first, const void *second) {
  const field_merge_row *left = first;
  const field_merge_row *right = second;
  int left_nan = isnan(left->value);
  int right_nan = isnan(right->value);
  if (left_nan != right_nan) { return left_nan ? 1 : -1; }
  if (left->value < right->value) { return -1; }
  if (left->value > right->value) { return 1; }
  return tie(left, right);
}

static int geo_compare(const void *first, const void *second) {
  const field_merge_row *left = first;
  const field_merge_row *right = second;
  if (left->code != right->code) { return left->code < right->code ? -1 : 1; }
  return tie(left, right);
}

static int valid_coordinate(const narsil_field_merge_source *source, size_t index) {
  const double *lat = source->regions[1].data;
  const double *lon = source->regions[2].data;
  return isfinite(lat[index]) && lat[index] >= -MAX_LATITUDE && lat[index] <= MAX_LATITUDE && isfinite(lon[index]) &&
         lon[index] >= -MAX_LONGITUDE && lon[index] <= MAX_LONGITUDE;
}

static int valid_number(const narsil_field_merge_source *source, size_t index) {
  return !isnan(((const double *)source->regions[0].data)[index]);
}

static narsil_status count_rows(const narsil_field_merge_request *request, size_t *count) {
  int geo = request->kind == NARSIL_MERGE_GEO;
  for (size_t source_index = 0; source_index < request->source_count; source_index++) {
    const narsil_field_merge_source *source = request->sources + source_index;
    const uint32_t *ordinals = source->regions[geo ? 3 : 1].data;
    for (size_t at = 0; at < source->regions[0].length; at++) {
      uint32_t ordinal = ordinals[at];
      int valid = geo ? valid_coordinate(source, at) : valid_number(source, at);
      if (ordinal >= source->document_count || !valid) { return NARSIL_FILE_UNREADABLE; }
      if (source->mapping[ordinal] != UINT32_MAX) {
        if (*count == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
        (*count)++;
      }
    }
  }
  return NARSIL_OK;
}

narsil_status field_merge_rows(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  int geo = request->kind == NARSIL_MERGE_GEO;
  size_t count = 0;
  narsil_status status = count_rows(request, &count);
  if (status != NARSIL_OK) { return status; }
  status = segment_merge_reserve((void **)&scratch->rows, count, &scratch->row_capacity, sizeof *scratch->rows);
  if (status != NARSIL_OK) { return status; }
  for (size_t source_index = 0; source_index < request->source_count; source_index++) {
    const narsil_field_merge_source *source = request->sources + source_index;
    const uint32_t *ordinals = source->regions[geo ? 3 : 1].data;
    const double *values = source->regions[geo ? 1 : 0].data;
    for (size_t at = 0; at < source->regions[0].length; at++) {
      uint32_t ordinal = source->mapping[ordinals[at]];
      if (ordinal == UINT32_MAX) { continue; }
      field_merge_row *row = scratch->rows + scratch->row_count++;
      *row = (field_merge_row){.ordinal = ordinal, .source = source_index, .index = (uint32_t)at};
      memcpy(&row->value, values + at, sizeof row->value);
      if (geo) {
        const uint64_t *codes = source->regions[0].data;
        const double *longitude = source->regions[2].data;
        row->code = codes[at];
        row->longitude = longitude[at];
      }
    }
  }
  if (count > 1) { qsort(scratch->rows, count, sizeof *scratch->rows, geo ? geo_compare : numeric_compare); }
  for (size_t at = 0; at < (geo ? 4U : 2U); at++) { scratch->sizes.lengths[at] = (uint32_t)count; }
  return NARSIL_OK;
}

void field_merge_publish(const field_merge_scratch *scratch, const narsil_field_merge_request *request,
                         const narsil_field_merge_output *output) {
  if (request->kind == NARSIL_MERGE_STORED) {
    field_merge_publish_stored(scratch, request, output);
    return;
  }
  if (request->kind == NARSIL_MERGE_ENUM || request->kind == NARSIL_MERGE_PATTERN) {
    field_merge_publish_dictionary(scratch, request, output);
    return;
  }
  if (request->kind == NARSIL_MERGE_BOOLEAN) {
    for (size_t value = 0; value < 2; value++) {
      uint32_t *bits = output->regions[value].data;
      memset(bits, 0, scratch->sizes.lengths[value] * sizeof *bits);
      for (uint32_t ordinal = 0; ordinal < request->document_count; ordinal++) {
        field_merge_document document = scratch->documents[ordinal];
        const uint32_t *source = document.source->regions[value].data;
        if ((source[document.ordinal / FIELD_MERGE_WORD_BITS] &
             (UINT32_C(1) << (document.ordinal % FIELD_MERGE_WORD_BITS))) != 0) {
          bits[ordinal / FIELD_MERGE_WORD_BITS] |= UINT32_C(1) << (ordinal % FIELD_MERGE_WORD_BITS);
        }
      }
    }
    return;
  }
  int geo = request->kind == NARSIL_MERGE_GEO;
  double *values = output->regions[geo ? 1 : 0].data;
  uint32_t *ordinals = output->regions[geo ? 3 : 1].data;
  for (size_t at = 0; at < scratch->row_count; at++) {
    const field_merge_row *row = scratch->rows + at;
    memcpy(values + at, &row->value, sizeof *values);
    ordinals[at] = row->ordinal;
    if (geo) {
      uint64_t *codes = output->regions[0].data;
      double *longitude = output->regions[2].data;
      codes[at] = row->code;
      longitude[at] = row->longitude;
    }
  }
}
