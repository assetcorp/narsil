#ifndef NARSIL_PATTERN_SIMULATION_H
#define NARSIL_PATTERN_SIMULATION_H

#include "../../include/narsil_core.h"
#include "../analysis/text.h"
#include "program.h"

#include <stddef.h>
#include <stdint.h>

enum { PATTERN_CONTEXTS = 9, PATTERN_EDGE_KINDS = 3 };
enum { PATTERN_MATCH_REACHED = -1, PATTERN_CLOSURE_UNKNOWN = -2 };
enum { PATTERN_STEP_CONTINUES, PATTERN_STEP_MATCHED, PATTERN_STEP_DEAD };

typedef struct {
  narsil_code_points marks;
  narsil_code_points stack;
  narsil_code_points candidates;
  narsil_code_points after;
  narsil_code_points starts;
  int32_t start_counts[PATTERN_CONTEXTS];
  uint32_t stamp;
  uint32_t previous_kind;
  uint32_t steps;
} pattern_simulation;

typedef struct {
  const uint32_t *seeds;
  size_t count;
  uint32_t context;
  uint32_t from_start;
} pattern_closure_request;

int32_t pattern_close(const pattern_program *program, pattern_simulation *scratch,
                      const pattern_closure_request *request);
uint32_t pattern_point_kind(uint32_t point);
narsil_status pattern_simulation_prepare(pattern_program *program, pattern_simulation *scratch);
void pattern_simulation_reset(pattern_simulation *scratch);
uint32_t pattern_simulation_step(const pattern_program *program, pattern_simulation *scratch, uint32_t point);
int pattern_simulation_end(const pattern_program *program, pattern_simulation *scratch);

#endif
