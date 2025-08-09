# BitTorrent v1 Client POC — Engineering Spec

> Goal: Implement a minimal-yet-correct BitTorrent client focused on downloading a single-file torrent using the v1 protocol (BEP 3) over TCP with HTTP trackers. The design is modular so we can later add v2/Merkle (BEP 52), magnets/ut\_metadata (BEP 9/10), UDP trackers (BEP 15), DHT (BEP 5), and uTP.

---

## 1) Scope & Non‑Goals

### In Scope (MVP)

- Parse `.torrent` (v1) metainfo (bencode) and compute **v1 infohash** (SHA‑1 of `bencode(info)`).
- Announce to **HTTP trackers** with `compact=1` and parse peer list.
- Connect to peers over **TCP**, perform **v1 handshake**, and speak the **core wire protocol** messages (0–9, 20 reserved for future).
- Manage **bitfields**, **interested/unchoke**, **request/piece/cancel** for downloading.
- **Integrity verification**: SHA‑1 per piece (v1) before writing to disk.
- **Piece selection**: rarest‑first; block pipelining; basic endgame.
- CLI to download a **single-file** torrent to an output path; show progress/rates.

### Non‑Goals (MVP)

- No DHT (BEP 5), UDP trackers (BEP 15), µTP/LEDBAT, PEX, encryption, magnet metadata exchange, v2 Merkle hashing.
- No multi-file layout (we may parse but will error out with clear message).
- No seeding/upload path (client remains choked to others); we still send `have` messages for correctness.

### Stretch Goals (Post‑MVP)

- **Metadata over P2P**: BEP 10 (extension) + BEP 9 (ut\_metadata) → magnet without `.torrent`.
- **DHT** (BEP 5), **UDP tracker** (BEP 15), **PEX**.
- **v2/Hybrid** (BEP 52): SHA‑256 infohash, file tree, piece layers, `hash request/hashes/hash reject` messages.
- **uTP + LEDBAT** for congestion‑friendliness.
- Resume data and simple fast‑resume file.

---

## 2) Deliverables

- `torrent-poc` CLI executable (Node/TS) with `download` command.
- Library API (importable) exposing `downloadTorrent()`.
- Unit tests for bencode, metainfo hashing, compact peer parsing, message framing, and piece verification.
- Integration test using a tiny Linux distro torrent (≤100 MB) with a known HTTP tracker.

---

## 3) Tech Stack & Standards

- **Language**: TypeScript (Node ≥ 20).
- **Networking**: Node `net` (TCP) + `http/https` for trackers.
- **Hash**: Node `crypto` (SHA‑1 for v1).
- **I/O**: streaming writes with `fs.open` + `pwrite` style via `write` with position.
- **Style/Build**: ESLint, Prettier, ts-node or esbuild for dev.

---

## 4) CLI & Library Interfaces

### CLI

```
Usage: torrent-poc download <file.torrent> [options]

Options:
  -o, --out <path>            Output file path or directory (required)
  -p, --port <port>           TCP listen port (default: 6881)
  --max-peers <n>             Max concurrent peer connections (default: 30)
  --connections <n>           Initial peer dial budget (default: 60)
  --block-size <bytes>        Request block size (default: 16384)
  --window <n>                Requests in flight per peer (default: 12)
  --peer-id-prefix <s>        Peer ID prefix (default: -JS0001-)
  --seed-after                Do not exit after completion (MVP: ignored)
  --log <level>               error|warn|info|debug (default: info)
```

### Library

```ts
export type DownloadOptions = {
  outPath: string;
  port?: number;
  maxPeers?: number;
  dialBudget?: number;
  blockSize?: number; // default 16 KiB
  window?: number;    // in-flight requests per connection
  peerIdPrefix?: string; // e.g., "-JS0001-"
  logger?: Logger;
};

export type DownloadEvents = {
  onProgress?: (p: Progress) => void;
  onPeer?: (evt: PeerEvent) => void;
  onDone?: () => void;
};

export function downloadTorrent(torrentPath: string, opts: DownloadOptions, ev?: DownloadEvents): Promise<void>;
```

---

## 5) Architecture & Modules

