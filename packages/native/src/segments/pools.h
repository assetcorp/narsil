#ifndef NARSIL_SEGMENT_POOLS_H
#define NARSIL_SEGMENT_POOLS_H

#include "../../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

enum { SEGMENT_POOL_END, SEGMENT_POOL_FREE, SEGMENT_POOL_WORDS };
enum { SEGMENT_NO_SLICE = UINT8_MAX, SEGMENT_SLICE_CLASSES = UINT8_MAX };

typedef struct {
  uint32_t *values;
  size_t capacity;
  uint32_t *allocation;
  uint32_t *free_heads;
  const uint32_t *slice_capacities;
  size_t class_count;
} segment_pool;

typedef struct {
  uint32_t start;
  uint32_t length;
  uint8_t slice_class;
} segment_slice;

typedef struct {
  uint32_t heads[SEGMENT_SLICE_CLASSES];
  uint32_t end;
  uint32_t free_entries;
  segment_slice *slices;
  uint32_t *used;
  size_t capacity;
  size_t used_capacity;
  size_t count;
} segment_pool_plan;

narsil_status segment_pool_reserve(segment_pool_plan *plan, size_t capacity);
narsil_status segment_pool_begin(segment_pool_plan *plan, const segment_pool *pool);
narsil_status segment_pool_allocate(segment_pool_plan *plan, const segment_pool *pool, uint32_t length,
                                    segment_slice *slice);
void segment_pool_publish(const segment_pool_plan *plan, const segment_pool *pool);
narsil_status segment_pool_check(segment_pool_plan *plan);
void segment_pool_release_slice(const segment_pool *pool, segment_slice slice);
narsil_status segment_pool_trim_class(const segment_pool *pool, uint8_t source, uint32_t kept, uint8_t *target);
void segment_pool_trim_slice(const segment_pool *pool, segment_slice source, uint8_t target);
void segment_pool_release(segment_pool_plan *plan);
size_t segment_pool_bytes(const segment_pool_plan *plan);

#endif
