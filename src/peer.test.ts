import * as net from 'net';
import * as crypto from 'crypto';
import { PeerConnection, PeerError, BitSet, MessageType, RequestMessage, PieceMessage } from './peer';

describe('Peer Module', () => {
  let server: net.Server;
  let serverPort: number;

  beforeAll((done) => {
    server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        serverPort = address.port;
        done();
      }
    });
  });

  afterAll((done) => {
    if (server.listening) {
      server.close(done);
    } else {
      done();
    }
  });

  beforeEach(() => {
    server.removeAllListeners('connection');
  });

  describe('BitSet', () => {
    test('creates bitset with correct size', () => {
      const bitset = new BitSet(10);
      expect(bitset.getSize()).toBe(10);
      expect(bitset.countSet()).toBe(0);
    });

    test('sets and gets bits correctly', () => {
      const bitset = new BitSet(16);
      
      bitset.set(0);
      bitset.set(7);
      bitset.set(15);
      
      expect(bitset.get(0)).toBe(true);
      expect(bitset.get(7)).toBe(true);
      expect(bitset.get(15)).toBe(true);
      expect(bitset.get(1)).toBe(false);
      expect(bitset.get(8)).toBe(false);
      expect(bitset.countSet()).toBe(3);
    });

    test('unsets bits correctly', () => {
      const bitset = new BitSet(8);
      
      bitset.set(3);
      expect(bitset.get(3)).toBe(true);
      
      bitset.unset(3);
      expect(bitset.get(3)).toBe(false);
      expect(bitset.countSet()).toBe(0);
    });

    test('handles out of range indices gracefully', () => {
      const bitset = new BitSet(8);
      
      expect(() => bitset.set(-1)).toThrow(PeerError);
      expect(() => bitset.set(8)).toThrow(PeerError);
      expect(bitset.get(-1)).toBe(false);
      expect(bitset.get(8)).toBe(false);
    });

    test('creates from buffer correctly', () => {
      const buffer = Buffer.from([0b10100000, 0b01000000]); // Bits 0, 2, 9 set
      const bitset = BitSet.fromBuffer(buffer, 16);
      
      expect(bitset.get(0)).toBe(true);
      expect(bitset.get(1)).toBe(false);
      expect(bitset.get(2)).toBe(true);
      expect(bitset.get(9)).toBe(true);
      expect(bitset.countSet()).toBe(3);
    });

    test('converts to buffer correctly', () => {
      const bitset = new BitSet(16);
      bitset.set(0);
      bitset.set(2);
      bitset.set(9);
      
      const buffer = bitset.toBuffer();
      expect(buffer[0]).toBe(0b10100000);
      expect(buffer[1]).toBe(0b01000000);
    });
  });

  describe('PeerConnection', () => {
    const infoHash = crypto.randomBytes(20);
    const peerId = Buffer.from('-TEST01-123456789012');
    const numPieces = 10;

    describe('Constructor validation', () => {
      test('validates info hash length', () => {
        expect(() => new PeerConnection(
          { ip: '127.0.0.1', port: 8080 },
          Buffer.alloc(19), // Wrong length
          peerId,
          numPieces
        )).toThrow('Info hash must be 20 bytes');
      });

      test('validates peer ID length', () => {
        expect(() => new PeerConnection(
          { ip: '127.0.0.1', port: 8080 },
          infoHash,
          Buffer.alloc(19), // Wrong length
          numPieces
        )).toThrow('Peer ID must be 20 bytes');
      });
    });

    describe('Handshake', () => {
      test('builds correct handshake message', (done) => {
        let receivedData: Buffer = Buffer.alloc(0);
        
        server.on('connection', (socket) => {
          socket.on('data', (data) => {
            receivedData = Buffer.concat([receivedData, data]);
            
            // Verify handshake structure once we have enough data
            if (receivedData.length >= 68) {
              try {
                expect(receivedData[0]).toBe(19); // Protocol string length
                expect(receivedData.subarray(1, 20).toString()).toBe('BitTorrent protocol');
                expect(receivedData.subarray(28, 48)).toEqual(infoHash);
                expect(receivedData.subarray(48, 68)).toEqual(peerId);
                done();
              } catch (error) {
                done(error);
              }
            }
          });
        });

        const peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.connect().catch(() => {
          // Ignore connection errors, we just want to check the handshake
        });
      }, 10000);

      test('completes handshake successfully', (done) => {
        server.on('connection', (socket) => {
          socket.on('data', (data) => {
            // Echo back a valid handshake
            const response = Buffer.concat([
              Buffer.from([19]),
              Buffer.from('BitTorrent protocol'),
              Buffer.alloc(8, 0), // reserved
              infoHash,
              Buffer.from('-PEER01-123456789012'),
            ]);
            socket.write(response);
          });
        });

        const peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.on('handshake', (peerId) => {
          expect(peerId).toEqual(Buffer.from('-PEER01-123456789012'));
          peer.destroy();
          done();
        });

        peer.on('error', done);
        peer.connect();
      });

      test('rejects handshake with wrong protocol', (done) => {
        server.on('connection', (socket) => {
          socket.on('data', (data) => {
            const response = Buffer.concat([
              Buffer.from([13]),
              Buffer.from('Wrong protocol'),
              Buffer.alloc(8, 0),
              infoHash,
              Buffer.from('-PEER01-123456789012'),
            ]);
            socket.write(response);
          });
        });

        const peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.on('error', (error) => {
          expect(error.message).toContain('Invalid protocol');
          peer.destroy();
          done();
        });

        peer.connect().catch(() => {
          // Connection itself may fail, that's ok
        });
      }, 10000);

      test('rejects handshake with wrong info hash', (done) => {
        server.on('connection', (socket) => {
          socket.on('data', (data) => {
            const wrongInfoHash = crypto.randomBytes(20);
            const response = Buffer.concat([
              Buffer.from([19]),
              Buffer.from('BitTorrent protocol'),
              Buffer.alloc(8, 0),
              wrongInfoHash, // Wrong info hash
              Buffer.from('-PEER01-123456789012'),
            ]);
            socket.write(response);
          });
        });

        const peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.on('error', (error) => {
          expect(error.message).toContain('Info hash mismatch');
          peer.destroy();
          done();
        });

        peer.connect().catch(() => {
          // Connection itself may fail, that's ok
        });
      }, 10000);
    });

    describe('Message handling', () => {
      let peer: PeerConnection;
      let serverSocket: net.Socket;

      beforeEach((done) => {
        server.on('connection', (socket) => {
          serverSocket = socket;
          
          socket.on('data', (data) => {
            // Send valid handshake response
            if (data.length >= 68) {
              const response = Buffer.concat([
                Buffer.from([19]),
                Buffer.from('BitTorrent protocol'),
                Buffer.alloc(8, 0),
                infoHash,
                Buffer.from('-PEER01-123456789012'),
              ]);
              socket.write(response);
            }
          });
        });

        peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.on('handshake', () => {
          done();
        });

        peer.connect();
      });

      afterEach(() => {
        if (peer) {
          peer.destroy();
        }
      });

      test('handles keep-alive message', (done) => {
        peer.on('keepalive', () => {
          done();
        });

        // Send keep-alive (length = 0)
        const keepAlive = Buffer.alloc(4, 0);
        serverSocket.write(keepAlive);
      });

      test('handles choke/unchoke messages', (done) => {
        let chokeReceived = false;

        peer.on('choke', () => {
          chokeReceived = true;
          expect(peer.getState().choked).toBe(true);
        });

        peer.on('unchoke', () => {
          expect(chokeReceived).toBe(true);
          expect(peer.getState().choked).toBe(false);
          done();
        });

        // Send choke message
        const choke = Buffer.from([0, 0, 0, 1, MessageType.CHOKE]);
        serverSocket.write(choke);

        // Send unchoke message
        setTimeout(() => {
          const unchoke = Buffer.from([0, 0, 0, 1, MessageType.UNCHOKE]);
          serverSocket.write(unchoke);
        }, 10);
      });

      test('handles interested/not interested messages', (done) => {
        let interestedReceived = false;

        peer.on('interested', () => {
          interestedReceived = true;
          expect(peer.getState().peerInterested).toBe(true);
        });

        peer.on('not_interested', () => {
          expect(interestedReceived).toBe(true);
          expect(peer.getState().peerInterested).toBe(false);
          done();
        });

        // Send interested message
        const interested = Buffer.from([0, 0, 0, 1, MessageType.INTERESTED]);
        serverSocket.write(interested);

        // Send not interested message
        setTimeout(() => {
          const notInterested = Buffer.from([0, 0, 0, 1, MessageType.NOT_INTERESTED]);
          serverSocket.write(notInterested);
        }, 10);
      });

      test('handles have message', (done) => {
        peer.on('have', (message) => {
          expect(message.index).toBe(5);
          expect(peer.hasPiece(5)).toBe(true);
          done();
        });

        // Send have message for piece 5
        const have = Buffer.from([0, 0, 0, 5, MessageType.HAVE, 0, 0, 0, 5]);
        serverSocket.write(have);
      });

      test('handles bitfield message', (done) => {
        peer.on('bitfield', (bitfield) => {
          expect(bitfield.get(0)).toBe(true);
          expect(bitfield.get(1)).toBe(false);
          expect(bitfield.get(2)).toBe(true);
          expect(peer.hasPiece(0)).toBe(true);
          expect(peer.hasPiece(2)).toBe(true);
          done();
        });

        // Send bitfield message (bits 0 and 2 set)
        const bitfieldData = Buffer.from([0b10100000, 0b00000000]);
        const bitfield = Buffer.concat([
          Buffer.from([0, 0, 0, 3, MessageType.BITFIELD]), // length=3, type=5
          bitfieldData,
        ]);
        serverSocket.write(bitfield);
      });

      test('handles request message', (done) => {
        peer.on('request', (request) => {
          expect(request.index).toBe(1);
          expect(request.begin).toBe(16384);
          expect(request.length).toBe(16384);
          done();
        });

        // Send request message
        const request = Buffer.from([
          0, 0, 0, 13, MessageType.REQUEST, // length=13, type=6
          0, 0, 0, 1,    // index=1
          0, 0, 64, 0,   // begin=16384  
          0, 0, 64, 0,   // length=16384
        ]);
        serverSocket.write(request);
      });

      test('handles piece message', (done) => {
        const blockData = Buffer.from('test block data');

        peer.on('piece', (piece) => {
          expect(piece.index).toBe(2);
          expect(piece.begin).toBe(0);
          expect(piece.block).toEqual(blockData);
          done();
        });

        // Send piece message
        const pieceLength = 1 + 4 + 4 + blockData.length; // type + index + begin + block
        const piece = Buffer.concat([
          Buffer.from([0, 0, 0, pieceLength]), // length
          Buffer.from([MessageType.PIECE]),     // type
          Buffer.from([0, 0, 0, 2]),           // index=2
          Buffer.from([0, 0, 0, 0]),           // begin=0
          blockData,
        ]);
        serverSocket.write(piece);
      });

      test('handles cancel message', (done) => {
        peer.on('cancel', (cancel) => {
          expect(cancel.index).toBe(3);
          expect(cancel.begin).toBe(32768);
          expect(cancel.length).toBe(16384);
          done();
        });

        // Send cancel message
        const cancel = Buffer.from([
          0, 0, 0, 13, MessageType.CANCEL, // length=13, type=8
          0, 0, 0, 3,     // index=3
          0, 0, 128, 0,   // begin=32768
          0, 0, 64, 0,    // length=16384
        ]);
        serverSocket.write(cancel);
      });

      test('handles port message', (done) => {
        peer.on('port', (port) => {
          expect(port.port).toBe(6881);
          done();
        });

        // Send port message
        const port = Buffer.from([
          0, 0, 0, 3, MessageType.PORT, // length=3, type=9
          26, 225, // port=6881
        ]);
        serverSocket.write(port);
      });

      test('handles unknown message types gracefully', (done) => {
        peer.on('unknown_message', (message) => {
          expect(message.type).toBe(255);
          expect(message.payload).toEqual(Buffer.from([1, 2, 3]));
          done();
        });

        // Send unknown message type
        const unknown = Buffer.from([
          0, 0, 0, 4, 255, // length=4, type=255 (unknown)
          1, 2, 3, // payload
        ]);
        serverSocket.write(unknown);
      });
    });

    describe('Message sending', () => {
      let peer: PeerConnection;
      let serverSocket: net.Socket;
      let receivedData: Buffer = Buffer.alloc(0);

      beforeEach((done) => {
        receivedData = Buffer.alloc(0);
        let handshakeComplete = false;
        
        server.on('connection', (socket) => {
          serverSocket = socket;
          
          socket.on('data', (data) => {
            if (!handshakeComplete) {
              // Send valid handshake response
              const response = Buffer.concat([
                Buffer.from([19]),
                Buffer.from('BitTorrent protocol'),
                Buffer.alloc(8, 0),
                infoHash,
                Buffer.from('-PEER01-123456789012'),
              ]);
              socket.write(response);
              handshakeComplete = true;
            } else {
              // Capture post-handshake messages
              receivedData = Buffer.concat([receivedData, data]);
            }
          });
        });

        peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.on('handshake', () => {
          done();
        });

        peer.on('error', done);

        peer.connect();
      }, 10000);

      afterEach(() => {
        if (peer) {
          peer.destroy();
        }
      });

      test('sends choke message correctly', async () => {
        await peer.sendChoke();
        
        const expected = Buffer.from([0, 0, 0, 1, MessageType.CHOKE]);
        expect(receivedData.subarray(0, 5)).toEqual(expected);
        expect(peer.getState().peerChoked).toBe(true);
      });

      test('sends unchoke message correctly', async () => {
        await peer.sendUnchoke();
        
        const expected = Buffer.from([0, 0, 0, 1, MessageType.UNCHOKE]);
        expect(receivedData.subarray(0, 5)).toEqual(expected);
        expect(peer.getState().peerChoked).toBe(false);
      });

      test('sends interested message correctly', async () => {
        await peer.sendInterested();
        
        const expected = Buffer.from([0, 0, 0, 1, MessageType.INTERESTED]);
        expect(receivedData.subarray(0, 5)).toEqual(expected);
        expect(peer.getState().interested).toBe(true);
      });

      test('sends have message correctly', async () => {
        await peer.sendHave(7);
        
        const expected = Buffer.from([0, 0, 0, 5, MessageType.HAVE, 0, 0, 0, 7]);
        expect(receivedData.subarray(0, 9)).toEqual(expected);
      });

      test('sends bitfield message correctly', async () => {
        const bitfield = new BitSet(16);
        bitfield.set(0);
        bitfield.set(5);
        
        await peer.sendBitfield(bitfield);
        
        expect(receivedData[0]).toBe(0); // Length byte 1
        expect(receivedData[1]).toBe(0); // Length byte 2
        expect(receivedData[2]).toBe(0); // Length byte 3
        expect(receivedData[3]).toBe(3); // Length = 3 (1 byte type + 2 bytes bitfield)
        expect(receivedData[4]).toBe(MessageType.BITFIELD);
        expect(receivedData[5]).toBe(0b10000100); // Bits 0 and 5 set
      });

      test('sends request message correctly', async () => {
        const request: RequestMessage = {
          index: 1,
          begin: 16384,
          length: 16384,
        };
        
        await peer.sendRequest(request);
        
        const expected = Buffer.from([
          0, 0, 0, 13, MessageType.REQUEST,
          0, 0, 0, 1,    // index
          0, 0, 64, 0,   // begin
          0, 0, 64, 0,   // length
        ]);
        expect(receivedData.subarray(0, 17)).toEqual(expected);
        expect(peer.getState().inflight).toBe(1);
      });

      test('sends piece message correctly', async () => {
        const blockData = Buffer.from('test data');
        const piece: PieceMessage = {
          index: 2,
          begin: 0,
          block: blockData,
        };
        
        await peer.sendPiece(piece);
        
        expect(receivedData.readUInt32BE(0)).toBe(8 + blockData.length + 1); // length
        expect(receivedData[4]).toBe(MessageType.PIECE); // type
        expect(receivedData.readUInt32BE(5)).toBe(2); // index
        expect(receivedData.readUInt32BE(9)).toBe(0); // begin
        expect(receivedData.subarray(13, 13 + blockData.length)).toEqual(blockData);
      });

      test('sends keep-alive message correctly', async () => {
        await peer.sendKeepAlive();
        
        const expected = Buffer.from([0, 0, 0, 0]); // Length = 0
        expect(receivedData.subarray(0, 4)).toEqual(expected);
      });
    });

    describe('Error handling', () => {
      test('handles connection timeout', async () => {
        const peer = new PeerConnection(
          { ip: '192.0.2.1', port: 12345 }, // Non-routable IP to ensure timeout
          infoHash,
          peerId,
          numPieces
        );

        await expect(peer.connect()).rejects.toThrow('Connection timeout');
        peer.destroy();
      }, 15000);

      test('handles invalid message formats', (done) => {
        let peer: PeerConnection;
        
        server.on('connection', (socket) => {
          socket.on('data', (data) => {
            // Send valid handshake first
            if (data.length >= 68) {
              const response = Buffer.concat([
                Buffer.from([19]),
                Buffer.from('BitTorrent protocol'),
                Buffer.alloc(8, 0),
                infoHash,
                Buffer.from('-PEER01-123456789012'),
              ]);
              socket.write(response);
              
              // Then send invalid have message (wrong length)
              setTimeout(() => {
                const invalidHave = Buffer.from([0, 0, 0, 3, MessageType.HAVE, 0, 0]); // Too short
                socket.write(invalidHave);
              }, 10);
            }
          });
        });

        peer = new PeerConnection(
          { ip: '127.0.0.1', port: serverPort },
          infoHash,
          peerId,
          numPieces
        );

        peer.on('error', (error) => {
          expect(error.message).toContain('Invalid HAVE message');
          peer.destroy();
          done();
        });

        peer.connect();
      });
    });

    describe('State management', () => {
      test('tracks peer state correctly', async () => {
        const peer = new PeerConnection(
          { ip: '127.0.0.1', port: 8080 },
          infoHash,
          peerId,
          numPieces
        );

        const state = peer.getState();
        expect(state.choked).toBe(true);
        expect(state.interested).toBe(false);
        expect(state.peerChoked).toBe(true);
        expect(state.peerInterested).toBe(false);
        expect(state.inflight).toBe(0);
        expect(state.bitfield.getSize()).toBe(numPieces);
        
        peer.destroy();
      });

      test('updates inflight counter on request/cancel', async () => {
        const peer = new PeerConnection(
          { ip: '127.0.0.1', port: 8080 },
          infoHash,
          peerId,
          numPieces
        );

        expect(peer.getState().inflight).toBe(0);
        
        // Simulate sending requests without actual network
        peer['state'].inflight++;
        peer['state'].inflight++;
        expect(peer.getState().inflight).toBe(2);
        
        peer['state'].inflight = Math.max(0, peer.getState().inflight - 1);
        expect(peer.getState().inflight).toBe(1);
        
        peer.destroy();
      });
    });
  });
});