```
src/
  bencode.ts        // decode/encode
  metainfo.ts       // .torrent parse, infohash, piece table
  tracker.ts        // HTTP announce (compact=1) + retry/backoff
  peer.ts           // handshake, message codec, state machine
  scheduler.ts      // rarest-first, block queues, endgame
  storage.ts        // piece buffers, verify, file writes
  client.ts         // orchestration, lifecycle, metrics
  util/log.ts       // structured logging
```

### Responsibilities

- **bencode.ts**: Minimal decoder/encoder supporting int, byte string, list, dict. Return byte strings as `Buffer`.
- **metainfo.ts**: Parse top-level dict; extract `announce`, `announce-list`, `info`, `info.name`, `info.length`, `info["piece length"]`, `info.pieces` (Buffer); compute `infoHashV1 = sha1(bencode(info))`.
- **tracker.ts**: Build HTTP GET with `info_hash` (raw bytes URL-encoded), `peer_id`, `port`, `uploaded`, `downloaded`, `left`, `compact=1`, `event`. Parse bencoded response; decode `peers` compact string (6N bytes -> {ip,port}). Handle `interval` and `min interval`.
- **peer.ts**:
  - TCP connect; send/receive **handshake**: `[pstrlen=19]["BitTorrent protocol"][8 reserved][20B infohash][20B peer_id]`.
  - After handshake: length-prefixed messages. Support: `keep-alive (len=0)`, `choke(0)`, `unchoke(1)`, `interested(2)`, `not_interested(3)`, `have(4)`, `bitfield(5)`, `request(6){index,u32 begin,u32 length}`, `piece(7){index,begin,block}`, `cancel(8)`, `port(9)`.
  - Maintain per-peer state: choked/interested, bitfield (BitSet), inflight requests.
- **scheduler.ts**:
  - Build **availability histogram** from peers’ bitfields + `have` updates.
  - **Rarest-first** piece order; per-peer filter to pieces that peer has and we still want.
  - **Pipelining**: maintain `window` requests in flight per connection (default 12) using 16 KiB blocks.
  - **Endgame**: when remaining unfulfilled blocks ≤ window \* number of peers, duplicate requests; cancel on first arrival.
  - **Timeouts**: requeue block if not received within 30s.
- **storage.ts**:
  - Allocate per-piece buffer; track block receipts by offset.
  - On piece completion: `sha1(pieceBuffer) == expectedHash`; if OK → write to file at the correct offset; else mark piece bad, raise hashfail on the contributing peer(s), and requeue.
- **client.ts**:
  - Load torrent; compute `left`.
  - Tracker announce loop → peer candidates.
  - Dial peers (respect `maxPeers`); manage connection lifecycle.
  - Emit progress/metrics; graceful shutdown (`event=stopped`).

---

## 6) Data Models

```ts
type TorrentMeta = {
  announce: string;
  announceList?: string[][];
  name: string;
  length: number;            // single-file only in MVP
  pieceLength: number;       // bytes
  pieces: Buffer;            // 20B * numPieces
  infoHashV1: Buffer;        // 20B
};

type Piece = {
  index: number;
  length: number;            // last piece may be shorter
  hash: Buffer;              // 20B SHA-1
  received: Set<number>;     // block offsets received
};

type PeerState = {
  id?: Buffer;               // their peer_id if sent
  choked: boolean;
  interested: boolean;
  bitfield: BitSet;          // piece availability
  inflight: number;          // requests in flight
  socket: net.Socket;
  throughput: {downBps: number; upBps: number};
  lastActive: number;        // ms
};

// Progress metrics emitted externally
interface Progress {
  piecesDone: number;
  piecesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  downBps: number;           // moving average
  etaSec?: number;
}
```

---

## 7) Algorithms & Flows

### Piece Indexing

- `numPieces = ceil(length / pieceLength)`.
- For piece `i` → file offset `i * pieceLength`. Last piece length `= length - pieceLength * (numPieces - 1)`.

### Scheduler Loop (per tick / on events)

1. Update availability histogram from peers’ bitfields.
2. Build **rarest-first queue** of piece indices still wanted.
3. For each unchoked/interesting peer with capacity (< window):
   - Select next piece it has from rarest-first queue.
   - Enqueue next unrequested block(s) for that piece in `blockSize` strides.
4. On `piece` arrival: mark block received; if piece complete, hash-verify → write → broadcast `have` to connected peers.
5. **Timeout sweep** every few seconds: requeue overdue blocks; consider peer penalty for repeated timeouts.
6. **Endgame** trigger: If remaining blocks ≤ `window * connectedPeers`, allow duplicate requests.

