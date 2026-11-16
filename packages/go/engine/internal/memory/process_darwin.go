//go:build darwin && cgo

package memory

/*
#include <mach/mach.h>
#include <stdint.h>
#include <sys/sysctl.h>
#include <sys/types.h>

static int narsil_go_unbacked_resident_bytes(uint64_t *bytes) {
  task_vm_info_data_t vm;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&vm, &count) == KERN_SUCCESS && vm.resident_size > 0) {
    *bytes = vm.resident_size > vm.external ? vm.resident_size - vm.external : 0;
    return 1;
  }
  mach_task_basic_info_data_t basic;
  count = MACH_TASK_BASIC_INFO_COUNT;
  if (task_info(mach_task_self(), MACH_TASK_BASIC_INFO, (task_info_t)&basic, &count) != KERN_SUCCESS) {
    return 0;
  }
  *bytes = basic.resident_size;
  return 1;
}

static int narsil_go_host_memory_bytes(uint64_t *bytes) {
  uint64_t held = 0;
  size_t length = sizeof(held);
  if (sysctlbyname("hw.memsize", &held, &length, NULL, 0) != 0 || length != sizeof(held) || held == 0) {
    return 0;
  }
  *bytes = held;
  return 1;
}
*/
import "C"

func platformProcessBytes() (uint64, bool) {
	var bytes C.uint64_t
	if C.narsil_go_unbacked_resident_bytes(&bytes) == 0 {
		return 0, false
	}
	return uint64(bytes), true
}

func platformLimitBytes(uint64) (uint64, bool) {
	var bytes C.uint64_t
	if C.narsil_go_host_memory_bytes(&bytes) == 0 {
		return 0, false
	}
	return uint64(bytes), true
}
