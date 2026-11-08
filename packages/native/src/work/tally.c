#include "tally.h"

#include "../../include/narsil_core.h"
#include "../../include/narsil_work.h"
#include "../regions.h"
#include "constants.h"

#include <stdalign.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdint.h>

int work_meter_valid(const narsil_work_meter *meter) {
  if (meter == NULL || meter->cap < 0 || meter->spent == NULL || meter->stop == NULL ||
      (uintptr_t)meter->spent % alignof(_Atomic(int64_t)) != 0 ||
      (uintptr_t)meter->stop % alignof(_Atomic(uint32_t)) != 0) {
    return 0;
  }
  memory_region spent;
  memory_region stop;
  memory_region descriptor;
  if (!region_of(meter->spent, 1, sizeof *meter->spent, &spent) ||
      !region_of(meter->stop, 1, sizeof *meter->stop, &stop) || !region_of(meter, 1, sizeof *meter, &descriptor) ||
      overlaps(spent, stop) || overlaps(spent, descriptor)) {
    return 0;
  }
  return atomic_load((const _Atomic(int64_t) *)meter->spent) >= 0 &&
         atomic_load((const _Atomic(uint32_t) *)meter->stop) <= 1;
}

static narsil_status stopped(const narsil_work_meter *meter) {
  if (atomic_load((const _Atomic(uint32_t) *)meter->stop) != 0 ||
      (meter->deadline != 0 && narsil_clock_now() > meter->deadline)) {
    return NARSIL_STOPPED;
  }
  return NARSIL_OK;
}

narsil_status work_tally_begin(work_tally *tally, const narsil_work_meter *meter) {
  tally->meter = meter;
  tally->pending = 0;
  tally->headroom = 0;
  tally->status = NARSIL_INVALID_ARGUMENT;
  if (!work_meter_valid(meter)) { return tally->status; }
  int64_t spent = atomic_load((const _Atomic(int64_t) *)meter->spent);
  tally->headroom = meter->cap - spent;
  tally->status = spent > meter->cap ? NARSIL_WORK_CAP_EXCEEDED : stopped(meter);
  return tally->status;
}

static narsil_status add_shared(work_tally *tally) {
  _Atomic(int64_t) *counter = (_Atomic(int64_t) *)tally->meter->spent;
  int64_t previous = atomic_load(counter);
  for (;;) {
    if (previous < 0 || previous > INT64_MAX - (int64_t)tally->pending) { return NARSIL_WORK_CAP_EXCEEDED; }
    int64_t next = previous + (int64_t)tally->pending;
    if (atomic_compare_exchange_weak(counter, &previous, next)) {
      tally->headroom = tally->meter->cap - next;
      return next > tally->meter->cap ? NARSIL_WORK_CAP_EXCEEDED : NARSIL_OK;
    }
  }
}

narsil_status work_tally_flush(work_tally *tally) {
  if (tally->status != NARSIL_OK) { return tally->status; }
  if (tally->pending > 0) {
    tally->status = add_shared(tally);
    tally->pending = 0;
  }
  if (tally->status == NARSIL_OK) { tally->status = stopped(tally->meter); }
  return tally->status;
}

narsil_status work_tally_add(work_tally *tally, uint64_t units) {
  while (units > 0 && tally->status == NARSIL_OK) {
    uint32_t available = NARSIL_WORK_FLUSH_UNITS - tally->pending;
    uint32_t kept = units < available ? (uint32_t)units : available;
    tally->pending += kept;
    units -= kept;
    if (tally->pending == NARSIL_WORK_FLUSH_UNITS || (int64_t)tally->pending > tally->headroom) {
      (void)work_tally_flush(tally);
    }
  }
  return tally->status;
}
