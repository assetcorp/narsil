#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_phrases.h"
#include "../work/tally.h"
#include "scratch.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static narsil_status capacity(const narsil_phrase_request *request, const narsil_phrase_output *output) {
  if (output->matched_words < phrase_bitmap_words(request->ordinal_count) ||
      output->start_capacity < request->phrase_count + 1) {
    return NARSIL_NEEDS_ROOM;
  }
  if (!request->collect) { return NARSIL_OK; }
  size_t rows = 0;
  for (size_t phrase = 0; phrase < request->phrase_count; phrase++) {
    size_t least = SIZE_MAX;
    for (size_t entry = request->starts[phrase]; entry < request->starts[phrase + 1]; entry++) {
      size_t count = request->postings[request->tokens[entry]].count;
      if (count < least) { least = count; }
    }
    if (least > UINT32_MAX - rows) { return NARSIL_OUT_OF_MEMORY; }
    rows += least;
  }
  return rows > output->document_capacity || rows > output->field_capacity || rows > output->frequency_capacity
             ? NARSIL_NEEDS_ROOM
             : NARSIL_OK;
}

static void publish(const phrase_scratch *scratch, const narsil_phrase_request *request,
                    const narsil_phrase_output *output, uint32_t *row_count) {
  uint32_t rows = 0;
  for (size_t phrase = 0; phrase < request->phrase_count; phrase++) {
    output->starts[phrase] = rows;
    size_t count = scratch->row_counts.values[phrase];
    size_t from = scratch->row_starts.values[phrase];
    if (count > 0) {
      memmove(output->documents + rows, output->documents + from, count * sizeof *output->documents);
      memmove(output->fields + rows, output->fields + from, count * sizeof *output->fields);
      memmove(output->frequencies + rows, output->frequencies + from, count * sizeof *output->frequencies);
      rows += (uint32_t)count;
    }
  }
  output->starts[request->phrase_count] = rows;
  size_t words = phrase_bitmap_words(request->ordinal_count);
  memcpy(output->matched, scratch->matched.values, words * sizeof *output->matched);
  uint32_t remainder = request->ordinal_count % PHRASE_WORD_BITS;
  if (request->ordinal_count == 0) {
    output->matched[0] = 0;
  } else if (remainder != 0) {
    output->matched[words - 1] &= (UINT32_C(1) << remainder) - 1;
  }
  *row_count = rows;
}

narsil_status narsil_match_phrases(narsil_workspace *workspace, const narsil_phrase_request *request,
                                   const narsil_phrase_output *output, uint32_t *row_count) {
  if (workspace == NULL || !phrase_regions(request, output, row_count) || !phrase_shape(request)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = capacity(request, output);
  if (status != NARSIL_OK) { return status; }
  work_tally tally;
  status = work_tally_begin(&tally, &request->meter);
  if (status != NARSIL_OK) { return status; }
  phrase_scratch *scratch = workspace_phrase_scratch(workspace);
  int missing = 0;
  status = phrase_prepare(scratch, request, &tally, &missing);
  if (status == NARSIL_OK && !missing) { status = phrase_collect(scratch, request, output, &tally); }
  if (status != NARSIL_OK) { return status; }
  publish(scratch, request, output, row_count);
  return NARSIL_OK;
}
