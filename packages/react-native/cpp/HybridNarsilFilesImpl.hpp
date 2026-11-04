#pragma once

#include "HybridNarsilFilesSpec.hpp"

namespace margelo::nitro::narsil {

class HybridNarsilFilesImpl : public HybridNarsilFilesSpec {
public:
  HybridNarsilFilesImpl() : HybridObject(TAG) {}

  double open(const std::string& path, const std::string& flags) override;
  void close(double descriptor) override;
  double read(double descriptor, const std::shared_ptr<ArrayBuffer>& target, double byteOffset, double byteLength,
              double position) override;
  double write(double descriptor, const std::shared_ptr<ArrayBuffer>& source, double byteOffset, double byteLength,
               double position) override;
  void sync(double descriptor) override;
  std::shared_ptr<Promise<std::shared_ptr<ArrayBuffer>>> readAsync(double descriptor, double byteLength,
                                                                   double position) override;
  std::shared_ptr<Promise<double>> writeAsync(double descriptor, const std::shared_ptr<ArrayBuffer>& source,
                                              double byteOffset, double byteLength, double position) override;
  std::shared_ptr<Promise<void>> syncAsync(double descriptor) override;
  void truncate(double descriptor, double byteLength) override;
  FileStatus descriptorStatus(double descriptor) override;
  FileStatus pathStatus(const std::string& path) override;
  void makeDirectory(const std::string& path) override;
  std::vector<DirectoryEntry> readDirectory(const std::string& path) override;
  void rename(const std::string& from, const std::string& to) override;
  void unlink(const std::string& path) override;
  void removeDirectory(const std::string& path) override;
  void link(const std::string& existingPath, const std::string& newPath) override;
};

}
