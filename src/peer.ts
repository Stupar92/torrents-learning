import * as net from 'net';
import { EventEmitter } from 'events';

export class PeerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerError';
  }
}

export interface PeerInfo {
  ip: string;
  port: number;
}

export interface PeerState {
  id?: Buffer;               // their peer_id if sent
  choked: boolean;          // we are choked by peer
  interested: boolean;      // we are interested in peer
  peerChoked: boolean;      // peer is choked by us
  peerInterested: boolean;  // peer is interested in us
  bitfield: BitSet;         // piece availability
  inflight: number;         // requests in flight
  socket?: net.Socket;
  throughput: { downBps: number; upBps: number };
  lastActive: number;       // ms
}

export class BitSet {
  private bits: Buffer;
  private size: number;

  constructor(size: number) {
    this.size = size;
    this.bits = Buffer.alloc(Math.ceil(size / 8), 0);
  }

  static fromBuffer(buffer: Buffer, size: number): BitSet {
    const bitset = new BitSet(size);
    // Copy only the needed bytes
    const neededBytes = Math.ceil(size / 8);
    buffer.copy(bitset.bits, 0, 0, Math.min(buffer.length, neededBytes));
    return bitset;
  }

  set(index: number): void {
    if (index < 0 || index >= this.size) {
      throw new PeerError(`Bit index ${index} out of range [0, ${this.size})`);
    }
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8); // Most significant bit first
    this.bits[byteIndex] |= (1 << bitIndex);
  }

  unset(index: number): void {
    if (index < 0 || index >= this.size) {
      throw new PeerError(`Bit index ${index} out of range [0, ${this.size})`);
    }
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    this.bits[byteIndex] &= ~(1 << bitIndex);
  }

  get(index: number): boolean {
    if (index < 0 || index >= this.size) {
      return false;
    }
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    return (this.bits[byteIndex] & (1 << bitIndex)) !== 0;
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bits);
  }

  getSize(): number {
    return this.size;
  }

  countSet(): number {
    let count = 0;
    for (let i = 0; i < this.size; i++) {
      if (this.get(i)) count++;
    }
    return count;
  }
}

export enum MessageType {
  CHOKE = 0,
  UNCHOKE = 1,
  INTERESTED = 2,
  NOT_INTERESTED = 3,
  HAVE = 4,
  BITFIELD = 5,
  REQUEST = 6,
  PIECE = 7,
  CANCEL = 8,
  PORT = 9,
}

export interface WireMessage {
  type: MessageType;
  payload?: Buffer;
}

export interface RequestMessage {
  index: number;
  begin: number;
  length: number;
}

export interface PieceMessage {
  index: number;
  begin: number;
  block: Buffer;
}

export interface CancelMessage {
  index: number;
  begin: number;
  length: number;
}

export interface HaveMessage {
  index: number;
}

export interface PortMessage {
  port: number;
}

export class PeerConnection extends EventEmitter {
  private static readonly PROTOCOL_STRING = 'BitTorrent protocol';
  private static readonly HANDSHAKE_LENGTH = 68;
  private static readonly KEEPALIVE_INTERVAL = 120000; // 2 minutes
  private static readonly MESSAGE_TIMEOUT = 30000; // 30 seconds

  private socket: net.Socket;
  private state: PeerState;
  private infoHash: Buffer;
  private peerId: Buffer;
  private handshakeComplete = false;
  private messageBuffer = Buffer.alloc(0);
  private keepAliveTimer?: NodeJS.Timeout;
  private lastMessageTime = Date.now();

