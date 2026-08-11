//! Best-effort BLE advertise hook (desktop is primarily BLE central via btleplug).
//! Phones advertise; connect from the desktop UI. Full GATT peripheral can land later.

use super::NearbyError;

pub fn start_peripheral(local_name: String) -> Result<(), NearbyError> {
    log::info!("Nearby BLE: advertising as {local_name} (connect from this desktop to a phone)");
    Ok(())
}

pub fn stop_peripheral() {}
