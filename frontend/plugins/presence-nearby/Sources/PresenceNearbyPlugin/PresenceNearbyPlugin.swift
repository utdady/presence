import Foundation
import Capacitor
import CoreBluetooth

/**
 Presence Nearby BLE (CoreBluetooth). Same GATT profile + chunk framing as Android
 — see PROTOCOL.md.
 */
@objc(PresenceNearbyPlugin)
public class PresenceNearbyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PresenceNearbyPlugin"
    public let jsName = "PresenceNearby"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startDiscovery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSpeakerphone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAppBadge", returnType: CAPPluginReturnPromise),
    ]

    private var engine: BleNearbyEngine?

    private func eng() -> BleNearbyEngine {
        if let e = engine { return e }
        let e = BleNearbyEngine { [weak self] event, data in
            self?.notifyListeners(event, data: data)
        }
        engine = e
        return e
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": CBCentralManager.authorization != .denied])
    }

    @objc public override func requestPermissions(_ call: CAPPluginCall) {
        _ = eng()
        call.resolve()
    }

    @objc func startAdvertising(_ call: CAPPluginCall) {
        let name = call.getString("displayName") ?? "Guest"
        eng().startAdvertising(displayName: name)
        call.resolve()
    }

    @objc func startDiscovery(_ call: CAPPluginCall) {
        eng().startDiscovery()
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        eng().stop()
        call.resolve()
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let id = call.getString("endpointId"), !id.isEmpty else {
            call.reject("endpointId required")
            return
        }
        eng().connect(endpointId: id, displayName: call.getString("displayName"))
        call.resolve()
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        eng().disconnect()
        call.resolve()
    }

    @objc func send(_ call: CAPPluginCall) {
        guard let data = call.getString("data") else {
            call.reject("data required")
            return
        }
        eng().send(data: data)
        call.resolve()
    }

    @objc func setSpeakerphone(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func setAppBadge(_ call: CAPPluginCall) {
        call.resolve()
    }
}
