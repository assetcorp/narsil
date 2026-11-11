#include "HybridNarsilCoreImpl.hpp"
#include "PagedVectorInput.hpp"
#include "PagedVectorSnapshot.hpp"
#include "core/src/regions.h"

#include <NitroModules/JSIConverter.hpp>
#include <NitroModules/Promise.hpp>
#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

namespace {
enum { FIELD, REQUEST, CACHE, METER, STOP, DEADLINE, ORDINALS, SCORES, FAULT, ARGUMENTS };

void disjoint(const void* input, size_t inputBytes, const void* output, size_t count, size_t width) {
  memory_region source{};
  memory_region destination{};
  if (!region_of(input, inputBytes, 1, &source) || !region_of(output, count, width, &destination) ||
      overlaps(source, destination)) throwInvalid("The paged input overlaps an output");
}

void checkCopiedInput(const void* input, size_t bytes, const narsil_page_cache& cache,
                     const narsil_paged_vector_output& output, const narsil_page_fault* fault, const int64_t* spent) {
  disjoint(input, bytes, output.ordinals, output.ordinal_capacity, sizeof *output.ordinals);
  disjoint(input, bytes, output.scores, output.score_capacity, sizeof *output.scores);
  disjoint(input, bytes, fault, 1, sizeof *fault);
  disjoint(input, bytes, spent, 1, sizeof *spent);
  disjoint(input, bytes, cache.bytes, cache.byte_capacity, 1);
  disjoint(input, bytes, cache.files, cache.slots, sizeof *cache.files);
  disjoint(input, bytes, cache.offsets, cache.slots, sizeof *cache.offsets);
  disjoint(input, bytes, cache.pages, cache.slots, sizeof *cache.pages);
  disjoint(input, bytes, cache.lengths, cache.slots, sizeof *cache.lengths);
  disjoint(input, bytes, cache.checksums, cache.slots, sizeof *cache.checksums);
}
}

jsi::Value HybridNarsilCoreImpl::pagedVectors(jsi::Runtime& runtime, const jsi::Value* arguments,
                                             size_t count, bool asynchronous) try {
  if (count != ARGUMENTS) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedVectorInput field;
  PagedQueryInput query;
  PagedCacheInput cache;
  field.prepare(runtime, arguments[FIELD]);
  query.prepare(runtime, arguments[REQUEST]);
  cache.prepare(runtime, arguments[CACHE]);
  TypedElements regions(ARGUMENTS);
  for (size_t at = METER; at < ARGUMENTS; at++) regions.prepare(runtime, at, arguments[at]);
  auto job = asynchronous ? std::make_shared<PagedVectorSnapshot>() : nullptr;
  if (job != nullptr) {
    cache.retain(runtime, job->buffers);
    for (size_t at = METER; at < ARGUMENTS; at++) {
      if (at != DEADLINE) job->buffers.push_back(regions.retainOwned(runtime, at));
    }
    job->files = field.filesHeld();
  }
  auto descriptor = field.read(runtime);
  auto request = query.read(runtime);
  auto pages = cache.read(runtime);
  auto meter = regions.read<int64_t>(runtime, METER, "The search work meter");
  auto stop = regions.read<uint32_t>(runtime, STOP, "The search stop flag");
  auto deadline = regions.read<const uint64_t>(runtime, DEADLINE, "The search deadline");
  auto ordinals = regions.read<uint32_t>(runtime, ORDINALS, "The candidate ordinals");
  auto scores = regions.read<double>(runtime, SCORES, "The candidate scores");
  auto fault = regions.read<uint64_t>(runtime, FAULT, "The page fault");
  if (meter.length != 2 || stop.length != 1 || deadline.length != 1 || fault.length != 3) {
    return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  }
  request.meter = {meter.data, meter.data[1], stop.data, deadline.data[0]};
  narsil_paged_vector_output output{ordinals.data, ordinals.length, scores.data, scores.length};
  auto pageFault = reinterpret_cast<narsil_page_fault*>(fault.data);
  checkCopiedInput(meter.data + 1, sizeof *meter.data, pages, output, pageFault, meter.data);
  checkCopiedInput(deadline.data, sizeof *deadline.data, pages, output, pageFault, meter.data);
  uint32_t written = 0;
  if (job == nullptr) {
    auto status = narsil_search_paged_vectors(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                               &descriptor, &request, &output, &written, pageFault);
    return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
  }
  auto validation = request;
  validation.k = 0;
  auto status = narsil_search_paged_vectors(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                             &descriptor, &validation, &output, &written, pageFault);
  if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
  job->copyInputs(descriptor, request);
  job->cache = pages;
  job->output = output;
  job->fault = pageFault;
  narsil_workspace* created = nullptr;
  status = narsil_workspace_create(&created);
  if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
  job->workspace.reset(created);
  auto promise = Promise<double>::async([job]() { return job->search(); });
  return JSIConverter<std::shared_ptr<Promise<double>>>::toJSI(runtime, promise);
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::searchPagedVectors(jsi::Runtime& runtime, const jsi::Value&,
                                                   const jsi::Value* arguments, size_t count) {
  return pagedVectors(runtime, arguments, count, false);
}

jsi::Value HybridNarsilCoreImpl::searchPagedVectorsAsync(jsi::Runtime& runtime, const jsi::Value&,
                                                        const jsi::Value* arguments, size_t count) {
  return pagedVectors(runtime, arguments, count, true);
}

}
