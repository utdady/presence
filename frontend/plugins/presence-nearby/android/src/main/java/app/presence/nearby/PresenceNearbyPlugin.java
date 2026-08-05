package app.presence.nearby;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothServerSocket;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * True zero-Wi-Fi transport: Bluetooth Classic RFCOMM only.
 * Same Capacitor API as before (advertise / discover / connect / send / events).
 * No Google Nearby Connections, no Wi-Fi P2P / hotspot upgrade.
 */
@CapacitorPlugin(
    name = "PresenceNearby",
    permissions = {
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
            }
        ),
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_SCAN,
                Manifest.permission.BLUETOOTH_ADVERTISE,
                Manifest.permission.BLUETOOTH_CONNECT
            }
        )
    }
)
public class PresenceNearbyPlugin extends Plugin {
    private static final String TAG = "PresenceNearby";
    /** Fixed RFCOMM service UUID — both sides must use the same value. */
    private static final UUID RFCOMM_UUID =
        UUID.fromString("8f4e2a10-9c3d-4b7e-a1f2-0d5e6c7b8a9c");
    private static final String SERVICE_NAME = "Presence";
    /** Device name prefix so discovery can find other Presence peers. */
    private static final String NAME_PREFIX = "Presence/";
    private static final int MAX_PAYLOAD = 512 * 1024;
    private static final int DISCOVERABLE_SECONDS = 300;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final ExecutorService ioPool = Executors.newCachedThreadPool();
    private final Object writeLock = new Object();
    private final Map<String, String> peerNames = new HashMap<>();
    private final AtomicBoolean accepting = new AtomicBoolean(false);
    private final AtomicBoolean discovering = new AtomicBoolean(false);

    private PluginCall pendingStartCall;
    private String pendingStartAction;

    private String savedAdapterName;
    private String localDisplayName = "Presence";
    private String connectedPeerId;
    private String connectedPeerName;

    private BluetoothServerSocket serverSocket;
    private BluetoothSocket dataSocket;
    private DataInputStream dataIn;
    private DataOutputStream dataOut;
    private Thread acceptThread;
    private Thread readerThread;
    private boolean discoveryReceiverRegistered;
    private boolean discoverablePrompted;

