package app.presence.nearby;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/**
 * Capacitor surface for Presence Nearby — BLE GATT via {@link BleNearbyTransport}.
 * JS API unchanged from the RFCOMM era.
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
    private static final String BADGE_CHANNEL = "presence_online_badge";
    private static final int BADGE_NOTIFY_ID = 71001;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private BleNearbyTransport transport;

    private PluginCall pendingStartCall;
    private String pendingStartAction;

    private BleNearbyTransport transport() {
        if (transport == null) {
            transport =
                new BleNearbyTransport(
                    getContext(),
                    new BleNearbyTransport.Listener() {
                        @Override
                        public void onPeerFound(String id, String name) {
                            JSObject ev = new JSObject();
                            ev.put("id", id);
                            ev.put("name", name);
                            emitOnMain("peerFound", ev);
                        }

                        @Override
                        public void onPeerLost(String id) {
                            JSObject ev = new JSObject();
                            ev.put("id", id);
                            emitOnMain("peerLost", ev);
                        }

                        @Override
                        public void onConnected(String id, String name) {
                            JSObject ev = new JSObject();
                            ev.put("id", id);
                            ev.put("name", name);
                            emitOnMain("connected", ev);
                        }

                        @Override
                        public void onDisconnected(String id) {
                            JSObject ev = new JSObject();
                            ev.put("id", id);
                            emitOnMain("disconnected", ev);
                        }

                        @Override
                        public void onMessage(String peerId, String data) {
                            JSObject ev = new JSObject();
                            ev.put("peerId", peerId);
                            ev.put("data", data);
                            emitOnMain("message", ev);
                        }

                        @Override
                        public void onError(String message) {
                            Log.e(TAG, message);
                            JSObject ev = new JSObject();
                            ev.put("message", message);
                            emitOnMain("error", ev);
                        }
                    });
        }
        return transport;
    }

    private void emitOnMain(String event, JSObject data) {
        mainHandler.post(() -> notifyListeners(event, data));
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
        // BLE scan historically needed location on older APIs.
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
                    + " permissions.";
            startCall.reject(msg);
            return;
        }
        if ("advertise".equals(action)) {
            doStartAdvertising(startCall);
        } else if ("discover".equals(action)) {
            doStartDiscovery(startCall);
        } else {
            startCall.resolve();
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", transport().isBleAvailable());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        if (hasRequiredRuntimePermissions()) {
            call.resolve();
            return;
        }
        if (!ensurePermissionsThen(call, "resolveOnly")) {
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
        String name = call.getString("displayName", "Guest");
        transport().startAdvertising(name != null ? name : "Guest");
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        if (!ensurePermissionsThen(call, "discover")) {
            return;
        }
        doStartDiscovery(call);
    }

    private void doStartDiscovery(PluginCall call) {
        transport().startDiscovery();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        transport().stop();
        call.resolve();
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String endpointId = call.getString("endpointId");
        if (endpointId == null || endpointId.isEmpty()) {
            call.reject("endpointId required");
            return;
        }
        String displayName = call.getString("displayName");
        transport().connect(endpointId, displayName);
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        transport().disconnect();
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data required");
            return;
        }
        transport().send(data);
        call.resolve();
    }

    @PluginMethod
    public void setSpeakerphone(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        try {
            AudioManager am = (AudioManager) getContext().getSystemService(android.content.Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                am.setSpeakerphoneOn(on);
            }
        } catch (Exception e) {
            Log.w(TAG, "setSpeakerphone: " + e.getMessage());
        }
        call.resolve();
    }

    @PluginMethod
    public void setAppBadge(PluginCall call) {
        int count = call.getInt("count", 0);
        try {
            NotificationManagerCompat nm = NotificationManagerCompat.from(getContext());
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.NotificationChannel ch =
                    new android.app.NotificationChannel(
                        BADGE_CHANNEL, "Online friends", android.app.NotificationManager.IMPORTANCE_MIN);
                ch.setShowBadge(true);
                nm.createNotificationChannel(ch);
            }
            if (count <= 0) {
                nm.cancel(BADGE_NOTIFY_ID);
            } else {
                NotificationCompat.Builder b =
                    new NotificationCompat.Builder(getContext(), BADGE_CHANNEL)
                        .setSmallIcon(android.R.drawable.presence_online)
                        .setContentTitle("Presence")
                        .setContentText(count + " online")
                        .setNumber(count)
                        .setOngoing(true)
                        .setSilent(true)
                        .setPriority(NotificationCompat.PRIORITY_MIN);
                nm.notify(BADGE_NOTIFY_ID, b.build());
            }
        } catch (Exception e) {
            Log.w(TAG, "setAppBadge: " + e.getMessage());
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (transport != null) {
            transport.stop();
        }
        super.handleOnDestroy();
    }
}
