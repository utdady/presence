package app.presence.nearby

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Log
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Dual-role BLE GATT transport (peripheral advertise + central scan/connect).
 * Wire format: see PROTOCOL.md — 5-byte chunk header + payload.
 */
@SuppressLint("MissingPermission")
class BleNearbyTransport(
    private val context: Context,
    private val listener: Listener,
) {
    interface Listener {
        fun onPeerFound(id: String, name: String)
        fun onPeerLost(id: String)
        fun onConnected(id: String, name: String)
        fun onDisconnected(id: String)
        fun onMessage(peerId: String, data: String)
        fun onError(message: String)
    }

    companion object {
        private const val TAG = "BleNearby"
        val SERVICE_UUID: UUID = UUID.fromString("8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9c")
        val WRITE_UUID: UUID = UUID.fromString("8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9d")
        val NOTIFY_UUID: UUID = UUID.fromString("8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9e")
        private val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
        const val NAME_PREFIX = "Presence/"
        private const val MAX_MESSAGE = 65536
        private const val HEADER = 5
        private const val DEFAULT_PAYLOAD = 20
        private const val FLAG_MORE = 0x01
    }

    private val main = Handler(Looper.getMainLooper())
    private val btManager =
        context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    private val adapter: BluetoothAdapter? = btManager.adapter

    private var advertiser: BluetoothLeAdvertiser? = null
    private var scanner: BluetoothLeScanner? = null
    private var gattServer: BluetoothGattServer? = null
    private var writeChar: BluetoothGattCharacteristic? = null
    private var notifyChar: BluetoothGattCharacteristic? = null

    private var advertising = false
    private var scanning = false
    private var localDisplayName = "Guest"

    /** Central connection (we initiated). */
    private var centralGatt: BluetoothGatt? = null
    private var centralPeerId: String? = null
    private var centralPeerName: String? = null
    private var centralWriteChar: BluetoothGattCharacteristic? = null
    private var centralNotifyChar: BluetoothGattCharacteristic? = null
    private var centralMtuPayload = DEFAULT_PAYLOAD

    /** Peripheral link (peer initiated to us). */
    private var peripheralDevice: BluetoothDevice? = null
    private var peripheralPeerId: String? = null
    private var peripheralPeerName: String? = null
    private var peripheralSubscribed = false

    private val peerNames = ConcurrentHashMap<String, String>()
    private val nextMsgId = AtomicInteger(0)
    private val reassembly = ConcurrentHashMap<String, Reassembly>()

    private data class Reassembly(
        val chunks: HashMap<Int, ByteArray> = HashMap(),
        var lastIndex: Int? = null,
    )

    fun isBleAvailable(): Boolean {
        if (adapter == null) return false
        return context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)
    }

    fun startAdvertising(displayName: String) {
        val ad = adapter ?: run {
            listener.onError("Bluetooth unavailable")
            return
        }
        if (!ad.isEnabled) {
            listener.onError("Turn on Bluetooth")
            return
        }
        localDisplayName = sanitizeName(displayName)
        ensureGattServer()
        val adv = ad.bluetoothLeAdvertiser ?: run {
            listener.onError("BLE advertising not supported")
            return
        }
        advertiser = adv
        val settings =
            AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build()
        val data =
            AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(ParcelUuid(SERVICE_UUID))
                .build()
        val scanResponse =
            AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .build()
        try {
            // Local name used in scan response when includeDeviceName=true
            @Suppress("DEPRECATION")
            ad.name = NAME_PREFIX + localDisplayName
        } catch (_: SecurityException) {
            /* ignore */
        }
        adv.startAdvertising(settings, data, scanResponse, advertiseCallback)
        advertising = true
    }

    fun startDiscovery() {
        val ad = adapter ?: run {
            listener.onError("Bluetooth unavailable")
            return
        }
        if (!ad.isEnabled) {
            listener.onError("Turn on Bluetooth")
            return
        }
        ensureGattServer()
        val sc = ad.bluetoothLeScanner ?: run {
            listener.onError("BLE scanner not supported")
            return
        }
        scanner = sc
        val filters =
            listOf(
                ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build(),
            )
        val settings =
            ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build()
        sc.startScan(filters, settings, scanCallback)
        scanning = true
    }

    fun stop() {
        stopAdvertisingInternal()
        stopScanningInternal()
        disconnectAll()
        closeGattServer()
        peerNames.clear()
        reassembly.clear()
    }

    fun connect(endpointId: String, displayName: String?) {
        val ad = adapter ?: run {
            listener.onError("Bluetooth unavailable")
            return
        }
        if (centralGatt != null || peripheralDevice != null) {
            listener.onError("Already connected")
            return
        }
        val device =
            try {
                ad.getRemoteDevice(endpointId)
            } catch (e: IllegalArgumentException) {
                listener.onError("Invalid peer id")
                return
            }
        centralPeerId = endpointId
        centralPeerName = displayName ?: peerNames[endpointId] ?: endpointId
        stopScanningInternal()
        centralGatt =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                @Suppress("DEPRECATION")
                device.connectGatt(context, false, gattCallback)
            }
    }

    fun disconnect() {
        disconnectAll()
    }

    fun send(data: String) {
        val bytes = data.toByteArray(StandardCharsets.UTF_8)
        if (bytes.size > MAX_MESSAGE) {
            listener.onError("Message too large for Nearby BLE")
            return
        }
        val msgId = nextMsgId.getAndIncrement() and 0xffff
        val payloadSize = currentPayloadSize()
        val chunks = fragment(bytes, msgId, payloadSize)
        main.post {
            for (chunk in chunks) {
                if (!writeChunk(chunk)) {
                    listener.onError("Send failed")
                    return@post
                }
            }
        }
    }

    private fun currentPayloadSize(): Int {
        return when {
            centralGatt != null -> centralMtuPayload
            else -> DEFAULT_PAYLOAD
        }
    }

    private fun writeChunk(chunk: ByteArray): Boolean {
        val cg = centralGatt
        val cWrite = centralWriteChar
        if (cg != null && cWrite != null) {
            return writeCentral(cg, cWrite, chunk)
        }
        val pd = peripheralDevice
        val nChar = notifyChar
        val server = gattServer
        if (pd != null && nChar != null && server != null && peripheralSubscribed) {
            nChar.value = chunk
            return server.notifyCharacteristicChanged(pd, nChar, false)
        }
        listener.onError("Not connected")
        return false
    }

    private fun writeCentral(
        gatt: BluetoothGatt,
        characteristic: BluetoothGattCharacteristic,
        chunk: ByteArray,
    ): Boolean {
        characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        characteristic.value = chunk
        return gatt.writeCharacteristic(characteristic)
    }

    private fun fragment(data: ByteArray, msgId: Int, payloadSize: Int): List<ByteArray> {
        val out = ArrayList<ByteArray>()
        var offset = 0
        var index = 0
        while (offset < data.size || (offset == 0 && data.isEmpty())) {
            val end = minOf(offset + payloadSize, data.size)
            val more = end < data.size
            val body = data.copyOfRange(offset, end)
            val buf = ByteBuffer.allocate(HEADER + body.size).order(ByteOrder.LITTLE_ENDIAN)
            buf.put((if (more) FLAG_MORE else 0).toByte())
            buf.putShort(msgId.toShort())
            buf.putShort(index.toShort())
            buf.put(body)
            out.add(buf.array())
            offset = end
            index++
            if (!more) break
        }
        return out
    }

    private fun ingestChunk(peerId: String, chunk: ByteArray) {
        if (chunk.size < HEADER) return
        val buf = ByteBuffer.wrap(chunk).order(ByteOrder.LITTLE_ENDIAN)
        val flags = buf.get().toInt() and 0xff
        val msgId = buf.short.toInt() and 0xffff
        val index = buf.short.toInt() and 0xffff
        val body = ByteArray(chunk.size - HEADER)
        buf.get(body)
        val key = "$peerId:$msgId"
        val slot = reassembly.getOrPut(key) { Reassembly() }
        slot.chunks[index] = body
        if (flags and FLAG_MORE == 0) {
            slot.lastIndex = index
        }
        val last = slot.lastIndex ?: return
        for (i in 0..last) {
            if (!slot.chunks.containsKey(i)) return
        }
        var total = 0
        for (i in 0..last) {
            total += slot.chunks[i]!!.size
            if (total > MAX_MESSAGE) {
                reassembly.remove(key)
                listener.onError("Message too large")
                return
            }
        }
        val full = ByteArray(total)
        var o = 0
        for (i in 0..last) {
            val part = slot.chunks[i]!!
            System.arraycopy(part, 0, full, o, part.size)
            o += part.size
        }
        reassembly.remove(key)
        val text = String(full, StandardCharsets.UTF_8)
        main.post { listener.onMessage(peerId, text) }
    }

    private fun ensureGattServer() {
        if (gattServer != null) return
        val server = btManager.openGattServer(context, gattServerCallback) ?: return
        gattServer = server
        val service =
            BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        val write =
            BluetoothGattCharacteristic(
                WRITE_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
                    BluetoothGattCharacteristic.PROPERTY_WRITE,
                BluetoothGattCharacteristic.PERMISSION_WRITE,
            )
        val notify =
            BluetoothGattCharacteristic(
                NOTIFY_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ,
            )
        notify.addDescriptor(
            BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
            ),
        )
        service.addCharacteristic(write)
        service.addCharacteristic(notify)
        writeChar = write
        notifyChar = notify
        server.addService(service)
    }

    private fun closeGattServer() {
        try {
            gattServer?.close()
        } catch (_: Exception) {
        }
        gattServer = null
        writeChar = null
        notifyChar = null
    }

    private fun stopAdvertisingInternal() {
        if (!advertising) return
        try {
            advertiser?.stopAdvertising(advertiseCallback)
        } catch (_: Exception) {
        }
        advertising = false
    }

    private fun stopScanningInternal() {
        if (!scanning) return
        try {
            scanner?.stopScan(scanCallback)
        } catch (_: Exception) {
        }
        scanning = false
    }

    private fun disconnectAll() {
        try {
            centralGatt?.disconnect()
            centralGatt?.close()
        } catch (_: Exception) {
        }
        val wasCentral = centralPeerId
        centralGatt = null
        centralWriteChar = null
        centralNotifyChar = null
        centralMtuPayload = DEFAULT_PAYLOAD
        if (wasCentral != null) {
            val id = wasCentral
            centralPeerId = null
            centralPeerName = null
            main.post { listener.onDisconnected(id) }
        }
        val pd = peripheralDevice
        if (pd != null) {
            try {
                gattServer?.cancelConnection(pd)
            } catch (_: Exception) {
            }
        }
        val wasPeriph = peripheralPeerId
        peripheralDevice = null
        peripheralSubscribed = false
        peripheralPeerId = null
        peripheralPeerName = null
        if (wasPeriph != null) {
            main.post { listener.onDisconnected(wasPeriph) }
        }
    }

    private val advertiseCallback =
        object : AdvertiseCallback() {
            override fun onStartSuccess(settingsInEffect: AdvertiseSettings?) {
                Log.i(TAG, "Advertising as $NAME_PREFIX$localDisplayName")
            }

            override fun onStartFailure(errorCode: Int) {
                advertising = false
                listener.onError("Advertise failed ($errorCode)")
            }
        }

    private val scanCallback =
        object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult?) {
                if (result == null) return
                val device = result.device ?: return
                val address = device.address ?: return
                if (address == centralPeerId || address == peripheralPeerId) return
                val rawName =
                    result.scanRecord?.deviceName
                        ?: try {
                            device.name
                        } catch (_: SecurityException) {
                            null
                        }
                if (rawName == null || !rawName.startsWith(NAME_PREFIX)) return
                val display = rawName.substring(NAME_PREFIX.length).trim().ifEmpty { rawName }
                if (peerNames.put(address, display) == null) {
                    main.post { listener.onPeerFound(address, display) }
                }
            }

            override fun onScanFailed(errorCode: Int) {
                scanning = false
                listener.onError("Scan failed ($errorCode)")
            }
        }

    private val gattCallback =
        object : BluetoothGattCallback() {
            override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    Log.w(TAG, "Central GATT status $status")
                    val id = centralPeerId
                    try {
                        gatt.close()
                    } catch (_: Exception) {
                    }
                    if (centralGatt === gatt) {
                        centralGatt = null
                        centralWriteChar = null
                        centralNotifyChar = null
                        centralPeerId = null
                        centralPeerName = null
                    }
                    if (status == 133) {
                        listener.onError("BLE connect failed (133) — try again")
                    } else {
                        listener.onError("BLE connect failed ($status)")
                    }
                    if (id != null) main.post { listener.onDisconnected(id) }
                    return
                }
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    gatt.requestMtu(517)
                    gatt.discoverServices()
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    val id = centralPeerId
                    try {
                        gatt.close()
                    } catch (_: Exception) {
                    }
                    if (centralGatt === gatt) {
                        centralGatt = null
                        centralWriteChar = null
                        centralNotifyChar = null
                        centralPeerId = null
                        centralPeerName = null
                    }
                    if (id != null) main.post { listener.onDisconnected(id) }
                }
            }

            override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
                if (status == BluetoothGatt.GATT_SUCCESS) {
                    centralMtuPayload = maxOf(20, mtu - 3 - HEADER)
                }
            }

            override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    listener.onError("Service discovery failed")
                    return
                }
                val service = gatt.getService(SERVICE_UUID)
                if (service == null) {
                    listener.onError("Presence BLE service missing")
                    return
                }
                centralWriteChar = service.getCharacteristic(WRITE_UUID)
                centralNotifyChar = service.getCharacteristic(NOTIFY_UUID)
                val notify = centralNotifyChar
                if (centralWriteChar == null || notify == null) {
                    listener.onError("Presence BLE characteristics missing")
                    return
                }
                gatt.setCharacteristicNotification(notify, true)
                val cccd = notify.getDescriptor(CCCD_UUID)
                if (cccd != null) {
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    gatt.writeDescriptor(cccd)
                }
                val id = centralPeerId ?: return
                val name = centralPeerName ?: peerNames[id] ?: id
                main.post { listener.onConnected(id, name) }
            }

            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
            ) {
                if (characteristic.uuid != NOTIFY_UUID) return
                val id = centralPeerId ?: return
                val value = characteristic.value ?: return
                ingestChunk(id, value)
            }

            @Deprecated("Deprecated in Java")
            override fun onCharacteristicChanged(
                gatt: BluetoothGatt,
                characteristic: BluetoothGattCharacteristic,
                value: ByteArray,
            ) {
                if (characteristic.uuid != NOTIFY_UUID) return
                val id = centralPeerId ?: return
                ingestChunk(id, value)
            }
        }

    private val gattServerCallback =
        object : BluetoothGattServerCallback() {
            override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    // Wait until CCCD subscribe before treating as app-connected.
                    peripheralDevice = device
                    peripheralPeerId = device.address
                    peripheralPeerName =
                        peerNames[device.address]
                            ?: try {
                                device.name?.removePrefix(NAME_PREFIX)?.trim()
                            } catch (_: SecurityException) {
                                null
                            }
                            ?: device.address
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    if (peripheralDevice?.address == device.address) {
                        val id = peripheralPeerId
                        peripheralDevice = null
                        peripheralSubscribed = false
                        peripheralPeerId = null
                        peripheralPeerName = null
                        if (id != null) main.post { listener.onDisconnected(id) }
                    }
                }
            }

            override fun onCharacteristicWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                characteristic: BluetoothGattCharacteristic,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray?,
            ) {
                if (characteristic.uuid == WRITE_UUID && value != null) {
                    val id = device.address
                    ingestChunk(id, value)
                }
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            }

            override fun onDescriptorWriteRequest(
                device: BluetoothDevice,
                requestId: Int,
                descriptor: BluetoothGattDescriptor,
                preparedWrite: Boolean,
                responseNeeded: Boolean,
                offset: Int,
                value: ByteArray?,
            ) {
                if (descriptor.uuid == CCCD_UUID) {
                    peripheralSubscribed =
                        value != null &&
                            value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
                    if (peripheralSubscribed) {
                        peripheralDevice = device
                        peripheralPeerId = device.address
                        val name = peripheralPeerName ?: peerNames[device.address] ?: device.address
                        peripheralPeerName = name
                        main.post { listener.onConnected(device.address, name) }
                    }
                }
                if (responseNeeded) {
                    gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, value)
                }
            }
        }

    private fun sanitizeName(raw: String): String {
        val cleaned =
            raw.map { ch -> if (ch.code in 32..126) ch else ' ' }.joinToString("")
                .trim()
                .ifEmpty { "Guest" }
        return if (cleaned.length <= 18) cleaned else cleaned.substring(0, 18)
    }
}
