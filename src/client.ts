import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { TorrentMeta, parseTorrentFile } from './metainfo';
import { TrackerClient } from './tracker';
import { PeerConnection, BitSet } from './peer';
import { PieceScheduler } from './scheduler';
import { TorrentStorage } from './storage';

export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

export interface ClientOptions {
  outputPath: string;
  maxPeers?: number;
  blockSize?: number;
  windowSize?: number;
  port?: number;
  announceInterval?: number;
  requestTimeout?: number;
}

export interface ClientStats {
  status: 'stopped' | 'starting' | 'downloading' | 'seeding' | 'completed' | 'error';
  torrentName: string;
  totalSize: number;
  downloadedSize: number;
  uploadedSize: number;
  remainingSize: number;
  progress: number;
  downloadRate: number;
  uploadRate: number;
  connectedPeers: number;
  totalPeers: number;
  availablePeers: number;
  seeders: number;
  leechers: number;
  completedPieces: number;
  totalPieces: number;
  endgameActive: boolean;
  eta: number;
  announces: number;
  announceInterval: number;
  uptime: number;
}

export interface PeerStats {
  id: string;
  address: string;
  port: number;
  status: string;
  downloadRate: number;
  uploadRate: number;
  pieces: number;
  inflightRequests: number;
  isChoked: boolean;
  isInterested: boolean;
  peerChoked: boolean;
  peerInterested: boolean;
  lastActive: number;
}

export class TorrentClient extends EventEmitter {
  private static readonly DEFAULT_MAX_PEERS = 30;
  private static readonly DEFAULT_BLOCK_SIZE = 16384; // 16KB
  private static readonly DEFAULT_WINDOW_SIZE = 12;
  private static readonly DEFAULT_PORT = 6881;
  private static readonly DEFAULT_ANNOUNCE_INTERVAL = 30 * 60 * 1000; // 30 minutes
  private static readonly PEER_ID_PREFIX = '-JS0001-';

  private readonly torrentMeta: TorrentMeta;
  private readonly options: Required<ClientOptions>;
  private readonly peerId: Buffer;
  
  // Core components
  private tracker?: TrackerClient;
  private scheduler?: PieceScheduler;
  private storage?: TorrentStorage;
  
  // State management
  private status: ClientStats['status'] = 'stopped';
  private readonly connectedPeers: Map<string, PeerConnection> = new Map();
  private readonly knownPeers: Set<string> = new Set();
  private bytesUploaded = 0;
  private startTime?: number;
  private announceCount = 0;
  
  // Timers
  private announceTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private peerConnectTimer?: NodeJS.Timeout;

  constructor(torrentFilePath: string, options: ClientOptions) {
    super();
    
    // Parse torrent file
    this.torrentMeta = parseTorrentFile(torrentFilePath);
    
    // Set up options with defaults
    this.options = {
      maxPeers: options.maxPeers ?? TorrentClient.DEFAULT_MAX_PEERS,
      blockSize: options.blockSize ?? TorrentClient.DEFAULT_BLOCK_SIZE,
      windowSize: options.windowSize ?? TorrentClient.DEFAULT_WINDOW_SIZE,
      port: options.port ?? TorrentClient.DEFAULT_PORT,
      announceInterval: options.announceInterval ?? TorrentClient.DEFAULT_ANNOUNCE_INTERVAL,
      requestTimeout: options.requestTimeout ?? 30000,
      outputPath: options.outputPath,
    };
    
    // Generate peer ID
    this.peerId = this.generatePeerId();
    
    this.emit('client_created', {
      torrentName: this.torrentMeta.name,
      infoHash: this.torrentMeta.infoHashV1.toString('hex'),
      totalSize: this.torrentMeta.length,
      totalPieces: Math.ceil(this.torrentMeta.length / this.torrentMeta.pieceLength),
    });
  }

