import { EventEmitter } from 'events';
import { PeerConnection, BitSet, RequestMessage, PieceMessage, CancelMessage } from './peer';
import { TorrentMeta, Piece, getPieceMap } from './metainfo';

export class SchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchedulerError';
  }
}

export interface BlockRequest {
  pieceIndex: number;
  begin: number;
  length: number;
  peer: PeerConnection;
  requestedAt: number;
  timeoutAt: number;
}

export interface PieceProgress {
  pieceIndex: number;
  totalLength: number;
  receivedBlocks: Map<number, Buffer>; // offset -> block data
  requestedBlocks: Set<number>; // set of requested block offsets
  availableBlocks: Set<number>; // set of blocks still needed
}

export interface SchedulerStats {
  piecesCompleted: number;
  piecesTotal: number;
  bytesDownloaded: number;
  bytesTotal: number;
  activeRequests: number;
  availablePeers: number;
  downloadRate: number; // bytes per second
  endgameActive: boolean;
}

export class PieceScheduler extends EventEmitter {
  private static readonly DEFAULT_BLOCK_SIZE = 16384; // 16KB
  private static readonly DEFAULT_WINDOW_SIZE = 12; // requests per peer
  private static readonly REQUEST_TIMEOUT = 30000; // 30 seconds
  private static readonly ENDGAME_THRESHOLD = 20; // blocks remaining to trigger endgame

  private readonly torrentMeta: TorrentMeta;
  private readonly pieces: Piece[];
  private readonly blockSize: number;
  private readonly windowSize: number;

  // Piece tracking
  private readonly pieceProgress: Map<number, PieceProgress> = new Map();
  private readonly completedPieces: Set<number> = new Set();
  private readonly availabilityMap: Map<number, number> = new Map(); // piece -> count of peers who have it
  
  // Request tracking
  private readonly activeRequests: Map<string, BlockRequest> = new Map(); // requestId -> request
  private readonly peerRequests: Map<PeerConnection, Set<string>> = new Map(); // peer -> set of requestIds
  
  // Peer tracking
  private readonly peers: Set<PeerConnection> = new Set();
  private readonly peerBitfields: Map<PeerConnection, BitSet> = new Map();
  
  // State
  private endgameActive = false;
  private bytesDownloaded = 0;
  private downloadRateTracker: { timestamp: number; bytes: number }[] = [];

  constructor(
    torrentMeta: TorrentMeta,
    blockSize: number = PieceScheduler.DEFAULT_BLOCK_SIZE,
    windowSize: number = PieceScheduler.DEFAULT_WINDOW_SIZE
  ) {
    super();

    this.torrentMeta = torrentMeta;
    this.pieces = getPieceMap(torrentMeta);
    this.blockSize = blockSize;
    this.windowSize = windowSize;

    // Initialize piece progress tracking
    for (const piece of this.pieces) {
      const progress: PieceProgress = {
        pieceIndex: piece.index,
        totalLength: piece.length,
        receivedBlocks: new Map(),
        requestedBlocks: new Set(),
        availableBlocks: new Set(),
      };

      // Calculate blocks for this piece
      const numBlocks = Math.ceil(piece.length / this.blockSize);
      for (let i = 0; i < numBlocks; i++) {
        const offset = i * this.blockSize;
        progress.availableBlocks.add(offset);
      }

      this.pieceProgress.set(piece.index, progress);
      this.availabilityMap.set(piece.index, 0);
    }

    // Start periodic maintenance
    this.startMaintenanceTimer();
  }

  addPeer(peer: PeerConnection, bitfield?: BitSet): void {
    if (this.peers.has(peer)) {
      return;
    }

    this.peers.add(peer);
    this.peerRequests.set(peer, new Set());

    if (bitfield) {
      this.peerBitfields.set(peer, bitfield);
      this.updateAvailability(peer, bitfield);
    }

    // Set up peer event handlers
    peer.on('bitfield', (bf) => this.handlePeerBitfield(peer, bf));
    peer.on('have', (message) => this.handlePeerHave(peer, message.index));
    peer.on('piece', (message) => this.handlePeerPiece(peer, message));
    peer.on('choke', () => this.handlePeerChoke(peer));
    peer.on('unchoke', () => this.handlePeerUnchoke(peer));
    peer.on('close', () => this.removePeer(peer));
    peer.on('error', () => this.removePeer(peer));

    this.emit('peer_added', peer);
    this.scheduleRequests();
  }

