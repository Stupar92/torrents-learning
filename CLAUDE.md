# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a BitTorrent v1 client POC implementation in TypeScript/Node.js focusing on downloading single-file torrents. The goal is educational - implementing a minimal but correct BitTorrent client with modular architecture for future extensions.

## Tech Stack

- **Language**: TypeScript (Node ≥ 20)
- **Networking**: Node `net` (TCP) + `http/https` for trackers
- **Hash**: Node `crypto` (SHA-1 for v1)
- **I/O**: Node `fs` with positioned writes
- **Build/Style**: ESLint, Prettier, ts-node or esbuild for dev

## Development Commands

```bash
# Setup (after package.json created)
npm install
npm run dev          # Development build/watch
npm run build        # Production build
npm run test         # Run unit tests
npm run lint         # ESLint
npm run format       # Prettier

# CLI usage (after build)
npm run start download <file.torrent> -o <output-path>
```

## Project Structure

```
src/
  bencode.ts        # bencode decode/encode
  metainfo.ts       # .torrent parse, infohash, piece table
  tracker.ts        # HTTP announce (compact=1) + retry/backoff
  peer.ts           # handshake, message codec, state machine
  scheduler.ts      # rarest-first, block queues, endgame
  storage.ts        # piece buffers, verify, file writes
  client.ts         # orchestration, lifecycle, metrics
  util/log.ts       # structured logging
  cli.ts            # CLI interface
```

## Implementation Order (Work Breakdown)

1. **bencode** parser/encoder + tests
2. **metainfo** parse + infohash calc + tests  
3. **tracker** announce (HTTP, compact=1) + tests
4. **handshake & codec** (peer wire framing) + tests
5. **storage** (piece map, verify, writes)
6. **scheduler** (rarest-first, window, timeouts, endgame)
7. **client** orchestration + CLI + progress
8. Integration test & hardening

## Key Implementation Details

- **Peer ID**: `-JS0001-XXXXXXXXXXXX` format (12 random chars)
- **Handshake**: `0x13 "BitTorrent protocol"` + 8 reserved + 20B infohash + 20B peer_id
- **Message framing**: 4-byte big-endian length prefix
- **Block size**: 16KB default, pipelined requests (window=12 per peer)
- **Piece selection**: Rarest-first with endgame mode
- **Integrity**: SHA-1 verification per piece before disk write

## Testing Strategy

- Unit tests for each module (bencode, metainfo, tracker, codec, etc.)
- Integration test with small public torrent (≤100MB)
- Verify final file hash matches expected checksum

## CLI Interface

```
torrent-poc download <file.torrent> [options]
  -o, --out <path>            Output file path (required)
  -p, --port <port>           TCP listen port (default: 6881)
  --max-peers <n>             Max concurrent peers (default: 30)
  --block-size <bytes>        Request block size (default: 16384)
  --window <n>                Requests in flight per peer (default: 12)
  --log <level>               error|warn|info|debug (default: info)
```