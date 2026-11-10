#pragma once

#include "TypedElements.hpp"
#include "narsil_paged.h"

#include <memory>
#include <vector>

namespace margelo::nitro::narsil {

struct PagedFileRelease {
  void operator()(narsil_paged_file* file) const { narsil_paged_file_close(file); }
};

using PagedFile = std::shared_ptr<narsil_paged_file>;

class PagedFileState final : public jsi::NativeState {
public:
  PagedFile file;
};

uint32_t pagedWhole(const jsi::Value& value);
uint64_t pagedUint64(jsi::Runtime& runtime, const jsi::Value& value);
std::shared_ptr<PagedFileState> pagedFileState(jsi::Runtime& runtime, const jsi::Value& value);

class PagedSectionInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value);
  narsil_page_section read(jsi::Runtime& runtime);
  PagedFile file;
private:
  std::shared_ptr<PagedFileState> _state;
  TypedElements _regions{1};
  uint64_t _offset = 0;
  uint64_t _length = 0;
  uint32_t _pageBytes = 0;
};

class PagedCacheInput {
public:
  void prepare(jsi::Runtime& runtime, const jsi::Value& value);
  narsil_page_cache read(jsi::Runtime& runtime);
  void retain(jsi::Runtime& runtime, std::vector<std::shared_ptr<ArrayBuffer>>& buffers);
  bool present = false;
private:
  TypedElements _regions{6};
};

}
