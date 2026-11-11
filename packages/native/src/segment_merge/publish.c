#include "internal.h"

#include "../../include/narsil_frozen_segments.h"
#include "../../include/narsil_segment_merge.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static void publish_strings(const merge_string *entries, size_t count, const narsil_merged_strings *output) {
  size_t written = 0;
  output->offsets[0] = 0;
  for (size_t at = 0; at < count; at++) {
    const merge_string *entry = entries + at;
    memcpy(output->text + written, entry->spelling.bytes, entry->spelling.length);
    written += entry->spelling.length;
    output->offsets[(at * 2) + 1] = (uint32_t)written;
    memcpy(output->text + written, entry->token.bytes, entry->token.length);
    written += entry->token.length;
    output->offsets[(at * 2) + 2] = (uint32_t)written;
    output->counts[at] = entry->count;
  }
}

static uint32_t publish_rows(const segment_merge_scratch *scratch, const narsil_keyword_merge_output *output,
                             size_t *posting_at, size_t *position_at) {
  uint32_t documents = 0;
  uint32_t previous = UINT32_MAX;
  for (size_t at = 0; at < scratch->row_count; at++) {
    const merge_posting *row = scratch->rows + at;
    const narsil_keyword_merge_input *input = row->input;
    output->posting_documents[*posting_at] = row->target;
    output->posting_frequencies[*posting_at] = row->frequency;
    output->posting_fields[*posting_at] = input->field_mapping[row->field];
    if (row->target != previous) { documents++; }
    previous = row->target;
    if (scratch->sizes.has_positions != 0) {
      output->position_offsets[*posting_at] = (uint32_t)*position_at;
      if (row->position_count > 0) {
        memcpy(output->position_values + *position_at, row->positions + row->position_start,
               (size_t)row->position_count * sizeof *output->position_values);
        *position_at += row->position_count;
      }
    }
    (*posting_at)++;
  }
  return documents;
}

static void publish_postings(segment_merge_scratch *scratch, const narsil_keyword_merge_output *output) {
  size_t term_at = 0;
  size_t text_at = 0;
  size_t posting_at = 0;
  size_t position_at = 0;
  output->terms.offsets[0] = 0;
  output->posting_offsets[0] = 0;
  for (size_t start = 0; start < scratch->term_count;) {
    size_t end = start + 1;
    while (end < scratch->term_count &&
           segment_merge_compare_text(scratch->terms[start].text, scratch->terms[end].text) == 0) {
      end++;
    }
    if (scratch->terms[start].target != UINT32_MAX) {
      segment_merge_fill_rows(scratch, start, end);
      merge_text text = scratch->terms[start].text;
      memcpy(output->terms.text + text_at, text.bytes, text.length);
      text_at += text.length;
      output->terms.counts[term_at] = publish_rows(scratch, output, &posting_at, &position_at);
      output->terms.offsets[++term_at] = (uint32_t)text_at;
      output->posting_offsets[term_at] = (uint32_t)posting_at;
    }
    start = end;
  }
  if (scratch->sizes.has_positions != 0) { output->position_offsets[posting_at] = (uint32_t)position_at; }
}

static void publish_lengths(const narsil_keyword_merge_request *request, const narsil_keyword_merge_output *output) {
  size_t count = (size_t)request->field_count * request->document_count;
  if (count > 0) { memset(output->field_lengths, 0, count * sizeof *output->field_lengths); }
  for (size_t field = 0; field < request->field_count; field++) { output->total_field_lengths[field] = 0; }
  for (size_t at = 0; at < request->input_count; at++) {
    const narsil_keyword_merge_input *input = request->inputs + at;
    for (size_t field = 0; field < input->field_count; field++) {
      const uint32_t *lengths = input->field_lengths[field];
      if (lengths == NULL) { continue; }
      uint16_t target_field = input->field_mapping[field];
      size_t base = (size_t)target_field * request->document_count;
      for (size_t ordinal = 0; ordinal < input->document_count; ordinal++) {
        uint32_t target = input->mapping[ordinal];
        if (target == UINT32_MAX) { continue; }
        output->field_lengths[base + target] = lengths[ordinal];
        output->total_field_lengths[target_field] += lengths[ordinal];
      }
    }
  }
}

void segment_merge_publish(segment_merge_scratch *scratch, const narsil_keyword_merge_request *request,
                           const narsil_keyword_merge_output *output) {
  if (request->retained_terms == NULL) {
    publish_postings(scratch, output);
  } else {
    const narsil_frozen_strings *terms = request->retained_terms;
    if (terms->text_bytes > 0) { memcpy(output->terms.text, terms->text, terms->text_bytes); }
    memcpy(output->terms.offsets, terms->offsets, (terms->count + 1) * sizeof *terms->offsets);
    if (terms->count > 0) { memcpy(output->terms.counts, terms->counts, terms->count * sizeof *terms->counts); }
    memset(output->posting_offsets, 0, (terms->count + 1) * sizeof *output->posting_offsets);
  }
  publish_strings(scratch->surfaces, scratch->surface_count, &output->surfaces);
  publish_strings(scratch->spellings, scratch->spelling_count, &output->spellings);
  publish_lengths(request, output);
}
