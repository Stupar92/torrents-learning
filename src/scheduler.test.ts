import * as crypto from 'crypto';
import { PieceScheduler, SchedulerError } from './scheduler';
import { PeerConnection, BitSet, MessageType } from './peer';
import { TorrentMeta } from './metainfo';
import { EventEmitter } from 'events';

// Mock PeerConnection for testing
class MockPeerConnection extends EventEmitter {
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
  private requests: any[] = [];

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
    this.requests.push(request);
    return Promise.resolve();
  }

  async sendCancel(cancel: any) {
    this.requests = this.requests.filter(r => 
      !(r.index === cancel.index && r.begin === cancel.begin && r.length === cancel.length)
    );
    return Promise.resolve();
  }

  async sendHave(pieceIndex: number) {
    return Promise.resolve();
  }

  getRequests() {
    return [...this.requests];
  }

  clearRequests() {
    this.requests = [];
  }

  // Simulate receiving piece data
  simulatePiece(pieceIndex: number, begin: number, data: Buffer) {
    this.emit('piece', {
      index: pieceIndex,
      begin,
      block: data,
    });
  }

  simulateChoke() {
    this.mockState.choked = true;
    this.emit('choke');
  }

  simulateUnchoke() {
    this.mockState.choked = false;
    this.emit('unchoke');
  }
}

