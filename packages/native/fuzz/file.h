#ifndef NARSIL_FUZZ_FILE_H
#define NARSIL_FUZZ_FILE_H

#include <stddef.h>
#include <stdint.h>

#define FUZZ_CHECKSUM_BYTES 4U

typedef struct {
  const uint8_t *bytes;
  uint64_t available;
  uint64_t length;
  uint64_t page_bytes;
} fuzz_page_source;

const char *fuzz_file_write(const uint8_t *bytes, size_t length);
void fuzz_page_checksums(fuzz_page_source source, uint8_t *checksums, uint64_t pages);

#endif
