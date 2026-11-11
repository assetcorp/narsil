#include "scratch.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_highlight.h"
#include "../analysis/split.h"
#include "../analysis/text.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static int order_spans(const narsil_span *first, const narsil_span *second) {
  if (first->start != second->start) { return first->start < second->start ? -1 : 1; }
  return (first->length > second->length) - (first->length < second->length);
}

static int compare_spans(const void *first, const void *second) { return order_spans(first, second); }

static void merge_spans(narsil_spans *spans) {
  if (spans->length == 0) { return; }
  qsort(spans->spans, spans->length, sizeof *spans->spans, compare_spans);
  size_t count = 1;
  for (size_t at = 1; at < spans->length; at++) {
    narsil_span next = spans->spans[at];
    narsil_span *previous = spans->spans + count - 1;
    uint32_t end = previous->start + previous->length;
    if (next.start <= end) {
      uint32_t next_end = next.start + next.length;
      if (next_end > end) { previous->length = next_end - previous->start; }
    } else {
      spans->spans[count++] = next;
    }
  }
  spans->length = count;
}

static int splits_pair(narsil_highlight_text text, size_t index) {
  return index > 0 && index < text.length && text.units[index - 1] >= NARSIL_HIGH_SURROGATE_FIRST &&
         text.units[index - 1] < NARSIL_LOW_SURROGATE_FIRST && text.units[index] >= NARSIL_LOW_SURROGATE_FIRST &&
         text.units[index] < NARSIL_SURROGATE_END;
}

static narsil_span select_window(const narsil_spans *spans, const narsil_highlight_request *request) {
  size_t length = request->text.length;
  size_t maximum = request->maximum;
  if (maximum == 0 || length <= maximum) { return (narsil_span){0, (uint32_t)length}; }
  size_t best = 0;
  size_t best_count = 0;
  size_t first = 0;
  size_t last = 0;
  for (size_t at = 0; at < spans->length; at++) {
    size_t position = spans->spans[at].start;
    size_t start = position > maximum / 2 ? position - (maximum / 2) : 0;
    size_t end = length - start < maximum ? length : start + maximum;
    start = end > maximum ? end - maximum : 0;
    while (first < spans->length && spans->spans[first].start < start) { first++; }
    if (last < first) { last = first; }
    while (last < spans->length && spans->spans[last].start + spans->spans[last].length <= end) { last++; }
    if (last - first > best_count) {
      best = start;
      best_count = last - first;
    }
  }
  size_t end = length - best < maximum ? length : best + maximum;
  if (splits_pair(request->text, best)) { best--; }
  if (splits_pair(request->text, end)) { end++; }
  return (narsil_span){(uint32_t)best, (uint32_t)(end - best)};
}

static narsil_status append(narsil_text *target, narsil_highlight_text text) {
  return (narsil_status)narsil_text_append(target, text.units, text.length);
}

static narsil_status assemble(highlight_scratch *scratch, const narsil_highlight_request *request, narsil_span window) {
  static const uint16_t dots[] = {'.', '.', '.'};
  narsil_text *snippet = &scratch->snippet;
  snippet->length = 0;
  narsil_status status = NARSIL_OK;
  if (window.start > 0) { status = append(snippet, (narsil_highlight_text){dots, 3}); }
  size_t from = window.start;
  size_t end = window.start + window.length;
  size_t retained = 0;
  for (size_t at = 0; status == NARSIL_OK && at < scratch->marked.length; at++) {
    narsil_span span = scratch->marked.spans[at];
    if (span.start < window.start || span.start + span.length > end) { continue; }
    status = append(snippet, (narsil_highlight_text){request->text.units + from, span.start - from});
    if (status == NARSIL_OK) { status = append(snippet, request->pre_tag); }
    if (status == NARSIL_OK) {
      status = append(snippet, (narsil_highlight_text){request->text.units + span.start, span.length});
    }
    if (status == NARSIL_OK) { status = append(snippet, request->post_tag); }
    from = span.start + span.length;
    scratch->marked.spans[retained++] = span;
  }
  scratch->marked.length = retained;
  if (status == NARSIL_OK && end > from) {
    status = append(snippet, (narsil_highlight_text){request->text.units + from, end - from});
  }
  if (status == NARSIL_OK && end < request->text.length) { status = append(snippet, (narsil_highlight_text){dots, 3}); }
  return status;
}

narsil_status highlight_render(highlight_scratch *scratch, const narsil_highlight_request *request,
                               const narsil_highlight_output *output, uint32_t *count) {
  merge_spans(&scratch->marked);
  narsil_status status = assemble(scratch, request, select_window(&scratch->marked, request));
  if (status != NARSIL_OK) { return status; }
  if (scratch->snippet.length > UINT32_MAX || scratch->marked.length > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
  if (scratch->snippet.length > output->snippet_capacity || scratch->marked.length > output->position_words / 2) {
    return NARSIL_NEEDS_ROOM;
  }
  if (scratch->snippet.length > 0) {
    memcpy(output->snippet, scratch->snippet.units, scratch->snippet.length * sizeof *output->snippet);
  }
  for (size_t at = 0; at < scratch->marked.length; at++) {
    output->positions[at * 2] = scratch->marked.spans[at].start;
    output->positions[(at * 2) + 1] = scratch->marked.spans[at].start + scratch->marked.spans[at].length;
  }
  *output->snippet_length = (uint32_t)scratch->snippet.length;
  *count = (uint32_t)scratch->marked.length;
  return NARSIL_OK;
}
