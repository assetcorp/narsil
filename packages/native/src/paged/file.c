#include "file.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_paged.h"

#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>

static _Atomic uint64_t next_identity = 1;

static uint64_t take_identity(void) {
  uint64_t next = atomic_load_explicit(&next_identity, memory_order_relaxed);
  while (next < UINT64_MAX) {
    if (atomic_compare_exchange_weak_explicit(&next_identity, &next, next + 1, memory_order_relaxed,
                                              memory_order_relaxed)) {
      return next;
    }
  }
  return 0;
}

narsil_status narsil_paged_file_open(const char *path, narsil_paged_file **file) {
  if (path == NULL || file == NULL) { return NARSIL_INVALID_ARGUMENT; }
  narsil_paged_file *created = calloc(1, sizeof *created);
  if (created == NULL) { return NARSIL_OUT_OF_MEMORY; }
  created->identity = take_identity();
  narsil_status status = created->identity == 0 ? NARSIL_OUT_OF_MEMORY : paged_open(created, path);
  if (status != NARSIL_OK) {
    free(created);
    return status;
  }
  *file = created;
  return NARSIL_OK;
}

void narsil_paged_file_close(narsil_paged_file *file) {
  if (file == NULL) { return; }
  paged_close(file);
  free(file);
}

uint64_t narsil_paged_file_length(const narsil_paged_file *file) { return file == NULL ? 0 : file->length; }
uint64_t narsil_paged_file_identity(const narsil_paged_file *file) { return file == NULL ? 0 : file->identity; }
