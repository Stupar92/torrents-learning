#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { TorrentClient, ClientStats, PeerStats } from './client';

interface CliOptions {
  torrentFile: string;
  outputPath: string;
  maxPeers?: number;
  blockSize?: number;
  windowSize?: number;
  port?: number;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  quiet?: boolean;
  json?: boolean;
}

class CliProgress {
  private lastUpdate = 0;
  private readonly updateInterval = 500; // ms
  
  update(stats: ClientStats): void {
    const now = Date.now();
    if (now - this.lastUpdate < this.updateInterval) {
      return;
    }
    this.lastUpdate = now;
    
    const progressBar = this.generateProgressBar(stats.progress);
    const speed = this.formatBytes(stats.downloadRate) + '/s';
    const eta = stats.eta === Infinity ? '--:--:--' : this.formatTime(stats.eta);
    const size = `${this.formatBytes(stats.downloadedSize)} / ${this.formatBytes(stats.totalSize)}`;
    
    // Clear line and write progress
    process.stdout.write('\r\x1b[K'); // Clear line
    process.stdout.write(
      `${progressBar} ${stats.progress.toFixed(1)}% | ` +
      `${size} | ${speed} | ETA: ${eta} | ` +
      `Peers: ${stats.connectedPeers}/${stats.totalPeers} | ` +
      `Pieces: ${stats.completedPieces}/${stats.totalPieces}`
    );
  }
  
  complete(stats: ClientStats, downloadTime: number): void {
    process.stdout.write('\n');
    console.log(`✅ Download completed!`);
    console.log(`📁 File: ${stats.torrentName}`);
    console.log(`📦 Size: ${this.formatBytes(stats.totalSize)}`);
    console.log(`⏱️  Time: ${this.formatTime(downloadTime / 1000)}`);
    console.log(`🚀 Average speed: ${this.formatBytes(stats.totalSize / (downloadTime / 1000))}/s`);
  }
  
  error(message: string): void {
    process.stdout.write('\n');
    console.error(`❌ Error: ${message}`);
  }
  
  private generateProgressBar(progress: number, width: number = 30): string {
    const filled = Math.round(width * (progress / 100));
    const empty = width - filled;
    return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
  }
  
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
  
  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

class Logger {
  constructor(private level: string = 'info', private quiet: boolean = false) {}
  
  debug(...args: any[]): void {
    if (this.shouldLog('debug')) {
      console.log(`[DEBUG]`, ...args);
    }
  }
  
  info(...args: any[]): void {
    if (this.shouldLog('info')) {
      console.log(`[INFO]`, ...args);
    }
  }
  
  warn(...args: any[]): void {
    if (this.shouldLog('warn')) {
      console.warn(`[WARN]`, ...args);
    }
  }
  
  error(...args: any[]): void {
    if (this.shouldLog('error')) {
      console.error(`[ERROR]`, ...args);
    }
  }
  
  private shouldLog(level: string): boolean {
    if (this.quiet) return false;
    
    const levels = ['debug', 'info', 'warn', 'error'];
    const currentIndex = levels.indexOf(this.level);
    const messageIndex = levels.indexOf(level);
    
    return messageIndex >= currentIndex;
  }
}

function parseArguments(): CliOptions {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(0);
  }
  
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    showVersion();
    process.exit(0);
  }
  
  if (args[0] !== 'download') {
    console.error('Error: First argument must be "download"');
    console.error('Run "torrent-poc help" for usage information');
    process.exit(1);
  }
  
  if (args.length < 2) {
    console.error('Error: Torrent file path is required');
    console.error('Run "torrent-poc help" for usage information');
    process.exit(1);
  }
  
  const options: CliOptions = {
    torrentFile: args[1],
    outputPath: process.cwd(), // Default to current directory
  };
  
  // Parse flags
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    
    switch (arg) {
      case '-o':
      case '--out':
        if (!nextArg) {
          console.error('Error: --out requires a path argument');
          process.exit(1);
        }
        options.outputPath = nextArg;
        i++;
        break;
        
      case '-p':
      case '--port':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          console.error('Error: --port requires a numeric argument');
          process.exit(1);
        }
        options.port = parseInt(nextArg);
        i++;
        break;
        
      case '--max-peers':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          console.error('Error: --max-peers requires a numeric argument');
          process.exit(1);
        }
        options.maxPeers = parseInt(nextArg);
        i++;
        break;
        
      case '--block-size':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          console.error('Error: --block-size requires a numeric argument');
          process.exit(1);
        }
        options.blockSize = parseInt(nextArg);
        i++;
        break;
        
      case '--window':
        if (!nextArg || isNaN(parseInt(nextArg))) {
          console.error('Error: --window requires a numeric argument');
          process.exit(1);
        }
        options.windowSize = parseInt(nextArg);
        i++;
        break;
        
      case '--log':
        if (!nextArg || !['error', 'warn', 'info', 'debug'].includes(nextArg)) {
          console.error('Error: --log must be one of: error, warn, info, debug');
          process.exit(1);
        }
        options.logLevel = nextArg as CliOptions['logLevel'];
        i++;
        break;
        
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
        
      case '--json':
        options.json = true;
        break;
        
      default:
        console.error(`Error: Unknown option: ${arg}`);
        console.error('Run "torrent-poc help" for usage information');
        process.exit(1);
    }
  }
  
  return options;
}

