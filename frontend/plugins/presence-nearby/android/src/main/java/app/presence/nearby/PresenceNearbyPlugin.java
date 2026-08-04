package app.presence.nearby;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

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
        ),
        @Permission(
            alias = "nearbyWifi",
            strings = { Manifest.permission.NEARBY_WIFI_DEVICES }
        )
    }
)
public class PresenceNearbyPlugin extends Plugin {
    private static final String TAG = "PresenceNearby";
    private static final String SERVICE_ID = "presence.nearby.v1";
    private static final Strategy STRATEGY = Strategy.P2P_POINT_TO_POINT;

    private ConnectionsClient connectionsClient;
    private String connectedEndpointId;
    private PluginCall pendingStartCall;
    private String pendingStartAction; // "advertise" | "discover"

    private ConnectionsClient client() {
        if (connectionsClient == null) {
            connectionsClient = Nearby.getConnectionsClient(getContext());
        }
        return connectionsClient;
    }

    /** Stop advertise/discover so retries don't hit STATUS_ALREADY_*. */
    private void quietStopNetworking() {
        try {
            client().stopAdvertising();
        } catch (Exception e) {
            Log.d(TAG, "stopAdvertising: " + e.getMessage());
        }
        try {
            client().stopDiscovery();
        } catch (Exception e) {
            Log.d(TAG, "stopDiscovery: " + e.getMessage());
        }
    }

