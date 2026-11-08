#include "regions.h"

#include "../../include/narsil_segments.h"
#include "../../include/narsil_terms.h"
#include "../regions.h"
#include "../terms/table.h"
#include "pools.h"

#include <stddef.h>
#include <stdint.h>

enum { BITS_PER_WORD = 32 };

int segment_region_read(segment_regions *regions, const void *pointer, size_t count, size_t width) {
  if (regions->read_count == SEGMENT_READ_REGIONS ||
      !region_of(pointer, count, width, &regions->reads[regions->read_count])) {
    return 0;
  }
  regions->read_count++;
  return 1;
}

int segment_region_write(segment_regions *regions, const void *pointer, size_t count, size_t width) {
  if (width == 0 || (count > 0 && (uintptr_t)pointer % width != 0) || regions->write_count == SEGMENT_WRITE_REGIONS ||
      !region_of(pointer, count, width, &regions->writes[regions->write_count])) {
    return 0;
  }
  regions->write_count++;
  return 1;
}

int segment_region_input(const segment_regions *regions, const void *pointer, size_t count, size_t width) {
  memory_region input;
  if (!region_of(pointer, count, width, &input)) { return 0; }
  for (size_t index = 0; index < regions->write_count; index++) {
    if (overlaps(input, regions->writes[index])) { return 0; }
  }
  return 1;
}

static int string_regions(segment_regions *regions, const narsil_term_table *table) {
  memory_region held[TERM_TABLE_REGIONS];
  if ((uintptr_t)table->header % _Alignof(uint32_t) != 0 || !term_table_regions(table, held) ||
      regions->write_count > SEGMENT_WRITE_REGIONS - (TERM_TABLE_REGIONS - 1)) {
    return 0;
  }
  if ((uintptr_t)table->slots % _Alignof(int32_t) != 0 || (uintptr_t)table->term_offset % _Alignof(uint32_t) != 0 ||
      (uintptr_t)table->term_length % _Alignof(uint32_t) != 0 ||
      (uintptr_t)table->first_unit_next % _Alignof(uint32_t) != 0 ||
      (uintptr_t)table->first_unit_head % _Alignof(uint32_t) != 0 ||
      (uintptr_t)table->units % _Alignof(uint16_t) != 0) {
    return 0;
  }
  for (size_t index = 1; index < TERM_TABLE_REGIONS; index++) { regions->writes[regions->write_count++] = held[index]; }
  return 1;
}

static int allocation_regions(segment_regions *regions, const narsil_slice_allocator *allocator) {
  if (allocator->class_count == 0 || allocator->class_count > SEGMENT_SLICE_CLASSES ||
      (uintptr_t)allocator->slice_capacities % _Alignof(uint32_t) != 0) {
    return 0;
  }
  return segment_region_read(regions, allocator->slice_capacities, allocator->class_count,
                             sizeof *allocator->slice_capacities) &&
         segment_region_write(regions, allocator->allocation, SEGMENT_POOL_WORDS, sizeof *allocator->allocation) &&
         segment_region_write(regions, allocator->free_heads, allocator->class_count, sizeof *allocator->free_heads);
}

static int surface_regions(segment_regions *regions, const narsil_surface_table *surfaces) {
  return surfaces->capacity == surfaces->strings.offset_count && string_regions(regions, &surfaces->strings) &&
         segment_region_write(regions, surfaces->token, surfaces->capacity, sizeof *surfaces->token) &&
         segment_region_write(regions, surfaces->count, surfaces->capacity, sizeof *surfaces->count);
}

static int run_regions(segment_regions *regions, const narsil_run_table *runs) {
  if (runs->capacity > INT32_MAX || runs->capacity > SIZE_MAX / 3 || runs->member_capacity > UINT32_MAX ||
      runs->slot_capacity < 2 || runs->slot_capacity > (size_t)INT32_MAX + 1 ||
      (runs->slot_capacity & (runs->slot_capacity - 1)) != 0) {
    return 0;
  }
  if (!segment_region_write(regions, runs->header, TERM_HEADER_WORDS, sizeof *runs->header) ||
      !segment_region_write(regions, runs->slots, runs->slot_capacity, sizeof *runs->slots) ||
      !segment_region_write(regions, runs->runs, runs->capacity * 3, sizeof *runs->runs) ||
      !segment_region_write(regions, runs->list_start, runs->capacity, sizeof *runs->list_start) ||
      !segment_region_write(regions, runs->list_length, runs->capacity, sizeof *runs->list_length) ||
      !segment_region_write(regions, runs->list_class, runs->capacity, sizeof *runs->list_class) ||
      !segment_region_write(regions, runs->members, runs->member_capacity, sizeof *runs->members) ||
      !allocation_regions(regions, &runs->allocator)) {
    return 0;
  }
  return runs->header[TERM_COUNT] <= runs->capacity && runs->header[TERM_SLOT_CAPACITY] == runs->slot_capacity;
}

