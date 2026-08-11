//! Shared BLE chunk framing — must match PROTOCOL.md / Android / iOS.

pub const SERVICE_UUID: &str = "8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9c";
pub const WRITE_UUID: &str = "8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9d";
pub const NOTIFY_UUID: &str = "8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9e";
pub const NAME_PREFIX: &str = "Presence/";
pub const MAX_MESSAGE: usize = 65536;
pub const HEADER: usize = 5;
pub const FLAG_MORE: u8 = 0x01;
pub const DEFAULT_PAYLOAD: usize = 20;

pub fn sanitize_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_graphic() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .trim()
        .to_string();
    let base = if cleaned.is_empty() {
        "Guest".to_string()
    } else {
        cleaned
    };
    base.chars().take(18).collect()
}

pub fn fragment(data: &[u8], msg_id: u16, payload_size: usize) -> Vec<Vec<u8>> {
    let payload_size = payload_size.max(1);
    let mut out = Vec::new();
    if data.is_empty() {
        let mut buf = Vec::with_capacity(HEADER);
        buf.push(0);
        buf.extend_from_slice(&msg_id.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        out.push(buf);
        return out;
    }
    let mut offset = 0usize;
    let mut index: u16 = 0;
    while offset < data.len() {
        let end = (offset + payload_size).min(data.len());
        let more = end < data.len();
        let mut buf = Vec::with_capacity(HEADER + (end - offset));
        buf.push(if more { FLAG_MORE } else { 0 });
        buf.extend_from_slice(&msg_id.to_le_bytes());
        buf.extend_from_slice(&index.to_le_bytes());
        buf.extend_from_slice(&data[offset..end]);
        out.push(buf);
        offset = end;
        index = index.wrapping_add(1);
        if !more {
            break;
        }
    }
    out
}

#[derive(Default)]
pub struct Reassembly {
    chunks: std::collections::HashMap<u16, Vec<u8>>,
    last_index: Option<u16>,
}

impl Reassembly {
    pub fn ingest(&mut self, chunk: &[u8]) -> Option<Vec<u8>> {
        if chunk.len() < HEADER {
            return None;
        }
        let flags = chunk[0];
        let index = u16::from_le_bytes([chunk[3], chunk[4]]);
        let body = chunk[HEADER..].to_vec();
        self.chunks.insert(index, body);
        if flags & FLAG_MORE == 0 {
            self.last_index = Some(index);
        }
        let last = self.last_index?;
        for i in 0..=last {
            if !self.chunks.contains_key(&i) {
                return None;
            }
        }
        let mut total = 0usize;
        for i in 0..=last {
            total += self.chunks.get(&i).map(|c| c.len()).unwrap_or(0);
            if total > MAX_MESSAGE {
                self.chunks.clear();
                self.last_index = None;
                return None;
            }
        }
        let mut full = Vec::with_capacity(total);
        for i in 0..=last {
            full.extend_from_slice(self.chunks.get(&i)?);
        }
        self.chunks.clear();
        self.last_index = None;
        Some(full)
    }
}
