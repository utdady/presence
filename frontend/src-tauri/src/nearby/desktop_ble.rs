//! Desktop BLE Nearby via btleplug (central role).
//! Same GATT UUIDs + chunk framing as Android/iOS — see PROTOCOL.md.
//!
//! Use **Find nearby** then tap a phone to connect (this desktop is the BLE central).

use super::framing::{
    self, sanitize_name, Reassembly, DEFAULT_PAYLOAD, NAME_PREFIX, NOTIFY_UUID, SERVICE_UUID,
    WRITE_UUID,
};
use super::NearbyError;
use crate::{emit_connected, emit_disconnected, emit_message, emit_peer_found};
use btleplug::api::{
    Central, CentralEvent, Characteristic, Manager as _, Peripheral as _, ScanFilter, WriteType,
};
use btleplug::platform::{Adapter, Manager, Peripheral, PeripheralId};
use futures::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Mutex;
use uuid::Uuid;

fn service_uuid() -> Uuid {
    Uuid::parse_str(SERVICE_UUID).expect("service uuid")
}
fn write_uuid() -> Uuid {
    Uuid::parse_str(WRITE_UUID).expect("write uuid")
}
fn notify_uuid() -> Uuid {
    Uuid::parse_str(NOTIFY_UUID).expect("notify uuid")
}

struct Session {
    peer_id: String,
    peripheral: Peripheral,
    write_char: Characteristic,
    payload_size: usize,
}

pub struct DesktopBle {
    display_name: String,
    scan_stop: Arc<AtomicBool>,
    peers: Arc<Mutex<HashMap<String, (Peripheral, String)>>>,
    session: Arc<Mutex<Option<Session>>>,
    reassembly: Arc<Mutex<HashMap<String, Reassembly>>>,
    next_msg_id: AtomicU16,
    adapter: Arc<Mutex<Option<Adapter>>>,
}

impl DesktopBle {
    pub fn new() -> Self {
        Self {
            display_name: "Guest".into(),
            scan_stop: Arc::new(AtomicBool::new(true)),
            peers: Arc::new(Mutex::new(HashMap::new())),
            session: Arc::new(Mutex::new(None)),
            reassembly: Arc::new(Mutex::new(HashMap::new())),
            next_msg_id: AtomicU16::new(0),
            adapter: Arc::new(Mutex::new(None)),
        }
    }

    pub fn available() -> bool {
        true
    }

