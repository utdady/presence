import Foundation
import CoreBluetooth

/// Dual-role BLE engine matching Android BleNearbyTransport / PROTOCOL.md.
final class BleNearbyEngine: NSObject {
    static let serviceUUID = CBUUID(string: "8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9c")
    static let writeUUID = CBUUID(string: "8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9d")
    static let notifyUUID = CBUUID(string: "8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9e")
    static let namePrefix = "Presence/"
    private static let maxMessage = 65536
    private static let header = 5
    private static let flagMore: UInt8 = 0x01
    private static let defaultPayload = 20

    private let emit: (String, [String: Any]) -> Void
    private var central: CBCentralManager!
    private var peripheralMgr: CBPeripheralManager!
    private var localName = "Guest"
    private var advertising = false
    private var scanning = false

    private var knownPeers: [UUID: (peripheral: CBPeripheral, name: String)] = [:]
    private var centralPeripheral: CBPeripheral?
    private var centralWriteChar: CBCharacteristic?
    private var centralNotifyChar: CBCharacteristic?
    private var centralPeerId: String?
    private var centralPeerName: String?
    private var mtuPayload = BleNearbyEngine.defaultPayload

    private var subscribedCentrais: Set<CBCentral> = []
    private var notifyChar: CBMutableCharacteristic?
    private var writeChar: CBMutableCharacteristic?
    private var peripheralPeerId: String?
    private var peripheralPeerName: String?

    private var nextMsgId: UInt16 = 0
    private var reassembly: [String: Reassembly] = [:]

    private struct Reassembly {
        var chunks: [Int: Data] = [:]
        var lastIndex: Int?
    }

    init(emit: @escaping (String, [String: Any]) -> Void) {
        self.emit = emit
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
        peripheralMgr = CBPeripheralManager(delegate: self, queue: .main)
    }

    func startAdvertising(displayName: String) {
        localName = sanitize(displayName)
        advertising = true
        startPeripheralServiceIfReady()
    }

    func startDiscovery() {
        scanning = true
        startScanIfReady()
    }

    func stop() {
        advertising = false
        scanning = false
        if central.isScanning { central.stopScan() }
        if peripheralMgr.isAdvertising { peripheralMgr.stopAdvertising() }
        disconnect()
        knownPeers.removeAll()
        reassembly.removeAll()
    }

    func connect(endpointId: String, displayName: String?) {
        guard let uuid = UUID(uuidString: endpointId),
              let entry = knownPeers[uuid] else {
            emit("error", ["message": "Unknown peer — scan first"])
            return
        }
        if centralPeripheral != nil || !subscribedCentrais.isEmpty {
            emit("error", ["message": "Already connected"])
            return
        }
        central.stopScan()
        scanning = false
        centralPeerId = endpointId
        centralPeerName = displayName ?? entry.name
        centralPeripheral = entry.peripheral
        central.connect(entry.peripheral, options: nil)
    }

    func disconnect() {
        if let p = centralPeripheral {
            central.cancelPeripheralConnection(p)
        }
        clearCentral()
        if let id = peripheralPeerId {
            emit("disconnected", ["id": id])
        }
        subscribedCentrais.removeAll()
        peripheralPeerId = nil
        peripheralPeerName = nil
    }

    func send(data: String) {
        guard let bytes = data.data(using: .utf8) else { return }
        if bytes.count > Self.maxMessage {
            emit("error", ["message": "Message too large for Nearby BLE"])
            return
        }
        let msgId = nextMsgId
        nextMsgId &+= 1
        let chunks = fragment(bytes, msgId: msgId, payloadSize: mtuPayload)
        for chunk in chunks {
            if !writeChunk(chunk) {
                emit("error", ["message": "Send failed"])
                return
            }
        }
    }

    private func writeChunk(_ chunk: Data) -> Bool {
        if let p = centralPeripheral, let ch = centralWriteChar {
            p.writeValue(chunk, for: ch, type: .withoutResponse)
            return true
        }
        if let notify = notifyChar, !subscribedCentrais.isEmpty {
            peripheralMgr.updateValue(chunk, for: notify, onSubscribedCentrals: Array(subscribedCentrais))
            return true
        }
        emit("error", ["message": "Not connected"])
        return false
    }

    private func fragment(_ data: Data, msgId: UInt16, payloadSize: Int) -> [Data] {
        var out: [Data] = []
        var offset = 0
        var index: UInt16 = 0
        if data.isEmpty {
            var buf = Data()
            buf.append(0)
            buf.append(contentsOf: withUnsafeBytes(of: msgId.littleEndian) { Data($0) })
            buf.append(contentsOf: withUnsafeBytes(of: index.littleEndian) { Data($0) })
            return [buf]
        }
        while offset < data.count {
            let end = min(offset + payloadSize, data.count)
            let more = end < data.count
            var buf = Data()
            buf.append(more ? Self.flagMore : 0)
            buf.append(contentsOf: withUnsafeBytes(of: msgId.littleEndian) { Data($0) })
            buf.append(contentsOf: withUnsafeBytes(of: index.littleEndian) { Data($0) })
            buf.append(data.subdata(in: offset..<end))
            out.append(buf)
            offset = end
            index &+= 1
            if !more { break }
        }
        return out
    }

