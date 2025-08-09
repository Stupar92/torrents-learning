import * as crypto from 'crypto';
import { PeerConnection, PeerError, BitSet, MessageType } from './peer';

describe('Peer Module - Core Functionality', () => {
  const infoHash = crypto.randomBytes(20);
  const peerId = Buffer.from('-TEST01-123456789012');
  const numPieces = 10;

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

  describe('PeerConnection Constructor', () => {
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

    test('creates peer with valid parameters', () => {
      const peer = new PeerConnection(
        { ip: '127.0.0.1', port: 8080 },
        infoHash,
        peerId,
        numPieces
      );

      expect(peer.getPeerInfo()).toEqual({ ip: '127.0.0.1', port: 8080 });
      expect(peer.getState().bitfield.getSize()).toBe(numPieces);
      expect(peer.isConnected()).toBe(false);
      
      peer.destroy();
    });
  });

  describe('Message Building', () => {
    let peer: PeerConnection;

    beforeEach(() => {
      peer = new PeerConnection(
        { ip: '127.0.0.1', port: 8080 },
        infoHash,
        peerId,
        numPieces
      );
    });

    afterEach(() => {
      peer.destroy();
    });

    test('builds correct handshake', () => {
      // Access private method for testing
      const handshake = peer['buildHandshake']();
      
      expect(handshake.length).toBe(68);
      expect(handshake[0]).toBe(19); // Protocol string length
      expect(handshake.subarray(1, 20).toString()).toBe('BitTorrent protocol');
      expect(handshake.subarray(20, 28)).toEqual(Buffer.alloc(8, 0)); // Reserved
      expect(handshake.subarray(28, 48)).toEqual(infoHash);
      expect(handshake.subarray(48, 68)).toEqual(peerId);
    });
  });

  describe('Message Parsing', () => {
    let peer: PeerConnection;

    beforeEach(() => {
      peer = new PeerConnection(
        { ip: '127.0.0.1', port: 8080 },
        infoHash,
        peerId,
        numPieces
      );
    });

    afterEach(() => {
      peer.destroy();
    });

    test('parses handshake correctly', () => {
      const validHandshake = Buffer.concat([
        Buffer.from([19]),
        Buffer.from('BitTorrent protocol'),
        Buffer.alloc(8, 0), // reserved
        infoHash,
        Buffer.from('-PEER01-123456789012'),
      ]);

      // Access private method for testing
      expect(() => peer['parseHandshake'](validHandshake)).not.toThrow();
      expect(peer.getState().id).toEqual(Buffer.from('-PEER01-123456789012'));
    });

    test('rejects invalid protocol', () => {
      const invalidHandshake = Buffer.concat([
        Buffer.from([13]),
        Buffer.from('Wrong protocol'),
        Buffer.alloc(8, 0),
        infoHash,
        Buffer.from('-PEER01-123456789012'),
      ]);

      expect(() => peer['parseHandshake'](invalidHandshake)).toThrow('Invalid protocol');
    });

    test('rejects wrong info hash', () => {
      const wrongInfoHash = crypto.randomBytes(20);
      const invalidHandshake = Buffer.concat([
        Buffer.from([19]),
        Buffer.from('BitTorrent protocol'),
        Buffer.alloc(8, 0),
        wrongInfoHash,
        Buffer.from('-PEER01-123456789012'),
      ]);

      expect(() => peer['parseHandshake'](invalidHandshake)).toThrow('Info hash mismatch');
    });

    test('parses choke message', () => {
      const chokeMessage = peer['parseMessage'](Buffer.from([MessageType.CHOKE]));
      expect(chokeMessage.type).toBe(MessageType.CHOKE);
      expect(chokeMessage.payload).toBeUndefined();
    });

    test('parses have message', () => {
      const payload = Buffer.alloc(4);
      payload.writeUInt32BE(5, 0);
      const haveMessage = peer['parseMessage'](Buffer.concat([Buffer.from([MessageType.HAVE]), payload]));
      
      expect(haveMessage.type).toBe(MessageType.HAVE);
      expect(haveMessage.payload).toEqual(payload);
    });

    test('parses request message', () => {
      const payload = Buffer.alloc(12);
      payload.writeUInt32BE(1, 0);  // index
      payload.writeUInt32BE(16384, 4);  // begin
      payload.writeUInt32BE(16384, 8);  // length
      
      const requestMessage = peer['parseMessage'](Buffer.concat([Buffer.from([MessageType.REQUEST]), payload]));
      
      expect(requestMessage.type).toBe(MessageType.REQUEST);
      expect(requestMessage.payload).toEqual(payload);
    });
  });

  describe('State Management', () => {
    let peer: PeerConnection;

    beforeEach(() => {
      peer = new PeerConnection(
        { ip: '127.0.0.1', port: 8080 },
        infoHash,
        peerId,
        numPieces
      );
    });

    afterEach(() => {
      peer.destroy();
    });

    test('tracks peer state correctly', () => {
      const state = peer.getState();
      expect(state.choked).toBe(true);
      expect(state.interested).toBe(false);
      expect(state.peerChoked).toBe(true);
      expect(state.peerInterested).toBe(false);
      expect(state.inflight).toBe(0);
      expect(state.bitfield.getSize()).toBe(numPieces);
    });

    test('updates state on message handling', () => {
      // Simulate receiving choke message
      peer['handleMessage']({ type: MessageType.CHOKE });
      expect(peer.getState().choked).toBe(true);

      // Simulate receiving unchoke message  
      peer['handleMessage']({ type: MessageType.UNCHOKE });
      expect(peer.getState().choked).toBe(false);

      // Simulate receiving interested message
      peer['handleMessage']({ type: MessageType.INTERESTED });
      expect(peer.getState().peerInterested).toBe(true);

      // Simulate receiving have message
      const havePayload = Buffer.alloc(4);
      havePayload.writeUInt32BE(5, 0);
      peer['handleMessage']({ type: MessageType.HAVE, payload: havePayload });
      expect(peer.hasPiece(5)).toBe(true);
    });

    test('handles bitfield message', () => {
      const bitfieldBuffer = Buffer.from([0b10100000, 0b01000000]); // Bits 0, 2, 9 set
      peer['handleMessage']({ type: MessageType.BITFIELD, payload: bitfieldBuffer });
      
      expect(peer.hasPiece(0)).toBe(true);
      expect(peer.hasPiece(1)).toBe(false);
      expect(peer.hasPiece(2)).toBe(true);
      expect(peer.hasPiece(9)).toBe(true);
    });
  });
});