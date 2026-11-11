#ifndef NARSIL_GO_REGION_MEMORY_H
#define NARSIL_GO_REGION_MEMORY_H

#include <stddef.h>

void *narsil_go_region_reserve(size_t bytes);
int narsil_go_region_commit(void *base, size_t bytes);
void narsil_go_region_release(void *base, size_t bytes);
size_t narsil_go_region_page_bytes(void);
void narsil_go_region_zero(void *base, size_t from, size_t to);

#endif
