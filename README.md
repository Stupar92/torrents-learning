# BitTorrent Client POC

A complete BitTorrent v1 client implementation in TypeScript/Node.js, built as a proof-of-concept with educational focus. This client can download single-file torrents using the BitTorrent protocol with HTTP trackers.

## 🚀 Features

- **Complete BitTorrent v1 Protocol** - Full implementation of the BitTorrent specification
- **HTTP Tracker Support** - Announces to trackers and discovers peers
- **Multi-peer Downloads** - Connects to multiple peers simultaneously
- **Rarest-first Algorithm** - Intelligent piece selection strategy
- **Endgame Mode** - Optimized completion for the final pieces
- **Piece Verification** - SHA-1 hash verification for data integrity
- **Positioned File Writes** - Direct disk writes to pre-allocated files
- **Real-time Progress** - Live download statistics and progress bars
- **Comprehensive CLI** - Full-featured command-line interface
- **Graceful Shutdown** - Clean shutdown with tracker announces

## 📋 Requirements

- Node.js ≥ 20.0.0
- npm or yarn
- Network connectivity for tracker and peer communications

## 🛠️ Installation

1. **Clone the repository:**
```bash
git clone <repository-url>
cd torrents-learning
```

2. **Install dependencies:**
```bash
npm install
```

3. **Build the project:**
```bash
npm run build
```

## 🎯 Quick Start

### Basic Download
```bash
npx ts-node src/cli.ts download example.torrent -o downloads/
```

### With Debug Logging
```bash
npx ts-node src/cli.ts download example.torrent -o downloads/ --log debug
```

### Custom Settings
```bash
npx ts-node src/cli.ts download example.torrent -o downloads/ --max-peers 10 --log info
```

## 📖 Usage

### Command Line Interface

The client provides a comprehensive CLI with the following commands:

#### Download Command
```bash
npx ts-node src/cli.ts download <file.torrent> [options]
```

**Options:**
- `-o, --out <path>` - Output directory (default: current directory)
- `-p, --port <port>` - TCP listen port (default: 6881)
- `--max-peers <n>` - Maximum concurrent peers (default: 30)
- `--block-size <bytes>` - Request block size (default: 16384)
- `--window <n>` - Requests in flight per peer (default: 12)
- `--log <level>` - Log level: error|warn|info|debug (default: info)
- `-q, --quiet` - Quiet mode - no progress output
- `--json` - Output stats in JSON format

#### Other Commands
```bash
npx ts-node src/cli.ts help     # Show help
npx ts-node src/cli.ts version  # Show version
```

### Examples

**Download a Linux distribution:**
```bash
npx ts-node src/cli.ts download debian.torrent -o ~/Downloads/ --log info
```

**High-performance download:**
```bash
npx ts-node src/cli.ts download large-file.torrent -o downloads/ --max-peers 20 --window 16
```

**JSON output for monitoring:**
```bash
npx ts-node src/cli.ts download file.torrent -o downloads/ --quiet --json > stats.json
```

**Debug mode for troubleshooting:**
```bash
npx ts-node src/cli.ts download file.torrent -o downloads/ --log debug
```

## 🏗️ Architecture

The client is built with a modular architecture:

### Core Modules

- **`bencode.ts`** - Bencode encoding/decoding for .torrent files
- **`metainfo.ts`** - Torrent file parsing and info hash calculation
- **`tracker.ts`** - HTTP tracker communication and peer discovery
- **`peer.ts`** - BitTorrent wire protocol and peer connections
- **`scheduler.ts`** - Piece scheduling with rarest-first algorithm
- **`storage.ts`** - File I/O with piece verification and positioned writes
- **`client.ts`** - Main orchestration and lifecycle management
- **`cli.ts`** - Command-line interface

### Data Flow

