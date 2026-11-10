#ifndef NARSIL_WORK_TALLY_H
#define NARSIL_WORK_TALLY_H

#include "../../include/narsil_core.h"
#include "../../include/narsil_work.h"

#include <stdint.h>

typedef struct {
  const narsil_work_meter *meter;
  uint32_t pending;
  int64_t headroom;
  narsil_status status;
} work_tally;

int work_meter_valid(const narsil_work_meter *meter);
narsil_status work_tally_begin(work_tally *tally, const narsil_work_meter *meter);
narsil_status work_tally_add(work_tally *tally, uint64_t units);
narsil_status work_tally_flush(work_tally *tally);

#endif
