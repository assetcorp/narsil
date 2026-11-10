#include "regions.h"

#include "../regions.h"

#include "../../include/narsil_keyword.h"

#include <stddef.h>
#include <stdint.h>

enum { ORDINALS, SCORES, MATCHED, COUNT, TOTAL_MATCHED, SCORING_PATH, OUTPUT_COUNT };

static int valid_input(const void *pointer, size_t count, size_t width, const memory_region *outputs,
                       size_t output_count) {
  memory_region input;
  if (!region_of(pointer, count, width, &input)) { return 0; }
  for (size_t index = 0; index < output_count; index++) {
    if (overlaps(input, outputs[index])) { return 0; }
  }
  return 1;
}

static int output_regions(const narsil_keyword_request *request, const narsil_keyword_output *output,
                          memory_region *outputs) {
  if (!region_of(output->ordinals, output->length, sizeof *output->ordinals, &outputs[ORDINALS]) ||
      !region_of(output->scores, output->length, sizeof *output->scores, &outputs[SCORES]) ||
      !region_of(output->matched, request->collect ? output->matched_words : 0, sizeof *output->matched,
                 &outputs[MATCHED]) ||
      !region_of(&output->count, 1, sizeof output->count, &outputs[COUNT]) ||
      !region_of(&output->total_matched, 1, sizeof output->total_matched, &outputs[TOTAL_MATCHED]) ||
      !region_of(&output->scoring_path, 1, sizeof output->scoring_path, &outputs[SCORING_PATH])) {
    return 0;
  }
  for (size_t target = 0; target < OUTPUT_COUNT; target++) {
    for (size_t prior = 0; prior < target; prior++) {
      if (overlaps(outputs[target], outputs[prior])) { return 0; }
    }
  }
  return 1;
}

static int inputs_are_disjoint(const narsil_keyword_request *request, const memory_region *outputs,
                               size_t output_count) {
  if (!valid_input(request->pool_doc_ids, request->pool_length, sizeof *request->pool_doc_ids, outputs, output_count) ||
      !valid_input(request->pool_frequencies, request->pool_length, sizeof *request->pool_frequencies, outputs,
                   output_count) ||
      !valid_input(request->pool_fields, request->pool_length, sizeof *request->pool_fields, outputs, output_count) ||
      !valid_input(request->row_doc_ids, request->row_length, sizeof *request->row_doc_ids, outputs, output_count) ||
      !valid_input(request->row_frequencies, request->row_length, sizeof *request->row_frequencies, outputs,
                   output_count) ||
      !valid_input(request->row_fields, request->row_length, sizeof *request->row_fields, outputs, output_count) ||
      !valid_input(request->slots, request->slot_count, sizeof *request->slots * NARSIL_KEYWORD_SLOT_STRIDE, outputs,
                   output_count) ||
      !valid_input(request->lists, request->list_capacity, sizeof *request->lists * NARSIL_KEYWORD_LIST_STRIDE, outputs,
                   output_count) ||
      !valid_input(request->list_values, request->list_capacity,
                   sizeof *request->list_values * NARSIL_KEYWORD_LIST_VALUE_STRIDE, outputs, output_count) ||
      !valid_input(request->slot_values, request->slot_value_capacity, sizeof *request->slot_values, outputs,
                   output_count) ||
      !valid_input(request->searchable, request->field_count, sizeof *request->searchable, outputs, output_count) ||
      !valid_input(request->partial_marks, request->field_count, sizeof *request->partial_marks, outputs,
                   output_count) ||
      !valid_input(request->name_ranks, request->field_count, sizeof *request->name_ranks, outputs, output_count) ||
      !valid_input(request->field_numbers, request->field_count,
                   sizeof *request->field_numbers * NARSIL_KEYWORD_FIELD_NUMBER_COLUMNS, outputs, output_count) ||
      !valid_input(request->lengths, request->field_count, sizeof *request->lengths, outputs, output_count) ||
      !valid_input(request->filter, request->has_filter ? request->filter_words : 0, sizeof *request->filter, outputs,
                   output_count) ||
      !valid_input(request->live, request->live_words, sizeof *request->live, outputs, output_count) ||
      !valid_input(request->removed, request->removed_words, sizeof *request->removed, outputs, output_count)) {
    return 0;
  }
  for (uint32_t field = 0; field < request->field_count; field++) {
    narsil_keyword_column column = request->lengths[field];
    if (!valid_input(column.values, column.length, sizeof *column.values, outputs, output_count)) { return 0; }
  }
  return 1;
}

int keyword_regions_are_disjoint(const narsil_keyword_request *request, const narsil_keyword_output *output) {
  memory_region outputs[OUTPUT_COUNT];
  return output_regions(request, output, outputs) && inputs_are_disjoint(request, outputs, OUTPUT_COUNT);
}

int keyword_binding_regions_are_disjoint(const narsil_keyword_request *request, const narsil_keyword_output *output,
                                         const double *settings, size_t settings_count, const double *outcome,
                                         size_t outcome_count) {
  memory_region outputs[OUTPUT_COUNT + 1];
  if (!output_regions(request, output, outputs) ||
      !region_of(outcome, outcome_count, sizeof *outcome, &outputs[OUTPUT_COUNT]) ||
      !valid_input(outcome, outcome_count, sizeof *outcome, outputs, OUTPUT_COUNT) ||
      !valid_input(settings, settings_count, sizeof *settings, outputs, OUTPUT_COUNT + 1)) {
    return 0;
  }
  return inputs_are_disjoint(request, &outputs[OUTPUT_COUNT], 1);
}
