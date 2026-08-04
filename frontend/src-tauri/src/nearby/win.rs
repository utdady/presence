//! Windows Bluetooth Classic RFCOMM — same service UUID and framing as Android.

use super::{NearbyError, MAX_PAYLOAD, NAME_PREFIX, SERVICE_UUID};
use crate::{
    emit_connected, emit_disconnected, emit_message, emit_nearby_error, emit_peer_found,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use windows::core::GUID;
use windows::Win32::Devices::Bluetooth::{
    BluetoothEnableDiscovery, BluetoothEnableIncomingConnections,
    BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindFirstRadio,
    BluetoothFindNextDevice, BluetoothFindRadioClose, BluetoothGetRadioInfo,
    BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS,
    BLUETOOTH_RADIO_INFO, SOCKADDR_BTH,
};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Networking::WinSock::{
    accept, bind, closesocket, connect, getpeername, getsockname, listen, recv, send, shutdown,
    socket, WSAGetLastError, WSAStartup, SEND_RECV_FLAGS, SOCKADDR, SOCKET, SOCKET_ERROR,
    SOCK_STREAM, WSADATA, INVALID_SOCKET, SD_BOTH,
};

const AF_BTH: i32 = 32;
const BTHPROTO_RFCOMM: i32 = 3;
const BT_PORT_ANY: u32 = 0;

fn service_guid() -> GUID {
    let _ = SERVICE_UUID;
    GUID::from_u128(0x8f4e2a10_9c3d_4b7e_a1f2_0d5e6c7b8a9c)
}

fn winsock_startup() -> Result<(), NearbyError> {
    unsafe {
        let mut data = WSADATA::default();
        let r = WSAStartup(0x0202, &mut data);
        if r != 0 {
            return Err(NearbyError::msg(format!("WSAStartup failed: {r}")));
        }
    }
    Ok(())
}

pub fn bluetooth_radio_present() -> bool {
    winsock_startup().is_ok()
}

fn make_rfcomm_socket() -> Result<SOCKET, NearbyError> {
    unsafe {
        socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM)
            .map_err(|e| NearbyError::msg(format!("RFCOMM socket failed: {e}")))
    }
}

fn sock_key(s: SOCKET) -> usize {
    s.0
}

fn from_key(k: usize) -> SOCKET {
    SOCKET(k)
}

#[derive(Clone)]
struct Session {
    peer_id: String,
    peer_name: String,
    socket: usize,
}

static SESSION: StdMutex<Option<Session>> = StdMutex::new(None);

pub struct WinNearby {
    display_name: String,
    accept_stop: Arc<AtomicBool>,
    discover_stop: Arc<AtomicBool>,
    listen_socket: Option<usize>,
}

impl WinNearby {
    pub fn new() -> Self {
        let _ = winsock_startup();
        Self {
            display_name: "Presence".into(),
            accept_stop: Arc::new(AtomicBool::new(true)),
            discover_stop: Arc::new(AtomicBool::new(true)),
            listen_socket: None,
        }
    }