    private func ingest(peerId: String, chunk: Data) {
        guard chunk.count >= Self.header else { return }
        let flags = chunk[0]
        let msgId = chunk.subdata(in: 1..<3).withUnsafeBytes { $0.load(as: UInt16.self).littleEndian }
        let index = Int(chunk.subdata(in: 3..<5).withUnsafeBytes { $0.load(as: UInt16.self).littleEndian })
        let body = chunk.subdata(in: Self.header..<chunk.count)
        let key = "\(peerId):\(msgId)"
        var slot = reassembly[key] ?? Reassembly()
        slot.chunks[index] = body
        if flags & Self.flagMore == 0 {
            slot.lastIndex = index
        }
        reassembly[key] = slot
        guard let last = slot.lastIndex else { return }
        for i in 0...last {
            if slot.chunks[i] == nil { return }
        }
        var total = 0
        for i in 0...last { total += slot.chunks[i]!.count }
        if total > Self.maxMessage {
            reassembly.removeValue(forKey: key)
            emit("error", ["message": "Message too large"])
            return
        }
        var full = Data()
        for i in 0...last { full.append(slot.chunks[i]!) }
        reassembly.removeValue(forKey: key)
        if let text = String(data: full, encoding: .utf8) {
            emit("message", ["peerId": peerId, "data": text])
        }
    }

    private func startScanIfReady() {
        guard scanning, central.state == .poweredOn else { return }
        central.scanForPeripherals(
            withServices: [Self.serviceUUID],
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )
    }

    private func startPeripheralServiceIfReady() {
        guard advertising, peripheralMgr.state == .poweredOn else { return }
        let write = CBMutableCharacteristic(
            type: Self.writeUUID,
            properties: [.writeWithoutResponse, .write],
            value: nil,
            permissions: [.writeable]
        )
        let notify = CBMutableCharacteristic(
            type: Self.notifyUUID,
            properties: [.notify],
            value: nil,
            permissions: [.readable]
        )
        writeChar = write
        notifyChar = notify
        let service = CBMutableService(type: Self.serviceUUID, primary: true)
        service.characteristics = [write, notify]
        peripheralMgr.removeAllServices()
        peripheralMgr.add(service)
        let name = Self.namePrefix + localName
        peripheralMgr.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
            CBAdvertisementDataLocalNameKey: name,
        ])
    }

    private func clearCentral() {
        if let id = centralPeerId {
            emit("disconnected", ["id": id])
        }
        centralPeripheral = nil
        centralWriteChar = nil
        centralNotifyChar = nil
        centralPeerId = nil
        centralPeerName = nil
        mtuPayload = Self.defaultPayload
    }

    private func sanitize(_ raw: String) -> String {
        let cleaned = String(raw.unicodeScalars.filter { $0.value >= 32 && $0.value < 127 })
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let base = cleaned.isEmpty ? "Guest" : cleaned
        return String(base.prefix(18))
    }
}

extension BleNearbyEngine: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            startScanIfReady()
        } else if central.state == .unauthorized {
            emit("error", ["message": "Bluetooth permission denied"])
        }
    }

    func centralManager(
        _ central: CBCentralManager,
        didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any],
        rssi RSSI: NSNumber
    ) {
        let raw =
            (advertisementData[CBAdvertisementDataLocalNameKey] as? String)
            ?? peripheral.name
            ?? ""
        guard raw.hasPrefix(Self.namePrefix) else { return }
        let display = String(raw.dropFirst(Self.namePrefix.count)).trimmingCharacters(in: .whitespaces)
        let name = display.isEmpty ? raw : display
        let id = peripheral.identifier
        let isNew = knownPeers[id] == nil
        knownPeers[id] = (peripheral, name)
        if isNew {
            emit("peerFound", ["id": id.uuidString, "name": name])
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        emit("error", ["message": error?.localizedDescription ?? "BLE connect failed"])
        clearCentral()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        clearCentral()
    }
}

extension BleNearbyEngine: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            emit("error", ["message": "Presence BLE service missing"])
            return
        }
        peripheral.discoverCharacteristics([Self.writeUUID, Self.notifyUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        for ch in service.characteristics ?? [] {
            if ch.uuid == Self.writeUUID { centralWriteChar = ch }
            if ch.uuid == Self.notifyUUID {
                centralNotifyChar = ch
                peripheral.setNotifyValue(true, for: ch)
            }
        }
        if let mtu = Optional(peripheral.maximumWriteValueLength(for: .withoutResponse)) {
            mtuPayload = max(20, mtu - Self.header)
        }
        let id = centralPeerId ?? peripheral.identifier.uuidString
        let name = centralPeerName ?? knownPeers[peripheral.identifier]?.name ?? id
        emit("connected", ["id": id, "name": name])
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == Self.notifyUUID, let value = characteristic.value else { return }
        let id = centralPeerId ?? peripheral.identifier.uuidString
        ingest(peerId: id, chunk: value)
    }
}

extension BleNearbyEngine: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        if peripheral.state == .poweredOn {
            startPeripheralServiceIfReady()
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for req in requests {
            if req.characteristic.uuid == Self.writeUUID, let value = req.value {
                let id = req.central.identifier.uuidString
                ingest(peerId: id, chunk: value)
            }
            peripheral.respond(to: req, withResult: .success)
        }
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didSubscribeTo characteristic: CBCharacteristic
    ) {
        guard characteristic.uuid == Self.notifyUUID else { return }
        subscribedCentrais.insert(central)
        let id = central.identifier.uuidString
        peripheralPeerId = id
        peripheralPeerName = id
        emit("connected", ["id": id, "name": id])
    }

    func peripheralManager(
        _ peripheral: CBPeripheralManager,
        central: CBCentral,
        didUnsubscribeFrom characteristic: CBCharacteristic
    ) {
        subscribedCentrais.remove(central)
        if subscribedCentrais.isEmpty, let id = peripheralPeerId {
            emit("disconnected", ["id": id])
            peripheralPeerId = nil
            peripheralPeerName = nil
        }
    }
}
