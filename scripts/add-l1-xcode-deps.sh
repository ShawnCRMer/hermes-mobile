#!/bin/bash
# Add Phase L1 source files and SPM dependencies to the Xcode project.
# Run once after creating the Swift source files.

set -euo pipefail

PBXPROJ="ios/App/App.xcodeproj/project.pbxproj"

if ! grep -q "LocalInferenceServer.swift" "$PBXPROJ"; then
  echo "Adding L1 source files and SPM deps to Xcode project..."

  # UUIDs for new entries (deterministic for idempotency)
  # Source files
  LIS_FILE="DD000001000000000000E1E1"      # LocalInferenceServer.swift file ref
  LIS_BUILD="DD000001000000000000E2E2"     # LocalInferenceServer.swift build file
  MS_FILE="DD000001000000000000E3E3"       # ModelStore.swift file ref
  MS_BUILD="DD000001000000000000E4E4"      # ModelStore.swift build file
  MLX_FILE="DD000001000000000000E5E5"      # MLXInferenceEngine.swift file ref
  MLX_BUILD="DD000001000000000000E6E6"     # MLXInferenceEngine.swift build file
  MMP_FILE="DD000001000000000000E7E7"      # ModelManagerPlugin.swift file ref
  MMP_BUILD="DD000001000000000000E8E8"     # ModelManagerPlugin.swift build file

  # SPM packages
  HB_PKG="DD000001000000000000F1F1"        # Hummingbird remote package ref
  HB_PROD="DD000001000000000000F2F2"       # Hummingbird product dependency
  HB_FRAMEWORK="DD000001000000000000F3F3"  # Hummingbird in frameworks build file
  MLXLM_PKG="DD000001000000000000F4F4"     # mlx-swift-lm remote package ref
  MLXLLM_PROD="DD000001000000000000F5F5"   # MLXLLM product dependency
  MLXLM_COMMON_PROD="DD000001000000000000F6F6"  # MLXLMCommon product dependency
  MLXLLM_FRAMEWORK="DD000001000000000000F7F7"    # MLXLLM in frameworks build file
  MLXLM_COMMON_FRAMEWORK="DD000001000000000000F8F8" # MLXLMCommon in frameworks

  # 1. Add PBXBuildFile entries (after the existing PythonRuntime build file)
  sed -i '' "/CC000001000000000000C1C1.*PythonRuntime.swift in Sources/a\\
\\		$LIS_BUILD /* LocalInferenceServer.swift in Sources */ = {isa = PBXBuildFile; fileRef = $LIS_FILE /* LocalInferenceServer.swift */; };\\
\\		$MS_BUILD /* ModelStore.swift in Sources */ = {isa = PBXBuildFile; fileRef = $MS_FILE /* ModelStore.swift */; };\\
\\		$MLX_BUILD /* MLXInferenceEngine.swift in Sources */ = {isa = PBXBuildFile; fileRef = $MLX_FILE /* MLXInferenceEngine.swift */; };\\
\\		$MMP_BUILD /* ModelManagerPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = $MMP_FILE /* ModelManagerPlugin.swift */; };\\
\\		$HB_FRAMEWORK /* Hummingbird in Frameworks */ = {isa = PBXBuildFile; productRef = $HB_PROD /* Hummingbird */; };\\
\\		$MLXLLM_FRAMEWORK /* MLXLLM in Frameworks */ = {isa = PBXBuildFile; productRef = $MLXLLM_PROD /* MLXLLM */; };\\
\\		$MLXLM_COMMON_FRAMEWORK /* MLXLMCommon in Frameworks */ = {isa = PBXBuildFile; productRef = $MLXLM_COMMON_PROD /* MLXLMCommon */; };
" "$PBXPROJ"

  # 2. Add PBXFileReference entries (after PythonRuntime file ref)
  sed -i '' "/CC000001000000000000C2C2.*PythonRuntime.swift/a\\
\\		$LIS_FILE /* LocalInferenceServer.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = LocalInferenceServer.swift; sourceTree = \"<group>\"; };\\
\\		$MS_FILE /* ModelStore.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ModelStore.swift; sourceTree = \"<group>\"; };\\
\\		$MLX_FILE /* MLXInferenceEngine.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MLXInferenceEngine.swift; sourceTree = \"<group>\"; };\\
\\		$MMP_FILE /* ModelManagerPlugin.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = ModelManagerPlugin.swift; sourceTree = \"<group>\"; };
" "$PBXPROJ"

  # 3. Add children to HermesGateway group (after PythonRuntime.swift entry)
  sed -i '' "/CC000001000000000000C2C2.*PythonRuntime.swift,/a\\
\\				$LIS_FILE /* LocalInferenceServer.swift */,\\
\\				$MS_FILE /* ModelStore.swift */,\\
\\				$MLX_FILE /* MLXInferenceEngine.swift */,\\
\\				$MMP_FILE /* ModelManagerPlugin.swift */,
" "$PBXPROJ"

  # 4. Add to Sources build phase (after PythonRuntime in Sources)
  sed -i '' "/CC000001000000000000C1C1.*PythonRuntime.swift in Sources/a\\
