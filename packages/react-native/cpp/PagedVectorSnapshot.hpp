#pragma once

#include "HybridNarsilCoreImpl.hpp"
#include "PagedInput.hpp"
#include "narsil_paged_vectors.h"

#include <algorithm>
#include <memory>
#include <vector>

namespace margelo::nitro::narsil {

class PagedVectorSnapshot {
public:
  narsil_paged_vector_field field{};
  narsil_paged_vector_request request{};
  narsil_paged_vector_output output{};
  narsil_page_cache cache{};
  narsil_page_fault* fault = nullptr;
  std::vector<PagedFile> files;
  std::vector<std::shared_ptr<ArrayBuffer>> buffers;
  std::unique_ptr<narsil_workspace, WorkspaceRelease> workspace;

  void copyInputs(const narsil_paged_vector_field& source, const narsil_paged_vector_request& query) {
    field = source;
    request = query;
    auto copiedFiles = copy(source.files, source.file_count);
    field.files = copiedFiles;
    for (size_t at = 0; at < field.file_count; at++) {
      auto& file = copiedFiles[at];
      if (file.dead != nullptr) file.dead = copy(file.dead, file.dead_bytes);
      copySection(file.vectors);
      if (file.records != nullptr) {
        auto records = copy(file.records, 1);
        copySection(*records);
        file.records = records;
      }
    }
    auto parts = copy(source.parts, source.part_count);
    field.parts = parts;
    for (size_t at = 0; at < field.part_count; at++) {
      auto& part = parts[at];
      part.levels = copy(part.levels, part.level_count);
      part.node_offsets = copy(part.node_offsets, part.offset_count);
      copySection(part.neighbours);
    }
    if (field.centroid != nullptr) field.centroid = copy(field.centroid, field.centroid_count);
    request.query = copy(query.query, query.query_count);
    if (query.accepted != nullptr) request.accepted = copy(query.accepted, query.accepted_words);
    if (query.excluded != nullptr) request.excluded = copy(query.excluded, query.excluded_words);
  }

  double search() {
    uint32_t count = 0;
    auto status = narsil_search_paged_vectors(workspace.get(), &cache, &field, &request, &output, &count, fault);
    return status == NARSIL_OK ? static_cast<double>(count) : -static_cast<double>(status);
  }

private:
  template <typename Element>
  Element* copy(const Element* source, size_t count) {
    auto values = std::make_shared<std::vector<Element>>(count);
    if (count > 0) std::copy_n(source, count, values->data());
    _copies.push_back(values);
    return values->data();
  }

  void copySection(narsil_page_section& section) { section.checksums = copy(section.checksums, section.checksum_bytes); }
  std::vector<std::shared_ptr<void>> _copies;
};

}
