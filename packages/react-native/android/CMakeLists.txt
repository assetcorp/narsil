cmake_minimum_required(VERSION 3.9.0)
project(NarsilReactNative C CXX)

set(PACKAGE_NAME NarsilReactNative)
set(CMAKE_CXX_STANDARD 20)
set(CORE_DIRECTORY ${CMAKE_SOURCE_DIR}/../cpp/core)

if(NOT EXISTS ${CORE_DIRECTORY}/include/narsil_core.h)
  message(FATAL_ERROR "The package has no copy of the search core in cpp/core. Run `node scripts/copy-core.mjs` in the package directory first.")
endif()

file(GLOB CORE_SOURCES ${CORE_DIRECTORY}/src/*.c)
file(GLOB BINDING_SOURCES ${CMAKE_SOURCE_DIR}/../cpp/*.cpp)

add_library(${PACKAGE_NAME} SHARED
  src/main/cpp/cpp-adapter.cpp
  src/main/cpp/AndroidEnvironment.cpp
  ${BINDING_SOURCES}
  ${CORE_SOURCES}
)

set_source_files_properties(${CORE_SOURCES} PROPERTIES COMPILE_OPTIONS "-std=c11;-ffp-contract=off;-O2")

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/NarsilReactNative+autolinking.cmake)

include_directories(
  "src/main/cpp"
  "../cpp"
  "../cpp/core/include"
)

find_library(LOG_LIB log)
find_library(Z_LIB z)

target_link_options(${PACKAGE_NAME} PRIVATE "-Wl,-z,max-page-size=16384")

target_link_libraries(
  ${PACKAGE_NAME}
  ${LOG_LIB}
  ${Z_LIB}
  android
)