  removePeer(peer: PeerConnection): void {
    if (!this.peers.has(peer)) {
      return;
    }

    // Cancel all requests from this peer
    const peerRequestIds = this.peerRequests.get(peer) || new Set();
    for (const requestId of peerRequestIds) {
      const request = this.activeRequests.get(requestId);
      if (request) {
        this.cancelBlockRequest(request);
      }
    }

    // Remove peer tracking
    this.peers.delete(peer);
    this.peerRequests.delete(peer);
    const oldBitfield = this.peerBitfields.get(peer);
    this.peerBitfields.delete(peer);

    // Update availability counts
    if (oldBitfield) {
      for (let i = 0; i < oldBitfield.getSize(); i++) {
        if (oldBitfield.get(i)) {
          const currentCount = this.availabilityMap.get(i) || 0;
          this.availabilityMap.set(i, Math.max(0, currentCount - 1));
        }
      }
    }

    this.emit('peer_removed', peer);
    this.scheduleRequests();
  }

  private handlePeerBitfield(peer: PeerConnection, bitfield: BitSet): void {
    const oldBitfield = this.peerBitfields.get(peer);
    this.peerBitfields.set(peer, bitfield);

    // Update availability counts
    this.updateAvailability(peer, bitfield, oldBitfield);
    this.scheduleRequests();
  }

  private handlePeerHave(peer: PeerConnection, pieceIndex: number): void {
    let bitfield = this.peerBitfields.get(peer);
    if (!bitfield) {
      bitfield = new BitSet(this.pieces.length);
      this.peerBitfields.set(peer, bitfield);
    }

    if (!bitfield.get(pieceIndex)) {
      bitfield.set(pieceIndex);
      const currentCount = this.availabilityMap.get(pieceIndex) || 0;
      this.availabilityMap.set(pieceIndex, currentCount + 1);
      this.scheduleRequests();
    }
  }

  private handlePeerPiece(peer: PeerConnection, message: PieceMessage): void {
    const requestId = this.getRequestId(message.index, message.begin);
    const request = this.activeRequests.get(requestId);

    if (!request) {
      // Unexpected piece, ignore
      return;
    }

    // Remove from tracking
    this.removeActiveRequest(request);

    // Validate block length
    const expectedLength = this.getBlockLength(message.index, message.begin);
    if (message.block.length !== expectedLength) {
      this.emit('block_error', { 
        peer, 
        pieceIndex: message.index, 
        begin: message.begin, 
        error: 'Invalid block length' 
      });
      return;
    }

    // Store block data
    const progress = this.pieceProgress.get(message.index);
    if (!progress) {
      return;
    }

    progress.receivedBlocks.set(message.begin, message.block);
    progress.requestedBlocks.delete(message.begin);
    progress.availableBlocks.delete(message.begin);

    this.bytesDownloaded += message.block.length;
    this.updateDownloadRate(message.block.length);

    // Check if piece is complete
    if (progress.availableBlocks.size === 0) {
      this.completePiece(message.index);
    } else {
      this.emit('block_received', {
        peer,
        pieceIndex: message.index,
        begin: message.begin,
        length: message.block.length,
      });
    }

    this.scheduleRequests();
  }

  private handlePeerChoke(peer: PeerConnection): void {
    // Cancel all requests from this peer
    const peerRequestIds = this.peerRequests.get(peer) || new Set();
    for (const requestId of peerRequestIds) {
      const request = this.activeRequests.get(requestId);
      if (request) {
        this.cancelBlockRequest(request);
      }
    }
  }

  private handlePeerUnchoke(peer: PeerConnection): void {
    this.scheduleRequests();
  }

  private updateAvailability(peer: PeerConnection, newBitfield: BitSet, oldBitfield?: BitSet): void {
    for (let i = 0; i < newBitfield.getSize(); i++) {
      const hadPiece = oldBitfield?.get(i) || false;
      const hasPiece = newBitfield.get(i);

      if (hasPiece && !hadPiece) {
        const currentCount = this.availabilityMap.get(i) || 0;
        this.availabilityMap.set(i, currentCount + 1);
      } else if (!hasPiece && hadPiece) {
        const currentCount = this.availabilityMap.get(i) || 0;
        this.availabilityMap.set(i, Math.max(0, currentCount - 1));
      }
    }
  }

