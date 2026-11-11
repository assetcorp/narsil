#include "cache.h"
#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../allocation.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

enum { BYTE_BITS = 8, THIRD_BYTE_SHIFT = 16, FOURTH_BYTE_SHIFT = 24 };

static uint32_t word_at(const uint8_t *bytes, size_t index) {
  const uint8_t *word = bytes + (index * sizeof(uint32_t));
  return (uint32_t)word[0] | ((uint32_t)word[1] << BYTE_BITS) | ((uint32_t)word[2] << THIRD_BYTE_SHIFT) |
         ((uint32_t)word[3] << FOURTH_BYTE_SHIFT);
}

static int section_input(const segment_regions *regions, const narsil_page_section *section) {
  return section != NULL && (uintptr_t)section % _Alignof(narsil_page_section) == 0 &&
         segment_region_input(regions, section, 1, sizeof *section) && section->file != NULL &&
         (uintptr_t)section->file % _Alignof(struct narsil_paged_file) == 0 &&
         segment_region_input(regions, section->file, 1, sizeof *section->file) &&
         segment_region_input(regions, section->checksums, section->checksum_bytes, 1);
}

static int regions_valid(const narsil_page_cache *cache, narsil_paged_position_list list,
                         narsil_paged_position_output output, const narsil_page_fault *fault) {
  segment_regions regions = {0};
  if ((uintptr_t)output.offsets % _Alignof(uint32_t) != 0 || (uintptr_t)output.values % _Alignof(uint32_t) != 0 ||
      (uintptr_t)fault % _Alignof(narsil_page_fault) != 0 || !paged_cache_regions(&regions, cache) ||
      !segment_region_write(&regions, output.offsets, output.offset_capacity, sizeof *output.offsets) ||
      !segment_region_write(&regions, output.values, output.value_capacity, sizeof *output.values) ||
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

static narsil_status read_offsets(narsil_workspace *workspace, narsil_page_cache *cache,
                                  narsil_paged_position_list list, size_t words, narsil_page_fault *fault) {
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  size_t bytes = words * sizeof(uint32_t);
  if (bytes > scratch->offset_capacity) {
    void *grown = core_reallocate(scratch->offsets, bytes);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->offsets = grown;
    scratch->offset_capacity = bytes;
  }
  uint64_t position = (uint64_t)list.first * sizeof(uint32_t);
  narsil_status status = paged_read_section(workspace, cache, list.offsets, position, scratch->offsets, bytes, fault);
  if (status != NARSIL_OK) { return status; }
  uint32_t previous = 0;
  for (size_t at = 0; at < words; at++) {
    uint32_t value = word_at(scratch->offsets, at);
    if (value < previous || value > list.values->length / sizeof(uint32_t)) {
      return invalid(list.offsets, position + (at * sizeof(uint32_t)), fault);
    }
    previous = value;
  }
  if ((list.first == 0 && word_at(scratch->offsets, 0) != 0) ||
      (position + bytes == list.offsets->length && previous != list.values->length / sizeof(uint32_t))) {
    return invalid(list.offsets, position, fault);
  }
  return NARSIL_OK;
}

narsil_status narsil_read_paged_positions(narsil_workspace *workspace, narsil_page_cache *cache,
                                          narsil_paged_position_list list, narsil_paged_position_output output,
                                          narsil_page_fault *fault) {
  if (workspace == NULL || !regions_valid(cache, list, output, fault)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_status status = section_valid(list.offsets, fault);
  if (status == NARSIL_OK) { status = section_valid(list.values, fault); }
  if (status != NARSIL_OK) { return status; }
  uint64_t words64 = (uint64_t)list.count + 1;
  uint64_t first_offset = (uint64_t)list.first * sizeof(uint32_t);
  uint64_t offset_bytes = words64 * sizeof(uint32_t);
  if (first_offset > list.offsets->length || offset_bytes > list.offsets->length - first_offset) {
    return invalid(list.offsets, first_offset, fault);
  }
  if (words64 > SIZE_MAX / sizeof(uint32_t) || words64 > output.offset_capacity) { return NARSIL_NEEDS_ROOM; }
  size_t words = (size_t)words64;
  status = read_offsets(workspace, cache, list, words, fault);
  if (status != NARSIL_OK) { return status; }
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  uint32_t first = word_at(scratch->offsets, 0);
  uint32_t end_offset = word_at(scratch->offsets, words - 1);
  uint32_t count = end_offset - first;
  uint64_t value_bytes = (uint64_t)count * sizeof(uint32_t);
  if (value_bytes > SIZE_MAX || count > output.value_capacity) { return NARSIL_NEEDS_ROOM; }
  size_t bytes = (size_t)value_bytes;
  status = paged_reserve_values(scratch, bytes);
  if (status != NARSIL_OK) { return status; }
  status = paged_read_section(workspace, cache, list.values, (uint64_t)first * sizeof(uint32_t), scratch->values, bytes,
                              fault);
  if (status != NARSIL_OK) { return status; }
  for (size_t row = 0; row + 1 < words; row++) {
    uint32_t start = word_at(scratch->offsets, row) - first;
    uint32_t end = word_at(scratch->offsets, row + 1) - first;
    for (uint32_t at = start; at < end; at++) {
      if (at > start && word_at(scratch->values, at) < word_at(scratch->values, at - 1)) {
        return invalid(list.values, ((uint64_t)first + at) * sizeof(uint32_t), fault);
      }
    }
  }
  for (size_t at = 0; at < words; at++) { output.offsets[at] = word_at(scratch->offsets, at) - first; }
  for (uint32_t at = 0; at < count; at++) { output.values[at] = word_at(scratch->values, at); }
  return NARSIL_OK;
}
