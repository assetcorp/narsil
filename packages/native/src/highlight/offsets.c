#include "scratch.h"

#include "../../include/narsil_core.h"
#include "../allocation.h"
#include "../analysis/normalise.h"
#include "../analysis/split.h"
#include "../analysis/text.h"
#include "../analysis/unicode.h"

#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

enum { FIRST_ORIGINS = 64 };

static narsil_status append_origin(highlight_scratch *scratch, uint32_t point, uint32_t start, uint32_t end) {
  if (scratch->origin_count == scratch->origin_capacity) {
    if (scratch->origin_capacity > SIZE_MAX / 2) { return NARSIL_OUT_OF_MEMORY; }
    size_t capacity = scratch->origin_capacity == 0 ? FIRST_ORIGINS : scratch->origin_capacity * 2;
    if (capacity > SIZE_MAX / sizeof *scratch->origins) { return NARSIL_OUT_OF_MEMORY; }
    void *grown = core_reallocate(scratch->origins, capacity * sizeof *scratch->origins);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->origins = grown;
    scratch->origin_capacity = capacity;
  }
  size_t index = scratch->origin_count++;
  scratch->origins[index] = (highlight_origin){point, start, end, index, 0};
  return NARSIL_OK;
}

static int order_origins(const highlight_origin *first, const highlight_origin *second) {
  if (first->point != second->point) { return first->point < second->point ? -1 : 1; }
  return (first->order > second->order) - (first->order < second->order);
}

static int compare_origins(const void *first, const void *second) { return order_origins(first, second); }

static narsil_status decompose_origins(highlight_scratch *scratch, const uint16_t *text, size_t length) {
  scratch->origin_count = 0;
  narsil_status status = (narsil_status)narsil_text_reserve(&scratch->width, length);
  if (status != NARSIL_OK) { return status; }
  for (size_t at = 0; at < length; at++) { scratch->width.units[at] = narsil_fold_width(text[at]); }
  scratch->width.length = length;
  size_t index = 0;
  while (index < length) {
    size_t start = index;
    uint32_t point = narsil_decode_next(scratch->width.units, length, &index);
    uint32_t parts[NARSIL_UNICODE_MAX_DECOMPOSITION];
    uint32_t count = narsil_unicode_decompose(point, parts);
    for (uint32_t next = 0; next < count; next++) {
      status = append_origin(scratch, parts[next], (uint32_t)start, (uint32_t)index);
      if (status != NARSIL_OK) { return status; }
    }
  }
  if (scratch->origin_count > 0) {
    qsort(scratch->origins, scratch->origin_count, sizeof *scratch->origins, compare_origins);
  }
  for (size_t slot = 0; slot < scratch->origin_count; slot++) { scratch->origins[slot].next = slot; }
  return (narsil_status)narsil_nfc(scratch->width.units, length, &scratch->composed, &scratch->decomposed);
}

static const highlight_origin *take_origin(highlight_scratch *scratch, uint32_t point) {
  size_t low = 0;
  size_t high = scratch->origin_count;
  while (low < high) {
    size_t middle = low + ((high - low) / 2);
    if (scratch->origins[middle].point < point) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  if (low == scratch->origin_count || scratch->origins[low].point != point) { return NULL; }
  size_t index = scratch->origins[low].next++;
  if (index >= scratch->origin_count || scratch->origins[index].point != point) { return NULL; }
  return scratch->origins + index;
}

static int original_span(highlight_scratch *scratch, uint32_t point, narsil_span *span) {
  uint32_t parts[NARSIL_UNICODE_MAX_DECOMPOSITION];
  uint32_t count = narsil_unicode_decompose(point, parts);
  uint32_t start = UINT32_MAX;
  uint32_t end = 0;
  for (uint32_t at = 0; at < count; at++) {
    const highlight_origin *origin = take_origin(scratch, parts[at]);
    if (origin == NULL) { return 0; }
    if (origin->start < start) { start = origin->start; }
    if (origin->end > end) { end = origin->end; }
  }
  *span = (narsil_span){start, end - start};
  return 1;
}

static void unite(narsil_span *target, narsil_span added) {
  uint32_t end = target->start + target->length;
  uint32_t added_end = added.start + added.length;
  if (added_end > end) { end = added_end; }
  if (added.start < target->start) { target->start = added.start; }
  target->length = end - target->start;
}

static narsil_status map_composed(highlight_scratch *scratch) {
  size_t index = 0;
  narsil_span leading = {0, 0};
  while (index < scratch->composed.length) {
    uint32_t point = narsil_decode_next(scratch->composed.units, scratch->composed.length, &index);
    narsil_span span;
    if (!original_span(scratch, point, &span)) { return NARSIL_INVALID_ARGUMENT; }
    point = narsil_fold_form(point);
    if (point == UINT32_MAX) {
      if (scratch->offsets.length > 0) {
        unite(scratch->offsets.spans + scratch->offsets.length - 1, span);
      } else if (leading.length == 0) {
        leading = span;
      } else {
        unite(&leading, span);
      }
      continue;
    }
    if (leading.length > 0) {
      unite(&span, leading);
      leading.length = 0;
    }
    uint32_t second = 0;
    uint32_t lower = narsil_unicode_lowercase_of(point, &second);
    size_t units = lower > UINT16_MAX ? 2U : 1U;
    if (second != 0) { units += second > UINT16_MAX ? 2U : 1U; }
    for (size_t unit = 0; unit < units; unit++) {
      int status = narsil_spans_push(&scratch->offsets, span);
      if (status != NARSIL_OK) { return (narsil_status)status; }
    }
  }
  return NARSIL_OK;
}

narsil_status highlight_offsets(highlight_scratch *scratch, const uint16_t *text, size_t length) {
  scratch->offsets.length = 0;
  narsil_status status = decompose_origins(scratch, text, length);
  return status == NARSIL_OK ? map_composed(scratch) : status;
}
