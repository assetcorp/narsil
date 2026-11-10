#include "allocation_failures.h"
#include "fixture.h"

#include "../include/narsil_analysis.h"
#include "../include/narsil_core.h"

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define FNV64_PRIME UINT64_C(1099511628211)
#define BYTE_BITS 8U
#define WORD_BYTES 8U
#define MAX_ALLOCATIONS_PER_CALL 200000U
#define MAX_REFUSED_SITES 512U
#define MESSAGE_BYTES 512U
#define UNICODE_TABLE_ALLOCATIONS 2U

typedef struct {
  uint64_t seen;
  uint64_t target;
  uint64_t refusals;
  int persistent;
} allocation_gate;

static allocation_gate gate;
static const char *refused_sites[MAX_REFUSED_SITES];
static size_t refused_site_count;

#ifdef NARSIL_ALLOCATION_FAILURE_TESTS

#include "../src/allocation.h"

static void note_refused_site(const char *site) {
  for (size_t at = 0; at < refused_site_count; at++) {
    if (strcmp(refused_sites[at], site) == 0) { return; }
  }
  if (refused_site_count < MAX_REFUSED_SITES) {
    refused_sites[refused_site_count++] = site;
  } else {
    report("the allocation-failure test refused more distinct allocation sites than it records");
  }
}

int allocation_refused(const char *site) {
  if (gate.target == 0) { return 0; }
  gate.seen++;
  if (gate.seen < gate.target || (gate.seen > gate.target && !gate.persistent)) { return 0; }
  gate.refusals++;
  note_refused_site(site);
  return 1;
}

#define ALLOCATION_FAILURES_BUILT 1

#else

#define ALLOCATION_FAILURES_BUILT 0

#endif

static void arm(uint64_t target, int persistent) { gate = (allocation_gate){0, target, 0, persistent}; }

static uint64_t disarm(void) {
  uint64_t refusals = gate.refusals;
  gate = (allocation_gate){0};
  return refusals;
}

uint64_t digest_bytes(uint64_t digest, const void *bytes, size_t length) {
  const uint8_t *view = bytes;
  for (size_t at = 0; at < length; at++) { digest = (digest ^ view[at]) * FNV64_PRIME; }
  return digest;
}

uint64_t digest_word(uint64_t digest, uint64_t word) {
  for (uint32_t byte = 0; byte < WORD_BYTES; byte++) {
    digest = (digest ^ ((word >> (byte * BYTE_BITS)) & UINT8_MAX)) * FNV64_PRIME;
  }
  return digest;
}

static void report_call(const failing_call *call, uint64_t target, int persistent, const char *what,
                        narsil_status status) {
  char message[MESSAGE_BYTES];
  int written = snprintf(message, sizeof message, "%s, refusing allocation %llu%s: %s (status %d)", call->name,
                         (unsigned long long)target, persistent ? " and every later one" : "", what, (int)status);
  check(0, written < 0 ? what : message);
}

typedef struct {
  uint64_t refusals;
  uint64_t digest;
  uint64_t target;
  int persistent;
} attempt_outcome;

static attempt_outcome attempt(const failing_call *call, uint64_t target, int persistent) {
  attempt_outcome outcome = {0, 0, target, persistent};
  void *inputs = call->prepare();
  narsil_workspace *workspace = NULL;
  if (inputs == NULL || narsil_workspace_create(&workspace) != NARSIL_OK) {
    report_call(call, target, persistent, "the inputs have no memory", NARSIL_OUT_OF_MEMORY);
    outcome.refusals = UINT64_MAX;
    if (inputs != NULL) { call->release(inputs); }
    return outcome;
  }
  arm(target, persistent);
  narsil_status status = call->call(workspace, inputs);
  outcome.refusals = disarm();
  if (outcome.refusals == 0) {
    if (status != NARSIL_OK) {
      report_call(call, target, persistent, "the call fails with no refused allocation", status);
    }
  } else if (status == NARSIL_OUT_OF_MEMORY) {
    status = call->call(workspace, inputs);
    if (status != NARSIL_OK) {
      report_call(call, target, persistent, "the call fails again once memory returns", status);
    }
  } else if (status != NARSIL_OK) {
    report_call(call, target, persistent, "a refused allocation returns another status", status);
  }
  outcome.digest = call->digest(inputs);
  call->release(inputs);
  narsil_workspace_destroy(workspace);
  return outcome;
}

