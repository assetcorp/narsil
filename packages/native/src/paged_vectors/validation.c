#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../../include/narsil_paged_vectors.h"
#include "../internal.h"
#include "../paged/cache.h"
#include "../paged/file.h"
#include "../segments/regions.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>

static int input(const segment_regions *regions, const void *pointer, size_t count, size_t width, size_t alignment) {
  return (uintptr_t)pointer % alignment == 0 && segment_region_input(regions, pointer, count, width);
}

static int section_inputs(const segment_regions *regions, const narsil_page_section *section) {
  return section != NULL && input(regions, section, 1, sizeof *section, _Alignof(narsil_page_section)) &&
         section->file != NULL &&
         input(regions, section->file, 1, sizeof *section->file, _Alignof(struct narsil_paged_file)) &&
         input(regions, section->checksums, section->checksum_bytes, 1, 1);
}

static int field_inputs(const segment_regions *regions, const narsil_paged_vector_field *field) {
  if (!input(regions, field->files, field->file_count, sizeof *field->files, _Alignof(narsil_paged_vector_file)) ||
      !input(regions, field->parts, field->part_count, sizeof *field->parts, _Alignof(narsil_paged_graph_part)) ||
      !input(regions, field->centroid, field->centroid_count, sizeof *field->centroid, _Alignof(float))) {
    return 0;
  }
  for (size_t at = 0; at < field->file_count; at++) {
    const narsil_paged_vector_file *file = &field->files[at];
    if (!input(regions, file->dead, file->dead_bytes, 1, 1) || !section_inputs(regions, &file->vectors) ||
        (file->records != NULL && !section_inputs(regions, file->records))) {
      return 0;
    }
  }
  for (size_t at = 0; at < field->part_count; at++) {
    const narsil_paged_graph_part *part = &field->parts[at];
    if (!input(regions, part->levels, part->level_count, 1, 1) ||
        !input(regions, part->node_offsets, part->offset_count, sizeof *part->node_offsets, _Alignof(uint32_t)) ||
        !section_inputs(regions, &part->neighbours)) {
      return 0;
    }
  }
  return 1;
}

static narsil_status section_valid(const narsil_page_section *section, narsil_page_fault *fault) {
  narsil_status status = paged_section_valid(section);
  if (status != NARSIL_OK) { *fault = (narsil_page_fault){section->file->identity, section->offset, 0}; }
  return status;
}

static narsil_status files_valid(const narsil_paged_vector_field *field, narsil_page_fault *fault) {
  uint64_t next = 0;
  uint64_t row_bytes = (uint64_t)field->dimension * sizeof(float);
  uint64_t record_bytes = ((((uint64_t)field->dimension * field->bits) + (PAGED_BYTE_BITS - 1)) / PAGED_BYTE_BITS) +
                          NARSIL_OSQ_TRAILER_BYTES;
  for (size_t at = 0; at < field->file_count; at++) {
    const narsil_paged_vector_file *file = &field->files[at];
    size_t dead_bytes = ((size_t)file->count / PAGED_BYTE_BITS) + (file->count % PAGED_BYTE_BITS != 0);
    if (file->first != next || file->count == 0 || file->count > field->total - next ||
        row_bytes > UINT64_MAX / file->count || file->vectors.length != row_bytes * file->count ||
        (file->dead == NULL ? file->dead_bytes != 0 : file->dead_bytes != dead_bytes) ||
        (field->bits == 0 ? file->records != NULL : file->records == NULL)) {
      return NARSIL_INVALID_ARGUMENT;
    }
    narsil_status status = section_valid(&file->vectors, fault);
    if (status != NARSIL_OK) { return status; }
    if (file->records != NULL) {
      if (record_bytes > UINT64_MAX / file->count || file->records->length != record_bytes * file->count) {
        return NARSIL_INVALID_ARGUMENT;
      }
      status = section_valid(file->records, fault);
      if (status != NARSIL_OK) { return status; }
    }
    next += file->count;
  }
  return next == field->total ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}

