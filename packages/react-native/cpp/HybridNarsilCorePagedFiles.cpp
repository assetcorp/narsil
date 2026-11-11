#include "HybridNarsilCoreImpl.hpp"
#include "PagedInput.hpp"

#include <new>
#include <stdexcept>
#include <string>

namespace margelo::nitro::narsil {

narsil_workspace* HybridNarsilCoreImpl::pagedWorkspace(jsi::Runtime& runtime) {
  auto& held = stateOf(runtime);
  if (held.keywordWorkspace == nullptr) {
    narsil_workspace* created = nullptr;
    if (narsil_workspace_create(&created) != NARSIL_OK) throw std::bad_alloc();
    held.keywordWorkspace.reset(created);
  }
  return held.keywordWorkspace.get();
}

jsi::Value HybridNarsilCoreImpl::openPagedFile(jsi::Runtime& runtime, const jsi::Value&,
                                              const jsi::Value* arguments, size_t count) try {
  if (count != 1 || !arguments[0].isString()) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto path = arguments[0].getString(runtime).utf8(runtime);
  if (path.find('\0') != std::string::npos) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto state = std::make_shared<PagedFileState>();
  narsil_paged_file* file = nullptr;
  auto status = narsil_paged_file_open(path.c_str(), &file);
  if (status != NARSIL_OK) return jsi::Value(-static_cast<double>(status));
  state->file = PagedFile(file, PagedFileRelease{});
  jsi::Object result(runtime);
  result.setNativeState(runtime, state);
  result.setProperty(runtime, "identity", jsi::BigInt::fromUint64(runtime, narsil_paged_file_identity(file)));
  result.setProperty(runtime, "length", jsi::BigInt::fromUint64(runtime, narsil_paged_file_length(file)));
  return result;
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::closePagedFile(jsi::Runtime& runtime, const jsi::Value&,
                                               const jsi::Value* arguments, size_t count) try {
  if (count != 1) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  pagedFileState(runtime, arguments[0])->file.reset();
  return jsi::Value(0);
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
}

jsi::Value HybridNarsilCoreImpl::readPage(jsi::Runtime& runtime, const jsi::Value&,
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
  auto descriptor = section.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<uint8_t>(runtime, 0, "The page output");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto status = narsil_read_page(pagedWorkspace(runtime), cache.present ? &pages : nullptr, &descriptor, page,
                                  output.data, output.length, reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::readPagedPostings(jsi::Runtime& runtime, const jsi::Value&,
                                                const jsi::Value* arguments, size_t count) try {
  if (count != 8) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput section;
  PagedCacheInput cache;
  section.prepare(runtime, arguments[0]);
  cache.prepare(runtime, arguments[1]);
  auto first = pagedWhole(arguments[2]);
  auto postings = pagedWhole(arguments[3]);
  auto documents = pagedWhole(arguments[4]);
  auto fields = pagedWhole(arguments[5]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[6]);
  regions.prepare(runtime, 1, arguments[7]);
  auto descriptor = section.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<uint8_t>(runtime, 0, "The posting output");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto status = narsil_read_paged_postings(pagedWorkspace(runtime), cache.present ? &pages : nullptr, &descriptor,
                                         {first, postings, documents, fields}, output.data, output.length,
                                         reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::readPagedPositions(jsi::Runtime& runtime, const jsi::Value&,
                                                 const jsi::Value* arguments, size_t count) try {
  if (count != 8) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput offsetSection;
  PagedSectionInput valueSection;
  PagedCacheInput cache;
  offsetSection.prepare(runtime, arguments[0]);
  valueSection.prepare(runtime, arguments[1]);
  cache.prepare(runtime, arguments[2]);
  auto first = pagedWhole(arguments[3]);
  auto postings = pagedWhole(arguments[4]);
  TypedElements regions(3);
  regions.prepare(runtime, 0, arguments[5]);
  regions.prepare(runtime, 1, arguments[6]);
  regions.prepare(runtime, 2, arguments[7]);
  auto offsets = offsetSection.read(runtime);
  auto values = valueSection.read(runtime);
  auto pages = cache.read(runtime);
  auto outOffsets = regions.read<uint32_t>(runtime, 0, "The position offsets");
  auto outValues = regions.read<uint32_t>(runtime, 1, "The position values");
  auto fault = regions.read<uint64_t>(runtime, 2, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  auto status = narsil_read_paged_positions(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                          {&offsets, &values, first, postings},
                                          {outOffsets.data, outOffsets.length, outValues.data, outValues.length},
                                          reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(-static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::readPagedRemovals(jsi::Runtime& runtime, const jsi::Value&,
                                                const jsi::Value* arguments, size_t count) try {
  if (count != 7) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput offsetSection;
  PagedSectionInput valueSection;
  PagedCacheInput cache;
  offsetSection.prepare(runtime, arguments[0]);
  valueSection.prepare(runtime, arguments[1]);
  cache.prepare(runtime, arguments[2]);
  auto ordinal = pagedWhole(arguments[3]);
  auto tokens = pagedWhole(arguments[4]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[5]);
  regions.prepare(runtime, 1, arguments[6]);
  auto offsets = offsetSection.read(runtime);
  auto values = valueSection.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<uint32_t>(runtime, 0, "The removal entries");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  uint32_t written = 0;
  auto status = narsil_read_paged_removals(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                         {&offsets, &values, ordinal, tokens},
                                         {output.data, output.length, &written},
                                         reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(written) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

jsi::Value HybridNarsilCoreImpl::readPagedId(jsi::Runtime& runtime, const jsi::Value&,
                                          const jsi::Value* arguments, size_t count) try {
  if (count != 6) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  PagedSectionInput offsetSection;
  PagedSectionInput valueSection;
  PagedCacheInput cache;
  offsetSection.prepare(runtime, arguments[0]);
  valueSection.prepare(runtime, arguments[1]);
  cache.prepare(runtime, arguments[2]);
  auto ordinal = pagedWhole(arguments[3]);
  TypedElements regions(2);
  regions.prepare(runtime, 0, arguments[4]);
  regions.prepare(runtime, 1, arguments[5]);
  auto offsets = offsetSection.read(runtime);
  auto values = valueSection.read(runtime);
  auto pages = cache.read(runtime);
  auto output = regions.read<uint8_t>(runtime, 0, "The document ID");
  auto fault = regions.read<uint64_t>(runtime, 1, "The page fault");
  if (fault.length != 3) return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
  uint32_t length = 0;
  auto status = narsil_read_paged_id(pagedWorkspace(runtime), cache.present ? &pages : nullptr,
                                   {&offsets, &values, ordinal}, {output.data, output.length, &length},
                                   reinterpret_cast<narsil_page_fault*>(fault.data));
  return jsi::Value(status == NARSIL_OK ? static_cast<double>(length) : -static_cast<double>(status));
} catch (const std::invalid_argument&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::length_error&) {
  return jsi::Value(-static_cast<double>(NARSIL_INVALID_ARGUMENT));
} catch (const std::bad_alloc&) {
  return jsi::Value(-static_cast<double>(NARSIL_OUT_OF_MEMORY));
}

}
