#include "internal.h"

#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segment_merge.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

static int input_region(const segment_regions *regions, const void *pointer, size_t count, size_t width) {
  return (count == 0 || (uintptr_t)pointer % width == 0) && segment_region_input(regions, pointer, count, width);
}

static int strings(const segment_regions *regions, const narsil_frozen_strings *table, size_t stride) {
  if (table == NULL || (uintptr_t)table % _Alignof(narsil_frozen_strings) != 0 || table->count > UINT32_MAX ||
      table->text_bytes > UINT32_MAX || table->count > (SIZE_MAX - 1) / stride) {
    return 0;
  }
  return segment_region_input(regions, table, 1, sizeof *table) &&
         input_region(regions, table->text, table->text_bytes, sizeof *table->text) &&
         input_region(regions, table->offsets, (table->count * stride) + 1, sizeof *table->offsets) &&
         input_region(regions, table->counts, table->count, sizeof *table->counts);
}

static int postings(const segment_regions *regions, const narsil_keyword_merge_input *input) {
  if (input->posting_count > UINT32_MAX || input->posting_count == SIZE_MAX || input->position_count > UINT32_MAX ||
      input->terms.count == SIZE_MAX) {
    return 0;
  }
  return strings(regions, &input->terms, 1) &&
         input_region(regions, input->payload_slots, input->terms.count, sizeof *input->payload_slots) &&
         input_region(regions, input->posting_offsets, input->terms.count + 1, sizeof *input->posting_offsets) &&
         input_region(regions, input->posting_documents, input->posting_count, sizeof *input->posting_documents) &&
         input_region(regions, input->posting_frequencies, input->posting_count, sizeof *input->posting_frequencies) &&
         input_region(regions, input->posting_fields, input->posting_count, sizeof *input->posting_fields) &&
         (input->position_offsets == NULL ? input->position_values == NULL && input->position_count == 0
                                          : input_region(regions, input->position_offsets, input->posting_count + 1,
                                                         sizeof *input->position_offsets) &&
                                                input_region(regions, input->position_values, input->position_count,
                                                             sizeof *input->position_values));
}

static int growing(const segment_regions *regions, const narsil_keyword_merge_input *input) {
  segment_regions source = {0};
  if (!segment_write_regions(&source, input->growing) || input->document_count > input->growing->ordinal_capacity ||
      input->field_count != input->growing->field_count) {
    return 0;
  }
  for (size_t at = 0; at < source.write_count; at++) {
    for (size_t output = 0; output < regions->write_count; output++) {
      if (overlaps(source.writes[at], regions->writes[output])) { return 0; }
    }
  }
  for (size_t at = 0; at < source.read_count; at++) {
    for (size_t output = 0; output < regions->write_count; output++) {
      if (overlaps(source.reads[at], regions->writes[output])) { return 0; }
    }
  }
  return 1;
}

static int input(const segment_regions *regions, const narsil_keyword_merge_input *source) {
  if (source->field_count > (uint32_t)UINT16_MAX + 1 ||
      !(source->growing == NULL ? postings(regions, source) : growing(regions, source)) ||
      !input_region(regions, source->mapping, source->document_count, sizeof *source->mapping) ||
      !input_region(regions, source->field_mapping, source->field_count, sizeof *source->field_mapping) ||
      !input_region(regions, (const void *)source->field_lengths, source->field_count, sizeof *source->field_lengths) ||
      (source->surfaces != NULL && !strings(regions, source->surfaces, 2)) ||
      (source->spellings != NULL && !strings(regions, source->spellings, 2))) {
    return 0;
  }
  for (size_t field = 0; field < source->field_count; field++) {
    if (source->field_lengths[field] != NULL &&
        !input_region(regions, source->field_lengths[field], source->document_count, sizeof(uint32_t))) {
      return 0;
    }
  }
  return 1;
}

int segment_merge_inputs(const narsil_keyword_merge_request *request, const segment_regions *regions) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_keyword_merge_request) != 0 ||
      request->field_count > (uint32_t)UINT16_MAX + 1 ||
      (request->input_count > 0 && (uintptr_t)request->inputs % _Alignof(narsil_keyword_merge_input) != 0) ||
      !segment_region_input(regions, request, 1, sizeof *request) ||
      !segment_region_input(regions, request->inputs, request->input_count, sizeof *request->inputs) ||
      (request->retained_terms != NULL && !strings(regions, request->retained_terms, 1))) {
    return 0;
  }
  for (size_t at = 0; at < request->input_count; at++) {
    if (!input(regions, request->inputs + at)) { return 0; }
  }
  return 1;
}

static int output_strings(segment_regions *regions, const narsil_merged_strings *table) {
  return segment_region_write(regions, table->text, table->text_capacity, sizeof *table->text) &&
         segment_region_write(regions, table->offsets, table->offset_capacity, sizeof *table->offsets) &&
         segment_region_write(regions, table->counts, table->count_capacity, sizeof *table->counts);
}

int segment_merge_outputs(const narsil_keyword_merge_request *request, const narsil_keyword_merge_output *output,
                          segment_regions *regions) {
  if (output == NULL || (uintptr_t)output % _Alignof(narsil_keyword_merge_output) != 0 ||
      !output_strings(regions, &output->terms) || !output_strings(regions, &output->surfaces) ||
      !output_strings(regions, &output->spellings) ||
      !segment_region_write(regions, output->posting_offsets, output->posting_offset_capacity,
                            sizeof *output->posting_offsets) ||
      !segment_region_write(regions, output->posting_documents, output->posting_capacity,
                            sizeof *output->posting_documents) ||
      !segment_region_write(regions, output->posting_frequencies, output->posting_capacity,
                            sizeof *output->posting_frequencies) ||
      !segment_region_write(regions, output->posting_fields, output->posting_capacity,
                            sizeof *output->posting_fields) ||
      !segment_region_write(regions, output->position_offsets, output->position_offset_capacity,
                            sizeof *output->position_offsets) ||
      !segment_region_write(regions, output->position_values, output->position_capacity,
                            sizeof *output->position_values) ||
      !segment_region_write(regions, output->field_lengths, output->field_length_capacity,
                            sizeof *output->field_lengths) ||
      !segment_region_write(regions, output->total_field_lengths, output->field_count,
                            sizeof *output->total_field_lengths)) {
    return 0;
  }
  for (size_t at = 0; at < regions->write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions->writes[at], regions->writes[before])) { return 0; }
    }
  }
  return segment_region_input(regions, output, 1, sizeof *output) && segment_merge_inputs(request, regions);
}