    private boolean isGranted(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission)
            == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasRequiredRuntimePermissions() {
        if (!isGranted(Manifest.permission.ACCESS_COARSE_LOCATION)
            || !isGranted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            return false;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!isGranted(Manifest.permission.BLUETOOTH_SCAN)
                || !isGranted(Manifest.permission.BLUETOOTH_ADVERTISE)
                || !isGranted(Manifest.permission.BLUETOOTH_CONNECT)) {
                return false;
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!isGranted(Manifest.permission.NEARBY_WIFI_DEVICES)) {
                return false;
            }
        }
        return true;
    }

    private String[] missingPermissionAliases() {
        List<String> aliases = new ArrayList<>();
        if (getPermissionState("location") != PermissionState.GRANTED) {
            // Also handle partial grant via direct checks
            if (!isGranted(Manifest.permission.ACCESS_COARSE_LOCATION)
                || !isGranted(Manifest.permission.ACCESS_FINE_LOCATION)) {
                aliases.add("location");
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!isGranted(Manifest.permission.BLUETOOTH_SCAN)
                || !isGranted(Manifest.permission.BLUETOOTH_ADVERTISE)
                || !isGranted(Manifest.permission.BLUETOOTH_CONNECT)) {
                aliases.add("bluetooth");
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!isGranted(Manifest.permission.NEARBY_WIFI_DEVICES)) {
                aliases.add("nearbyWifi");
            }
        }
        return aliases.toArray(new String[0]);
    }

    /**
     * Request any missing Nearby permissions, then run startAdvertise/startDiscover
     * stored on the pending call.
     */
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
                "Nearby needs Location and Bluetooth permissions. Enable them in system Settings if denied.";
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

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String endpointId, @NonNull Payload payload) {
            if (payload.getType() != Payload.Type.BYTES || payload.asBytes() == null) {
                return;
            }
            String data = new String(payload.asBytes(), StandardCharsets.UTF_8);
            JSObject ev = new JSObject();
            ev.put("peerId", endpointId);
            ev.put("data", data);
            notifyListeners("message", ev);
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String endpointId, @NonNull PayloadTransferUpdate update) {
        }
    };

    private final ConnectionLifecycleCallback connectionLifecycleCallback = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String endpointId, @NonNull ConnectionInfo info) {
            client().acceptConnection(endpointId, payloadCallback);
        }

        @Override
        public void onConnectionResult(@NonNull String endpointId, @NonNull ConnectionResolution resolution) {
            if (resolution.getStatus().isSuccess()) {
                connectedEndpointId = endpointId;
                JSObject ev = new JSObject();
                ev.put("id", endpointId);
                ev.put("name", endpointId);
                notifyListeners("connected", ev);
            } else {
                emitError("Connection failed: " + resolution.getStatus().getStatusMessage());
            }
        }

        @Override
        public void onDisconnected(@NonNull String endpointId) {
            if (endpointId.equals(connectedEndpointId)) {
                connectedEndpointId = null;
            }
            JSObject ev = new JSObject();
            ev.put("id", endpointId);
            notifyListeners("disconnected", ev);
        }
    };

    private final EndpointDiscoveryCallback discoveryCallback = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String endpointId, @NonNull DiscoveredEndpointInfo info) {
            JSObject ev = new JSObject();
            ev.put("id", endpointId);
            ev.put("name", info.getEndpointName());
            notifyListeners("peerFound", ev);
        }

        @Override
        public void onEndpointLost(@NonNull String endpointId) {
            JSObject ev = new JSObject();
            ev.put("id", endpointId);
            notifyListeners("peerLost", ev);
        }
    };

    private void emitError(String message) {
        Log.e(TAG, message);
        JSObject ev = new JSObject();
        ev.put("message", message);
        notifyListeners("error", ev);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
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
        // Always clear prior session so retry after permission grant is clean.
        quietStopNetworking();
        String displayName = call.getString("displayName", "Presence");
        AdvertisingOptions options = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        client()
            .startAdvertising(displayName, SERVICE_ID, connectionLifecycleCallback, options)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> {
                String msg = e.getMessage() != null ? e.getMessage() : "advertise failed";
                // If we still race, stop and try once more.
                if (msg.contains("STATUS_ALREADY_ADVERTISING") || msg.contains("8001")) {
                    quietStopNetworking();
                    client()
                        .startAdvertising(displayName, SERVICE_ID, connectionLifecycleCallback, options)
                        .addOnSuccessListener(unused -> call.resolve())
                        .addOnFailureListener(e2 -> {
                            String m2 = e2.getMessage() != null ? e2.getMessage() : "advertise failed";
                            emitError(m2);
                            call.reject(m2, e2);
                        });
                    return;
                }
                emitError(msg);
                call.reject(msg, e);
            });
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!ensurePermissionsThen(call, "discover")) {
            return;
        }
        doStartDiscovery(call);
    }

    private void doStartDiscovery(PluginCall call) {
        // Do not stop advertising here — scanning runs advertise + discover together.
        try {
            client().stopDiscovery();
        } catch (Exception e) {
            Log.d(TAG, "stopDiscovery before start: " + e.getMessage());
        }
        DiscoveryOptions options = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        client()
            .startDiscovery(SERVICE_ID, discoveryCallback, options)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> {
                String msg = e.getMessage() != null ? e.getMessage() : "discovery failed";
                if (msg.contains("STATUS_ALREADY_DISCOVERING") || msg.contains("8002")) {
                    try {
                        client().stopDiscovery();
                    } catch (Exception ignored) {
                    }
                    client()
                        .startDiscovery(SERVICE_ID, discoveryCallback, options)
                        .addOnSuccessListener(unused -> call.resolve())
                        .addOnFailureListener(e2 -> {
                            String m2 = e2.getMessage() != null ? e2.getMessage() : "discovery failed";
                            emitError(m2);
                            call.reject(m2, e2);
                        });
                    return;
                }
                emitError(msg);
                call.reject(msg, e);
            });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        quietStopNetworking();
        if (connectedEndpointId != null) {
            try {
                client().disconnectFromEndpoint(connectedEndpointId);
            } catch (Exception e) {
                Log.d(TAG, "disconnect: " + e.getMessage());
            }
            connectedEndpointId = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String endpointId = call.getString("endpointId");
        if (endpointId == null || endpointId.isEmpty()) {
            call.reject("endpointId required");
            return;
        }
        String localName = call.getString("displayName", "Presence");
        client()
            .requestConnection(localName, endpointId, connectionLifecycleCallback)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> {
                emitError(e.getMessage() != null ? e.getMessage() : "connect failed");
                call.reject(e.getMessage(), e);
            });
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        if (connectedEndpointId != null) {
            try {
                client().disconnectFromEndpoint(connectedEndpointId);
            } catch (Exception e) {
                Log.d(TAG, "disconnect: " + e.getMessage());
            }
            connectedEndpointId = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data required");
            return;
        }
        if (connectedEndpointId == null) {
            call.reject("not connected");
            return;
        }
        Payload payload = Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8));
        client()
            .sendPayload(connectedEndpointId, payload)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> call.reject(e.getMessage(), e));
    }
}