function showHelp(): void {
  console.log(`
BitTorrent Client POC

USAGE:
  torrent-poc download <file.torrent> [options]

OPTIONS:
  -o, --out <path>            Output file path (default: current directory)
  -p, --port <port>           TCP listen port (default: 6881)
  --max-peers <n>             Max concurrent peers (default: 30)
  --block-size <bytes>        Request block size (default: 16384)
  --window <n>                Requests in flight per peer (default: 12)
  --log <level>               Log level: error|warn|info|debug (default: info)
  -q, --quiet                 Quiet mode - no progress output
  --json                      Output stats in JSON format
  -h, --help                  Show this help
  -v, --version               Show version

EXAMPLES:
  torrent-poc download ubuntu.torrent -o ~/Downloads/
  torrent-poc download test.torrent --max-peers 50 --log debug
  torrent-poc download large.torrent --quiet --json > stats.json
`);
}

function showVersion(): void {
  const packagePath = path.join(__dirname, '..', 'package.json');
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    console.log(`torrent-poc v${packageJson.version}`);
  } catch {
    console.log('torrent-poc v1.0.0');
  }
}

function validateOptions(options: CliOptions): void {
  // Check if torrent file exists
  if (!fs.existsSync(options.torrentFile)) {
    console.error(`Error: Torrent file not found: ${options.torrentFile}`);
    process.exit(1);
  }
  
  // Check if torrent file is readable
  try {
    fs.accessSync(options.torrentFile, fs.constants.R_OK);
  } catch {
    console.error(`Error: Cannot read torrent file: ${options.torrentFile}`);
    process.exit(1);
  }
  
  // Validate output path
  const outputDir = path.dirname(options.outputPath);
  if (!fs.existsSync(outputDir)) {
    console.error(`Error: Output directory does not exist: ${outputDir}`);
    process.exit(1);
  }
  
  // Validate numeric options
  if (options.port && (options.port < 1 || options.port > 65535)) {
    console.error('Error: Port must be between 1 and 65535');
    process.exit(1);
  }
  
  if (options.maxPeers && options.maxPeers < 1) {
    console.error('Error: Max peers must be greater than 0');
    process.exit(1);
  }
  
  if (options.blockSize && options.blockSize < 1024) {
    console.error('Error: Block size must be at least 1024 bytes');
    process.exit(1);
  }
  
  if (options.windowSize && options.windowSize < 1) {
    console.error('Error: Window size must be greater than 0');
    process.exit(1);
  }
}

async function downloadTorrent(options: CliOptions): Promise<void> {
  const logger = new Logger(options.logLevel, options.quiet);
  const progress = new CliProgress();
  
  let client: TorrentClient;
  let startTime: number;
  
  try {
    // Create client
    client = new TorrentClient(options.torrentFile, {
      outputPath: options.outputPath,
      maxPeers: options.maxPeers,
      blockSize: options.blockSize,
      windowSize: options.windowSize,
      port: options.port,
    });
    
    // Set up event handlers
    client.on('download_started', () => {
      startTime = Date.now();
      logger.info(`🚀 Started downloading: ${client.torrentName}`);
      logger.info(`📦 Size: ${formatBytes(client.totalSize)}`);
    });
    
    client.on('stats_updated', (stats: ClientStats) => {
      if (options.json) {
        console.log(JSON.stringify(stats));
      } else if (!options.quiet) {
        progress.update(stats);
      }
    });
    
    client.on('download_completed', (event) => {
      const downloadTime = Date.now() - startTime;
      if (options.json) {
        console.log(JSON.stringify({ event: 'completed', ...event, downloadTime }));
      } else {
        progress.complete(client.getStats(), downloadTime);
      }
    });
    
    client.on('debug', (message) => {
      logger.debug(message);
    });

    client.on('peer_connected', (event) => {
      logger.info(`🔗 Connected to peer: ${event.address}`);
    });
    
    client.on('peer_disconnected', (event) => {
      logger.debug(`💔 Disconnected from peer: ${event.address}`);
    });

    client.on('peer_connect_error', (event) => {
      logger.debug(`❌ Failed to connect to ${event.address}: ${event.error}`);
    });

    client.on('peer_connect_failed', (event) => {
      logger.debug(`🚫 Peer connection failed ${event.address}: ${event.error}`);
    });
    
    client.on('announce_success', (event) => {
      logger.debug(`📡 Tracker announce: ${event.peers} peers, ${event.seeders} seeders`);
    });
    
    client.on('announce_error', (event) => {
      logger.warn(`📡 Tracker announce failed:`, event.error);
    });
    
    client.on('piece_completed', (event) => {
      logger.debug(`✅ Completed piece ${event.pieceIndex}`);
    });
    
    client.on('endgame_started', () => {
      logger.info('🏁 Entered endgame mode');
    });
    
    client.on('error', (error) => {
      logger.error('Client error:', error);
      if (!options.json) {
        progress.error(error.message);
      }
      process.exit(1);
    });
    
    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`\n📡 Received ${signal}, shutting down gracefully...`);
      try {
        await client.stop();
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Start download
    await client.start();
    
    // Keep process alive
    await new Promise((resolve) => {
      client.on('download_completed', resolve);
      client.on('error', resolve);
    });
    
  } catch (error) {
    logger.error('Failed to start download:', error);
    if (!options.json) {
      progress.error(error instanceof Error ? error.message : 'Unknown error');
    }
    process.exit(1);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function main(): Promise<void> {
  try {
    const options = parseArguments();
    validateOptions(options);
    await downloadTorrent(options);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

export { main, CliOptions };