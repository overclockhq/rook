// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "Peek",
    platforms: [.macOS(.v14)],
    targets: [
        // The rules — the interruption budget, what counts as blocked, the state
        // machine — live here so they can be checked without a window server.
        .target(name: "PeekCore", path: "Sources/PeekCore"),

        .executableTarget(
            name: "Peek",
            dependencies: ["PeekCore"],
            path: "Sources/Peek",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        ),

        // `swift run PeekCheck` asserts the rules above. It is an executable
        // rather than a test target because XCTest and swift-testing both need a
        // full Xcode install, and this has to be runnable with the Command Line
        // Tools alone.
        .executableTarget(name: "PeekCheck", dependencies: ["PeekCore"], path: "Sources/PeekCheck"),
    ]
)
