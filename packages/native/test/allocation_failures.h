#ifndef NARSIL_TEST_ALLOCATION_FAILURES_H
#define NARSIL_TEST_ALLOCATION_FAILURES_H

#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>

#define ALLOCATION_FAILURES_ONLY "allocation-failures"
#define DIGEST_START UINT64_C(14695981039346656037)

typedef struct {
  const char *name;
  void *(*prepare)(void);
  narsil_status (*call)(narsil_workspace *workspace, void *inputs);
  uint64_t (*digest)(const void *inputs);
  void (*release)(void *inputs);
} failing_call;

uint64_t digest_bytes(uint64_t digest, const void *bytes, size_t length);
uint64_t digest_word(uint64_t digest, uint64_t word);
void refuse_each_allocation(const failing_call *call);
void allocation_failure_checks(void);

void analysis_allocation_failures(void);
void graph_allocation_failures(void);
void query_allocation_failures(void);
void group_allocation_failures(void);
void sort_value_allocation_failures(void);
void sort_order_allocation_failures(void);
void pattern_allocation_failures(void);
void segment_allocation_failures(void);
void frozen_allocation_failures(void);
void paged_posting_allocation_failures(void);
void paged_vector_allocation_failures(void);

#endif
