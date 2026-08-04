//! Bluetooth Nearby for Presence desktop.
//! Same RFCOMM UUID, `Presence/` name prefix, and length-prefixed frames as Android.

use thiserror::Error;

#[cfg(windows)]
mod win;

#[derive(Debug, Error)]
pub enum NearbyError {
    #[error("{0}")]
    Msg(String),
    #[error("not connected")]
    NotConnected,
    #[error("Bluetooth Nearby is only implemented on Windows for now")]
    UnsupportedPlatform,
}

impl NearbyError {
    pub fn msg(s: impl Into<String>) -> Self {
        NearbyError::Msg(s.into())
    }
}

/// Must match Android `PresenceNearbyPlugin` RFCOMM UUID.
pub const SERVICE_UUID: &str = "8f4e2a10-9c3d-4b7e-a1f2-0d5e6c7b8a9c";
pub const NAME_PREFIX: &str = "Presence/";
pub const MAX_PAYLOAD: usize = 512 * 1024;

pub fn platform_available() -> bool {
    #[cfg(windows)]
    {
        win::bluetooth_radio_present()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

pub struct NearbyManager {
    #[cfg(windows)]
    win: win::WinNearby,
}

impl NearbyManager {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            win: win::WinNearby::new(),
        }
    }

    pub async fn start_advertising(
        &mut self,
        app: tauri::AppHandle,
        display_name: String,
    ) -> Result<(), NearbyError> {
        #[cfg(windows)]
        {
            return self.win.start_advertising(app, display_name).await;
        }
        #[cfg(not(windows))]
        {
            let _ = (app, display_name);
            Err(NearbyError::UnsupportedPlatform)
        }
    }

    pub async fn start_discovery(&mut self, app: tauri::AppHandle) -> Result<(), NearbyError> {
        #[cfg(windows)]
        {
            return self.win.start_discovery(app).await;
        }
        #[cfg(not(windows))]
        {
            let _ = app;
            Err(NearbyError::UnsupportedPlatform)
        }
    }

    pub async fn stop(&mut self) -> Result<(), NearbyError> {
        #[cfg(windows)]
        {
            return self.win.stop().await;
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    pub async fn connect(
        &mut self,
        app: tauri::AppHandle,
        endpoint_id: String,
    ) -> Result<(), NearbyError> {
        #[cfg(windows)]
        {
            return self.win.connect(app, endpoint_id).await;
        }
        #[cfg(not(windows))]
        {
            let _ = (app, endpoint_id);
            Err(NearbyError::UnsupportedPlatform)
        }
    }

    pub async fn disconnect(&mut self) -> Result<(), NearbyError> {
        #[cfg(windows)]
        {
            return self.win.disconnect().await;
        }
        #[cfg(not(windows))]
        {
            Ok(())
        }
    }

    pub async fn send(&self, data: String) -> Result<(), NearbyError> {
        #[cfg(windows)]
        {
            return self.win.send(data).await;
        }
        #[cfg(not(windows))]
        {
            let _ = data;
            Err(NearbyError::UnsupportedPlatform)
        }
    }
}
