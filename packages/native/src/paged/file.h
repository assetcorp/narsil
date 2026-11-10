#ifndef NARSIL_PAGED_FILE_H
#define NARSIL_PAGED_FILE_H

#include "../../include/narsil_paged.h"

#include <stddef.h>
#include <stdint.h>

struct narsil_paged_file {
#ifdef _WIN32
  void *descriptor;
#else
  int descriptor;
#endif
  uint64_t length;
  uint64_t identity;
};

narsil_status paged_open(narsil_paged_file *file, const char *path);
void paged_close(narsil_paged_file *file);
narsil_status paged_read(const narsil_paged_file *file, uint64_t offset, uint8_t *into, size_t length);

#endif
