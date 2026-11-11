#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_posting_merge.h"
#include "../../include/narsil_segment_merge.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int output_regions(const narsil_keyword_merge_request *request, const narsil_posting_merge_output *output,
                          uint32_t *count) {
  if (output == NULL || (uintptr_t)output % _Alignof(narsil_posting_merge_output) != 0) { return 0; }
  segment_regions regions = {0};
  if (!segment_region_write(&regions, output->documents, output->row_capacity, sizeof *output->documents) ||
      !segment_region_write(&regions, output->frequencies, output->row_capacity, sizeof *output->frequencies) ||
      !segment_region_write(&regions, output->fields, output->row_capacity, sizeof *output->fields) ||
      !segment_region_write(&regions, output->position_offsets, output->offset_capacity,
                            sizeof *output->position_offsets) ||
      !segment_region_write(&regions, output->positions, output->position_capacity, sizeof *output->positions) ||
      !segment_region_write(&regions, output->totals, output->total_capacity, sizeof *output->totals) ||
      !segment_region_write(&regions, count, 1, sizeof *count) ||
      !segment_region_input(&regions, output, 1, sizeof *output) || !segment_merge_inputs(request, &regions)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  return 1;
}

static int order_rows(const merge_posting *first, const merge_posting *second) {
  if (first->target != second->target) { return first->target < second->target ? -1 : 1; }
  uint16_t first_field = first->input->field_mapping[first->field];
  uint16_t second_field = second->input->field_mapping[second->field];
  if (first_field != second_field) { return first_field < second_field ? -1 : 1; }
  if (first->source != second->source) { return first->source < second->source ? -1 : 1; }
  return first->row < second->row ? -1 : first->row > second->row;
}

static int compare_rows(const void *first, const void *second) { return order_rows(first, second); }

static int valid_row(size_t row, const narsil_keyword_merge_input *input, uint32_t fields) {
  uint32_t document = input->posting_documents[row];
  uint16_t field = input->posting_fields[row];
  if (document >= input->document_count || field >= input->field_count || input->field_mapping[field] >= fields) {
    return 0;
  }
  if (input->position_offsets == NULL) { return 1; }
  uint32_t start = input->position_offsets[row];
  uint32_t end = input->position_offsets[row + 1];
  if (start > end || end > input->position_count) { return 0; }
  for (size_t at = (size_t)start + 1; at < end; at++) {
    if (input->position_values[at] < input->position_values[at - 1]) { return 0; }
  }
  return 1;
}

static narsil_status collect(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request) {
  size_t capacity = 0;
  for (size_t source = 0; source < request->input_count; source++) {
    const narsil_keyword_merge_input *input = request->inputs + source;
    if (input->growing != NULL || input->posting_count > UINT32_MAX - capacity) { return NARSIL_INVALID_ARGUMENT; }
    capacity += input->posting_count;
  }
  void *allocation = scratch->rows;
  narsil_status status = segment_merge_reserve(&allocation, capacity, &scratch->row_capacity, sizeof *scratch->rows);
  scratch->rows = allocation;
  if (status != NARSIL_OK) { return status; }
  scratch->row_count = 0;
  int ordered = 1;
  for (size_t source = 0; source < request->input_count; source++) {
    const narsil_keyword_merge_input *input = request->inputs + source;
    merge_term term = {.input = input, .source = source};
    for (size_t row = 0; row < input->posting_count; row++) {
      if (!valid_row(row, input, request->field_count)) { return NARSIL_INVALID_ARGUMENT; }
      uint32_t document = input->posting_documents[row];
      if (input->mapping[document] == UINT32_MAX) { continue; }
      if (input->mapping[document] >= request->document_count) { return NARSIL_INVALID_ARGUMENT; }
      merge_posting posting;
      if (segment_merge_source_posting(&term, (uint32_t)row, &posting) != 1) { return NARSIL_INVALID_ARGUMENT; }
      if (scratch->row_count > 0 && order_rows(scratch->rows + scratch->row_count - 1, &posting) > 0) { ordered = 0; }
      scratch->rows[scratch->row_count++] = posting;
    }
  }
  if (!ordered) { qsort(scratch->rows, scratch->row_count, sizeof *scratch->rows, compare_rows); }
  return NARSIL_OK;
}

typedef struct {
  uint32_t positions;
  uint32_t documents;
  double frequency;
} posting_totals;

static narsil_status measure(const segment_merge_scratch *scratch, posting_totals *totals) {
  for (size_t at = 0; at < scratch->row_count; at++) {
    const merge_posting *row = scratch->rows + at;
    if (row->position_count > UINT32_MAX - totals->positions) { return NARSIL_INVALID_ARGUMENT; }
    totals->positions += row->position_count;
    totals->frequency += row->frequency;
    if (at == 0 || row->target != scratch->rows[at - 1].target) {
      totals->documents++;
    } else {
      const merge_posting *previous = scratch->rows + at - 1;
      if (row->source != previous->source ||
          row->input->posting_documents[row->row] != previous->input->posting_documents[previous->row] ||
          row->input->field_mapping[row->field] == previous->input->field_mapping[previous->field]) {
        return NARSIL_INVALID_ARGUMENT;
      }
    }
  }
  return NARSIL_OK;
}

narsil_status narsil_merge_postings(narsil_workspace *workspace, const narsil_keyword_merge_request *request,
                                    const narsil_posting_merge_output *output, uint32_t *count) {
  if (workspace == NULL || !output_regions(request, output, count)) { return NARSIL_INVALID_ARGUMENT; }
  if (request->retained_terms != NULL) { return NARSIL_INVALID_ARGUMENT; }
  segment_merge_scratch *scratch = workspace_segment_merge_scratch(workspace);
  narsil_status status = collect(scratch, request);
  if (status != NARSIL_OK) { return status; }
  posting_totals totals = {0};
  status = measure(scratch, &totals);
  if (status != NARSIL_OK) { return status; }
  if (scratch->row_count > output->row_capacity || scratch->row_count >= output->offset_capacity ||
      totals.positions > output->position_capacity || output->total_capacity < 2) {
    return NARSIL_NEEDS_ROOM;
  }
  size_t next = 0;
  for (size_t at = 0; at < scratch->row_count; at++) {
    const merge_posting *row = scratch->rows + at;
    output->documents[at] = row->target;
    output->frequencies[at] = row->frequency;
    output->fields[at] = row->input->field_mapping[row->field];
    output->position_offsets[at] = (uint32_t)next;
    if (row->position_count > 0) {
      memcpy(output->positions + next, row->positions + row->position_start,
             (size_t)row->position_count * sizeof *output->positions);
      next += row->position_count;
    }
  }
  output->position_offsets[scratch->row_count] = (uint32_t)next;
  output->totals[0] = totals.documents;
  output->totals[1] = totals.frequency;
  *count = (uint32_t)scratch->row_count;
  return NARSIL_OK;
}
