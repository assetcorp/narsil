#include "internal.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"
#include "../../include/narsil_paged_vectors.h"
#include "../internal.h"
#include "../paged/cache.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

const narsil_paged_vector_file *paged_file_of(const narsil_paged_vector_field *field, uint32_t ordinal) {
  size_t low = 0;
  size_t high = field->file_count;
  while (low + 1 < high) {
    size_t middle = low + ((high - low) / 2);
    if (field->files[middle].first <= ordinal) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return &field->files[low];
}

uint8_t paged_levels(const narsil_paged_vector_field *field, uint32_t ordinal) {
  return field->parts[ordinal / PAGED_GRAPH_PART_NODES].levels[ordinal % PAGED_GRAPH_PART_NODES];
}

int paged_admits(const paged_walk *walk, uint32_t ordinal) {
  const narsil_paged_vector_file *file = paged_file_of(walk->field, ordinal);
  uint32_t local = ordinal - file->first;
  if (file->dead != NULL && ((file->dead[local / PAGED_BYTE_BITS] >> (local % PAGED_BYTE_BITS)) & 1) != 0) { return 0; }
  uint32_t mask = 1U << (ordinal % PAGED_BIT_WORD_BITS);
  uint32_t word = ordinal / PAGED_BIT_WORD_BITS;
  return (walk->request->accepted == NULL || (walk->request->accepted[word] & mask) != 0) &&
         (walk->request->excluded == NULL || (walk->request->excluded[word] & mask) == 0);
}

static narsil_status read_word(paged_walk *walk, const narsil_page_section *section, uint64_t position,
                               uint32_t *value) {
  return paged_read_section(walk->workspace, walk->cache, section, position, (uint8_t *)value, sizeof *value,
                            walk->fault);
}

static narsil_status invalid_page(paged_walk *walk, const narsil_page_section *section, uint64_t position) {
  *walk->fault =
      (narsil_page_fault){narsil_paged_file_identity(section->file), section->offset, position / section->page_bytes};
  return NARSIL_PAGE_INVALID;
}

narsil_status paged_neighbours(paged_walk *walk, uint32_t ordinal, uint64_t *start, uint32_t *count) {
  const narsil_paged_graph_part *part = &walk->field->parts[ordinal / PAGED_GRAPH_PART_NODES];
  uint32_t local = ordinal % PAGED_GRAPH_PART_NODES;
  uint64_t position = part->node_offsets[local];
  uint64_t end = part->node_offsets[local + 1];
  uint32_t levels = part->levels[local];
  for (uint32_t current = 0; current < levels; current++) {
    if (position > end || end - position < sizeof(uint32_t)) { return invalid_page(walk, &part->neighbours, position); }
    uint32_t length = 0;
    narsil_status status = read_word(walk, &part->neighbours, position, &length);
    if (status != NARSIL_OK) { return status; }
    position += sizeof(uint32_t);
    if (length > (end - position) / sizeof(uint32_t)) { return invalid_page(walk, &part->neighbours, position); }
    if (current == walk->layer) {
      *start = position;
      *count = length;
    }
    position += (uint64_t)length * sizeof(uint32_t);
  }
  return position == end && walk->layer < levels ? NARSIL_OK : invalid_page(walk, &part->neighbours, position);
}

narsil_status paged_neighbour(paged_walk *walk, uint32_t ordinal, uint32_t *neighbour, uint64_t position) {
  const narsil_paged_graph_part *part = &walk->field->parts[ordinal / PAGED_GRAPH_PART_NODES];
  return read_word(walk, &part->neighbours, position, neighbour);
}

narsil_status paged_vector_distance(paged_walk *walk, uint32_t ordinal, double *distance, int exact) {
  const narsil_paged_vector_file *file = paged_file_of(walk->field, ordinal);
  uint32_t local = ordinal - file->first;
  uint32_t dimension = walk->field->dimension;
  if (!exact && file->records != NULL) {
    size_t bytes = (size_t)walk->codes.code_bytes + NARSIL_OSQ_TRAILER_BYTES;
    narsil_status status = paged_read_section(walk->workspace, walk->cache, file->records, (uint64_t)local * bytes,
                                              walk->scratch->record, bytes, walk->fault);
    if (status != NARSIL_OK) { return status; }
    *distance = estimate_distance(&walk->codes, walk->scratch->record);
    return NARSIL_OK;
  }
  size_t bytes = (size_t)dimension * sizeof(float);
  float *vector = walk->workspace->stored_vector;
  narsil_status status = paged_read_section(walk->workspace, walk->cache, &file->vectors, (uint64_t)local * bytes,
                                            (uint8_t *)vector, bytes, walk->fault);
  if (status != NARSIL_OK) { return status; }
  for (uint32_t at = 0; at < dimension; at++) {
    if (!isfinite(vector[at])) {
      return invalid_page(walk, &file->vectors, ((uint64_t)local * bytes) + (at * sizeof(float)));
    }
  }
  if (walk->field->metric == NARSIL_METRIC_EUCLIDEAN) {
    *distance = sqrt((double)kernel_squared_distance(walk->request->query, vector, dimension));
  } else {
    double dot = (double)kernel_dot(walk->request->query, vector, dimension);
    if (walk->field->metric == NARSIL_METRIC_DOT_PRODUCT) {
      *distance = -dot;
    } else {
      double magnitude = (double)kernel_magnitude(vector, dimension);
      *distance = walk->magnitude == 0 || magnitude == 0 ? 1 : 1 - (dot / (walk->magnitude * magnitude));
    }
  }
  return NARSIL_OK;
}
