//! Bluetooth Nearby for Presence desktop — BLE GATT (PROTOCOL.md).
//! Windows + macOS via btleplug central (connect from desktop to a phone).

use thiserror::Error;

mod framing;

#[cfg(any(windows, target_os = "macos"))]
mod desktop_ble;

#[cfg(windows)]
mod win_peripheral;

#[cfg(target_os = "macos")]
mod macos_peripheral;

#[derive(Debug, Error)]
pub enum NearbyError {
    #[error("{0}")]
    Msg(String),
    #[error("not connected")]
    NotConnected,
    #[error("Bluetooth Nearby is not available on this platform")]
    UnsupportedPlatform,
}

impl NearbyError {
    pub fn msg(s: impl Into<String>) -> Self {
        NearbyError::Msg(s.into())
    }
}

pub const NAME_PREFIX: &str = framing::NAME_PREFIX;

pub fn platform_available() -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        desktop_ble::DesktopBle::available()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

pub struct NearbyManager {
    #[cfg(any(windows, target_os = "macos"))]
    ble: desktop_ble::DesktopBle,
}

impl NearbyManager {
    pub fn new() -> Self {
        Self {
            #[cfg(any(windows, target_os = "macos"))]
            ble: desktop_ble::DesktopBle::new(),
        }
    }

    pub async fn start_advertising(
        &mut self,
        app: tauri::AppHandle,
        display_name: String,
    ) -> Result<(), NearbyError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            return self.ble.start_advertising(app, display_name).await;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (app, display_name);
            Err(NearbyError::UnsupportedPlatform)
        }
    }

    pub async fn start_discovery(&mut self, app: tauri::AppHandle) -> Result<(), NearbyError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            return self.ble.start_discovery(app).await;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = app;
            Err(NearbyError::UnsupportedPlatform)
        }
    }

    pub async fn stop(&mut self) -> Result<(), NearbyError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            return self.ble.stop().await;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Ok(())
        }
    }

    pub async fn connect(
        &mut self,
        app: tauri::AppHandle,
        endpoint_id: String,
    ) -> Result<(), NearbyError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            return self.ble.connect(app, endpoint_id).await;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = (app, endpoint_id);
            Err(NearbyError::UnsupportedPlatform)
        }
    }

    pub async fn disconnect(&mut self) -> Result<(), NearbyError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            return self.ble.disconnect().await;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Ok(())
        }
    }

    pub async fn send(&self, data: String) -> Result<(), NearbyError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            return self.ble.send(data).await;
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = data;
            Err(NearbyError::UnsupportedPlatform)
        }
    }
}
