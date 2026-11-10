#include "HybridNarsilCoreImpl.hpp"
#include "PagedInput.hpp"
extern "C" {
#include "core/src/paged/cache.h"
}

#include <NitroModules/JSIConverter.hpp>
#include <NitroModules/Promise.hpp>
#include <new>
#include <stdexcept>
#include <vector>

namespace margelo::nitro::narsil {

namespace {
struct PageRead {
  PagedFile file;
  std::vector<std::shared_ptr<ArrayBuffer>> buffers;
  std::vector<uint8_t> checksums;
  std::unique_ptr<narsil_workspace, WorkspaceRelease> workspace;
  narsil_page_section section{};
  narsil_page_cache cache{};
  uint64_t page = 0;
  uint8_t* output = nullptr;
  size_t capacity = 0;
  narsil_page_fault* fault = nullptr;

  double read() {
    return -static_cast<double>(narsil_read_page(workspace.get(), &cache, &section, page, output, capacity, fault));
  }
};
}

jsi::Value HybridNarsilCoreImpl::readPageAsync(jsi::Runtime& runtime, const jsi::Value&,
                                             const jsi::Value* arguments, size_t count) try {
  if (count != 5) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput section;
  PagedCacheInput cache;
  section.prepare(runtime, arguments[0]);
  cache.prepare(runtime, arguments[1]);
  uint64_t page = pagedUint64(runtime, arguments[2]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[3]);
  regions.prepare(runtime, 1, arguments[4]);
  auto job = std::make_shared<PageRead>();
  cache.retain(runtime, job->buffers);
  for (size_t at = 0; at < 2; at++) job->buffers.push_back(regions.retainOwned(runtime, at));
  job->file = section.file;
  job->section = section.read(runtime);
  job->cache = cache.read(runtime);
  job->page = page;
  auto output = regions.read<uint8_t>(runtime, 0, "The page output");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  job->output = output.data;
  job->capacity = output.length;
  job->fault = reinterpret_cast<narsil_page_fault*>(fault.data);
  if (fault.length != 3 || !paged_regions(&job->cache, &job->section, output.data, output.length, job->fault)) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  if (job->section.checksum_bytes > 0) {
    job->checksums.assign(job->section.checksums, job->section.checksums + job->section.checksum_bytes);
  }
  job->section.checksums = job->checksums.data();
  narsil_workspace* created = nullptr;
  auto status = narsil_workspace_create(&created);
  if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
  job->workspace.reset(created);
  auto promise = Promise<double>::async([job]() { return job->read(); });
  return JSIConverter<std::shared_ptr<Promise<double>>>::toJSI(runtime, promise);
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
