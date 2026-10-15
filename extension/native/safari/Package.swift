// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "SafariNativeCore",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "SafariNativeCore", targets: ["SafariNativeCore"]),
        .library(name: "SafariNativeIPC", targets: ["SafariNativeIPC"]),
    ],
    targets: [
        .target(name: "SafariNativeCore"),
        .testTarget(name: "SafariNativeCoreTests", dependencies: ["SafariNativeCore"]),
        .target(name: "SafariNativeIPC"),
        .testTarget(name: "SafariNativeIPCTests", dependencies: ["SafariNativeIPC"]),
    ]
)
