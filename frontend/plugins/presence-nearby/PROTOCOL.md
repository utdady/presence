# Presence Nearby — BLE wire protocol (v1)

Shared by Android, iOS, Windows, and macOS natives. The JS
`PresenceNearbyPlugin` API and `useNearbyCall` crypto/session layer are
**unchanged** — only the native transport speaks this document.

## GATT profile

| Item | UUID |
|------|------|
| Service | `8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9c` |
| Write (peer → this device, write-without-response) | `8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9d` |
| Notify (this device → peer) | `8f4e2a11-9c3d-4b7e-a1f2-0d5e6c7b8a9e` |

Legacy Classic RFCOMM used `8f4e2a10-…8a9c`. BLE service is **`8f4e2a11-…`** — not interchangeable with RFCOMM.

## Dual role

While Nearby is active, every device:

1. **Advertises** (peripheral) so others can find it — `startAdvertising`
2. **Scans** (central) so it can find others — `startDiscovery`

`connect` makes this device the **central** for that link; the peer is
**peripheral**. Bidirectional app data:

- Central → peripheral: write-without-response on peer’s Write characteristic
- Peripheral → central: notification on local Notify characteristic

## Local name

Advertise scan response / local name: `Presence/{displayName}`  
Sanitize: strip controls, max **18** chars for `{displayName}` (adv payload is tight).

## Chunk framing

Each ATT write/notification payload:

```
offset 0     : flags (uint8) — bit0 = 1 if more chunks follow for this message
offset 1–2   : message id (uint16 little-endian), wraps per sender
offset 3–4   : chunk index (uint16 little-endian), 0-based
offset 5+    : payload bytes
```

Reassembly:

- Buffer chunks by `(peerId, messageId)` in a map of `index → bytes`
- When a chunk arrives with `flags.bit0 == 0`, treat that index as last (`n`)
- Complete only when indices `0..n` are all present; then concatenate and emit
  one `message` event with the UTF-8 string (same as RFCOMM-era JS)
- Reject incomplete sets after timeout; reject total size &gt; **65536** bytes (v1)

Chunk body size = `min(mtu - 3 - 5, …)` after MTU negotiation; until then use a
conservative **20**-byte payload (legacy ATT default).

`requestMtu(517)` is best-effort.

## JS contract

- `send({ data: string })` — opaque UTF-8; native fragments
- `message` event `{ peerId, data }` — full reassembled string
- Peer `id`: platform BLE address / identifier string used in `connect`

## v1 app traffic

Allowed above the transport: crypto handshake + text chat.  
Voice notes, files, and live Nearby A/V are gated in JS until a faster local
media hop exists.
