#include "internal.h"

#include "../../include/narsil_field_merge.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

size_t field_merge_width(uint32_t kind, size_t region) {
  static const uint8_t widths[][NARSIL_FIELD_MERGE_REGIONS] = {
      {0}, {8, 4}, {4, 4}, {2, 4, 4, 4, 4}, {8, 8, 8, 4}, {1, 4, 1, 8, 4, 4, 2, 1}, {4, 4, 4, 4}};
  if (kind < NARSIL_MERGE_NUMERIC || kind > NARSIL_MERGE_PATTERN || region >= NARSIL_FIELD_MERGE_REGIONS) { return 0; }
  return widths[kind][region];
}

static int source_valid(const narsil_field_merge_source *source, uint32_t kind, const segment_regions *outputs) {
  if (source->document_count > UINT32_MAX ||
      (source->document_count > 0 && (uintptr_t)source->mapping % _Alignof(uint32_t) != 0) ||
      !segment_region_input(outputs, source->mapping, source->document_count, sizeof *source->mapping)) {
    return 0;
  }
  for (size_t at = 0; at < NARSIL_FIELD_MERGE_REGIONS; at++) {
    const narsil_field_merge_region *region = source->regions + at;
    size_t width = field_merge_width(kind, at);
    if (width == 0) {
      if (region->length != 0) { return 0; }
    } else if (region->length > UINT32_MAX || (region->length > 0 && (uintptr_t)region->data % width != 0) ||
               !segment_region_input(outputs, region->data, region->length, width)) {
      return 0;
    }
  }
  const narsil_field_merge_region *regions = source->regions;
  size_t words = source->document_count == 0 ? 1 : ((source->document_count - 1) / FIELD_MERGE_WORD_BITS) + 1;
  switch (kind) {
    case NARSIL_MERGE_NUMERIC:
      return regions[0].length == regions[1].length;
    case NARSIL_MERGE_BOOLEAN:
      return regions[0].length >= words && regions[1].length >= words;
    case NARSIL_MERGE_ENUM:
      return regions[1].length > 0 && regions[2].length == regions[1].length &&
             regions[4].length == regions[1].length - 1;
    case NARSIL_MERGE_GEO:
      return regions[0].length == regions[1].length && regions[0].length == regions[2].length &&
             regions[0].length == regions[3].length;
    case NARSIL_MERGE_STORED:
      return source->document_count < SIZE_MAX && regions[0].length == source->document_count &&
             regions[1].length == source->document_count + 1 && regions[2].length == regions[3].length &&
             regions[2].length == regions[4].length && regions[2].length == regions[FIELD_TEXT_LENGTHS].length;
    case NARSIL_MERGE_PATTERN:
      return regions[1].length % 3 == 0 && regions[2].length == (regions[1].length / 3) + 1;
    default:
      return 0;
  }
}

int field_merge_inputs(const narsil_field_merge_request *request, const segment_regions *outputs) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_field_merge_request) != 0 ||
      request->kind < NARSIL_MERGE_NUMERIC || request->kind > NARSIL_MERGE_PATTERN ||
      (request->source_count > 0 && (uintptr_t)request->sources % _Alignof(narsil_field_merge_source) != 0) ||
      !segment_region_input(outputs, request, 1, sizeof *request) ||
      !segment_region_input(outputs, request->sources, request->source_count, sizeof *request->sources)) {
    return 0;
  }
  for (size_t at = 0; at < request->source_count; at++) {
    if (!source_valid(request->sources + at, request->kind, outputs)) { return 0; }
  }
  return 1;
}

int field_merge_outputs(const narsil_field_merge_request *request, const narsil_field_merge_output *output,
                        segment_regions *regions) {
  if (request == NULL || (uintptr_t)request % _Alignof(narsil_field_merge_request) != 0 || output == NULL ||
      (uintptr_t)output % _Alignof(narsil_field_merge_output) != 0) {
    return 0;
  }
  for (size_t at = 0; at < NARSIL_FIELD_MERGE_REGIONS; at++) {
    const narsil_field_merge_target *region = output->regions + at;
    size_t width = field_merge_width(request->kind, at);
    if (width == 0) {
      if (region->capacity != 0) { return 0; }
    } else if ((region->capacity > 0 && (uintptr_t)region->data % width != 0) ||
               !segment_region_write(regions, region->data, region->capacity, width)) {
      return 0;
    }
  }
  for (size_t at = 0; at < regions->write_count; at++) {
    for (size_t previous = 0; previous < at; previous++) {
      if (overlaps(regions->writes[at], regions->writes[previous])) { return 0; }
    }
  }
  return segment_region_input(regions, output, 1, sizeof *output) && field_merge_inputs(request, regions);
}
