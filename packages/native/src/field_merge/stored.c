#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_field_merge.h"
#include "../../include/narsil_stored_values.h"
#include "../stored_values/values.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

static narsil_stored_values values_of(const narsil_field_merge_source *source) {
  const narsil_field_merge_region *regions = source->regions;
  return (narsil_stored_values){
      regions[FIELD_SHAPES].data,        regions[FIELD_SHAPES].length,     regions[FIELD_STARTS].data,
      regions[FIELD_STARTS].length,      regions[FIELD_KINDS].data,        regions[FIELD_KINDS].length,
      regions[FIELD_NUMBERS].data,       regions[FIELD_NUMBERS].length,    regions[FIELD_TEXT_STARTS].data,
      regions[FIELD_TEXT_STARTS].length, regions[FIELD_TEXT_LENGTHS].data, regions[FIELD_TEXT_LENGTHS].length,
      regions[FIELD_UNITS].data,         regions[FIELD_UNITS].length,      regions[FIELD_BYTES].data,
      regions[FIELD_BYTES].length};
}

typedef struct {
  uint64_t elements;
  uint64_t units;
  uint64_t bytes;
} stored_lengths;

static narsil_status measure_source(const narsil_field_merge_source *source, stored_lengths *lengths) {
  narsil_stored_values values = values_of(source);
  if (values.starts[0] != 0 || values.starts[values.shape_count] != values.kind_count) {
    return NARSIL_FILE_UNREADABLE;
  }
  for (size_t ordinal = 0; ordinal < source->document_count; ordinal++) {
    if (!stored_value_valid(&values, (uint32_t)ordinal)) { return NARSIL_FILE_UNREADABLE; }
    if (source->mapping[ordinal] == UINT32_MAX) { continue; }
    uint32_t start = values.starts[ordinal];
    uint32_t end = values.starts[ordinal + 1];
    lengths->elements += end - start;
    if (lengths->elements > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
    for (uint32_t index = start; index < end; index++) {
      if (values.kinds[index] == STORED_STRING) { lengths->units += values.text_length[index]; }
      if (values.kinds[index] == STORED_OTHER) { lengths->bytes += values.text_length[index]; }
      if (lengths->units > UINT32_MAX || lengths->bytes > UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
    }
  }
  return NARSIL_OK;
}

narsil_status field_merge_stored(field_merge_scratch *scratch, const narsil_field_merge_request *request) {
  stored_lengths measured = {0};
  for (size_t at = 0; at < request->source_count; at++) {
    narsil_status status = measure_source(request->sources + at, &measured);
    if (status != NARSIL_OK) { return status; }
  }
  if (request->document_count == UINT32_MAX) { return NARSIL_INVALID_ARGUMENT; }
  uint32_t *lengths = scratch->sizes.lengths;
  lengths[0] = request->document_count;
  lengths[1] = request->document_count + 1;
  for (size_t at = FIELD_KINDS; at < FIELD_UNITS; at++) { lengths[at] = (uint32_t)measured.elements; }
  lengths[FIELD_UNITS] = (uint32_t)measured.units;
  lengths[FIELD_BYTES] = (uint32_t)measured.bytes;
  return NARSIL_OK;
}

void field_merge_publish_stored(const field_merge_scratch *scratch, const narsil_field_merge_request *request,
                                const narsil_field_merge_output *output) {
  uint8_t *shapes = output->regions[0].data;
  uint32_t *starts = output->regions[1].data;
  uint8_t *kinds = output->regions[2].data;
  double *numbers = output->regions[3].data;
  uint32_t *text_starts = output->regions[4].data;
  uint32_t *text_lengths = output->regions[FIELD_TEXT_LENGTHS].data;
  uint16_t *units = output->regions[FIELD_UNITS].data;
  uint8_t *bytes = output->regions[FIELD_BYTES].data;
  uint32_t element = 0;
  uint32_t unit = 0;
  uint32_t byte = 0;
  starts[0] = 0;
  for (uint32_t ordinal = 0; ordinal < request->document_count; ordinal++) {
    field_merge_document document = scratch->documents[ordinal];
    narsil_stored_values values = values_of(document.source);
    shapes[ordinal] = values.shapes[document.ordinal];
    uint32_t start = values.starts[document.ordinal];
    uint32_t end = values.starts[(size_t)document.ordinal + 1];
    for (uint32_t at = start; at < end; at++, element++) {
      uint8_t kind = values.kinds[at];
      kinds[element] = kind;
      memcpy(numbers + element, values.numbers + at, sizeof *numbers);
      text_starts[element] = values.text_start[at];
      text_lengths[element] = values.text_length[at];
      uint32_t length = values.text_length[at];
      if (kind == STORED_STRING) {
        text_starts[element] = unit;
        if (length > 0) { memcpy(units + unit, values.units + values.text_start[at], length * sizeof *units); }
        unit += length;
      } else if (kind == STORED_OTHER) {
        text_starts[element] = byte;
        if (length > 0) { memcpy(bytes + byte, values.bytes + values.text_start[at], length); }
        byte += length;
      }
    }
    starts[(size_t)ordinal + 1] = element;
  }
}
