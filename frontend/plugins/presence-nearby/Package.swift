// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PresenceNearbyPlugin",
    platforms: [.iOS(.v14)],
    products: [
        .library(
            name: "PresenceNearbyPlugin",
            targets: ["PresenceNearbyPlugin"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "PresenceNearbyPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "Sources/PresenceNearbyPlugin"
        )
    ]
)