    pub async fn start_advertising(
        &mut self,
        app: AppHandle,
        display_name: String,
    ) -> Result<(), NearbyError> {
        self.display_name = sanitize_name(&display_name);
        self.stop_accept_only();

        let public_name = format!("{NAME_PREFIX}{}", self.display_name);
        if let Err(e) = prepare_radio_for_advertise(&public_name) {
            log::warn!("prepare radio: {e}");
        }

        let listen_sock = make_rfcomm_socket()?;

        let mut sa = SOCKADDR_BTH {
            addressFamily: AF_BTH as u16,
            btAddr: 0,
            serviceClassId: service_guid(),
            port: BT_PORT_ANY,
        };

        let bind_r = unsafe {
            bind(
                listen_sock,
                &sa as *const _ as *const SOCKADDR,
                std::mem::size_of::<SOCKADDR_BTH>() as i32,
            )
        };
        if bind_r != 0 {
            let err = unsafe { WSAGetLastError().0 };
            unsafe {
                let _ = closesocket(listen_sock);
            }
            return Err(NearbyError::msg(format!(
                "bind RFCOMM failed ({err}). Enable Bluetooth and try again."
            )));
        }

        let mut namelen = std::mem::size_of::<SOCKADDR_BTH>() as i32;
        unsafe {
            let _ = getsockname(
                listen_sock,
                &mut sa as *mut _ as *mut SOCKADDR,
                &mut namelen,
            );
        }
        let channel = sa.port;
        log::info!("RFCOMM listening channel={channel}");

        if unsafe { listen(listen_sock, 1) } != 0 {
            let err = unsafe { WSAGetLastError().0 };
            unsafe {
                let _ = closesocket(listen_sock);
            }
            return Err(NearbyError::msg(format!("listen failed: {err}")));
        }

        let listen_key = sock_key(listen_sock);
        self.listen_socket = Some(listen_key);
        self.accept_stop.store(false, Ordering::SeqCst);
        let stop = self.accept_stop.clone();
        let app2 = app.clone();

        thread::spawn(move || {
            let listen_sock = from_key(listen_key);
            while !stop.load(Ordering::SeqCst) {
                let client = unsafe { accept(listen_sock, None, None) };
                let Ok(client) = client else {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(80));
                    continue;
                };
                if client == INVALID_SOCKET {
                    thread::sleep(Duration::from_millis(80));
                    continue;
                }
                if SESSION.lock().ok().and_then(|g| g.clone()).is_some() {
                    unsafe {
                        let _ = closesocket(client);
                    }
                    continue;
                }

                let mut csa = SOCKADDR_BTH::default();
                let mut clen = std::mem::size_of::<SOCKADDR_BTH>() as i32;
                let peer_id = unsafe {
                    if getpeername(
                        client,
                        &mut csa as *mut _ as *mut SOCKADDR,
                        &mut clen,
                    ) == 0
                    {
                        format_bt_addr(csa.btAddr)
                    } else {
                        "peer".into()
                    }
                };
                let peer_name = peer_id.clone();
                let sock = sock_key(client);
                {
                    if let Ok(mut g) = SESSION.lock() {
                        *g = Some(Session {
                            peer_id: peer_id.clone(),
                            peer_name: peer_name.clone(),
                            socket: sock,
                        });
                    }
                }
                emit_connected(&app2, peer_id.clone(), peer_name);
                let app3 = app2.clone();
                thread::spawn(move || read_loop(app3, sock, peer_id));
            }
        });

        Ok(())
    }

    pub async fn start_discovery(&mut self, app: AppHandle) -> Result<(), NearbyError> {
        self.discover_stop.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(40));
        self.discover_stop = Arc::new(AtomicBool::new(false));
        let stop = self.discover_stop.clone();
        let app2 = app.clone();

        thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match inquiry_devices() {
                    Ok(list) => {
                        for (addr, name) in list {
                            if !name.starts_with(NAME_PREFIX) {
                                continue;
                            }
                            let display = name
                                .strip_prefix(NAME_PREFIX)
                                .unwrap_or(name.as_str())
                                .trim();
                            let display = if display.is_empty() {
                                name.clone()
                            } else {
                                display.to_string()
                            };
                            emit_peer_found(&app2, addr, display);
                        }
                    }
                    Err(e) => log::debug!("discovery: {e}"),
                }
                for _ in 0..48 {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(250));
                }
            }
        });
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<(), NearbyError> {
        self.discover_stop.store(true, Ordering::SeqCst);
        self.stop_accept_only();
        let _ = self.disconnect().await;
        Ok(())
    }

    fn stop_accept_only(&mut self) {
        self.accept_stop.store(true, Ordering::SeqCst);
        if let Some(s) = self.listen_socket.take() {
            unsafe {
                let _ = closesocket(from_key(s));
            }
        }
    }

    pub async fn connect(&mut self, app: AppHandle, endpoint_id: String) -> Result<(), NearbyError> {
        self.discover_stop.store(true, Ordering::SeqCst);

        if SESSION.lock().ok().and_then(|g| g.clone()).is_some() {
            return Err(NearbyError::msg("Already connected"));
        }

        let bt_addr = parse_bt_addr(&endpoint_id)?;
        let conn_sock = make_rfcomm_socket()?;

        let sa = SOCKADDR_BTH {
            addressFamily: AF_BTH as u16,
            btAddr: bt_addr,
            serviceClassId: service_guid(),
            port: 0,
        };

        let r = unsafe {
            connect(
                conn_sock,
                &sa as *const _ as *const SOCKADDR,
                std::mem::size_of::<SOCKADDR_BTH>() as i32,
            )
        };
        if r != 0 {
            let err = unsafe { WSAGetLastError().0 };
            unsafe {
                let _ = closesocket(conn_sock);
            }
            return Err(NearbyError::msg(format!(
                "RFCOMM connect failed ({err}). Is the phone advertising Nearby?"
            )));
        }

        let peer_name = endpoint_id.clone();
        let sock = sock_key(conn_sock);
        {
            if let Ok(mut g) = SESSION.lock() {
                *g = Some(Session {
                    peer_id: endpoint_id.clone(),
                    peer_name: peer_name.clone(),
                    socket: sock,
                });
            }
        }

        emit_connected(&app, endpoint_id.clone(), peer_name);
        let app2 = app.clone();
        let peer_id = endpoint_id;
        thread::spawn(move || read_loop(app2, sock, peer_id));
        Ok(())
    }

    pub async fn disconnect(&mut self) -> Result<(), NearbyError> {
        let session = SESSION.lock().ok().and_then(|mut g| g.take());
        if let Some(s) = session {
            unsafe {
                let sock = from_key(s.socket);
                let _ = shutdown(sock, SD_BOTH);
                let _ = closesocket(sock);
            }
        }
        Ok(())
    }

    pub async fn send(&self, data: String) -> Result<(), NearbyError> {
        let session = SESSION
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .ok_or(NearbyError::NotConnected)?;
        let bytes = data.into_bytes();
        if bytes.len() > MAX_PAYLOAD {
            return Err(NearbyError::msg("payload too large"));
        }
        write_frame(from_key(session.socket), &bytes)
    }
}