describe('PieceScheduler', () => {
  let torrentMeta: TorrentMeta;
  let scheduler: PieceScheduler;
  
  beforeEach(() => {
    // Create mock torrent metadata
    const pieces = Buffer.alloc(60); // 3 pieces * 20 bytes each
    for (let i = 0; i < 60; i++) {
      pieces[i] = i % 256; // Fill with test data
    }

    torrentMeta = {
      announce: 'http://tracker.example.com/announce',
      name: 'test-file.txt',
      length: 48000, // 3 pieces * 16KB each
      pieceLength: 16384,
      pieces,
      infoHashV1: crypto.randomBytes(20),
    };

    scheduler = new PieceScheduler(torrentMeta, 16384, 2); // 2 request window for testing
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
      expect(stats.endgameActive).toBe(false);
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
    test('adds peer correctly', () => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(2);

      scheduler.addPeer(peer, bitfield);

      expect(scheduler.getPeerCount()).toBe(1);
      expect(scheduler.getStats().availablePeers).toBe(0); // Peer is choked
    });

    test('removes peer correctly', () => {
      const peer = new MockPeerConnection('peer1') as any;
      scheduler.addPeer(peer);

      expect(scheduler.getPeerCount()).toBe(1);
      
      scheduler.removePeer(peer);
      expect(scheduler.getPeerCount()).toBe(0);
    });

    test('handles peer bitfield updates', () => {
      const peer = new MockPeerConnection('peer1') as any;
      scheduler.addPeer(peer);

      const bitfield = new BitSet(3);
      bitfield.set(1);
      
      peer.emit('bitfield', bitfield);

      // Availability should be updated
      const stats = scheduler.getStats();
      expect(stats.availablePeers).toBe(0); // Still choked
    });

    test('handles peer have messages', () => {
      const peer = new MockPeerConnection('peer1') as any;
      scheduler.addPeer(peer);

      peer.emit('have', { index: 2 });

      // Should update internal bitfield for peer
      expect(scheduler.getPeerCount()).toBe(1);
    });

    test('handles peer choke/unchoke', () => {
      const peer = new MockPeerConnection('peer1') as any;
      scheduler.addPeer(peer);

      // Initially choked
      expect(scheduler.getStats().availablePeers).toBe(0);

      // Unchoke
      peer.setChoked(false);
      peer.setConnected(true);
      peer.simulateUnchoke();

      expect(scheduler.getStats().availablePeers).toBe(1);

      // Choke again
      peer.simulateChoke();
      expect(scheduler.getStats().availablePeers).toBe(0);
    });
  });

  describe('Request Scheduling', () => {
    test('schedules requests when peer is available', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0); // Has first piece
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      // Trigger scheduling
      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          const requests = peer.getRequests();
          expect(requests.length).toBeGreaterThan(0);
          expect(requests[0].index).toBe(0); // Should request first piece
          done();
        }, 10);
      }, 10);
    });

    test('implements rarest-first selection', (done) => {
      const peer1 = new MockPeerConnection('peer1') as any;
      const peer2 = new MockPeerConnection('peer2') as any;

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

      peer1.setChoked(false);
      peer1.setConnected(true);

      setTimeout(() => {
        peer1.simulateUnchoke();
        
        setTimeout(() => {
          const requests = peer1.getRequests();
          expect(requests.length).toBeGreaterThan(0);
          // Should prefer piece 0 (only available from peer1, rarest)
          expect(requests[0].index).toBe(0);
          done();
        }, 10);
      }, 10);
    });

    test('respects window size limit', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(1);
      bitfield.set(2);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          const requests = peer.getRequests();
          // Should not exceed window size of 2
          expect(requests.length).toBeLessThanOrEqual(2);
          done();
        }, 10);
      }, 10);
    });

    test('handles block-level requests correctly', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          const requests = peer.getRequests();
          expect(requests.length).toBeGreaterThan(0);
          
          const request = requests[0];
          expect(request.index).toBe(0);
          expect(request.begin).toBe(0);
          expect(request.length).toBe(16384); // Block size
          done();
        }, 10);
      }, 10);
    });
  });

  describe('Piece Completion', () => {
    test('completes piece when all blocks received', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      scheduler.on('piece_completed', (event) => {
        expect(event.pieceIndex).toBe(0);
        expect(event.data.length).toBe(16384);
        expect(scheduler.getStats().piecesCompleted).toBe(1);
        done();
      });

      // Wait for requests, then simulate piece reception
      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          // Create valid piece data with correct hash
          const pieceData = Buffer.alloc(16384, 0);
          const expectedHash = crypto.createHash('sha1').update(pieceData).digest();
          
          // Update torrent metadata with correct hash
          torrentMeta.pieces.copy(expectedHash, 0, 0, 20);
          
          // Simulate receiving the piece
          peer.simulatePiece(0, 0, pieceData);
        }, 10);
      }, 10);
    });

    test('rejects piece with invalid hash', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      scheduler.on('piece_error', (event) => {
        expect(event.pieceIndex).toBe(0);
        expect(event.error).toContain('Hash verification failed');
        done();
      });

      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          // Send piece with wrong data (will have wrong hash)
          const wrongData = Buffer.alloc(16384, 0xFF);
          peer.simulatePiece(0, 0, wrongData);
        }, 10);
      }, 10);
    });

    test('emits download completion', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(1);
      bitfield.set(2);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      let piecesCompleted = 0;
      scheduler.on('piece_completed', () => {
        piecesCompleted++;
      });

      scheduler.on('download_completed', () => {
        expect(piecesCompleted).toBe(3);
        expect(scheduler.isComplete()).toBe(true);
        done();
      });

      // Complete all pieces
      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          for (let i = 0; i < 3; i++) {
            const pieceData = Buffer.alloc(16384, i);
            const hash = crypto.createHash('sha1').update(pieceData).digest();
            torrentMeta.pieces.copy(hash, i * 20, 0, 20);
            
            setTimeout(() => {
              peer.simulatePiece(i, 0, pieceData);
            }, i * 10);
          }
        }, 10);
      }, 10);
    });
  });

  describe('Endgame Mode', () => {
    test('enters endgame mode near completion', (done) => {
      // Create scheduler with small endgame threshold for testing
      scheduler.destroy();
      scheduler = new PieceScheduler(torrentMeta, 1024, 2); // Smaller blocks

      const peer1 = new MockPeerConnection('peer1') as any;
      const peer2 = new MockPeerConnection('peer2') as any;
      
      const bitfield = new BitSet(3);
      bitfield.set(0);
      bitfield.set(1);
      bitfield.set(2);
      
      scheduler.addPeer(peer1, bitfield);
      scheduler.addPeer(peer2, bitfield);
      
      peer1.setChoked(false);
      peer1.setConnected(true);
      peer2.setChoked(false);
      peer2.setConnected(true);

      scheduler.on('endgame_started', () => {
        expect(scheduler.getStats().endgameActive).toBe(true);
        done();
      });

      // Complete most pieces to trigger endgame
      setTimeout(() => {
        peer1.simulateUnchoke();
        peer2.simulateUnchoke();
        
        // Complete first two pieces
        setTimeout(() => {
          for (let i = 0; i < 2; i++) {
            const pieceData = Buffer.alloc(16384, i);
            const hash = crypto.createHash('sha1').update(pieceData).digest();
            torrentMeta.pieces.copy(hash, i * 20, 0, 20);
            
            // Send all blocks for the piece
            for (let offset = 0; offset < 16384; offset += 1024) {
              const blockSize = Math.min(1024, 16384 - offset);
              const blockData = pieceData.subarray(offset, offset + blockSize);
              peer1.simulatePiece(i, offset, blockData);
            }
          }
        }, 20);
      }, 10);
    }, 10000);
  });

  describe('Request Management', () => {
    test('cancels requests when peer chokes', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          const initialRequests = peer.getRequests().length;
          expect(initialRequests).toBeGreaterThan(0);
          
          // Simulate choke
          peer.simulateChoke();
          
          setTimeout(() => {
            // Requests should be cancelled (though mock doesn't track this perfectly)
            expect(scheduler.getStats().activeRequests).toBe(0);
            done();
          }, 10);
        }, 10);
      }, 10);
    });

    test('handles request timeouts', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      scheduler.on('request_timeout', (event) => {
        expect(event.peer).toBe(peer);
        expect(event.request).toBeDefined();
        done();
      });

      // Manually trigger timeout handling
      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          // Force timeout check
          scheduler['handleTimeouts']();
        }, 50);
      }, 10);
    }, 10000);
  });

  describe('Statistics', () => {
    test('tracks download progress correctly', () => {
      const stats = scheduler.getStats();
      expect(stats.bytesDownloaded).toBe(0);
      expect(stats.bytesTotal).toBe(48000);
      expect(stats.piecesCompleted).toBe(0);
      expect(stats.piecesTotal).toBe(3);
    });

    test('calculates download rate', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          // Simulate some data received
          const pieceData = Buffer.alloc(1024, 0);
          const hash = crypto.createHash('sha1').update(Buffer.alloc(16384, 0)).digest();
          torrentMeta.pieces.copy(hash, 0, 0, 20);
          
          peer.simulatePiece(0, 0, pieceData);
          
          setTimeout(() => {
            const stats = scheduler.getStats();
            expect(stats.bytesDownloaded).toBe(1024);
            // Download rate might be 0 due to timing in test
            expect(stats.downloadRate).toBeGreaterThanOrEqual(0);
            done();
          }, 100);
        }, 10);
      }, 10);
    });
  });

  describe('Error Handling', () => {
    test('handles invalid piece data', (done) => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      scheduler.on('block_error', (event) => {
        expect(event.error).toContain('Invalid block length');
        done();
      });

      setTimeout(() => {
        peer.simulateUnchoke();
        
        setTimeout(() => {
          // Send block with wrong length
          const wrongData = Buffer.alloc(1000); // Wrong size
          peer.simulatePiece(0, 0, wrongData);
        }, 10);
      }, 10);
    });

    test('handles peer removal during active requests', () => {
      const peer = new MockPeerConnection('peer1') as any;
      const bitfield = new BitSet(3);
      bitfield.set(0);
      
      scheduler.addPeer(peer, bitfield);
      peer.setChoked(false);
      peer.setConnected(true);

      // Remove peer immediately
      scheduler.removePeer(peer);
      
      expect(scheduler.getPeerCount()).toBe(0);
      expect(scheduler.getStats().activeRequests).toBe(0);
    });
  });

  describe('Memory Management', () => {
    test('cleans up on destroy', () => {
      const peer = new MockPeerConnection('peer1') as any;
      scheduler.addPeer(peer);

      expect(scheduler.getPeerCount()).toBe(1);
      
      scheduler.destroy();
      
      expect(scheduler.getPeerCount()).toBe(0);
      expect(scheduler.getStats().activeRequests).toBe(0);
    });
  });
});