### Timeouts & Keepalive

- Send TCP keep-alive (len=0) if no traffic for 120s.
- Block request timeout: 30s; disconnect peer after 3 consecutive timeouts or any hashfail.

---

## 8) Protocol Details (MVP correctness keys)

- **Peer ID**: Generate `-JS0001-XXXXXXXXXXXX` (12 random URL-safe chars). Persist for a process.
- **Handshake bytes**: `0x13 "BitTorrent protocol"` + 8 reserved zero bytes + 20B infohash (v1) + 20B peer\_id.
- **Message framing**: 4-byte length prefix (big-endian). `len=0` → keep-alive.
- **Tracker Announce (HTTP)**: GET with URL-encoded *raw* `info_hash` bytes. Include `uploaded=0`, `downloaded`, `left`, `event` (`started|completed|stopped`), `compact=1`, `numwant=50`.
- **Compact peers**: 6N bytes; each tuple = 4B IPv4 + 2B port.

---

## 9) Error Handling & Edge Cases

- **Mismatched handshake infohash** → drop connection.
- **Unexpected message while choked** (e.g., `piece`) → drop.
- **Malformed bitfield length** → drop.
- **Bad piece hash** → increment peer’s `hashfail`; if > 0 drop immediately; requeue piece.
- **Last piece shorter**: compute correct final block length; do not over-read.
- **Disk write errors**: propagate and abort cleanly.
- **Announce failures**: exponential backoff; rotate trackers from `announce-list` if present.

---

## 10) Observability

- Log levels: `error|warn|info|debug`.
- Per-peer stats: ip\:port, state, pieces they have, inflight, downBps.
- Global: piecesDone/total, bytesDone/total, downBps, ETA.
- Optional: stdout progress bar updated every 500 ms.

---

## 11) Security & Resource Limits

- Cap peers: `maxPeers` (default 30).
- Cap in-flight requests per peer: `window` (default 12).
- Validate all lengths and indexes (no OOB writes).
- Zero sensitive buffers after use if necessary.
- Do not open listening port to WAN in MVP (incoming not required).

---

## 12) Testing Plan

**Unit**

- bencode decode/encode roundtrips.
- `infoHashV1` computed from a known small `.torrent` fixture.
- Compact peers string → list.
- Message encode/decode for `request`, `piece` framing.
- Piece verification: craft buffer with known SHA‑1.

**Integration**

- Download a public, small test torrent (≤100 MB) via HTTP tracker only; assert final file hash equals official SHA‑256 from upstream.
- Adverse network: simulate slow peer and verify timeouts + requeue.

---

## 13) Acceptance Criteria (MVP)

- CLI can download a single-file torrent end‑to‑end via HTTP tracker(s) with multiple peers.
- Integrity check passes for every piece; final file matches known checksum.
- Rarest‑first and endgame operate (verified by logs/metrics).
- Clean shutdown with `event=stopped` announce; no unhandled promise rejections.

---

## 14) Work Breakdown (Suggested Order)

1. **bencode** parser/encoder + tests.
2. **metainfo** parse + infohash calc + tests.
3. **tracker** announce (HTTP, compact=1) + tests.
4. **handshake & codec** (peer wire framing) + tests.
5. **storage** (piece map, verify, writes).
6. **scheduler** (rarest-first, window, timeouts, endgame).
7. **client** orchestration + CLI + progress.
8. Integration test & hardening.

---

## 15) Future Extensions (Design Hooks)

- Reserve `reserved[5]` bit for extension protocol (BEP 10) detection later.
- Abstract `HashEngine` to allow SHA‑256 (v2) alongside SHA‑1.
- Generalize `FileLayout` for multi-file + padding alignment (BEP 47) later.
- Abstract `AnnounceClient` to add UDP and DHT sources of peers.

---

## 16) Legal & Usage Notes

- Use only torrents that you have rights to download (e.g., official Linux distros). The POC is for educational purposes.

---

## 17) Glossary (minimal)

- **Piece**: A fixed-size segment of the content (except possibly the last), hashed for integrity.
- **Block**: A sub-request within a piece (typically 16 KiB) to pipeline requests.
- **Rarest-first**: Choose pieces that appear least among connected peers to maximize swarm health.
- **Endgame**: Duplicate outstanding block requests near completion to reduce tail latency.

