#include "cache.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../regions.h"
#include "../segments/regions.h"
#include "file.h"

#include <stddef.h>
#include <stdint.h>

enum { RECORD_PAGE_BYTES = 16384 };

int paged_cache_regions(segment_regions *regions, const narsil_page_cache *cache) {
  if (cache == NULL) { return 1; }
  if ((uintptr_t)cache % _Alignof(narsil_page_cache) != 0 ||
      cache->slots > cache->byte_capacity / NARSIL_PAGE_SLOT_BYTES) {
    return 0;
  }
  return segment_region_write(regions, cache->bytes, cache->byte_capacity, sizeof *cache->bytes) &&
         segment_region_write(regions, cache->files, cache->slots, sizeof *cache->files) &&
         segment_region_write(regions, cache->offsets, cache->slots, sizeof *cache->offsets) &&
         segment_region_write(regions, cache->pages, cache->slots, sizeof *cache->pages) &&
         segment_region_write(regions, cache->lengths, cache->slots, sizeof *cache->lengths) &&
         segment_region_write(regions, cache->checksums, cache->slots, sizeof *cache->checksums);
}

int paged_regions(const narsil_page_cache *cache, const narsil_page_section *section, const uint8_t *output,
                  size_t output_capacity, const narsil_page_fault *fault) {
  if (section == NULL || (uintptr_t)section % _Alignof(narsil_page_section) != 0 || section->file == NULL ||
      (uintptr_t)section->file % _Alignof(struct narsil_paged_file) != 0 || fault == NULL ||
      (uintptr_t)fault % _Alignof(narsil_page_fault) != 0) {
    return 0;
  }
  segment_regions regions = {0};
  if (!paged_cache_regions(&regions, cache) ||
      !segment_region_write(&regions, output, output_capacity, sizeof *output) ||
      !segment_region_write(&regions, fault, sizeof *fault, 1) ||
      !segment_region_input(&regions, section, 1, sizeof *section) ||
      !segment_region_input(&regions, section->file, 1, sizeof *section->file) ||
      !segment_region_input(&regions, section->checksums, section->checksum_bytes, sizeof *section->checksums) ||
      (cache != NULL && !segment_region_input(&regions, cache, 1, sizeof *cache))) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  return 1;
}

narsil_status paged_section_valid(const narsil_page_section *section) {
  if (section->page_bytes != RECORD_PAGE_BYTES && section->page_bytes != NARSIL_PAGE_SLOT_BYTES) {
    return NARSIL_PAGE_INVALID;
  }
  uint64_t pages = (section->length / section->page_bytes) + (section->length % section->page_bytes != 0);
  if (pages > SIZE_MAX / sizeof(uint32_t) || section->checksum_bytes != (size_t)pages * sizeof(uint32_t) ||
      section->offset > section->file->length || section->length > section->file->length - section->offset) {
    return NARSIL_PAGE_INVALID;
  }
  return NARSIL_OK;
}