  private scheduleRequests(): void {
    // Skip scheduling if in endgame mode and no capacity
    const totalRemainingBlocks = this.getRemainingBlockCount();
    
    // Check if we should enter endgame mode
    if (!this.endgameActive && totalRemainingBlocks <= PieceScheduler.ENDGAME_THRESHOLD) {
      this.endgameActive = true;
      this.emit('endgame_started');
    }

    // Schedule requests for each available peer
    for (const peer of this.peers) {
      this.schedulePeerRequests(peer);
    }
  }

  private schedulePeerRequests(peer: PeerConnection): void {
    const peerState = peer.getState();
    
    // Skip if peer is choked, not connected, or at capacity
    if (peerState.choked || !peer.isConnected()) {
      return;
    }

    const currentRequests = this.peerRequests.get(peer)?.size || 0;
    const availableCapacity = this.windowSize - currentRequests;

    if (availableCapacity <= 0) {
      return;
    }

    const peerBitfield = this.peerBitfields.get(peer);
    if (!peerBitfield) {
      return;
    }

    // Get pieces to request in rarest-first order
    const candidatePieces = this.getRarestFirstPieces(peerBitfield);
    let requestsScheduled = 0;

    for (const pieceIndex of candidatePieces) {
      if (requestsScheduled >= availableCapacity) {
        break;
      }

      const blocksScheduled = this.scheduleBlocksForPiece(peer, pieceIndex, availableCapacity - requestsScheduled);
      requestsScheduled += blocksScheduled;
    }
  }

  private getRarestFirstPieces(peerBitfield: BitSet): number[] {
    const candidates: { pieceIndex: number; availability: number }[] = [];

    for (let i = 0; i < this.pieces.length; i++) {
      // Skip completed pieces
      if (this.completedPieces.has(i)) {
        continue;
      }

      // Skip pieces peer doesn't have
      if (!peerBitfield.get(i)) {
        continue;
      }

      // Skip pieces with no remaining blocks
      const progress = this.pieceProgress.get(i);
      if (!progress || progress.availableBlocks.size === 0) {
        continue;
      }

      const availability = this.availabilityMap.get(i) || 0;
      candidates.push({ pieceIndex: i, availability });
    }

    // Sort by availability (rarest first), then by piece index for determinism
    candidates.sort((a, b) => {
      if (a.availability !== b.availability) {
        return a.availability - b.availability;
      }
      return a.pieceIndex - b.pieceIndex;
    });

    return candidates.map(c => c.pieceIndex);
  }

  private scheduleBlocksForPiece(peer: PeerConnection, pieceIndex: number, maxBlocks: number): number {
    const progress = this.pieceProgress.get(pieceIndex);
    if (!progress) {
      return 0;
    }

    let scheduled = 0;
    const availableBlocks = Array.from(progress.availableBlocks);

    // In endgame mode, allow duplicate requests
    const blocksToRequest = this.endgameActive 
      ? availableBlocks.concat(Array.from(progress.requestedBlocks))
      : availableBlocks;

    for (const blockOffset of blocksToRequest) {
      if (scheduled >= maxBlocks) {
        break;
      }

      // Skip if already requested by this peer (avoid duplicates from same peer)
      const requestId = this.getRequestId(pieceIndex, blockOffset);
      const existingRequest = this.activeRequests.get(requestId);
      if (existingRequest && existingRequest.peer === peer) {
        continue;
      }

      const blockLength = this.getBlockLength(pieceIndex, blockOffset);
      const request: BlockRequest = {
        pieceIndex,
        begin: blockOffset,
        length: blockLength,
        peer,
        requestedAt: Date.now(),
        timeoutAt: Date.now() + PieceScheduler.REQUEST_TIMEOUT,
      };

      // Send request to peer
      peer.sendRequest({
        index: pieceIndex,
        begin: blockOffset,
        length: blockLength,
      }).then(() => {
        // Track the request
        this.addActiveRequest(request);
        progress.requestedBlocks.add(blockOffset);
        if (!this.endgameActive) {
          progress.availableBlocks.delete(blockOffset);
        }
      }).catch((error) => {
        this.emit('request_error', { peer, request, error });
      });

      scheduled++;
    }

    return scheduled;
  }