1. **Parse** torrent file to extract metadata and tracker URLs
2. **Announce** to tracker to discover available peers
3. **Connect** to peers and perform BitTorrent handshake
4. **Exchange** bitfields to learn what pieces peers have
5. **Schedule** piece requests using rarest-first algorithm
6. **Download** blocks from multiple peers simultaneously
7. **Verify** piece hashes and write to disk at correct positions
8. **Complete** when all pieces downloaded and verified

## 🧪 Development

### Available Scripts

```bash
npm run dev          # Development mode with ts-node
npm run build        # TypeScript compilation
npm run test         # Run unit tests
npm run test:watch   # Run tests in watch mode
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier formatting
npm run format:check # Check Prettier formatting
```

### Testing

The project includes comprehensive tests:
- **Unit tests** for all modules (259 tests total)
- **Integration tests** for component interaction
- **Mock-based tests** for network components

Run tests with:
```bash
npm test
```

### Code Structure

```
src/
├── bencode.ts        # Bencode parser/encoder
├── metainfo.ts       # Torrent file parsing
├── tracker.ts        # HTTP tracker client
├── peer.ts           # BitTorrent wire protocol
├── scheduler.ts      # Piece scheduling logic
├── storage.ts        # File I/O and verification
├── client.ts         # Main client orchestration
├── cli.ts           # Command-line interface
├── index.ts         # Library exports
└── *.test.ts        # Test files
```

## 🐛 Troubleshooting

### Common Issues

**"Peers: 0/X" - Not connecting to peers:**
- Check network connectivity and firewall settings
- Some peers may not accept incoming connections
- Try different torrents with more active swarms
- Use `--log debug` to see detailed connection attempts

**Download stuck at 0%:**
- Wait 5-10 seconds for initial peer connections
- Check that peers are unchoked (look for 🔓 in debug logs)
- Progress updates only when complete pieces are verified

**Connection timeouts:**
- Some peers may be behind firewalls/NAT
- The client will automatically try other peers
- Use `--max-peers` to increase connection attempts

### Debug Mode

Use debug logging to see detailed information:
```bash
npx ts-node src/cli.ts download file.torrent -o downloads/ --log debug
```

This shows:
- Tracker communication
- Peer connection attempts
- Handshake progress
- Block downloads
- Piece completion
- Hash verification

## ⚡ Performance Tips

1. **Increase peer connections:** `--max-peers 20`
2. **Optimize block requests:** `--window 16` 
3. **Choose active torrents** with many seeders
4. **Use SSD storage** for better I/O performance
5. **Monitor with JSON output** for automation

## 🔒 Security & Limitations

### Security Features
- Input validation for all torrent file data
- SHA-1 hash verification for every piece
- Resource limits (max peers, timeouts)
- No listening port opened to WAN by default

### Current Limitations
- **Single-file torrents only** (multi-file support not implemented)
- **HTTP trackers only** (no UDP or DHT support)
- **IPv4 only** (no IPv6 support)
- **No upload/seeding** (download-only client)
- **No resume support** (restarts from beginning)

## 📚 Protocol Details

This implementation follows the BitTorrent v1 specification:

- **Peer ID:** `-JS0001-XXXXXXXXXXXX` format
- **Handshake:** 68-byte handshake with protocol string
- **Messages:** Standard BitTorrent wire protocol messages
- **Piece Size:** Configurable block size (default 16KB)
- **Hash Algorithm:** SHA-1 for piece verification
- **Compact Peers:** Supports compact peer format from trackers

## 🤝 Contributing

This is an educational project. Feel free to:
- Report issues or bugs
- Suggest improvements
- Add features (multi-file support, UDP trackers, etc.)
- Improve documentation

## ⚖️ Legal Notice

This software is for educational purposes. Only use with torrents you have legal rights to download, such as:
- Official Linux distributions
- Open source software
- Public domain content
- Your own files

## 🙏 Acknowledgments

Built following the BitTorrent Protocol Specification and inspired by the principles of peer-to-peer file sharing for legitimate content distribution.

## 📄 License

MIT License - see LICENSE file for details.
