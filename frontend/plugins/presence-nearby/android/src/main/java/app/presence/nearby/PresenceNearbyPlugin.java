package app.presence.nearby;

import android.util.Log;

import androidx.annotation.NonNull;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
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

@CapacitorPlugin(name = "PresenceNearby")
public class PresenceNearbyPlugin extends Plugin {
    private static final String TAG = "PresenceNearby";
    private static final String SERVICE_ID = "presence.nearby.v1";
    private static final Strategy STRATEGY = Strategy.P2P_STAR;

    private ConnectionsClient connectionsClient;
    private String connectedEndpointId;

    private ConnectionsClient client() {
        if (connectionsClient == null) {
            connectionsClient = Nearby.getConnectionsClient(getContext());
        }
        return connectionsClient;
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
    public void startAdvertising(PluginCall call) {
        String displayName = call.getString("displayName", "Presence");
        AdvertisingOptions options = new AdvertisingOptions.Builder().setStrategy(STRATEGY).build();
        client()
            .startAdvertising(displayName, SERVICE_ID, connectionLifecycleCallback, options)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> {
                emitError(e.getMessage() != null ? e.getMessage() : "advertise failed");
                call.reject(e.getMessage(), e);
            });
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        DiscoveryOptions options = new DiscoveryOptions.Builder().setStrategy(STRATEGY).build();
        client()
            .startDiscovery(SERVICE_ID, discoveryCallback, options)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(e -> {
                emitError(e.getMessage() != null ? e.getMessage() : "discovery failed");
                call.reject(e.getMessage(), e);
            });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        client().stopAdvertising();
        client().stopDiscovery();
        if (connectedEndpointId != null) {
            client().disconnectFromEndpoint(connectedEndpointId);
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
            client().disconnectFromEndpoint(connectedEndpointId);
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