  constructor(
    private readonly peerInfo: PeerInfo,
    infoHash: Buffer,
    peerId: Buffer,
    numPieces: number,
    socket?: net.Socket
  ) {
    super();
    
    if (infoHash.length !== 20) {
      throw new PeerError('Info hash must be 20 bytes');
    }
    
    if (peerId.length !== 20) {
      throw new PeerError('Peer ID must be 20 bytes');
    }

    this.infoHash = infoHash;
    this.peerId = peerId;
    this.socket = socket || new net.Socket();
    
    this.state = {
      choked: true,
      interested: false,
      peerChoked: true,
      peerInterested: false,
      bitfield: new BitSet(numPieces),
      inflight: 0,
      socket: this.socket,
      throughput: { downBps: 0, upBps: 0 },
      lastActive: Date.now(),
    };

    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    this.socket.on('data', this.handleData.bind(this));
    this.socket.on('error', this.handleError.bind(this));
    this.socket.on('close', this.handleClose.bind(this));
    this.socket.on('timeout', this.handleTimeout.bind(this));
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket.destroy();
        reject(new PeerError('Connection timeout'));
      }, 10000); // 10 second connection timeout

      this.socket.connect(this.peerInfo.port, this.peerInfo.ip, () => {
        clearTimeout(timeout);
        this.sendHandshake()
          .then(() => resolve())
          .catch(reject);
      });

      this.socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new PeerError(`Connection failed: ${error.message}`));
      });
    });
  }

  private async sendHandshake(): Promise<void> {
    const handshake = this.buildHandshake();
    
    return new Promise((resolve, reject) => {
      this.socket.write(handshake, (error) => {
        if (error) {
          reject(new PeerError(`Failed to send handshake: ${error.message}`));
        } else {
          this.startKeepAlive();
          resolve();
        }
      });
    });
  }

  private buildHandshake(): Buffer {
    const protocolLength = Buffer.from([PeerConnection.PROTOCOL_STRING.length]);
    const protocol = Buffer.from(PeerConnection.PROTOCOL_STRING);
    const reserved = Buffer.alloc(8, 0); // All zeros for now
    
    return Buffer.concat([
      protocolLength,
      protocol,
      reserved,
      this.infoHash,
      this.peerId,
    ]);
  }

  private handleData(data: Buffer): void {
    this.messageBuffer = Buffer.concat([this.messageBuffer, data]);
    this.lastMessageTime = Date.now();
    this.state.lastActive = Date.now();

    if (!this.handshakeComplete) {
      this.processHandshake();
    } else {
      this.processMessages();
    }
  }

  private processHandshake(): void {
    if (this.messageBuffer.length < PeerConnection.HANDSHAKE_LENGTH) {
      return; // Wait for more data
    }

    try {
      this.parseHandshake(this.messageBuffer.subarray(0, PeerConnection.HANDSHAKE_LENGTH));
      this.messageBuffer = this.messageBuffer.subarray(PeerConnection.HANDSHAKE_LENGTH);
      this.handshakeComplete = true;
      
      this.emit('handshake', this.state.id);
      
      // Process any remaining data as messages
      if (this.messageBuffer.length > 0) {
        this.processMessages();
      }
    } catch (error) {
      this.emit('error', error);
    }
  }

  private parseHandshake(handshake: Buffer): void {
    let offset = 0;

    // Protocol string length
    const protocolLength = handshake[offset];
    offset++;

    // Protocol string
    const protocol = handshake.subarray(offset, offset + protocolLength).toString();
    offset += protocolLength;

    if (protocol !== PeerConnection.PROTOCOL_STRING) {
      throw new PeerError(`Invalid protocol: ${protocol}`);
    }

    // Reserved bytes (skip)
    const reserved = handshake.subarray(offset, offset + 8);
    offset += 8;

    // Info hash
    const receivedInfoHash = handshake.subarray(offset, offset + 20);
    offset += 20;

    if (!receivedInfoHash.equals(this.infoHash)) {
      throw new PeerError('Info hash mismatch');
    }

    // Peer ID
    this.state.id = handshake.subarray(offset, offset + 20);
  }

  private processMessages(): void {
    while (this.messageBuffer.length >= 4) {
      // Read message length (4 bytes, big-endian)
      const messageLength = this.messageBuffer.readUInt32BE(0);
      
      if (messageLength === 0) {
        // Keep-alive message
        this.messageBuffer = this.messageBuffer.subarray(4);
        this.emit('keepalive');
        continue;
      }

      // Check if we have the complete message
      if (this.messageBuffer.length < 4 + messageLength) {
        break; // Wait for more data
      }

      // Extract the message
      const messageData = this.messageBuffer.subarray(4, 4 + messageLength);
      this.messageBuffer = this.messageBuffer.subarray(4 + messageLength);

      try {
        const message = this.parseMessage(messageData);
        this.handleMessage(message);
      } catch (error) {
        this.emit('error', error);
        return;
      }
    }
  }

  private parseMessage(data: Buffer): WireMessage {
    if (data.length === 0) {
      throw new PeerError('Empty message data');
    }

    const type = data[0] as MessageType;
    const payload = data.length > 1 ? data.subarray(1) : undefined;

    return { type, payload };
  }

  private handleMessage(message: WireMessage): void {
    switch (message.type) {
      case MessageType.CHOKE:
        this.state.choked = true;
        this.emit('choke');
        break;

      case MessageType.UNCHOKE:
        this.state.choked = false;
        this.emit('unchoke');
        break;

      case MessageType.INTERESTED:
        this.state.peerInterested = true;
        this.emit('interested');
        break;

      case MessageType.NOT_INTERESTED:
        this.state.peerInterested = false;
        this.emit('not_interested');
        break;

      case MessageType.HAVE:
        if (!message.payload || message.payload.length !== 4) {
          throw new PeerError('Invalid HAVE message');
        }
        const pieceIndex = message.payload.readUInt32BE(0);
        this.state.bitfield.set(pieceIndex);
        this.emit('have', { index: pieceIndex });
        break;

      case MessageType.BITFIELD:
        if (!message.payload) {
          throw new PeerError('Invalid BITFIELD message');
        }
        this.state.bitfield = BitSet.fromBuffer(message.payload, this.state.bitfield.getSize());
        this.emit('bitfield', this.state.bitfield);
        break;

      case MessageType.REQUEST:
        if (!message.payload || message.payload.length !== 12) {
          throw new PeerError('Invalid REQUEST message');
        }
        const request: RequestMessage = {
          index: message.payload.readUInt32BE(0),
          begin: message.payload.readUInt32BE(4),
          length: message.payload.readUInt32BE(8),
        };
        this.emit('request', request);
        break;

      case MessageType.PIECE:
        if (!message.payload || message.payload.length < 8) {
          throw new PeerError('Invalid PIECE message');
        }
        const piece: PieceMessage = {
          index: message.payload.readUInt32BE(0),
          begin: message.payload.readUInt32BE(4),
          block: message.payload.subarray(8),
        };
        this.emit('piece', piece);
        break;

      case MessageType.CANCEL:
        if (!message.payload || message.payload.length !== 12) {
          throw new PeerError('Invalid CANCEL message');
        }
        const cancel: CancelMessage = {
          index: message.payload.readUInt32BE(0),
          begin: message.payload.readUInt32BE(4),
          length: message.payload.readUInt32BE(8),
        };
        this.emit('cancel', cancel);
        break;

      case MessageType.PORT:
        if (!message.payload || message.payload.length !== 2) {
          throw new PeerError('Invalid PORT message');
        }
        const port: PortMessage = {
          port: message.payload.readUInt16BE(0),
        };
        this.emit('port', port);
        break;

      default:
        // Unknown message type - ignore for forward compatibility
        this.emit('unknown_message', { type: message.type, payload: message.payload });
        break;
    }
  }

  // Public API for sending messages
  async sendChoke(): Promise<void> {
    this.state.peerChoked = true;
    return this.sendMessage(MessageType.CHOKE);
  }

  async sendUnchoke(): Promise<void> {
    this.state.peerChoked = false;
    return this.sendMessage(MessageType.UNCHOKE);
  }

  async sendInterested(): Promise<void> {
    this.state.interested = true;
    return this.sendMessage(MessageType.INTERESTED);
  }

  async sendNotInterested(): Promise<void> {
    this.state.interested = false;
    return this.sendMessage(MessageType.NOT_INTERESTED);
  }

  async sendHave(pieceIndex: number): Promise<void> {
    const payload = Buffer.alloc(4);
    payload.writeUInt32BE(pieceIndex, 0);
    return this.sendMessage(MessageType.HAVE, payload);
  }

  async sendBitfield(bitfield: BitSet): Promise<void> {
    return this.sendMessage(MessageType.BITFIELD, bitfield.toBuffer());
  }

  async sendRequest(request: RequestMessage): Promise<void> {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(request.index, 0);
    payload.writeUInt32BE(request.begin, 4);
    payload.writeUInt32BE(request.length, 8);
    this.state.inflight++;
    return this.sendMessage(MessageType.REQUEST, payload);
  }

  async sendPiece(piece: PieceMessage): Promise<void> {
    const payload = Buffer.alloc(8 + piece.block.length);
    payload.writeUInt32BE(piece.index, 0);
    payload.writeUInt32BE(piece.begin, 4);
    piece.block.copy(payload, 8);
    return this.sendMessage(MessageType.PIECE, payload);
  }

  async sendCancel(cancel: CancelMessage): Promise<void> {
    const payload = Buffer.alloc(12);
    payload.writeUInt32BE(cancel.index, 0);
    payload.writeUInt32BE(cancel.begin, 4);
    payload.writeUInt32BE(cancel.length, 8);
    this.state.inflight = Math.max(0, this.state.inflight - 1);
    return this.sendMessage(MessageType.CANCEL, payload);
  }

  async sendPort(port: number): Promise<void> {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(port, 0);
    return this.sendMessage(MessageType.PORT, payload);
  }

  private async sendMessage(type: MessageType, payload?: Buffer): Promise<void> {
    const payloadLength = payload ? payload.length : 0;
    const messageLength = 1 + payloadLength; // 1 byte for type + payload
    
    const message = Buffer.alloc(4 + messageLength);
    message.writeUInt32BE(messageLength, 0);
    message.writeUInt8(type, 4);
    
    if (payload) {
      payload.copy(message, 5);
    }

    return new Promise((resolve, reject) => {
      this.socket.write(message, (error) => {
        if (error) {
          reject(new PeerError(`Failed to send message: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async sendKeepAlive(): Promise<void> {
    const keepAlive = Buffer.alloc(4, 0); // Length = 0
    
    return new Promise((resolve, reject) => {
      this.socket.write(keepAlive, (error) => {
        if (error) {
          reject(new PeerError(`Failed to send keep-alive: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  private startKeepAlive(): void {
    this.keepAliveTimer = setInterval(() => {
      const timeSinceLastMessage = Date.now() - this.lastMessageTime;
      
      if (timeSinceLastMessage >= PeerConnection.KEEPALIVE_INTERVAL) {
        this.sendKeepAlive().catch((error) => {
          this.emit('error', error);
        });
      }
    }, PeerConnection.KEEPALIVE_INTERVAL / 2);
  }

  private handleError(error: Error): void {
    this.cleanup();
    this.emit('error', new PeerError(`Socket error: ${error.message}`));
  }

  private handleClose(): void {
    this.cleanup();
    this.emit('close');
  }

  private handleTimeout(): void {
    this.cleanup();
    this.emit('error', new PeerError('Connection timeout'));
  }

  private cleanup(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
    
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  // Getters
  getState(): Readonly<PeerState> {
    return { ...this.state };
  }

  getPeerInfo(): PeerInfo {
    return { ...this.peerInfo };
  }

  isConnected(): boolean {
    return this.socket && !this.socket.destroyed && this.handshakeComplete;
  }

  hasPiece(pieceIndex: number): boolean {
    return this.state.bitfield.get(pieceIndex);
  }

  // Cleanup
  destroy(): void {
    this.cleanup();
    this.removeAllListeners();
  }
}