fn prepare_radio_for_advertise(public_name: &str) -> Result<(), NearbyError> {
    let params = BLUETOOTH_FIND_RADIO_PARAMS {
        dwSize: std::mem::size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
    };
    let mut h_radio = HANDLE::default();
    let find = unsafe { BluetoothFindFirstRadio(&params, &mut h_radio) }
        .map_err(|e| NearbyError::msg(format!("no Bluetooth radio: {e}")))?;
    if find.is_invalid() {
        return Err(NearbyError::msg("no Bluetooth radio"));
    }
    let mut info = unsafe { std::mem::zeroed::<BLUETOOTH_RADIO_INFO>() };
    info.dwSize = std::mem::size_of::<BLUETOOTH_RADIO_INFO>() as u32;
    let _ = unsafe { BluetoothGetRadioInfo(h_radio, &mut info) };
    // Best-effort: become discoverable/connectable so phones can inquire.
    let _ = unsafe { BluetoothEnableDiscovery(h_radio, true) };
    let _ = unsafe { BluetoothEnableIncomingConnections(h_radio, true) };
    let _ = unsafe { BluetoothFindRadioClose(find) };
    // Windows does not expose a supported API to rename the radio to public_name;
    // SDP + discoverable still helps inbound RFCOMM. Log desired name for UX.
    log::info!("advertising as (desired) {public_name}");
    let _ = public_name;
    Ok(())
}

fn sanitize_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(18)
        .collect();
    if cleaned.is_empty() {
        "Guest".into()
    } else {
        cleaned
    }
}

fn format_bt_addr(addr: u64) -> String {
    let bytes = [
        (addr & 0xff) as u8,
        ((addr >> 8) & 0xff) as u8,
        ((addr >> 16) & 0xff) as u8,
        ((addr >> 24) & 0xff) as u8,
        ((addr >> 32) & 0xff) as u8,
        ((addr >> 40) & 0xff) as u8,
    ];
    format!(
        "{:02X}:{:02X}:{:02X}:{:02X}:{:02X}:{:02X}",
        bytes[5], bytes[4], bytes[3], bytes[2], bytes[1], bytes[0]
    )
}

fn parse_bt_addr(s: &str) -> Result<u64, NearbyError> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 6 {
        return Err(NearbyError::msg(
            "endpointId must be a Bluetooth MAC (AA:BB:CC:DD:EE:FF)",
        ));
    }
    let mut raw = [0u8; 6];
    for (i, p) in parts.iter().enumerate() {
        raw[i] = u8::from_str_radix(p.trim(), 16).map_err(|_| NearbyError::msg("bad MAC"))?;
    }
    let mut addr: u64 = 0;
    addr |= raw[5] as u64;
    addr |= (raw[4] as u64) << 8;
    addr |= (raw[3] as u64) << 16;
    addr |= (raw[2] as u64) << 24;
    addr |= (raw[1] as u64) << 32;
    addr |= (raw[0] as u64) << 40;
    Ok(addr)
}

