#include "cache.h"
#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../regions.h"
#include "../segments/regions.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

enum { BYTE_BITS = 8, WRITE_WORDS = 2 };

static uint64_t number_at(const uint8_t *bytes, size_t length) {
  uint64_t value = 0;
  for (size_t at = 0; at < length; at++) { value |= (uint64_t)bytes[at] << (at * BYTE_BITS); }
  return value;
}

static narsil_status invalid(const narsil_page_section *section, uint64_t offset, narsil_page_fault *fault) {
  *fault =
      (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, offset / section->page_bytes};
  return NARSIL_PAGE_INVALID;
}

static narsil_status section_valid(const narsil_page_section *section, size_t width, narsil_page_fault *fault) {
  narsil_status status = paged_section_valid(section);
  if (status != NARSIL_OK) {
    *fault = (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, 0};
    return status;
  }
  return section->length % width == 0 ? NARSIL_OK : invalid(section, 0, fault);
}

static double total_at(const uint8_t *bytes) {
  uint64_t bits = number_at(bytes, sizeof(double));
  double value = 0;
  memcpy(&value, &bits, sizeof value);
  return value;
}

narsil_status narsil_read_paged_totals(narsil_workspace *workspace, narsil_page_cache *cache,
                                       const narsil_page_section *section, narsil_paged_totals_request request,
                                       double *output, size_t capacity, narsil_page_fault *fault) {
  if (workspace == NULL || (uintptr_t)output % _Alignof(double) != 0 || capacity > SIZE_MAX / sizeof *output ||
      !paged_regions(cache, section, (uint8_t *)output, capacity * sizeof *output, fault)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = section_valid(section, sizeof(double), fault);
  if (status != NARSIL_OK) { return status; }
  uint64_t first = (uint64_t)request.first * sizeof(double);
  uint64_t length = (uint64_t)request.count * sizeof(double);
  if (first > section->length || length > section->length - first) { return invalid(section, first, fault); }
  if (length > SIZE_MAX || request.count > capacity) { return NARSIL_NEEDS_ROOM; }
  paged_scratch *scratch = workspace_paged_scratch(workspace);
  status = paged_reserve_values(scratch, (size_t)length);
  if (status != NARSIL_OK) { return status; }
  status = paged_read_section(workspace, cache, section, first, scratch->values, (size_t)length, fault);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < request.count; at++) {
    double value = total_at(scratch->values + ((size_t)at * sizeof(double)));
    if (!isfinite(value) || value < 0) { return invalid(section, first + ((uint64_t)at * sizeof(double)), fault); }
  }
  for (uint32_t at = 0; at < request.count; at++) {
    output[at] = total_at(scratch->values + ((size_t)at * sizeof(double)));
  }
  return NARSIL_OK;
}

narsil_status narsil_read_paged_ordinal(narsil_workspace *workspace, narsil_page_cache *cache,
                                        const narsil_page_section *section, narsil_paged_ordinal_request request,
                                        uint32_t *output, size_t capacity, narsil_page_fault *fault) {
  if (workspace == NULL || (uintptr_t)output % _Alignof(uint32_t) != 0 || capacity > SIZE_MAX / sizeof *output ||
      !paged_regions(cache, section, (uint8_t *)output, capacity * sizeof *output, fault)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  narsil_status status = section_valid(section, sizeof(uint32_t), fault);
  if (status != NARSIL_OK) { return status; }
  if (section->length != (uint64_t)request.documents * sizeof(uint32_t)) { return invalid(section, 0, fault); }
  if (capacity == 0) { return NARSIL_NEEDS_ROOM; }
  uint8_t bytes[sizeof(uint32_t)];
  uint64_t position = (uint64_t)request.position * sizeof(uint32_t);
  status = paged_read_section(workspace, cache, section, position, bytes, sizeof bytes, fault);
  if (status != NARSIL_OK) { return status; }
  uint32_t value = (uint32_t)number_at(bytes, sizeof bytes);
  if (value >= request.documents) { return invalid(section, position, fault); }
  output[0] = value;
  return NARSIL_OK;
}

static int section_input(const segment_regions *regions, const narsil_page_section *section) {
  return section != NULL && (uintptr_t)section % _Alignof(narsil_page_section) == 0 &&
         segment_region_input(regions, section, 1, sizeof *section) && section->file != NULL &&
         (uintptr_t)section->file % _Alignof(struct narsil_paged_file) == 0 &&
         segment_region_input(regions, section->file, 1, sizeof *section->file) &&
         segment_region_input(regions, section->checksums, section->checksum_bytes, 1);
}

static int write_regions(const narsil_page_cache *cache, narsil_paged_write_request request,
                         narsil_paged_write_output output, const narsil_page_fault *fault) {
  segment_regions regions = {0};
  if ((uintptr_t)fault % _Alignof(narsil_page_fault) != 0 || !paged_cache_regions(&regions, cache) ||
      !segment_region_write(&regions, output.values, output.capacity, sizeof *output.values) ||
      !segment_region_write(&regions, fault, sizeof *fault, 1) ||
      (cache != NULL && !segment_region_input(&regions, cache, 1, sizeof *cache)) ||
      !section_input(&regions, request.sequences) || !section_input(&regions, request.terms)) {
    return 0;
  }
  for (size_t at = 0; at < regions.write_count; at++) {
    for (size_t before = 0; before < at; before++) {
      if (overlaps(regions.writes[at], regions.writes[before])) { return 0; }
    }
  }
  return 1;
}

narsil_status narsil_read_paged_write_record(narsil_workspace *workspace, narsil_page_cache *cache,
                                             narsil_paged_write_request request, narsil_paged_write_output output,
                                             narsil_page_fault *fault) {
  if (workspace == NULL || !write_regions(cache, request, output, fault)) { return NARSIL_INVALID_ARGUMENT; }
  narsil_status status = section_valid(request.sequences, sizeof(uint64_t), fault);
  if (status == NARSIL_OK) { status = section_valid(request.terms, sizeof(uint64_t), fault); }
  if (status != NARSIL_OK) { return status; }
  if (request.sequences->length != request.terms->length) { return invalid(request.terms, 0, fault); }
  if (output.capacity < WRITE_WORDS) { return NARSIL_NEEDS_ROOM; }
  uint8_t sequence_bytes[sizeof(uint64_t)];
  uint8_t term_bytes[sizeof(uint64_t)];
  uint64_t position = (uint64_t)request.ordinal * sizeof(uint64_t);
  status =
      paged_read_section(workspace, cache, request.sequences, position, sequence_bytes, sizeof sequence_bytes, fault);
  if (status != NARSIL_OK) { return status; }
  status = paged_read_section(workspace, cache, request.terms, position, term_bytes, sizeof term_bytes, fault);
  if (status != NARSIL_OK) { return status; }
  uint64_t sequence = number_at(sequence_bytes, sizeof sequence_bytes);
  uint64_t term = number_at(term_bytes, sizeof term_bytes);
  if (sequence == 0 && term != 0) { return invalid(request.terms, position, fault); }
  output.values[0] = sequence;
  output.values[1] = term;
  return NARSIL_OK;
}
