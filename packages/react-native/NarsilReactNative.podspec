require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

app_links_worklets = lambda do
  autolinking = File.join(Pod::Config.instance.installation_root.to_s, "build", "generated", "autolinking", "autolinking.json")
  return false unless File.exist?(autolinking)
  worklets = JSON.parse(File.read(autolinking)).dig("dependencies", "react-native-worklets")
  !worklets.nil? && !worklets.dig("platforms", "ios").nil?
rescue NameError, JSON::ParserError, SystemCallError
  false
end

links_worklets = app_links_worklets.call
core_header = File.join(__dir__, "cpp", "core", "include", "narsil_core.h")
unless File.exist?(core_header)
  raise "#{package["name"]} has no copy of the search core in cpp/core. Run `node scripts/copy-core.mjs` in #{__dir__} first."
end

Pod::Spec.new do |s|
  s.name         = "NarsilReactNative"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/assetcorp/narsil.git", :tag => "#{s.name}-v#{s.version}" }

  s.source_files = [
    "cpp/*.{hpp,cpp}",
    "cpp/core/src/**/*.{c,h}",
    "cpp/core/include/*.h",
  ]
  s.private_header_files = ["cpp/*.hpp", "cpp/core/src/**/*.h", "cpp/core/include/*.h"]

  header_search_paths = "$(inherited) \"$(PODS_TARGET_SRCROOT)/cpp/core/include\""
  header_search_paths += " \"$(PODS_ROOT)/Headers/Public/RNWorklets\"" if links_worklets
  pod_target_xcconfig = {
    "GCC_C_LANGUAGE_STANDARD" => "c11",
    "OTHER_CFLAGS" => "$(inherited) -ffp-contract=off",
    "HEADER_SEARCH_PATHS" => header_search_paths,
  }
  pod_target_xcconfig["GCC_PREPROCESSOR_DEFINITIONS"] = "$(inherited) NARSIL_LINKS_WORKLETS=1" if links_worklets
  s.pod_target_xcconfig = pod_target_xcconfig
  s.libraries = "z"
  s.resource_bundles = { "NarsilReactNativePrivacyInfo" => ["ios/PrivacyInfo.xcprivacy"] }

  load "nitrogen/generated/ios/NarsilReactNative+autolinking.rb"
  add_nitrogen_files(s)

  s.dependency "React-jsi"
  s.dependency "React-callinvoker"
  s.dependency "RNWorklets" if links_worklets
  install_modules_dependencies(s)
end
