#include "cache.h"
#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

enum { BYTE_BITS = 8, THIRD_BYTE_SHIFT = 16, FOURTH_BYTE_SHIFT = 24, PAIR_WORDS = 2 };

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

static int regions_valid(const narsil_page_cache *cache, narsil_paged_removal_list list,
                         narsil_paged_removal_output output, const narsil_page_fault *fault) {
  segment_regions regions = {0};
  if ((uintptr_t)fault % _Alignof(narsil_page_fault) != 0 || !paged_cache_regions(&regions, cache) ||
      !segment_region_write(&regions, output.values, output.capacity, sizeof *output.values) ||
      !segment_region_write(&regions, output.count, 1, sizeof *output.count) ||
      !segment_region_write(&regions, fault, sizeof *fault, 1) ||
      (cache != NULL && !segment_region_input(&regions, cache, 1, sizeof *cache)) ||
      !section_input(&regions, list.offsets) || !section_input(&regions, list.values)) {
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
    return status;
  }
  return section->length % sizeof(uint32_t) == 0 ? NARSIL_OK : invalid(section, 0, fault);
}

narsil_status narsil_read_paged_removals(narsil_workspace *workspace, narsil_page_cache *cache,
                                         narsil_paged_removal_list list, narsil_paged_removal_output output,
                                         narsil_page_fault *fault) {
  if (workspace == NULL || !regions_valid(cache, list, output, fault)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_status status = section_valid(list.offsets, fault);
  if (status == NARSIL_OK) { status = section_valid(list.values, fault); }
  if (status != NARSIL_OK) { return status; }
  uint8_t bounds[PAIR_WORDS * sizeof(uint32_t)];
  uint64_t position = (uint64_t)list.ordinal * sizeof(uint32_t);
  status = paged_read_section(workspace, cache, list.offsets, position, bounds, sizeof bounds, fault);
  if (status != NARSIL_OK) { return status; }
  uint32_t first = word_at(bounds);
  uint32_t end = word_at(bounds + sizeof(uint32_t));
  if (first % PAIR_WORDS != 0 || end % PAIR_WORDS != 0 || first > end || end > list.values->length / sizeof(uint32_t) ||
      (list.ordinal == 0 && first != 0) ||
      (position + sizeof bounds == list.offsets->length && end != list.values->length / sizeof(uint32_t))) {
    return invalid(list.offsets, position, fault);
  }
  uint32_t words = end - first;
  uint64_t bytes = (uint64_t)words * sizeof(uint32_t);
  if (words > output.capacity || bytes > SIZE_MAX) { return NARSIL_NEEDS_ROOM; }
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  status = paged_reserve_values(scratch, (size_t)bytes);
  if (status != NARSIL_OK) { return status; }
  position = (uint64_t)first * sizeof(uint32_t);
  status = paged_read_section(workspace, cache, list.values, position, scratch->values, (size_t)bytes, fault);
  if (status != NARSIL_OK) { return status; }
  uint32_t previous = 0;
  for (uint32_t at = 0; at < words; at += PAIR_WORDS) {
    uint32_t token = word_at(scratch->values + ((size_t)at * sizeof(uint32_t)));
    if (token >= list.token_count || (at > 0 && token <= previous)) {
      return invalid(list.values, position + ((uint64_t)at * sizeof(uint32_t)), fault);
    }
    previous = token;
  }
  for (uint32_t at = 0; at < words; at++) {
    output.values[at] = word_at(scratch->values + ((size_t)at * sizeof(uint32_t)));
  }
  *output.count = words;
  return NARSIL_OK;
}