    async fn adapter(&self) -> Result<Adapter, NearbyError> {
        let mut slot = self.adapter.lock().await;
        if let Some(a) = slot.clone() {
            return Ok(a);
        }
        let manager = Manager::new()
            .await
            .map_err(|e| NearbyError::msg(format!("BLE manager: {e}")))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| NearbyError::msg(format!("BLE adapters: {e}")))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| NearbyError::msg("No Bluetooth adapter"))?;
        *slot = Some(adapter.clone());
        Ok(adapter)
    }

    pub async fn start_advertising(
        &mut self,
        _app: AppHandle,
        display_name: String,
    ) -> Result<(), NearbyError> {
        self.display_name = sanitize_name(&display_name);
        let name = format!("{NAME_PREFIX}{}", self.display_name);
        #[cfg(windows)]
        let _ = super::win_peripheral::start_peripheral(name.clone());
        #[cfg(target_os = "macos")]
        let _ = super::macos_peripheral::start_peripheral(name);
        let _ = self.adapter().await?;
        Ok(())
    }

    pub async fn start_discovery(&mut self, app: AppHandle) -> Result<(), NearbyError> {
        let adapter = self.adapter().await?;
        self.scan_stop.store(false, Ordering::SeqCst);
        let _ = adapter.stop_scan().await;
        adapter
            .start_scan(ScanFilter {
                services: vec![service_uuid()],
            })
            .await
            .map_err(|e| NearbyError::msg(format!("BLE scan: {e}")))?;

        let mut events = adapter
            .events()
            .await
            .map_err(|e| NearbyError::msg(format!("BLE events: {e}")))?;
        let peers = self.peers.clone();
        let stop = self.scan_stop.clone();
        let app2 = app.clone();
        let adapter2 = adapter.clone();
        tokio::spawn(async move {
            while !stop.load(Ordering::SeqCst) {
                tokio::select! {
                    ev = events.next() => {
                        let Some(ev) = ev else { break };
                        if let CentralEvent::DeviceDiscovered(id) = ev {
                            if let Ok(peripheral) = adapter2.peripheral(&id).await {
                                if let Ok(Some(props)) = peripheral.properties().await {
                                    let local = props.local_name.unwrap_or_default();
                                    if !local.starts_with(NAME_PREFIX) {
                                        continue;
                                    }
                                    let display = local[NAME_PREFIX.len()..].trim().to_string();
                                    let display = if display.is_empty() { local.clone() } else { display };
                                    let key = peripheral_key(&id);
                                    let mut map = peers.lock().await;
                                    if !map.contains_key(&key) {
                                        map.insert(key.clone(), (peripheral, display.clone()));
                                        drop(map);
                                        emit_peer_found(&app2, key, display);
                                    }
                                }
                            }
                        }
                    }
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                }
            }
        });
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<(), NearbyError> {
        self.scan_stop.store(true, Ordering::SeqCst);
        if let Ok(adapter) = self.adapter().await {
            let _ = adapter.stop_scan().await;
        }
        let _ = self.disconnect().await;
        #[cfg(windows)]
        super::win_peripheral::stop_peripheral();
        #[cfg(target_os = "macos")]
        super::macos_peripheral::stop_peripheral();
        self.peers.lock().await.clear();
        Ok(())
    }

    pub async fn connect(&mut self, app: AppHandle, endpoint_id: String) -> Result<(), NearbyError> {
        if self.session.lock().await.is_some() {
            return Err(NearbyError::msg("Already connected"));
        }
        self.scan_stop.store(true, Ordering::SeqCst);
        if let Ok(adapter) = self.adapter().await {
            let _ = adapter.stop_scan().await;
        }

        let (peripheral, name) = {
            let map = self.peers.lock().await;
            map.get(&endpoint_id)
                .map(|(p, n)| (p.clone(), n.clone()))
                .ok_or_else(|| NearbyError::msg("Unknown peer — scan first"))?
        };

        peripheral
            .connect()
            .await
            .map_err(|e| NearbyError::msg(format!("BLE connect: {e}")))?;
        peripheral
            .discover_services()
            .await
            .map_err(|e| NearbyError::msg(format!("BLE services: {e}")))?;

        let chars = peripheral.characteristics();
        let write_char = chars
            .iter()
            .find(|c| c.uuid == write_uuid())
            .cloned()
            .ok_or_else(|| NearbyError::msg("Presence write characteristic missing"))?;
        let notify_char = chars
            .iter()
            .find(|c| c.uuid == notify_uuid())
            .cloned()
            .ok_or_else(|| NearbyError::msg("Presence notify characteristic missing"))?;

        peripheral
            .subscribe(&notify_char)
            .await
            .map_err(|e| NearbyError::msg(format!("BLE subscribe: {e}")))?;

        *self.session.lock().await = Some(Session {
            peer_id: endpoint_id.clone(),
            peripheral: peripheral.clone(),
            write_char,
            payload_size: DEFAULT_PAYLOAD.max(20),
        });

        emit_connected(&app, endpoint_id.clone(), name);

        let mut notif = peripheral
            .notifications()
            .await
            .map_err(|e| NearbyError::msg(format!("BLE notifications: {e}")))?;
        let session = self.session.clone();
        let reassembly = self.reassembly.clone();
        let app2 = app.clone();
        let peer_for_read = endpoint_id.clone();
        tokio::spawn(async move {
            while let Some(n) = notif.next().await {
                if n.uuid != notify_uuid() {
                    continue;
                }
                let mut map = reassembly.lock().await;
                let slot = map.entry(peer_for_read.clone()).or_default();
                if let Some(full) = slot.ingest(&n.value) {
                    drop(map);
                    if let Ok(text) = String::from_utf8(full) {
                        emit_message(&app2, peer_for_read.clone(), text);
                    }
                }
            }
            let mut s = session.lock().await;
            if s.as_ref().map(|x| x.peer_id.as_str()) == Some(peer_for_read.as_str()) {
                *s = None;
                emit_disconnected(&app2, peer_for_read);
            }
        });

        Ok(())
    }

    pub async fn disconnect(&mut self) -> Result<(), NearbyError> {
        let mut s = self.session.lock().await;
        if let Some(sess) = s.take() {
            let _ = sess.peripheral.disconnect().await;
        }
        Ok(())
    }

    pub async fn send(&self, data: String) -> Result<(), NearbyError> {
        let bytes = data.into_bytes();
        if bytes.len() > framing::MAX_MESSAGE {
            return Err(NearbyError::msg("Message too large for Nearby BLE"));
        }
        let guard = self.session.lock().await;
        let sess = guard.as_ref().ok_or(NearbyError::NotConnected)?;
        let msg_id = self.next_msg_id.fetch_add(1, Ordering::SeqCst);
        let chunks = framing::fragment(&bytes, msg_id, sess.payload_size);
        for chunk in chunks {
            sess.peripheral
                .write(&sess.write_char, &chunk, WriteType::WithoutResponse)
                .await
                .map_err(|e| NearbyError::msg(format!("BLE write: {e}")))?;
        }
        Ok(())
    }
}

fn peripheral_key(id: &PeripheralId) -> String {
    format!("{id}")
}