static int column_regions(segment_regions *regions, const narsil_term_columns *columns) {
  size_t count = columns->capacity;
  return segment_region_write(regions, columns->slice_start, count, sizeof *columns->slice_start) &&
         segment_region_write(regions, columns->slice_class, count, sizeof *columns->slice_class) &&
         segment_region_write(regions, columns->lengths, count, sizeof *columns->lengths) &&
         segment_region_write(regions, columns->doc_frequency, count, sizeof *columns->doc_frequency) &&
         segment_region_write(regions, columns->dead_documents, count, sizeof *columns->dead_documents) &&
         segment_region_write(regions, columns->total_term_frequency, count, sizeof *columns->total_term_frequency) &&
         segment_region_write(regions, columns->surface_occurrences, count, sizeof *columns->surface_occurrences) &&
         segment_region_write(regions, columns->revision, count, sizeof *columns->revision) &&
         segment_region_write(regions, columns->flags, count, sizeof *columns->flags);
}

static int posting_regions(segment_regions *regions, const narsil_posting_pool *pool) {
  if (pool->capacity > UINT32_MAX) { return 0; }
  return segment_region_write(regions, pool->doc_ids, pool->capacity, sizeof *pool->doc_ids) &&
         segment_region_write(regions, pool->frequencies, pool->capacity, sizeof *pool->frequencies) &&
         segment_region_write(regions, pool->field_indices, pool->capacity, sizeof *pool->field_indices) &&
         (pool->position_starts == NULL ||
          segment_region_write(regions, pool->position_starts, pool->capacity, sizeof *pool->position_starts)) &&
         allocation_regions(regions, &pool->allocator);
}

static int optional_regions(segment_regions *regions, const narsil_growing_segment *segment) {
  if ((uintptr_t)segment->positions % _Alignof(narsil_position_pool) != 0 ||
      (uintptr_t)segment->surfaces % _Alignof(narsil_surface_table) != 0 ||
      (uintptr_t)segment->spellings % _Alignof(narsil_spelling_table) != 0) {
    return 0;
  }
  const narsil_position_pool *positions = segment->positions;
  if (positions != NULL &&
      (positions->capacity > UINT32_MAX || segment->postings.position_starts == NULL ||
       !segment_region_read(regions, positions, 1, sizeof *positions) ||
       !segment_region_write(regions, positions->values, positions->capacity, sizeof *positions->values) ||
       !segment_region_write(regions, positions->allocation, SEGMENT_POOL_WORDS, sizeof *positions->allocation))) {
    return 0;
  }
  if (segment->surfaces != NULL && (!segment_region_read(regions, segment->surfaces, 1, sizeof *segment->surfaces) ||
                                    !surface_regions(regions, segment->surfaces))) {
    return 0;
  }
  const narsil_spelling_table *spellings = segment->spellings;
  if (spellings != NULL && (!segment_region_read(regions, spellings, 1, sizeof *spellings) ||
                            !surface_regions(regions, &spellings->entries) ||
                            !segment_region_write(regions, spellings->code_points, spellings->entries.capacity,
                                                  sizeof *spellings->code_points) ||
                            !run_regions(regions, &spellings->runs))) {
    return 0;
  }
  return 1;
}

int segment_write_regions(segment_regions *regions, const narsil_growing_segment *segment) {
  if (segment == NULL || (uintptr_t)segment % _Alignof(narsil_growing_segment) != 0 ||
      segment->field_count > (uint32_t)UINT16_MAX + 1 || segment->columns.capacity != segment->terms.offset_count ||
      (segment->field_count > 0 && segment->ordinal_capacity > SIZE_MAX / segment->field_count)) {
    return 0;
  }
  size_t lengths = (size_t)segment->ordinal_capacity * segment->field_count;
  size_t words = segment->ordinal_capacity == 0 ? 1 : (((size_t)segment->ordinal_capacity - 1) / BITS_PER_WORD) + 1;
  if (!segment_region_read(regions, segment, 1, sizeof *segment) || !string_regions(regions, &segment->terms) ||
      !column_regions(regions, &segment->columns) || !posting_regions(regions, &segment->postings) ||
      !optional_regions(regions, segment) ||
      !segment_region_read(regions, segment->partial_fields, segment->field_count, sizeof *segment->partial_fields) ||
      !segment_region_write(regions, segment->retired, words, sizeof *segment->retired) ||
      !segment_region_write(regions, segment->field_lengths, lengths, sizeof *segment->field_lengths) ||
      !segment_region_write(regions, segment->total_documents, 1, sizeof *segment->total_documents) ||
      !segment_region_write(regions, segment->total_field_lengths, segment->field_count,
                            sizeof *segment->total_field_lengths)) {
    return 0;
  }
  for (size_t index = 0; index < regions->write_count; index++) {
    for (size_t other = 0; other < index; other++) {
      if (overlaps(regions->writes[index], regions->writes[other])) { return 0; }
    }
    for (size_t other = 0; other < regions->read_count; other++) {
      if (overlaps(regions->writes[index], regions->reads[other])) { return 0; }
    }
  }
  for (size_t field = 0; field < segment->field_count; field++) {
    if (segment->partial_fields[field] > 1 || (segment->partial_fields[field] != 0 && segment->spellings == NULL)) {
      return 0;
    }
  }
  return 1;
}
