#include "AndroidEnvironment.hpp"

#include <fbjni/fbjni.h>

namespace margelo::nitro::narsil {

namespace {

constexpr double UNKNOWN_BYTES = -1;

struct JNarsilAndroidEnvironment : facebook::jni::JavaClass<JNarsilAndroidEnvironment> {
  static constexpr auto kJavaDescriptor = "Lcom/margelo/nitro/narsil/NarsilAndroidEnvironment;";

  static double availableBytes() {
    static const auto method = javaClassStatic()->getStaticMethod<jdouble()>("availableBytes");
    return method(javaClassStatic());
  }

  static std::string filesDirectory() {
    static const auto method = javaClassStatic()->getStaticMethod<facebook::jni::JString()>("filesDirectory");
    auto directory = method(javaClassStatic());
    return directory ? directory->toStdString() : std::string();
  }
};

}

void primeAndroidEnvironment() {
  JNarsilAndroidEnvironment::javaClassStatic();
}

double androidAvailableBytes() {
  double bytes = UNKNOWN_BYTES;
  facebook::jni::ThreadScope::WithClassLoader([&] { bytes = JNarsilAndroidEnvironment::availableBytes(); });
  return bytes;
}

std::string androidFilesDirectory() {
  std::string directory;
  facebook::jni::ThreadScope::WithClassLoader([&] { directory = JNarsilAndroidEnvironment::filesDirectory(); });
  return directory;
}

}
