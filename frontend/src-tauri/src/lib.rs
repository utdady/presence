use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

mod nearby;

use nearby::NearbyManager;

pub struct AppState {
    pub nearby: Arc<Mutex<NearbyManager>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerPayload {
    id: String,
    name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PeerIdPayload {
    id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MessagePayload {
    peer_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct ErrorPayload {
    message: String,
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit("nearby-error", ErrorPayload { message });
}

#[tauri::command]
async fn nearby_is_available() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "available": nearby::platform_available()
    }))
}

#[tauri::command]
async fn nearby_request_permissions() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
async fn nearby_start_advertising(
    app: AppHandle,
    state: State<'_, AppState>,
    display_name: String,
) -> Result<(), String> {
    let mut g = state.nearby.lock().await;
    g.start_advertising(app, display_name)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn nearby_start_discovery(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut g = state.nearby.lock().await;
    g.start_discovery(app).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn nearby_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut g = state.nearby.lock().await;
    g.stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn nearby_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    endpoint_id: String,
    display_name: Option<String>,
) -> Result<(), String> {
    let _ = display_name;
    let mut g = state.nearby.lock().await;
    g.connect(app.clone(), endpoint_id)
        .await
        .map_err(|e| {
            emit_error(&app, e.to_string());
            e.to_string()
        })
}

#[tauri::command]
async fn nearby_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let mut g = state.nearby.lock().await;
    g.disconnect().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn nearby_send(state: State<'_, AppState>, data: String) -> Result<(), String> {
    let g = state.nearby.lock().await;
    g.send(data).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::try_init();

    tauri::Builder::default()
        .manage(AppState {
            nearby: Arc::new(Mutex::new(NearbyManager::new())),
        })
        .invoke_handler(tauri::generate_handler![
            nearby_is_available,
            nearby_request_permissions,
            nearby_start_advertising,
            nearby_start_discovery,
            nearby_stop,
            nearby_connect,
            nearby_disconnect,
            nearby_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Presence desktop");
}

pub(crate) fn emit_peer_found(app: &AppHandle, id: String, name: String) {
    let _ = app.emit("nearby-peer-found", PeerPayload { id, name });
}

pub(crate) fn emit_peer_lost(app: &AppHandle, id: String) {
    let _ = app.emit("nearby-peer-lost", PeerIdPayload { id });
}

pub(crate) fn emit_connected(app: &AppHandle, id: String, name: String) {
    let _ = app.emit("nearby-connected", PeerPayload { id, name });
}

pub(crate) fn emit_disconnected(app: &AppHandle, id: String) {
    let _ = app.emit("nearby-disconnected", PeerIdPayload { id });
}

pub(crate) fn emit_message(app: &AppHandle, peer_id: String, data: String) {
    let _ = app.emit("nearby-message", MessagePayload { peer_id, data });
}

pub(crate) fn emit_nearby_error(app: &AppHandle, message: String) {
    let _ = app.emit("nearby-error", ErrorPayload { message });
}