fn write_frame(sock: SOCKET, payload: &[u8]) -> Result<(), NearbyError> {
    let header = (payload.len() as u32).to_be_bytes();
    send_all(sock, &header)?;
    send_all(sock, payload)
}

fn send_all(sock: SOCKET, mut buf: &[u8]) -> Result<(), NearbyError> {
    while !buf.is_empty() {
        let n = unsafe { send(sock, buf, SEND_RECV_FLAGS(0)) };
        if n == SOCKET_ERROR {
            return Err(NearbyError::msg(format!(
                "send failed: {}",
                unsafe { WSAGetLastError().0 }
            )));
        }
        buf = &buf[n as usize..];
    }
    Ok(())
}

fn read_exact(sock: SOCKET, buf: &mut [u8]) -> Result<(), NearbyError> {
    let mut off = 0;
    while off < buf.len() {
        let n = unsafe { recv(sock, &mut buf[off..], SEND_RECV_FLAGS(0)) };
        if n == 0 {
            return Err(NearbyError::msg("peer closed"));
        }
        if n == SOCKET_ERROR {
            return Err(NearbyError::msg(format!(
                "recv failed: {}",
                unsafe { WSAGetLastError().0 }
            )));
        }
        off += n as usize;
    }
    Ok(())
}

fn read_loop(app: AppHandle, sock_key: usize, peer_id: String) {
    let sock = from_key(sock_key);
    loop {
        let mut header = [0u8; 4];
        if let Err(e) = read_exact(sock, &mut header) {
            log::debug!("read end: {e}");
            clear_session_if(&peer_id);
            emit_disconnected(&app, peer_id);
            unsafe {
                let _ = closesocket(sock);
            }
            break;
        }
        let len = u32::from_be_bytes(header) as usize;
        if len == 0 || len > MAX_PAYLOAD {
            emit_nearby_error(&app, format!("invalid frame length {len}"));
            clear_session_if(&peer_id);
            emit_disconnected(&app, peer_id);
            unsafe {
                let _ = closesocket(sock);
            }
            break;
        }
        let mut body = vec![0u8; len];
        if let Err(e) = read_exact(sock, &mut body) {
            log::debug!("read body: {e}");
            clear_session_if(&peer_id);
            emit_disconnected(&app, peer_id);
            unsafe {
                let _ = closesocket(sock);
            }
            break;
        }
        match String::from_utf8(body) {
            Ok(data) => emit_message(&app, peer_id.clone(), data),
            Err(_) => emit_nearby_error(&app, "non-utf8 frame".into()),
        }
    }
}

fn clear_session_if(peer_id: &str) {
    if let Ok(mut g) = SESSION.lock() {
        if g.as_ref().map(|s| s.peer_id == peer_id).unwrap_or(false) {
            *g = None;
        }
    }
}

fn inquiry_devices() -> Result<Vec<(String, String)>, NearbyError> {
    let search = BLUETOOTH_DEVICE_SEARCH_PARAMS {
        dwSize: std::mem::size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
        fReturnAuthenticated: true.into(),
        fReturnRemembered: true.into(),
        fReturnUnknown: true.into(),
        fReturnConnected: true.into(),
        fIssueInquiry: true.into(),
        cTimeoutMultiplier: 2,
        hRadio: HANDLE::default(),
    };

    let mut device = unsafe { std::mem::zeroed::<BLUETOOTH_DEVICE_INFO>() };
    device.dwSize = std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32;

    let find = unsafe { BluetoothFindFirstDevice(&search, &mut device) };
    let Ok(find) = find else {
        return Ok(vec![]);
    };
    if find.is_invalid() {
        return Ok(vec![]);
    }

    let mut out = Vec::new();
    loop {
        let name = wchar_to_string(&device.szName);
        let addr = unsafe { format_bt_addr(device.Address.Anonymous.ullLong) };
        if !name.is_empty() {
            out.push((addr, name));
        }
        device = unsafe { std::mem::zeroed::<BLUETOOTH_DEVICE_INFO>() };
        device.dwSize = std::mem::size_of::<BLUETOOTH_DEVICE_INFO>() as u32;
        if unsafe { BluetoothFindNextDevice(find, &mut device) }.is_err() {
            break;
        }
    }
    let _ = unsafe { BluetoothFindDeviceClose(find) };
    Ok(out)
}

fn wchar_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}