typedef struct {
  attempt_outcome *outcomes;
  size_t count;
  size_t capacity;
} recorded_digests;

static int record_digest(recorded_digests *digests, const attempt_outcome *outcome) {
  if (digests->count == digests->capacity) {
    size_t capacity = digests->capacity == 0 ? MESSAGE_BYTES : digests->capacity * 2;
    attempt_outcome *outcomes = realloc(digests->outcomes, capacity * sizeof *outcomes);
    if (outcomes == NULL) { return 0; }
    digests->outcomes = outcomes;
    digests->capacity = capacity;
  }
  digests->outcomes[digests->count++] = *outcome;
  return 1;
}

void refuse_each_allocation(const failing_call *call) {
  recorded_digests digests = {NULL, 0, 0};
  uint64_t expected = 0;
  int completed = 0;
  for (uint64_t target = 1; target <= MAX_ALLOCATIONS_PER_CALL && !completed; target++) {
    for (int persistent = 0; persistent < 2; persistent++) {
      attempt_outcome outcome = attempt(call, target, persistent);
      if (outcome.refusals == UINT64_MAX) {
        completed = -1;
        break;
      }
      if (outcome.refusals == 0) {
        expected = outcome.digest;
        completed = 1;
        break;
      }
      if (!record_digest(&digests, &outcome)) {
        report_call(call, target, persistent, "the digest record has no memory", NARSIL_OUT_OF_MEMORY);
        completed = -1;
        break;
      }
    }
  }
  if (completed == 0) { report_call(call, MAX_ALLOCATIONS_PER_CALL, 0, "the call never completes", NARSIL_OK); }
  for (size_t at = 0; completed == 1 && at < digests.count; at++) {
    const attempt_outcome *outcome = digests.outcomes + at;
    if (outcome->digest != expected) {
      report_call(call, outcome->target, outcome->persistent,
                  "the outputs after a refused allocation differ from a clean call", NARSIL_OK);
    }
  }
  free(digests.outcomes);
}

static void unicode_table_refusals(void) {
  for (uint64_t target = 1; target <= UNICODE_TABLE_ALLOCATIONS; target++) {
    narsil_analyser *analyser = NULL;
    arm(target, 0);
    narsil_status status = narsil_analyser_create(&analyser);
    uint64_t refusals = disarm();
    check(refusals == 1 && status == NARSIL_OUT_OF_MEMORY && analyser == NULL,
          "a refused Unicode table allocation leaves no analyser");
    narsil_analyser_destroy(analyser);
  }
}

static void workspace_refusal(void) {
  narsil_workspace *workspace = NULL;
  arm(1, 0);
  narsil_status status = narsil_workspace_create(&workspace);
  uint64_t refusals = disarm();
  check(refusals == 1 && status == NARSIL_OUT_OF_MEMORY && workspace == NULL,
        "a refused workspace allocation leaves no workspace");
  narsil_workspace_destroy(workspace);
}

static void report_refused_sites(void) {
  for (size_t at = 0; at < refused_site_count; at++) {
    if (printf("refused allocation site %s\n", refused_sites[at]) < 0) { report("the refused sites cannot print"); }
  }
}

void allocation_failure_checks(void) {
  if (!ALLOCATION_FAILURES_BUILT) {
    report("the allocation-failure checks need a build with NARSIL_ALLOCATION_FAILURE_TESTS defined");
    return;
  }
  unicode_table_refusals();
  workspace_refusal();
  analysis_allocation_failures();
  graph_allocation_failures();
  query_allocation_failures();
  pattern_allocation_failures();
  segment_allocation_failures();
  frozen_allocation_failures();
  paged_posting_allocation_failures();
  paged_vector_allocation_failures();
  report_refused_sites();
}