\\				$LIS_BUILD /* LocalInferenceServer.swift in Sources */,\\
\\				$MS_BUILD /* ModelStore.swift in Sources */,\\
\\				$MLX_BUILD /* MLXInferenceEngine.swift in Sources */,\\
\\				$MMP_BUILD /* ModelManagerPlugin.swift in Sources */,
" "$PBXPROJ"

  # 5. Add SPM frameworks to the Frameworks build phase (after Python.xcframework)
  sed -i '' "/CC000001000000000000C5C5.*Python.xcframework in Frameworks/a\\
\\				$HB_FRAMEWORK /* Hummingbird in Frameworks */,\\
\\				$MLXLLM_FRAMEWORK /* MLXLLM in Frameworks */,\\
\\				$MLXLM_COMMON_FRAMEWORK /* MLXLMCommon in Frameworks */,
" "$PBXPROJ"

  # 6. Add packageProductDependencies to App target (after CapApp-SPM)
  sed -i '' "/4D22ABE82AF431CB00220026.*CapApp-SPM/a\\
\\				$HB_PROD /* Hummingbird */,\\
\\				$MLXLLM_PROD /* MLXLLM */,\\
\\				$MLXLM_COMMON_PROD /* MLXLMCommon */,
" "$PBXPROJ"

  # 7. Add package references to project (after CapApp-SPM local reference)
  sed -i '' "/D4C12C0A2AAA248700AAC8A2.*XCLocalSwiftPackageReference/a\\
\\				$HB_PKG /* XCRemoteSwiftPackageReference \"hummingbird\" */,\\
\\				$MLXLM_PKG /* XCRemoteSwiftPackageReference \"mlx-swift-lm\" */,
" "$PBXPROJ"

  # 8. Add XCRemoteSwiftPackageReference sections (before End XCSwiftPackageProductDependency or at end)
  # Find a good insertion point — before the last closing of objects
  sed -i '' "/\/* End XCSwiftPackageProductDependency section \*\//i\\
\\
/* Begin XCRemoteSwiftPackageReference section */\\
\\		$HB_PKG /* XCRemoteSwiftPackageReference \"hummingbird\" */ = {\\
\\			isa = XCRemoteSwiftPackageReference;\\
\\			repositoryURL = \"https://github.com/hummingbird-project/hummingbird.git\";\\
\\			requirement = {\\
\\				kind = upToNextMajorVersion;\\
\\				minimumVersion = 2.0.0;\\
\\			};\\
\\		};\\
\\		$MLXLM_PKG /* XCRemoteSwiftPackageReference \"mlx-swift-lm\" */ = {\\
\\			isa = XCRemoteSwiftPackageReference;\\
\\			repositoryURL = \"https://github.com/ml-explore/mlx-swift-lm\";\\
\\			requirement = {\\
\\				kind = upToNextMajorVersion;\\
\\				minimumVersion = 3.31.0;\\
\\			};\\
\\		};\\
/* End XCRemoteSwiftPackageReference section */
" "$PBXPROJ"

  # 9. Add XCSwiftPackageProductDependency entries (extend existing section)
  sed -i '' "/\/* End XCSwiftPackageProductDependency section \*\//i\\
\\		$HB_PROD /* Hummingbird */ = {\\
\\			isa = XCSwiftPackageProductDependency;\\
\\			package = $HB_PKG /* XCRemoteSwiftPackageReference \"hummingbird\" */;\\
\\			productName = Hummingbird;\\
\\		};\\
\\		$MLXLLM_PROD /* MLXLLM */ = {\\
\\			isa = XCSwiftPackageProductDependency;\\
\\			package = $MLXLM_PKG /* XCRemoteSwiftPackageReference \"mlx-swift-lm\" */;\\
\\			productName = MLXLLM;\\
\\		};\\
\\		$MLXLM_COMMON_PROD /* MLXLMCommon */ = {\\
\\			isa = XCSwiftPackageProductDependency;\\
\\			package = $MLXLM_PKG /* XCRemoteSwiftPackageReference \"mlx-swift-lm\" */;\\
\\			productName = MLXLMCommon;\\
\\		};
" "$PBXPROJ"

  echo "Done. Open Xcode and resolve packages (File → Packages → Resolve Package Versions)."
else
  echo "L1 deps already present in project."
fi
