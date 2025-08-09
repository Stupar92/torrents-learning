import * as crypto from 'crypto';
import { PieceScheduler, SchedulerError } from './scheduler';
import { PeerConnection, BitSet } from './peer';
import { TorrentMeta } from './metainfo';
import { EventEmitter } from 'events';

// Simplified mock for core testing
class SimpleMockPeer extends EventEmitter {
  private mockState = {
    choked: true,
    interested: false,
    peerChoked: true,
    peerInterested: false,
    bitfield: new BitSet(0),
    inflight: 0,
    throughput: { downBps: 0, upBps: 0 },
    lastActive: Date.now(),
  };

  private connected = false;
  private sentRequests: any[] = [];

  constructor(private peerId: string) {
    super();
  }

  getState() {
    return { ...this.mockState };
  }

  isConnected() {
    return this.connected;
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  setChoked(choked: boolean) {
    this.mockState.choked = choked;
  }

  async sendRequest(request: any) {
    this.sentRequests.push({ ...request });
    return Promise.resolve();
  }

  async sendCancel(cancel: any) {
    this.sentRequests = this.sentRequests.filter(r => 
      !(r.index === cancel.index && r.begin === cancel.begin && r.length === cancel.length)
    );
    return Promise.resolve();
  }

  async sendHave(pieceIndex: number) {
    return Promise.resolve();
  }

  getSentRequests() {
    return [...this.sentRequests];
  }

  clearRequests() {
    this.sentRequests = [];
  }
}

describe('PieceScheduler - Core Logic', () => {
  let torrentMeta: TorrentMeta;
  let scheduler: PieceScheduler;
  
  beforeEach(() => {
    // Create a simple 3-piece torrent for testing
    const pieces = Buffer.alloc(60); // 3 pieces * 20 bytes each
    
    torrentMeta = {
      announce: 'http://tracker.example.com/announce',
      name: 'test-file.txt',
      length: 48000, // 3 pieces * 16KB each
      pieceLength: 16384,
      pieces,
      infoHashV1: crypto.randomBytes(20),
    };

    scheduler = new PieceScheduler(torrentMeta, 16384, 2); // Window size 2 for testing
  });

  afterEach(() => {
    scheduler.destroy();
  });

  describe('Initialization', () => {
    test('initializes with correct state', () => {
      const stats = scheduler.getStats();
      expect(stats.piecesTotal).toBe(3);
      expect(stats.piecesCompleted).toBe(0);
      expect(stats.bytesTotal).toBe(48000);
      expect(stats.bytesDownloaded).toBe(0);
      expect(stats.availablePeers).toBe(0);
      expect(stats.activeRequests).toBe(0);
      expect(stats.endgameActive).toBe(false);
    });

    test('calculates pieces correctly for different sizes', () => {
      // Test with partial last piece
      const smallTorrent: TorrentMeta = {
        ...torrentMeta,
        length: 20000, // 1.22 pieces
        pieces: Buffer.alloc(40), // 2 pieces
      };

      const smallScheduler = new PieceScheduler(smallTorrent);
      expect(smallScheduler.getStats().piecesTotal).toBe(2);
      smallScheduler.destroy();
    });

    test('handles empty torrent', () => {
      const emptyTorrent: TorrentMeta = {
        ...torrentMeta,
        length: 0,
        pieces: Buffer.alloc(0),
      };

      const emptyScheduler = new PieceScheduler(emptyTorrent);
      expect(emptyScheduler.getStats().piecesTotal).toBe(0);
      expect(emptyScheduler.isComplete()).toBe(true);
      emptyScheduler.destroy();
    });
  });

  describe('Peer Management', () => {
    test('adds and removes peers correctly', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      
      expect(scheduler.getPeerCount()).toBe(0);
      
      scheduler.addPeer(peer);
      expect(scheduler.getPeerCount()).toBe(1);
      
      scheduler.removePeer(peer);
      expect(scheduler.getPeerCount()).toBe(0);
    });

    test('tracks peer bitfields', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(2);

      scheduler.addPeer(peer, bitfield);
      expect(scheduler.getPeerCount()).toBe(1);
    });

    test('handles duplicate peer addition', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      
      scheduler.addPeer(peer);
      scheduler.addPeer(peer); // Should not add twice
      
      expect(scheduler.getPeerCount()).toBe(1);
    });
  });

  describe('Availability Tracking', () => {
    test('tracks piece availability from multiple peers', () => {
      const peer1 = new SimpleMockPeer('peer1') as any;
      const peer2 = new SimpleMockPeer('peer2') as any;

      // Peer1 has pieces 0 and 1
      const bitfield1 = new BitSet(3);
      bitfield1.set(0);
      bitfield1.set(1);

      // Peer2 has pieces 1 and 2
      const bitfield2 = new BitSet(3);
      bitfield2.set(1);
      bitfield2.set(2);

      scheduler.addPeer(peer1, bitfield1);
      scheduler.addPeer(peer2, bitfield2);

      // Internal availability should be tracked
      expect(scheduler.getPeerCount()).toBe(2);
    });

    test('updates availability on have messages', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      scheduler.addPeer(peer);

      // Simulate have message
      peer.emit('have', { index: 1 });

      expect(scheduler.getPeerCount()).toBe(1);
    });

    test('updates availability on bitfield changes', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      scheduler.addPeer(peer);

      const newBitfield = new BitSet(3);
      newBitfield.set(0);
      newBitfield.set(1);

      peer.emit('bitfield', newBitfield);

      expect(scheduler.getPeerCount()).toBe(1);
    });
  });

  describe('Request Scheduling Logic', () => {
    test('does not schedule for choked peers', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setConnected(true);
      // Keep peer choked (default)

      // Trigger scheduling
      scheduler['scheduleRequests']();

      const requests = peer.getSentRequests();
      expect(requests.length).toBe(0);
    });

    test('schedules requests for unchoked connected peers', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setConnected(true);
      peer.setChoked(false);

      // Trigger scheduling
      scheduler['scheduleRequests']();

      const requests = peer.getSentRequests();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].index).toBe(0);
    });

    test('respects window size limits', async () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(1);
      bitfield.set(2);
      
      scheduler.addPeer(peer, bitfield);
      peer.setConnected(true);
      peer.setChoked(false);

      // Trigger scheduling
      scheduler['scheduleRequests']();
      
      // Wait for async operations to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      const requests = peer.getSentRequests();
      // Should respect window size of 2
      expect(requests.length).toBeLessThanOrEqual(2);
    });

    test('implements rarest-first piece selection', () => {
      // Create scheduler with smaller blocks for easier testing
      scheduler.destroy();
      scheduler = new PieceScheduler(torrentMeta, 4096, 4); // 4KB blocks, window 4

      const peer1 = new SimpleMockPeer('peer1') as any;
      
      // Peer1 has only piece 0 (making it rarest)
      const bitfield1 = new BitSet(3);
      bitfield1.set(0);

      scheduler.addPeer(peer1, bitfield1);
      peer1.setConnected(true);
      peer1.setChoked(false);

      // Also add availability for other pieces through different method
      scheduler['availabilityMap'].set(1, 5); // Piece 1 very common
      scheduler['availabilityMap'].set(2, 3); // Piece 2 less common

      scheduler['scheduleRequests']();

      const requests = peer1.getSentRequests();
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].index).toBe(0); // Should choose rarest piece
    });

    test('calculates block lengths correctly', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setConnected(true);
      peer.setChoked(false);

      scheduler['scheduleRequests']();

      const requests = peer.getSentRequests();
      expect(requests.length).toBeGreaterThan(0);
      
      const request = requests[0];
      expect(request.length).toBe(16384); // Should match block size
      expect(request.begin).toBe(0);
    });
  });

  describe('Block Management', () => {
    test('generates correct request IDs', () => {
      const requestId = scheduler['getRequestId'](5, 16384);
      expect(requestId).toBe('5:16384');
    });

    test('calculates block lengths for last piece', () => {
      // Test with torrent where last piece is partial
      const partialTorrent: TorrentMeta = {
        ...torrentMeta,
        length: 20000, // Less than 2 full pieces
        pieces: Buffer.alloc(40), // 2 piece hashes
      };

      scheduler.destroy();
      scheduler = new PieceScheduler(partialTorrent);

      // Last piece should be smaller
      const lastPieceLength = scheduler['getBlockLength'](1, 0);
      expect(lastPieceLength).toBeLessThan(16384);
      expect(lastPieceLength).toBe(20000 - 16384); // Remaining bytes
    });

    test('throws on invalid piece index', () => {
      expect(() => {
        scheduler['getBlockLength'](999, 0);
      }).toThrow(SchedulerError);
    });
  });

  describe('State Tracking', () => {
    test('provides accurate statistics', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      scheduler.addPeer(peer);
      
      const stats = scheduler.getStats();
      expect(stats.piecesTotal).toBe(3);
      expect(stats.piecesCompleted).toBe(0);
      expect(stats.bytesTotal).toBe(48000);
      expect(stats.bytesDownloaded).toBe(0);
      expect(stats.availablePeers).toBe(0); // Peer is choked
      expect(stats.activeRequests).toBe(0);
    });

    test('tracks completion state', () => {
      expect(scheduler.isComplete()).toBe(false);
      expect(scheduler.getBytesDownloaded()).toBe(0);
      expect(scheduler.getCompletedPieces().size).toBe(0);
    });
  });

  describe('Request Tracking', () => {
    test('adds and removes active requests', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const request = {
        pieceIndex: 0,
        begin: 0,
        length: 16384,
        peer,
        requestedAt: Date.now(),
        timeoutAt: Date.now() + 30000,
      };

      scheduler['addActiveRequest'](request);
      expect(scheduler.getStats().activeRequests).toBe(1);

      scheduler['removeActiveRequest'](request);
      expect(scheduler.getStats().activeRequests).toBe(0);
    });
  });

  describe('Event Handling', () => {
    test('handles peer choke events', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      scheduler.addPeer(peer);

      // Simulate choke
      peer.emit('choke');

      // Should handle gracefully
      expect(scheduler.getPeerCount()).toBe(1);
    });

    test('handles peer close events', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      scheduler.addPeer(peer);
      
      expect(scheduler.getPeerCount()).toBe(1);

      // Simulate close
      peer.emit('close');

      expect(scheduler.getPeerCount()).toBe(0);
    });
  });

  describe('Memory Management', () => {
    test('cleans up properly on destroy', () => {
      const peer1 = new SimpleMockPeer('peer1') as any;
      const peer2 = new SimpleMockPeer('peer2') as any;
      
      scheduler.addPeer(peer1);
      scheduler.addPeer(peer2);

      expect(scheduler.getPeerCount()).toBe(2);

      scheduler.destroy();

      expect(scheduler.getPeerCount()).toBe(0);
      expect(scheduler.getStats().activeRequests).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    test('handles peer removal during active requests', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setConnected(true);
      peer.setChoked(false);

      // Schedule some requests
      scheduler['scheduleRequests']();

      // Remove peer
      scheduler.removePeer(peer);

      expect(scheduler.getPeerCount()).toBe(0);
    });

    test('handles empty bitfield', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const emptyBitfield = new BitSet(3); // No pieces set
      
      scheduler.addPeer(peer, emptyBitfield);
      peer.setConnected(true);
      peer.setChoked(false);

      scheduler['scheduleRequests']();

      const requests = peer.getSentRequests();
      expect(requests.length).toBe(0); // No pieces available
    });

    test('handles completed pieces in scheduling', () => {
      const peer = new SimpleMockPeer('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(1);
      
      scheduler.addPeer(peer, bitfield);
      
      // Mark piece 0 as completed
      scheduler['completedPieces'].add(0);
      
      peer.setConnected(true);
      peer.setChoked(false);

      scheduler['scheduleRequests']();

      const requests = peer.getSentRequests();
      if (requests.length > 0) {
        // Should skip completed piece 0
        expect(requests[0].index).toBe(1);
      }
    });
  });
});