//! macOS advertise hook — desktop uses btleplug central to connect to phone peripherals.
//! Requires NSBluetoothAlwaysUsageDescription in Info.plist (already set).

use super::NearbyError;

pub fn start_peripheral(local_name: String) -> Result<(), NearbyError> {
    log::info!("Nearby BLE: advertising as {local_name} (connect from this Mac to a phone)");
    Ok(())
}

pub fn stop_peripheral() {}
