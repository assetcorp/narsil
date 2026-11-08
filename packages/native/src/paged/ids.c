#include "cache.h"
#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../regions.h"
#include "../segments/regions.h"
#include "../terms/dictionary.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { BYTE_BITS = 8, THIRD_BYTE_SHIFT = 16, FOURTH_BYTE_SHIFT = 24, BOUND_WORDS = 2 };

static uint32_t word_at(const uint8_t *bytes) {
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << BYTE_BITS) | ((uint32_t)bytes[2] << THIRD_BYTE_SHIFT) |
         ((uint32_t)bytes[3] << FOURTH_BYTE_SHIFT);
}

static int section_input(const segment_regions *regions, const narsil_page_section *section) {
  return section != NULL && (uintptr_t)section % _Alignof(narsil_page_section) == 0 &&
         segment_region_input(regions, section, 1, sizeof *section) && section->file != NULL &&
         (uintptr_t)section->file % _Alignof(struct narsil_paged_file) == 0 &&
         segment_region_input(regions, section->file, 1, sizeof *section->file) &&
         segment_region_input(regions, section->checksums, section->checksum_bytes, 1);
}

static int regions_valid(const narsil_page_cache *cache, narsil_paged_id_request request, narsil_paged_id_output output,
                         const narsil_page_fault *fault) {
  segment_regions regions = {0};
  if ((uintptr_t)fault % _Alignof(narsil_page_fault) != 0 || !paged_cache_regions(&regions, cache) ||
      !segment_region_write(&regions, output.bytes, output.capacity, 1) ||
      !segment_region_write(&regions, output.length, 1, sizeof *output.length) ||
      !segment_region_write(&regions, fault, sizeof *fault, 1) ||
      (cache != NULL && !segment_region_input(&regions, cache, 1, sizeof *cache)) ||
      !section_input(&regions, request.offsets) || !section_input(&regions, request.values)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  return 1;
}

static narsil_status invalid(const narsil_page_section *section, uint64_t offset, narsil_page_fault *fault) {
  *fault =
      (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, offset / section->page_bytes};
  return NARSIL_PAGE_INVALID;
}

static narsil_status section_valid(const narsil_page_section *section, narsil_page_fault *fault) {
  narsil_status status = paged_section_valid(section);
  if (status != NARSIL_OK) {
    *fault = (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, 0};
  }
  return status;
}

narsil_status narsil_read_paged_id(narsil_workspace *workspace, narsil_page_cache *cache,
                                   narsil_paged_id_request request, narsil_paged_id_output output,
                                   narsil_page_fault *fault) {
  if (workspace == NULL || !regions_valid(cache, request, output, fault)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_status status = section_valid(request.offsets, fault);
  if (status == NARSIL_OK) { status = section_valid(request.values, fault); }
  if (status != NARSIL_OK) { return status; }
  if (request.offsets->length % sizeof(uint32_t) != 0) { return invalid(request.offsets, 0, fault); }
  uint8_t bounds[BOUND_WORDS * sizeof(uint32_t)];
  uint64_t position = (uint64_t)request.ordinal * sizeof(uint32_t);
  status = paged_read_section(workspace, cache, request.offsets, position, bounds, sizeof bounds, fault);
  if (status != NARSIL_OK) { return status; }
  uint32_t first = word_at(bounds);
  uint32_t end = word_at(bounds + sizeof(uint32_t));
  if (first > end || end > request.values->length || (request.ordinal == 0 && first != 0) ||
      (position + sizeof bounds == request.offsets->length && end != request.values->length)) {
    return invalid(request.offsets, position, fault);
  }
  uint32_t length = end - first;
  if (length > output.capacity) { return NARSIL_NEEDS_ROOM; }
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  status = paged_reserve_values(scratch, length);
  if (status != NARSIL_OK) { return status; }
  status = paged_read_section(workspace, cache, request.values, first, scratch->values, length, fault);
  if (status != NARSIL_OK) { return status; }
  term_cursor cursor = {NULL, scratch->values, 0, length};
  uint32_t point = 0;
  while (cursor.at < cursor.end) {
    size_t before = cursor.at;
    if (term_next(&cursor, &point) < 0) { return invalid(request.values, (uint64_t)first + before, fault); }
  }
  if (length > 0) { memcpy(output.bytes, scratch->values, length); }
  *output.length = length;
  return NARSIL_OK;
}