  async start(): Promise<void> {
    if (this.status !== 'stopped') {
      throw new ClientError('Client is already started');
    }

    try {
      this.status = 'starting';
      this.startTime = Date.now();
      this.emit('status_changed', { status: this.status });

      // Initialize storage
      this.storage = new TorrentStorage(
        this.torrentMeta, 
        this.options.outputPath, 
        this.options.blockSize
      );
      
      await this.storage.initialize();
      this.setupStorageEventHandlers();

      // Check if already complete
      if (this.storage.isComplete()) {
        this.status = 'completed';
        this.emit('status_changed', { status: this.status });
        this.emit('download_completed');
        return;
      }

      // Initialize scheduler
      this.scheduler = new PieceScheduler(
        this.torrentMeta,
        this.options.blockSize,
        this.options.windowSize
      );
      
      this.setupSchedulerEventHandlers();

      // Initialize tracker
      this.tracker = new TrackerClient();
      
      this.setupTrackerEventHandlers();

      // Start downloading
      this.status = 'downloading';
      this.emit('status_changed', { status: this.status });

      // Initial tracker announce
      await this.announceToTracker('started');
      
      // Start periodic announces
      this.startAnnounceTimer();
      
      // Start stats reporting
      this.startStatsTimer();
      
      // Start peer connection attempts
      this.startPeerConnectTimer();

      this.emit('download_started');

    } catch (error) {
      this.status = 'error';
      this.emit('status_changed', { status: this.status });
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.status === 'stopped') {
      return;
    }

    try {
      // Clear timers
      if (this.announceTimer) {
        clearInterval(this.announceTimer);
        this.announceTimer = undefined;
      }
      
      if (this.statsTimer) {
        clearInterval(this.statsTimer);
        this.statsTimer = undefined;
      }
      
      if (this.peerConnectTimer) {
        clearInterval(this.peerConnectTimer);
        this.peerConnectTimer = undefined;
      }

      // Disconnect all peers
      for (const peer of this.connectedPeers.values()) {
        try {
          peer.destroy();
        } catch {
          // Ignore disconnect errors
        }
      }
      this.connectedPeers.clear();

      // Final tracker announce
      if (this.tracker) {
        try {
          await this.announceToTracker('stopped');
        } catch {
          // Ignore final announce errors
        }
      }

      // Clean up components
      if (this.scheduler) {
        this.scheduler.destroy();
        this.scheduler = undefined;
      }
      
      if (this.storage) {
        await this.storage.close();
        this.storage = undefined;
      }

      this.status = 'stopped';
      this.emit('status_changed', { status: this.status });
      this.emit('download_stopped');

    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  async destroy(): Promise<void> {
    await this.stop();
    
    if (this.storage) {
      await this.storage.destroy();
    }
    
    this.removeAllListeners();
  }

  getStats(): ClientStats {
    const now = Date.now();
    const uptime = this.startTime ? now - this.startTime : 0;
    
    const storageStats = this.storage?.getStats();
    const schedulerStats = this.scheduler?.getStats();
    
    const downloadedSize = storageStats?.writtenSize ?? 0;
    const totalSize = this.torrentMeta.length;
    const remainingSize = totalSize - downloadedSize;
    const progress = totalSize > 0 ? (downloadedSize / totalSize) * 100 : 0;
    
    // Calculate ETA
    const downloadRate = schedulerStats?.downloadRate ?? 0;
    const eta = downloadRate > 0 ? Math.ceil(remainingSize / downloadRate) : Infinity;
    
    return {
      status: this.status,
      torrentName: this.torrentMeta.name,
      totalSize,
      downloadedSize,
      uploadedSize: this.bytesUploaded,
      remainingSize,
      progress,
      downloadRate,
      uploadRate: 0, // Not implemented in MVP
      connectedPeers: this.connectedPeers.size,
      totalPeers: this.knownPeers.size,
      availablePeers: schedulerStats?.availablePeers ?? 0,
      seeders: 0, // Would need tracker stats
      leechers: 0, // Would need tracker stats
      completedPieces: schedulerStats?.piecesCompleted ?? 0,
      totalPieces: schedulerStats?.piecesTotal ?? 0,
      endgameActive: schedulerStats?.endgameActive ?? false,
      eta,
      announces: this.announceCount,
      announceInterval: this.options.announceInterval,
      uptime,
    };
  }

  getPeerStats(): PeerStats[] {
    const stats: PeerStats[] = [];
    
    for (const [address, peer] of this.connectedPeers) {
      const [ip, port] = address.split(':');
      const state = peer.getState();
      
      stats.push({
        id: address,
        address: ip,
        port: parseInt(port, 10),
        status: peer.isConnected() ? 'connected' : 'disconnected',
        downloadRate: state.throughput?.downBps ?? 0,
        uploadRate: state.throughput?.upBps ?? 0,
        pieces: state.bitfield?.countSet() ?? 0,
        inflightRequests: state.inflight,
        isChoked: state.choked,
        isInterested: state.interested,
        peerChoked: state.peerChoked,
        peerInterested: state.peerInterested,
        lastActive: state.lastActive,
      });
    }
    
    return stats.sort((a, b) => b.downloadRate - a.downloadRate);
  }

  private generatePeerId(): Buffer {
    const randomSuffix = crypto.randomBytes(12).toString('base64url').slice(0, 12);
    return Buffer.from(TorrentClient.PEER_ID_PREFIX + randomSuffix, 'ascii');
  }

  private setupStorageEventHandlers(): void {
    if (!this.storage) return;

    this.storage.on('piece_completed', (event) => {
      this.emit('piece_completed', event);
      
      // Check if download is complete
      if (this.storage?.isComplete()) {
        this.handleDownloadComplete();
      }
    });

    this.storage.on('block_added', (event) => {
      this.emit('block_received', event);
    });

    this.storage.on('piece_hash_failed', (event) => {
      this.emit('piece_hash_failed', event);
    });

    this.storage.on('download_completed', () => {
      this.handleDownloadComplete();
    });
  }

  private setupSchedulerEventHandlers(): void {
    if (!this.scheduler) return;

    this.scheduler.on('piece_completed', (event) => {
      // Forward piece data to storage
      if (this.storage) {
        const pieceIndex = event.pieceIndex;
        const blocks = this.splitIntoBlocks(event.data, this.options.blockSize);
        
        for (let i = 0; i < blocks.length; i++) {
          const blockOffset = i * this.options.blockSize;
          this.storage.addBlock(pieceIndex, blockOffset, blocks[i]);
        }
      }
    });

    this.scheduler.on('endgame_started', () => {
      this.emit('endgame_started');
    });

    this.scheduler.on('request_timeout', (event) => {
      this.emit('peer_timeout', { peer: event.peer });
      // Could implement peer scoring here
    });

    this.scheduler.on('piece_error', (event) => {
      this.emit('piece_error', event);
    });
  }

  private setupTrackerEventHandlers(): void {
    // TrackerClient doesn't extend EventEmitter in current implementation
    // Events will be handled through promise resolution/rejection
  }

  private async announceToTracker(event: 'started' | 'completed' | 'stopped'): Promise<void> {
    if (!this.tracker || !this.storage) return;

    const stats = this.storage.getStats();
    
    try {
      const result = await this.tracker.announce(this.torrentMeta.announce, {
        infoHash: this.torrentMeta.infoHashV1,
        peerId: this.peerId,
        port: this.options.port,
        event,
        downloaded: stats.writtenSize,
        uploaded: this.bytesUploaded,
        left: stats.totalSize - stats.writtenSize,
        compact: true,
      });
      
      this.announceCount++;
      
      // Add new peers
      for (const peer of result.peers) {
        const address = `${peer.ip}:${peer.port}`;
        this.knownPeers.add(address);
      }
      
      this.emit('announce_success', {
        interval: result.interval,
        seeders: result.complete ?? 0,
        leechers: result.incomplete ?? 0,
        peers: result.peers.length,
      });
    } catch (error) {
      this.emit('announce_error', { error });
      throw error;
    }
  }

  private startAnnounceTimer(): void {
    this.announceTimer = setInterval(async () => {
      try {
        await this.announceToTracker(this.status === 'completed' ? 'completed' : 'started');
      } catch (error) {
        this.emit('announce_error', { error });
      }
    }, this.options.announceInterval);
  }

  private startStatsTimer(): void {
    this.statsTimer = setInterval(() => {
      this.emit('stats_updated', this.getStats());
    }, 1000); // Update stats every second
  }

  private startPeerConnectTimer(): void {
    this.peerConnectTimer = setInterval(() => {
      this.tryConnectToPeers();
    }, 5000); // Try connecting to peers every 5 seconds
  }

  private async tryConnectToPeers(): Promise<void> {
    if (this.connectedPeers.size >= this.options.maxPeers) {
      return;
    }

    const availablePeers = Array.from(this.knownPeers).filter(
      address => !this.connectedPeers.has(address)
    );

    if (availablePeers.length === 0) {
      this.emit('debug', 'No available peers to connect to');
      return;
    }

    const peersToConnect = availablePeers.slice(0, this.options.maxPeers - this.connectedPeers.size);
    
    this.emit('debug', `Attempting to connect to ${peersToConnect.length} peers: ${peersToConnect.join(', ')}`);

    for (const address of peersToConnect) {
      try {
        this.emit('debug', `Connecting to peer: ${address}`);
        await this.connectToPeer(address);
      } catch (error) {
        this.emit('peer_connect_error', { address, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }
  }

  private async connectToPeer(address: string): Promise<void> {
    if (this.connectedPeers.has(address)) {
      this.emit('debug', `Already connected to peer: ${address}`);
      return;
    }

    const [ip, port] = address.split(':');
    
    if (!ip || !port || isNaN(parseInt(port))) {
      const error = `Invalid peer address format: ${address}`;
      this.emit('peer_connect_failed', { address, error });
      throw new Error(error);
    }
    
    this.emit('debug', `Creating peer connection to ${ip}:${port}`);
    
    try {
      const peer = new PeerConnection(
        { ip, port: parseInt(port, 10) },
        this.torrentMeta.infoHashV1,
        this.peerId,
        Math.ceil(this.torrentMeta.length / this.torrentMeta.pieceLength)
      );
      
      this.emit('debug', `Peer object created for ${address}, setting up event handlers`);
      
      // Set up peer event handlers
      this.setupPeerEventHandlers(peer, address);
      
      this.emit('debug', `Attempting TCP connection to ${address}`);
      
      // Connect (handshake is done automatically in constructor)
      await peer.connect();
      
      this.emit('debug', `TCP connection established to ${address}`);
      
      // Add peer to scheduler and our tracking
      if (this.scheduler) {
        this.scheduler.addPeer(peer);
        this.emit('debug', `Added peer ${address} to scheduler`);
      }
      
      this.connectedPeers.set(address, peer);
      
      this.emit('peer_connected', { address, peer });
      this.emit('debug', `✅ Successfully connected to peer: ${address}`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown connection error';
      this.emit('peer_connect_failed', { address, error: errorMessage });
      this.emit('debug', `❌ Failed to connect to peer ${address}: ${errorMessage}`);
      throw error;
    }
  }

  private setupPeerEventHandlers(peer: PeerConnection, address: string): void {
    peer.on('disconnect', () => {
      this.connectedPeers.delete(address);
      if (this.scheduler) {
        this.scheduler.removePeer(peer);
      }
      this.emit('peer_disconnected', { address });
      this.emit('debug', `🔌 Peer disconnected: ${address}`);
    });

    peer.on('error', (error) => {
      this.connectedPeers.delete(address);
      if (this.scheduler) {
        this.scheduler.removePeer(peer);
      }
      this.emit('peer_error', { address, error });
      this.emit('debug', `⚠️ Peer error ${address}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    });

    peer.on('unchoke', () => {
      this.emit('debug', `🔓 Peer unchoked us: ${address}`);
    });

    peer.on('choke', () => {
      this.emit('debug', `🔒 Peer choked us: ${address}`);
    });

    peer.on('bitfield', (bitfield) => {
      const pieceCount = bitfield.countSet();
      this.emit('debug', `🗂️ Received bitfield from ${address}: ${pieceCount} pieces available`);
    });

    peer.on('have', (message) => {
      this.emit('debug', `📦 Peer ${address} has piece ${message.index}`);
    });

    peer.on('piece', (message) => {
      // Handled by scheduler
      this.emit('block_received', {
        peer: address,
        pieceIndex: message.index,
        begin: message.begin,
        length: message.block.length,
      });
      this.emit('debug', `📥 Received block from ${address}: piece ${message.index}, offset ${message.begin}, size ${message.block.length}`);
    });
  }

  private async handleDownloadComplete(): Promise<void> {
    if (this.status === 'completed') {
      return;
    }

    this.status = 'completed';
    this.emit('status_changed', { status: this.status });

    try {
      // Announce completion to tracker
      await this.announceToTracker('completed');
      
      this.emit('download_completed', {
        torrentName: this.torrentMeta.name,
        totalSize: this.torrentMeta.length,
        downloadTime: this.startTime ? Date.now() - this.startTime : 0,
      });
      
    } catch (error) {
      this.emit('error', error);
    }
  }

  private splitIntoBlocks(data: Buffer, blockSize: number): Buffer[] {
    const blocks: Buffer[] = [];
    
    for (let offset = 0; offset < data.length; offset += blockSize) {
      const end = Math.min(offset + blockSize, data.length);
      blocks.push(data.subarray(offset, end));
    }
    
    return blocks;
  }

  // Public getters
  get torrentName(): string {
    return this.torrentMeta.name;
  }

  get infoHash(): string {
    return this.torrentMeta.infoHashV1.toString('hex');
  }

  get totalSize(): number {
    return this.torrentMeta.length;
  }

  get isComplete(): boolean {
    return this.storage?.isComplete() ?? false;
  }

  get currentStatus(): ClientStats['status'] {
    return this.status;
  }
}