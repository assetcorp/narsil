#ifndef NARSIL_PAGED_CACHE_H
#define NARSIL_PAGED_CACHE_H

#include "../../include/narsil_paged.h"
#include "../segments/regions.h"

#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t *page;
  size_t capacity;
  uint8_t *values;
  size_t value_capacity;
  uint8_t *offsets;
  size_t offset_capacity;
} paged_scratch;

narsil_status paged_reserve_values(paged_scratch *scratch, size_t bytes);

paged_scratch *workspace_paged_scratch(narsil_workspace *workspace);
uint32_t paged_checksum(const uint8_t *bytes, size_t length);
int paged_cache_regions(segment_regions *regions, const narsil_page_cache *cache);
int paged_regions(const narsil_page_cache *cache, const narsil_page_section *section, const uint8_t *output,
                  size_t output_capacity, const narsil_page_fault *fault);
narsil_status paged_section_valid(const narsil_page_section *section);
narsil_status paged_read_section(narsil_workspace *workspace, narsil_page_cache *cache,
                                 const narsil_page_section *section, uint64_t offset, uint8_t *output, size_t length,
                                 narsil_page_fault *fault);
narsil_status paged_page(narsil_workspace *workspace, narsil_page_cache *cache, const narsil_page_section *section,
                         uint64_t page, const uint8_t **bytes, size_t *length, narsil_page_fault *fault);

#endif