static narsil_status parts_valid(const narsil_paged_vector_field *field, narsil_page_fault *fault) {
  uint64_t next = 0;
  size_t file_index = 0;
  for (size_t at = 0; at < field->part_count; at++) {
    const narsil_paged_graph_part *part = &field->parts[at];
    if (part->first != next || part->count == 0 || part->count > PAGED_GRAPH_PART_NODES ||
        part->count > field->total - next || (at + 1 < field->part_count && part->count != PAGED_GRAPH_PART_NODES) ||
        part->level_count != part->count || part->offset_count != (size_t)part->count + 1 ||
        part->node_offsets[0] != 0) {
      return NARSIL_INVALID_ARGUMENT;
    }
    narsil_status status = section_valid(&part->neighbours, fault);
    if (status != NARSIL_OK) { return status; }
    for (uint32_t local = 0; local < part->count; local++) {
      uint32_t ordinal = part->first + local;
      while (file_index + 1 < field->file_count && field->files[file_index + 1].first <= ordinal) { file_index++; }
      const narsil_paged_vector_file *file = &field->files[file_index];
      uint32_t offset = ordinal - file->first;
      int dead = file->dead != NULL && ((file->dead[offset / PAGED_BYTE_BITS] >> (offset % PAGED_BYTE_BITS)) & 1) != 0;
      if (part->levels[local] > field->max_layer + 1 || (!dead && part->levels[local] == 0) ||
          part->node_offsets[local] > part->node_offsets[local + 1] ||
          part->node_offsets[local + 1] > part->neighbours.length) {
        *fault = (narsil_page_fault){part->neighbours.file->identity, part->neighbours.offset,
                                     part->node_offsets[local] / part->neighbours.page_bytes};
        return NARSIL_PAGE_INVALID;
      }
    }
    next += part->count;
  }
  return next == field->total ? NARSIL_OK : NARSIL_INVALID_ARGUMENT;
}

narsil_status paged_vector_validate(const segment_regions *regions, const narsil_paged_vector_field *field,
                                    const narsil_paged_vector_request *request, narsil_page_fault *fault) {
  if (!field_inputs(regions, field) ||
      !input(regions, request->query, request->query_count, sizeof *request->query, _Alignof(float)) ||
      !input(regions, request->accepted, request->accepted_words, sizeof *request->accepted, _Alignof(uint32_t)) ||
      !input(regions, request->excluded, request->excluded_words, sizeof *request->excluded, _Alignof(uint32_t))) {
    return NARSIL_INVALID_ARGUMENT;
  }
  size_t words = field->total == 0 ? 1 : (((size_t)field->total - 1) / PAGED_BIT_WORD_BITS) + 1;
  if (field->dimension == 0 || !is_metric(field->metric) || !is_code_width(field->bits) ||
      field->max_layer > PAGED_MAX_LAYER || field->has_entry_point < 0 || field->has_entry_point > 1 ||
      (field->has_entry_point && field->entry_point >= field->total) ||
      (field->total == 0 && (field->file_count != 0 || field->part_count != 0)) ||
      (field->bits == 0 ? field->centroid_count != 0 : field->centroid_count != field->dimension) ||
      request->query_count != field->dimension || request->explicit_rescore_window < 0 ||
      request->explicit_rescore_window > 1 || request->rescore_depth > request->ef ||
      (field->total != 0 && request->ef == 0) || isnan(request->min_similarity) ||
      request->min_similarity == HUGE_VAL ||
      (request->accepted == NULL ? request->accepted_words != 0 : request->accepted_words < words) ||
      (request->excluded == NULL ? request->excluded_words != 0 : request->excluded_words < words)) {
    return NARSIL_INVALID_ARGUMENT;
  }
  for (size_t at = 0; at < request->query_count; at++) {
    if (!isfinite(request->query[at])) { return NARSIL_INVALID_ARGUMENT; }
  }
  for (size_t at = 0; at < field->centroid_count; at++) {
    if (!isfinite(field->centroid[at])) { return NARSIL_INVALID_ARGUMENT; }
  }
  narsil_status status = files_valid(field, fault);
  return status == NARSIL_OK ? parts_valid(field, fault) : status;
}