  private completePiece(pieceIndex: number): void {
    const progress = this.pieceProgress.get(pieceIndex);
    const piece = this.pieces[pieceIndex];
    
    if (!progress || !piece) {
      return;
    }

    // Reconstruct piece data from blocks
    const blocks: Buffer[] = [];
    let totalLength = 0;

    for (let offset = 0; offset < piece.length; offset += this.blockSize) {
      const block = progress.receivedBlocks.get(offset);
      if (!block) {
        this.emit('piece_error', { 
          pieceIndex, 
          error: 'Missing block data' 
        });
        return;
      }
      blocks.push(block);
      totalLength += block.length;
    }

    const pieceData = Buffer.concat(blocks, totalLength);

    // Verify piece hash
    const crypto = require('crypto');
    const actualHash = crypto.createHash('sha1').update(pieceData).digest();
    
    if (!actualHash.equals(piece.hash)) {
      this.emit('piece_error', { 
        pieceIndex, 
        error: 'Hash verification failed',
        expected: piece.hash.toString('hex'),
        actual: actualHash.toString('hex')
      });
      
      // Reset piece for re-download
      this.resetPiece(pieceIndex);
      return;
    }

    // Mark piece as completed
    this.completedPieces.add(pieceIndex);
    this.pieceProgress.delete(pieceIndex);

    // Cancel any duplicate requests in endgame mode
    if (this.endgameActive) {
      this.cancelDuplicateRequests(pieceIndex);
    }

    // Notify all peers that we have this piece
    for (const peer of this.peers) {
      peer.sendHave(pieceIndex).catch(() => {
        // Ignore send errors
      });
    }

    this.emit('piece_completed', { 
      pieceIndex, 
      data: pieceData,
      length: pieceData.length 
    });

    // Check if download is complete
    if (this.completedPieces.size === this.pieces.length) {
      this.emit('download_completed');
    }
  }

  private resetPiece(pieceIndex: number): void {
    const piece = this.pieces[pieceIndex];
    if (!piece) {
      return;
    }

    // Cancel existing requests for this piece
    const requestsToCancel: BlockRequest[] = [];
    for (const request of this.activeRequests.values()) {
      if (request.pieceIndex === pieceIndex) {
        requestsToCancel.push(request);
      }
    }

    for (const request of requestsToCancel) {
      this.cancelBlockRequest(request);
    }

    // Reset progress
    const progress: PieceProgress = {
      pieceIndex,
      totalLength: piece.length,
      receivedBlocks: new Map(),
      requestedBlocks: new Set(),
      availableBlocks: new Set(),
    };

    const numBlocks = Math.ceil(piece.length / this.blockSize);
    for (let i = 0; i < numBlocks; i++) {
      const offset = i * this.blockSize;
      progress.availableBlocks.add(offset);
    }

    this.pieceProgress.set(pieceIndex, progress);
    this.completedPieces.delete(pieceIndex);
  }

  private cancelDuplicateRequests(completedPieceIndex: number): void {
    const requestsToCancel: BlockRequest[] = [];
    
    for (const request of this.activeRequests.values()) {
      if (request.pieceIndex === completedPieceIndex) {
        requestsToCancel.push(request);
      }
    }

    for (const request of requestsToCancel) {
      // Send cancel message to peer
      request.peer.sendCancel({
        index: request.pieceIndex,
        begin: request.begin,
        length: request.length,
      }).catch(() => {
        // Ignore send errors
      });

      this.removeActiveRequest(request);
    }
  }

  private addActiveRequest(request: BlockRequest): void {
    const requestId = this.getRequestId(request.pieceIndex, request.begin);
    this.activeRequests.set(requestId, request);
    
    let peerRequests = this.peerRequests.get(request.peer);
    if (!peerRequests) {
      peerRequests = new Set();
      this.peerRequests.set(request.peer, peerRequests);
    }
    peerRequests.add(requestId);
  }