    private final BroadcastReceiver discoveryReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) {
                return;
            }
            String action = intent.getAction();
            if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                BluetoothDevice device;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    device =
                        intent.getParcelableExtra(
                            BluetoothDevice.EXTRA_DEVICE, BluetoothDevice.class);
                } else {
                    device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                }
                if (device == null) {
                    return;
                }
                try {
                    String name = device.getName();
                    String address = device.getAddress();
                    if (address == null) {
                        return;
                    }
                    if (name == null || !name.startsWith(NAME_PREFIX)) {
                        return;
                    }
                    String display = name.substring(NAME_PREFIX.length()).trim();
                    if (display.isEmpty()) {
                        display = name;
                    }
                    peerNames.put(address, display);
                    JSObject ev = new JSObject();
                    ev.put("id", address);
                    ev.put("name", display);
                    notifyListeners("peerFound", ev);
                } catch (SecurityException se) {
                    Log.w(TAG, "ACTION_FOUND security: " + se.getMessage());
                }
            } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(action)) {
                // Continuous scan while discovery mode is on.
                if (discovering.get() && connectedPeerId == null) {
                    startClassicDiscovery();
                }
            }
        }
    };

    private BluetoothAdapter adapter() {
        return BluetoothAdapter.getDefaultAdapter();
    }

    private boolean isGranted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasRequiredRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return isGranted(Manifest.permission.BLUETOOTH_SCAN)
                && isGranted(Manifest.permission.BLUETOOTH_ADVERTISE)
                && isGranted(Manifest.permission.BLUETOOTH_CONNECT);
        }
        // Classic discovery needs location on Android 6–11.
        return isGranted(Manifest.permission.ACCESS_COARSE_LOCATION)
            || isGranted(Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private String[] missingPermissionAliases() {
        List<String> aliases = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!isGranted(Manifest.permission.BLUETOOTH_SCAN)
                || !isGranted(Manifest.permission.BLUETOOTH_ADVERTISE)
                || !isGranted(Manifest.permission.BLUETOOTH_CONNECT)) {
                aliases.add("bluetooth");
            }
        } else {
            if (!isGranted(Manifest.permission.ACCESS_COARSE_LOCATION)
                && !isGranted(Manifest.permission.ACCESS_FINE_LOCATION)) {
                aliases.add("location");
            }
        }
        return aliases.toArray(new String[0]);
    }

    private boolean ensurePermissionsThen(PluginCall call, String action) {
        if (hasRequiredRuntimePermissions()) {
            return true;
        }
        String[] aliases = missingPermissionAliases();
        if (aliases.length == 0) {
            return true;
        }
        pendingStartCall = call;
        pendingStartAction = action;
        requestPermissionForAliases(aliases, call, "nearbyPermissionsCallback");
        return false;
    }

    @PermissionCallback
    private void nearbyPermissionsCallback(PluginCall call) {
        PluginCall startCall = pendingStartCall != null ? pendingStartCall : call;
        String action = pendingStartAction;
        pendingStartCall = null;
        pendingStartAction = null;

        if (!hasRequiredRuntimePermissions()) {
            String msg =
                "Nearby needs Bluetooth"
                    + (Build.VERSION.SDK_INT < Build.VERSION_CODES.S ? " and Location" : "")
                    + " permissions. Enable them in system Settings if denied.";
            emitError(msg);
            startCall.reject(msg);
            return;
        }
        if ("advertise".equals(action)) {
            doStartAdvertising(startCall);
        } else if ("discover".equals(action)) {
            doStartDiscovery(startCall);
        } else if ("resolveOnly".equals(action)) {
            startCall.resolve();
        } else {
            startCall.resolve();
        }
    }

    private void emitError(String message) {
        Log.e(TAG, message);
        JSObject ev = new JSObject();
        ev.put("message", message);
        mainHandler.post(() -> notifyListeners("error", ev));
    }

    private void emitOnMain(String event, JSObject data) {
        mainHandler.post(() -> notifyListeners(event, data));
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        BluetoothAdapter adapter = adapter();
        ret.put("available", adapter != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasRequiredRuntimePermissions()) {
            call.resolve();
            return;
        }
        String[] aliases = missingPermissionAliases();
        if (aliases.length == 0) {
            call.resolve();
            return;
        }
        pendingStartCall = call;
        pendingStartAction = "resolveOnly";
        requestPermissionForAliases(aliases, call, "requestOnlyCallback");
    }

    @PermissionCallback
    private void requestOnlyCallback(PluginCall call) {
        pendingStartCall = null;
        pendingStartAction = null;
        if (!hasRequiredRuntimePermissions()) {
            call.reject("Permissions not granted");
            return;
        }
        call.resolve();
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        if (!ensurePermissionsThen(call, "advertise")) {
            return;
        }
        doStartAdvertising(call);
    }

    private void doStartAdvertising(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("Bluetooth not supported on this device");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("Turn on Bluetooth to use Nearby");
            return;
        }

        String displayName = call.getString("displayName", "Presence");
        if (displayName == null || displayName.trim().isEmpty()) {
            displayName = "Presence";
        }
        localDisplayName = displayName.trim();

        try {
            // Rename so peers discover this phone as a Presence peer.
            if (savedAdapterName == null) {
                savedAdapterName = adapter.getName();
            }
            String publicName = NAME_PREFIX + sanitizeName(localDisplayName);
            adapter.setName(publicName);

            // Prompt discoverable so inquiry can see this device (once per session).
            if (!discoverablePrompted) {
                try {
                    Intent discoverable = new Intent(BluetoothAdapter.ACTION_REQUEST_DISCOVERABLE);
                    discoverable.putExtra(
                        BluetoothAdapter.EXTRA_DISCOVERABLE_DURATION, DISCOVERABLE_SECONDS);
                    if (getActivity() != null) {
                        getActivity().startActivity(discoverable);
                        discoverablePrompted = true;
                    }
                } catch (Exception e) {
                    Log.w(TAG, "discoverable prompt: " + e.getMessage());
                }
            }

            startServerListen();
            call.resolve();
        } catch (SecurityException se) {
            String msg = "Bluetooth permission denied for advertising";
            emitError(msg);
            call.reject(msg, se);
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : "advertise failed";
            emitError(msg);
            call.reject(msg, e);
        }
    }

    private static String sanitizeName(String name) {
        // Keep adapter name short and printable.
        String cleaned = name.replaceAll("[\\r\\n]", " ").trim();
        if (cleaned.length() > 18) {
            cleaned = cleaned.substring(0, 18);
        }
        return cleaned.isEmpty() ? "Guest" : cleaned;
    }

    private void startServerListen() throws IOException {
        stopAcceptLoop();
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            throw new IOException("No Bluetooth adapter");
        }
        // Insecure RFCOMM avoids system pairing dialogs for many devices.
        serverSocket =
            adapter.listenUsingInsecureRfcommWithServiceRecord(SERVICE_NAME, RFCOMM_UUID);
        accepting.set(true);
        acceptThread =
            new Thread(
                () -> {
                    while (accepting.get()) {
                        try {
                            BluetoothSocket socket = serverSocket.accept();
                            if (socket == null) {
                                continue;
                            }
                            final BluetoothSocket accepted = socket;
                            mainHandler.post(
                                () -> {
                                    try {
                                        if (connectedPeerId != null) {
                                            try {
                                                accepted.close();
                                            } catch (IOException ignored) {
                                            }
                                            return;
                                        }
                                        attachSocket(accepted, true);
                                    } catch (Exception ex) {
                                        Log.e(TAG, "incoming attach", ex);
                                        try {
                                            accepted.close();
                                        } catch (IOException ignored) {
                                        }
                                        emitError(
                                            ex.getMessage() != null
                                                ? ex.getMessage()
                                                : "incoming connect failed");
                                    }
                                });
                        } catch (IOException e) {
                            if (accepting.get()) {
                                Log.d(TAG, "accept ended: " + e.getMessage());
                            }
                            break;
                        }
                    }
                },
                "PresenceBtAccept");
        acceptThread.start();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!ensurePermissionsThen(call, "discover")) {
            return;
        }
        doStartDiscovery(call);
    }

    private void doStartDiscovery(PluginCall call) {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            call.reject("Bluetooth not supported on this device");
            return;
        }
        if (!adapter.isEnabled()) {
            call.reject("Turn on Bluetooth to use Nearby");
            return;
        }

        try {
            registerDiscoveryReceiver();
            discovering.set(true);
            peerNames.clear();

            // Already paired Presence devices.
            try {
                for (BluetoothDevice device : adapter.getBondedDevices()) {
                    String name = device.getName();
                    String address = device.getAddress();
                    if (name != null && name.startsWith(NAME_PREFIX) && address != null) {
                        String display = name.substring(NAME_PREFIX.length()).trim();
                        if (display.isEmpty()) {
                            display = name;
                        }
                        peerNames.put(address, display);
                        JSObject ev = new JSObject();
                        ev.put("id", address);
                        ev.put("name", display);
                        notifyListeners("peerFound", ev);
                    }
                }
            } catch (SecurityException se) {
                Log.w(TAG, "bonded: " + se.getMessage());
            }

            if (!startClassicDiscovery()) {
                call.reject("Could not start Bluetooth discovery");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            String msg = e.getMessage() != null ? e.getMessage() : "discovery failed";
            emitError(msg);
            call.reject(msg, e);
        }
    }

    private boolean startClassicDiscovery() {
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            return false;
        }
        try {
            if (adapter.isDiscovering()) {
                adapter.cancelDiscovery();
            }
            return adapter.startDiscovery();
        } catch (SecurityException se) {
            emitError("Bluetooth scan permission denied");
            return false;
        }
    }

    private void registerDiscoveryReceiver() {
        if (discoveryReceiverRegistered) {
            return;
        }
        IntentFilter filter = new IntentFilter();
        filter.addAction(BluetoothDevice.ACTION_FOUND);
        filter.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext()
                .registerReceiver(discoveryReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(discoveryReceiver, filter);
        }
        discoveryReceiverRegistered = true;
    }

    private void unregisterDiscoveryReceiver() {
        if (!discoveryReceiverRegistered) {
            return;
        }
        try {
            getContext().unregisterReceiver(discoveryReceiver);
        } catch (Exception e) {
            Log.d(TAG, "unregister receiver: " + e.getMessage());
        }
        discoveryReceiverRegistered = false;
    }

    private void cancelDiscoveryQuiet() {
        discovering.set(false);
        BluetoothAdapter adapter = adapter();
        if (adapter == null) {
            return;
        }
        try {
            if (adapter.isDiscovering()) {
                adapter.cancelDiscovery();
            }
        } catch (SecurityException se) {
            Log.d(TAG, "cancelDiscovery: " + se.getMessage());
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String endpointId = call.getString("endpointId");
        if (endpointId == null || endpointId.isEmpty()) {
            call.reject("endpointId required");
            return;
        }
        if (connectedPeerId != null) {
            call.reject("Already connected");
            return;
        }
        BluetoothAdapter adapter = adapter();
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("Bluetooth is off");
            return;
        }

        // Discovery fights RFCOMM connects — always stop first.
        cancelDiscoveryQuiet();

        ioPool.execute(
            () -> {
                BluetoothSocket socket = null;
                try {
                    BluetoothDevice device = adapter.getRemoteDevice(endpointId);
                    String name = peerNames.get(endpointId);
                    try {
                        String dn = device.getName();
                        if (dn != null) {
                            name = dn.startsWith(NAME_PREFIX)
                                ? dn.substring(NAME_PREFIX.length()).trim()
                                : dn;
                        }
                    } catch (SecurityException ignored) {
                    }
                    if (name == null || name.isEmpty()) {
                        name = endpointId;
                    }

                    socket = device.createInsecureRfcommSocketToServiceRecord(RFCOMM_UUID);
                    socket.connect();
                    final String peerName = name;
                    final BluetoothSocket okSocket = socket;
                    mainHandler.post(
                        () -> {
                            try {
                                attachSocket(okSocket, false);
                                call.resolve();
                            } catch (Exception e) {
                                try {
                                    okSocket.close();
                                } catch (IOException ignored) {
                                }
                                String msg =
                                    e.getMessage() != null ? e.getMessage() : "connect failed";
                                emitError(msg);
                                call.reject(msg, e);
                            }
                        });
                } catch (Exception e) {
                    if (socket != null) {
                        try {
                            socket.close();
                        } catch (IOException ignored) {
                        }
                    }
                    String msg = e.getMessage() != null ? e.getMessage() : "connect failed";
                    Log.e(TAG, "connect", e);
                    emitError(msg);
                    mainHandler.post(() -> call.reject(msg, e));
                }
            });
    }

    /**
     * @param incoming true if this side accepted via server socket
     */
    private void attachSocket(BluetoothSocket socket, boolean incoming) throws IOException {
        if (connectedPeerId != null) {
            socket.close();
            return;
        }

        // Stop scan + accept more peers.
        cancelDiscoveryQuiet();
        stopAcceptLoopKeepServerClosed();

        dataSocket = socket;
        dataIn = new DataInputStream(socket.getInputStream());
        dataOut = new DataOutputStream(socket.getOutputStream());

        BluetoothDevice remote = socket.getRemoteDevice();
        String address = remote != null ? remote.getAddress() : "unknown";
        String name = peerNames.get(address);
        try {
            if (remote != null) {
                String dn = remote.getName();
                if (dn != null) {
                    name =
                        dn.startsWith(NAME_PREFIX)
                            ? dn.substring(NAME_PREFIX.length()).trim()
                            : dn;
                }
            }
        } catch (SecurityException ignored) {
        }
        if (name == null || name.isEmpty()) {
            name = localDisplayName;
        }

        connectedPeerId = address;
        connectedPeerName = name;

        startReader();

        JSObject ev = new JSObject();
        ev.put("id", connectedPeerId);
        ev.put("name", connectedPeerName);
        emitOnMain("connected", ev);
        Log.i(TAG, "RFCOMM connected (" + (incoming ? "incoming" : "outgoing") + ") " + address);
    }

    private void startReader() {
        readerThread =
            new Thread(
                () -> {
                    try {
                        while (dataSocket != null && dataSocket.isConnected() && dataIn != null) {
                            int len = dataIn.readInt();
                            if (len <= 0 || len > MAX_PAYLOAD) {
                                throw new IOException("invalid frame length: " + len);
                            }
                            byte[] buf = new byte[len];
                            dataIn.readFully(buf);
                            String data = new String(buf, StandardCharsets.UTF_8);
                            JSObject ev = new JSObject();
                            ev.put("peerId", connectedPeerId);
                            ev.put("data", data);
                            emitOnMain("message", ev);
                        }
                    } catch (Exception e) {
                        Log.d(TAG, "reader end: " + e.getMessage());
                        mainHandler.post(this::handleRemoteDisconnect);
                    }
                },
                "PresenceBtRead");
        readerThread.start();
    }

    private void handleRemoteDisconnect() {
        if (connectedPeerId == null && dataSocket == null) {
            return;
        }
        String id = connectedPeerId != null ? connectedPeerId : "unknown";
        closeDataSocketQuiet();
        connectedPeerId = null;
        connectedPeerName = null;
        JSObject ev = new JSObject();
        ev.put("id", id);
        notifyListeners("disconnected", ev);
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data required");
            return;
        }
        if (dataOut == null || connectedPeerId == null) {
            call.reject("not connected");
            return;
        }
        byte[] bytes = data.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_PAYLOAD) {
            call.reject("payload too large");
            return;
        }
        ioPool.execute(
            () -> {
                try {
                    synchronized (writeLock) {
                        if (dataOut == null) {
                            mainHandler.post(() -> call.reject("not connected"));
                            return;
                        }
                        dataOut.writeInt(bytes.length);
                        dataOut.write(bytes);
                        dataOut.flush();
                    }
                    mainHandler.post(call::resolve);
                } catch (Exception e) {
                    String msg = e.getMessage() != null ? e.getMessage() : "send failed";
                    mainHandler.post(
                        () -> {
                            emitError(msg);
                            call.reject(msg, e);
                            handleRemoteDisconnect();
                        });
                }
            });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        closeDataSocketQuiet();
        String id = connectedPeerId;
        connectedPeerId = null;
        connectedPeerName = null;
        if (id != null) {
            JSObject ev = new JSObject();
            ev.put("id", id);
            notifyListeners("disconnected", ev);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        quietStopAll();
        call.resolve();
    }

    @PluginMethod
    public void setSpeakerphone(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Context ctx = getContext();
        if (ctx == null) {
            call.reject("No context");
            return;
        }
        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        if (am == null) {
            call.reject("No AudioManager");
            return;
        }
        am.setMode(AudioManager.MODE_IN_COMMUNICATION);
        am.setSpeakerphoneOn(on);
        call.resolve();
    }

    private void quietStopAll() {
        discovering.set(false);
        cancelDiscoveryQuiet();
        unregisterDiscoveryReceiver();
        stopAcceptLoop();
        closeDataSocketQuiet();
        connectedPeerId = null;
        connectedPeerName = null;
        peerNames.clear();
        discoverablePrompted = false;
        restoreAdapterName();
    }

    private void stopAcceptLoop() {
        accepting.set(false);
        stopAcceptLoopKeepServerClosed();
    }

    private void stopAcceptLoopKeepServerClosed() {
        accepting.set(false);
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
            serverSocket = null;
        }
        if (acceptThread != null) {
            acceptThread.interrupt();
            acceptThread = null;
        }
    }

    private void closeDataSocketQuiet() {
        if (readerThread != null) {
            readerThread.interrupt();
            readerThread = null;
        }
        try {
            if (dataIn != null) {
                dataIn.close();
            }
        } catch (IOException ignored) {
        }
        dataIn = null;
        try {
            if (dataOut != null) {
                dataOut.close();
            }
        } catch (IOException ignored) {
        }
        dataOut = null;
        try {
            if (dataSocket != null) {
                dataSocket.close();
            }
        } catch (IOException ignored) {
        }
        dataSocket = null;
    }

    private void restoreAdapterName() {
        BluetoothAdapter adapter = adapter();
        if (adapter == null || savedAdapterName == null) {
            return;
        }
        try {
            adapter.setName(savedAdapterName);
        } catch (SecurityException se) {
            Log.d(TAG, "restore name: " + se.getMessage());
        }
        savedAdapterName = null;
    }

    @Override
    protected void handleOnDestroy() {
        quietStopAll();
        ioPool.shutdownNow();
        super.handleOnDestroy();
    }
}
