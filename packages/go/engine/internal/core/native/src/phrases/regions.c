#include "internal.h"

#include "../../include/narsil_phrases.h"
#include "../regions.h"
#include "../work/tally.h"

#include <stddef.h>
#include <stdint.h>

enum { WRITE_REGIONS = 7, READ_REGIONS = 7, POSTING_REGIONS = 5 };

size_t phrase_bitmap_words(uint32_t count) {
  size_t words = (size_t)(count / PHRASE_WORD_BITS) + (count % PHRASE_WORD_BITS != 0);
  return words == 0 ? 1 : words;
}

static int read_region(const void *pointer, size_t count, size_t width, const memory_region *writes) {
  memory_region read;
  if ((count > 0 && (uintptr_t)pointer % width != 0) || !region_of(pointer, count, width, &read)) { return 0; }
  for (size_t at = 0; at < WRITE_REGIONS; at++) {
    if (overlaps(read, writes[at])) { return 0; }
  }
  return 1;
}

static int descriptors(const narsil_phrase_request *request, const narsil_phrase_output *output,
                       const memory_region *writes) {
  memory_region metadata[3];
  if (!region_of(request, 1, sizeof *request, &metadata[0]) || !region_of(output, 1, sizeof *output, &metadata[1]) ||
      !region_of(request->postings, request->token_count, sizeof *request->postings, &metadata[2])) {
    return 0;
  }
  for (size_t at = 0; at < WRITE_REGIONS; at++) {
    for (size_t input = 0; input < 3; input++) {
      if (overlaps(writes[at], metadata[input])) { return 0; }
    }
  }
  return 1;
}

static int posting_regions(const narsil_phrase_request *request, const memory_region *writes) {
  for (size_t token = 0; token < request->token_count; token++) {
    const narsil_phrase_postings *list = request->postings + token;
    if (list->count > UINT32_MAX || list->position_count > UINT32_MAX) { return 0; }
    const void *regions[POSTING_REGIONS] = {list->documents, list->fields, list->position_starts, list->position_counts,
                                            list->positions};
    const size_t sizes[POSTING_REGIONS] = {list->count, list->count, list->count, list->count, list->position_count};
    const size_t types[POSTING_REGIONS] = {sizeof(uint32_t), sizeof(uint16_t), sizeof(uint32_t), sizeof(uint32_t),
                                           sizeof(uint32_t)};
    for (size_t at = 0; at < POSTING_REGIONS; at++) {
      if (!read_region(regions[at], sizes[at], types[at], writes)) { return 0; }
    }
  }
  return 1;
}

int phrase_regions(const narsil_phrase_request *request, const narsil_phrase_output *output, uint32_t *count) {
  if (request == NULL || output == NULL || (uintptr_t)request % _Alignof(narsil_phrase_request) != 0 ||
      (uintptr_t)output % _Alignof(narsil_phrase_output) != 0 || request->token_count > UINT32_MAX ||
      request->phrase_count > UINT32_MAX || request->phrase_count == SIZE_MAX || request->entry_count > UINT32_MAX ||
      (request->token_count > 0 &&
       (request->postings == NULL || (uintptr_t)request->postings % _Alignof(narsil_phrase_postings) != 0)) ||
      !work_meter_valid(&request->meter)) {
    return 0;
  }
  memory_region writes[WRITE_REGIONS];
  void *pointers[WRITE_REGIONS] = {output->matched,     output->starts, output->documents,   output->fields,
                                   output->frequencies, count,          request->meter.spent};
  const size_t lengths[WRITE_REGIONS] = {output->matched_words,
                                         output->start_capacity,
                                         output->document_capacity,
                                         output->field_capacity,
                                         output->frequency_capacity,
                                         1,
                                         1};
  const size_t widths[WRITE_REGIONS] = {sizeof(uint32_t), sizeof(uint32_t), sizeof(uint32_t), sizeof(uint16_t),
                                        sizeof(uint32_t), sizeof(uint32_t), sizeof(int64_t)};
  for (size_t at = 0; at < WRITE_REGIONS; at++) {
    if ((lengths[at] > 0 && (uintptr_t)pointers[at] % widths[at] != 0) ||
        !region_of(pointers[at], lengths[at], widths[at], &writes[at])) {
      return 0;
    }
    for (size_t previous = 0; previous < at; previous++) {
      if (overlaps(writes[at], writes[previous])) { return 0; }
    }
  }
  if (!descriptors(request, output, writes)) { return 0; }
  const void *inputs[READ_REGIONS] = {request->starts, request->tokens,  request->offsets,   request->searchable,
                                      request->filter, request->removed, request->meter.stop};
  const size_t input_lengths[READ_REGIONS] = {request->phrase_count + 1,
                                              request->entry_count,
                                              request->entry_count,
                                              request->field_count,
                                              request->filter_words,
                                              request->removed_words,
                                              1};
  const size_t input_widths[READ_REGIONS] = {sizeof(uint32_t), sizeof(uint32_t), sizeof(uint32_t), sizeof(uint8_t),
                                             sizeof(uint32_t), sizeof(uint32_t), sizeof(uint32_t)};
  for (size_t at = 0; at < READ_REGIONS; at++) {
    if (!read_region(inputs[at], input_lengths[at], input_widths[at], writes)) { return 0; }
  }
  return posting_regions(request, writes);
}

int phrase_row_valid(const narsil_phrase_request *request, const narsil_phrase_postings *list, uint32_t row) {
  size_t start = list->position_starts[row];
  size_t count = list->position_counts[row];
  return list->documents[row] < request->ordinal_count && list->fields[row] < request->field_count &&
         start <= list->position_count && count <= list->position_count - start;
}

int phrase_shape(const narsil_phrase_request *request) {
  size_t words = phrase_bitmap_words(request->ordinal_count);
  if (request->field_count > (uint32_t)UINT16_MAX + 1 || (request->collect != 0 && request->collect != 1) ||
      request->removed_words != words ||
      (request->filter == NULL ? request->filter_words != 0 : request->filter_words != words) ||
      request->starts[0] != 0 || request->starts[request->phrase_count] != request->entry_count) {
    return 0;
  }
  for (size_t at = 0; at < request->phrase_count; at++) {
    if (request->starts[at] >= request->starts[at + 1]) { return 0; }
  }
  for (size_t at = 0; at < request->entry_count; at++) {
    if (request->tokens[at] >= request->token_count) { return 0; }
  }
  for (size_t at = 0; at < request->field_count; at++) {
    if (request->searchable[at] > 1) { return 0; }
  }
  for (size_t at = 0; at < request->token_count; at++) {
    int ordered = request->postings[at].ordered;
    if (ordered != 0 && ordered != 1) { return 0; }
  }
  return 1;
}
