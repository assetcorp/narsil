#include "cache.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../allocation.h"
#include "file.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define PAGE_HASH_MULTIPLIER UINT64_C(0x9e3779b97f4a7c15)
#define PAGE_HASH_FIRST_MIX UINT64_C(0xbf58476d1ce4e5b9)
#define PAGE_HASH_SECOND_MIX UINT64_C(0x94d049bb133111eb)

enum {
  BYTE_BITS = 8,
  THIRD_BYTE_SHIFT = 16,
  FOURTH_BYTE_SHIFT = 24,
  HASH_FIRST_SHIFT = 30,
  HASH_SECOND_SHIFT = 27,
  HASH_LAST_SHIFT = 31
};

static uint32_t checksum_at(const narsil_page_section *section, uint64_t page) {
  const uint8_t *bytes = section->checksums + ((size_t)page * sizeof(uint32_t));
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << BYTE_BITS) | ((uint32_t)bytes[2] << THIRD_BYTE_SHIFT) |
         ((uint32_t)bytes[3] << FOURTH_BYTE_SHIFT);
}

static size_t slot_of(const narsil_page_cache *cache, uint64_t file, uint64_t offset) {
  uint64_t hash = (file * PAGE_HASH_MULTIPLIER) ^ offset;
  hash = (hash ^ (hash >> HASH_FIRST_SHIFT)) * PAGE_HASH_FIRST_MIX;
  hash = (hash ^ (hash >> HASH_SECOND_SHIFT)) * PAGE_HASH_SECOND_MIX;
  hash ^= hash >> HASH_LAST_SHIFT;
  return (size_t)(hash % cache->slots);
}

static narsil_status prepare_page(narsil_workspace *workspace, size_t length, uint8_t **bytes) {
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  if (length > scratch->capacity) {
    void *grown = core_reallocate(scratch->page, length);
    if (grown == NULL) { return NARSIL_OUT_OF_MEMORY; }
    scratch->page = grown;
    scratch->capacity = length;
  }
  *bytes = scratch->page;
  return NARSIL_OK;
}

narsil_status paged_page(narsil_workspace *workspace, narsil_page_cache *cache, const narsil_page_section *section,
                         uint64_t page, const uint8_t **bytes, size_t *length, narsil_page_fault *fault) {
  uint64_t pages = (section->length / section->page_bytes) + (section->length % section->page_bytes != 0);
  if (page >= pages) { return NARSIL_PAGE_INVALID; }
  uint64_t relative = page * section->page_bytes;
  uint64_t remaining = section->length - relative;
  *length = remaining < section->page_bytes ? (size_t)remaining : section->page_bytes;
  uint64_t offset = section->offset + relative;
  uint32_t expected = checksum_at(section, page);
  size_t slot = 0;
  int caches = cache != NULL && cache->slots > 0;
  if (caches) {
    slot = slot_of(cache, section->file->identity, offset);
    if (cache->files[slot] == section->file->identity && cache->offsets[slot] == section->offset &&
        cache->pages[slot] == page && cache->lengths[slot] == *length && cache->checksums[slot] == expected) {
      *bytes = cache->bytes + (slot * NARSIL_PAGE_SLOT_BYTES);
      return NARSIL_OK;
    }
  }
  uint8_t *loaded = NULL;
  narsil_status status = prepare_page(workspace, *length, &loaded);
  if (status != NARSIL_OK) { return status; }
  status = paged_read(section->file, offset, loaded, *length);
  if (status == NARSIL_OK && paged_checksum(loaded, *length) != expected) { status = NARSIL_PAGE_CORRUPT; }
  if (status != NARSIL_OK) {
    *fault = (narsil_page_fault){section->file->identity, section->offset, page};
    return status;
  }
  if (caches) {
    uint8_t *destination = cache->bytes + (slot * NARSIL_PAGE_SLOT_BYTES);
    memcpy(destination, loaded, *length);
    cache->files[slot] = section->file->identity;
    cache->offsets[slot] = section->offset;
    cache->pages[slot] = page;
    cache->lengths[slot] = (uint32_t)*length;
    cache->checksums[slot] = expected;
    *bytes = destination;
  } else {
    *bytes = loaded;
  }
  return NARSIL_OK;
}

narsil_status narsil_read_page(narsil_workspace *workspace, narsil_page_cache *cache,
                               const narsil_page_section *section, uint64_t page, uint8_t *output,
                               size_t output_capacity, narsil_page_fault *fault) {
  if (workspace == NULL || !paged_regions(cache, section, output, output_capacity, fault)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = paged_section_valid(section);
  if (status != NARSIL_OK) {
    *fault = (narsil_page_fault){section->file->identity, section->offset, page};
    return status;
  }
  uint64_t pages = (section->length / section->page_bytes) + (section->length % section->page_bytes != 0);
  if (page >= pages) {
    *fault = (narsil_page_fault){section->file->identity, section->offset, page};
    return NARSIL_PAGE_INVALID;
  }
  uint64_t remaining = section->length - (page * section->page_bytes);
  size_t length = remaining < section->page_bytes ? (size_t)remaining : section->page_bytes;
  if (output_capacity < length) { return NARSIL_NEEDS_ROOM; }
  const uint8_t *bytes = NULL;
  status = paged_page(workspace, cache, section, page, &bytes, &length, fault);
  if (status == NARSIL_OK) { memcpy(output, bytes, length); }
  return status;
}
