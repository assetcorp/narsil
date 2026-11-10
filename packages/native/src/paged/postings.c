#include "cache.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"

#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { POSTING_BYTES = 8, FIELD_LIMIT = 65536, BYTE_BITS = 8, THIRD_BYTE_SHIFT = 16, FOURTH_BYTE_SHIFT = 24 };

static uint32_t word_at(const uint8_t *bytes) {
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << BYTE_BITS) | ((uint32_t)bytes[2] << THIRD_BYTE_SHIFT) |
         ((uint32_t)bytes[3] << FOURTH_BYTE_SHIFT);
}

static uint32_t field_at(const uint8_t *bytes) { return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << BYTE_BITS); }

static narsil_status invalid(const narsil_page_section *section, uint64_t offset, narsil_page_fault *fault) {
  *fault =
      (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, offset / section->page_bytes};
  return NARSIL_PAGE_INVALID;
}

narsil_status narsil_read_paged_postings(narsil_workspace *workspace, narsil_page_cache *cache,
                                         const narsil_page_section *section, narsil_paged_posting_list list,
                                         uint8_t *output, size_t output_capacity, narsil_page_fault *fault) {
  if (workspace == NULL || !paged_regions(cache, section, output, output_capacity, fault) ||
      list.fields > FIELD_LIMIT) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = paged_section_valid(section);
  if (status != NARSIL_OK) {
    *fault = (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, 0};
    return status;
  }
  uint32_t count = list.count;
  uint64_t offset = (uint64_t)list.first * POSTING_BYTES;
  uint64_t length = (uint64_t)count * POSTING_BYTES;
  if (section->length % POSTING_BYTES != 0 || offset > section->length || length > section->length - offset) {
    return invalid(section, offset, fault);
  }
  if (length > SIZE_MAX || length > output_capacity) { return NARSIL_NEEDS_ROOM; }
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  size_t bytes = (size_t)length;
  status = paged_reserve_values(scratch, bytes);
  if (status != NARSIL_OK) { return status; }
  status = paged_read_section(workspace, cache, section, offset, scratch->values, bytes, fault);
  if (status != NARSIL_OK) { return status; }
  uint32_t prior_document = 0;
  uint32_t prior_field = 0;
  for (uint32_t row = 0; row < count; row++) {
    size_t document_offset = (size_t)row * sizeof(uint32_t);
    size_t field_offset = ((size_t)count * (sizeof(uint32_t) + sizeof(uint16_t))) + ((size_t)row * sizeof(uint16_t));
    uint32_t document = word_at(scratch->values + document_offset);
    uint32_t field = field_at(scratch->values + field_offset);
    if (document >= list.documents) { return invalid(section, offset + document_offset, fault); }
    if (field >= list.fields) { return invalid(section, offset + field_offset, fault); }
    if (row > 0 && (document < prior_document || (document == prior_document && field <= prior_field))) {
      return invalid(section, offset + document_offset, fault);
    }
    prior_document = document;
    prior_field = field;
  }
  if (bytes > 0) { memcpy(output, scratch->values, bytes); }
  return NARSIL_OK;
}
