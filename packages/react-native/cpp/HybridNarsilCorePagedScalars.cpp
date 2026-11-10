#include "HybridNarsilCoreImpl.hpp"
#include "PagedInput.hpp"

#include <new>
#include <stdexcept>

namespace margelo::nitro::narsil {

jsi::Value HybridNarsilCoreImpl::readPagedTotals(jsi::Runtime& runtime, const jsi::Value&,
                                               const jsi::Value* arguments, size_t count) try {
  if (count != 6) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput section;
  PagedCacheInput cache;
  section.prepare(runtime, arguments[0]);
  cache.prepare(runtime, arguments[1]);
  auto first = pagedWhole(arguments[2]);
  auto totals = pagedWhole(arguments[3]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[4]);
  regions.prepare(runtime, 1, arguments[5]);
  auto descriptor = section.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<double>(runtime, 0, "The term totals");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto status = narsil_read_paged_totals(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                       &descriptor, {first, totals}, output.data, output.length,
                                       reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::readPagedOrdinal(jsi::Runtime& runtime, const jsi::Value&,
                                                const jsi::Value* arguments, size_t count) try {
  if (count != 6) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput section;
  PagedCacheInput cache;
  section.prepare(runtime, arguments[0]);
  cache.prepare(runtime, arguments[1]);
  auto position = pagedWhole(arguments[2]);
  auto documents = pagedWhole(arguments[3]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[4]);
  regions.prepare(runtime, 1, arguments[5]);
  auto descriptor = section.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<uint32_t>(runtime, 0, "The document ordinal");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto status = narsil_read_paged_ordinal(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                        &descriptor, {position, documents}, output.data, output.length,
                                        reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::readPagedWriteRecord(jsi::Runtime& runtime, const jsi::Value&,
                                                    const jsi::Value* arguments, size_t count) try {
  if (count != 6) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput sequenceSection;
  PagedSectionInput termSection;
  PagedCacheInput cache;
  sequenceSection.prepare(runtime, arguments[0]);
  termSection.prepare(runtime, arguments[1]);
  cache.prepare(runtime, arguments[2]);
  auto ordinal = pagedWhole(arguments[3]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[4]);
  regions.prepare(runtime, 1, arguments[5]);
  auto sequences = sequenceSection.read(runtime);
  auto terms = termSection.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<uint64_t>(runtime, 0, "The write record");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto status = narsil_read_paged_write_record(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                             {&sequences, &terms, ordinal}, {output.data, output.length},
                                             reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