  private removeActiveRequest(request: BlockRequest): void {
    const requestId = this.getRequestId(request.pieceIndex, request.begin);
    this.activeRequests.delete(requestId);
    
    const peerRequests = this.peerRequests.get(request.peer);
    if (peerRequests) {
      peerRequests.delete(requestId);
    }
  }

  private cancelBlockRequest(request: BlockRequest): void {
    // Send cancel message to peer
    request.peer.sendCancel({
      index: request.pieceIndex,
      begin: request.begin,
      length: request.length,
    }).catch(() => {
      // Ignore send errors
    });

    // Remove from tracking
    this.removeActiveRequest(request);

    // Mark block as available again
    const progress = this.pieceProgress.get(request.pieceIndex);
    if (progress) {
      progress.requestedBlocks.delete(request.begin);
      progress.availableBlocks.add(request.begin);
    }
  }

  private getRequestId(pieceIndex: number, begin: number): string {
    return `${pieceIndex}:${begin}`;
  }

  private getBlockLength(pieceIndex: number, blockOffset: number): number {
    const piece = this.pieces[pieceIndex];
    if (!piece) {
      throw new SchedulerError(`Invalid piece index: ${pieceIndex}`);
    }

    const remainingBytes = piece.length - blockOffset;
    return Math.min(this.blockSize, remainingBytes);
  }

  private getRemainingBlockCount(): number {
    let count = 0;
    for (const progress of this.pieceProgress.values()) {
      count += progress.availableBlocks.size + progress.requestedBlocks.size;
    }
    return count;
  }

  private updateDownloadRate(bytesReceived: number): void {
    const now = Date.now();
    this.downloadRateTracker.push({ timestamp: now, bytes: bytesReceived });
    
    // Keep only last 30 seconds of data
    const cutoff = now - 30000;
    this.downloadRateTracker = this.downloadRateTracker.filter(entry => entry.timestamp > cutoff);
  }

  private calculateDownloadRate(): number {
    if (this.downloadRateTracker.length < 2) {
      return 0;
    }

    const totalBytes = this.downloadRateTracker.reduce((sum, entry) => sum + entry.bytes, 0);
    const timeSpan = this.downloadRateTracker[this.downloadRateTracker.length - 1].timestamp - 
                     this.downloadRateTracker[0].timestamp;
    
    return timeSpan > 0 ? (totalBytes * 1000) / timeSpan : 0; // bytes per second
  }

  private maintenanceTimer?: NodeJS.Timeout;

  private startMaintenanceTimer(): void {
    this.maintenanceTimer = setInterval(() => {
      this.handleTimeouts();
    }, 5000); // Check every 5 seconds
  }

  private handleTimeouts(): void {
    const now = Date.now();
    const timedOutRequests: BlockRequest[] = [];

    for (const request of this.activeRequests.values()) {
      if (now >= request.timeoutAt) {
        timedOutRequests.push(request);
      }
    }

    for (const request of timedOutRequests) {
      this.emit('request_timeout', { peer: request.peer, request });
      this.cancelBlockRequest(request);
    }

    if (timedOutRequests.length > 0) {
      this.scheduleRequests();
    }
  }

  // Public API
  getStats(): SchedulerStats {
    return {
      piecesCompleted: this.completedPieces.size,
      piecesTotal: this.pieces.length,
      bytesDownloaded: this.bytesDownloaded,
      bytesTotal: this.torrentMeta.length,
      activeRequests: this.activeRequests.size,
      availablePeers: Array.from(this.peers).filter(p => !p.getState().choked && p.isConnected()).length,
      downloadRate: this.calculateDownloadRate(),
      endgameActive: this.endgameActive,
    };
  }

  isComplete(): boolean {
    return this.completedPieces.size === this.pieces.length;
  }

  getBytesDownloaded(): number {
    return this.bytesDownloaded;
  }

  getCompletedPieces(): Set<number> {
    return new Set(this.completedPieces);
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  destroy(): void {
    // Cancel all requests
    for (const request of this.activeRequests.values()) {
      this.cancelBlockRequest(request);
    }

    // Stop maintenance timer
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }

    // Clear all state
    this.peers.clear();
    this.peerRequests.clear();
    this.peerBitfields.clear();
    this.activeRequests.clear();
    this.removeAllListeners();
  }
}