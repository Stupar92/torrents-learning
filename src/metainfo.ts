import * as crypto from 'crypto';
import * as fs from 'fs';
import { decode, encode, BencodeValue } from './bencode';

export class MetainfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetainfoError';
  }
}

export interface TorrentMeta {
  announce: string;
  announceList?: string[][];
  name: string;
  length: number;            // single-file only in MVP
  pieceLength: number;       // bytes
  pieces: Buffer;            // 20B * numPieces
  infoHashV1: Buffer;        // 20B SHA-1
}

export interface Piece {
  index: number;
  length: number;            // last piece may be shorter
  hash: Buffer;              // 20B SHA-1
}

interface RawTorrentInfo {
  name: Buffer;
  length?: number;
  files?: Array<{
    length: number;
    path: Buffer[];
  }>;
  'piece length': number;
  pieces: Buffer;
}

interface RawTorrent {
  announce: Buffer;
  'announce-list'?: Buffer[][];
  info: RawTorrentInfo;
}

export function parseTorrentFile(filePath: string): TorrentMeta {
  const data = fs.readFileSync(filePath);
  return parseTorrentBuffer(data);
}

export function parseTorrentBuffer(data: Buffer): TorrentMeta {
  let decoded: BencodeValue;
  
  try {
    decoded = decode(data);
  } catch (error) {
    throw new MetainfoError(`Failed to decode bencode: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
  
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new MetainfoError('Torrent file must contain a dictionary at root level');
  }
  
  const torrent = decoded as { [key: string]: BencodeValue };
  
  // Extract announce URL
  const announceValue = torrent.announce;
  if (!Buffer.isBuffer(announceValue)) {
    throw new MetainfoError('Missing or invalid announce URL');
  }
  const announce = announceValue.toString('utf8');
  
  // Extract announce-list (optional)
  let announceList: string[][] | undefined;
  if (torrent['announce-list']) {
    const announceListValue = torrent['announce-list'];
    if (!Array.isArray(announceListValue)) {
      throw new MetainfoError('Invalid announce-list format');
    }
    
    announceList = [];
    for (const tier of announceListValue) {
      if (!Array.isArray(tier)) {
        throw new MetainfoError('Invalid announce-list tier format');
      }
      
      const tierUrls: string[] = [];
      for (const url of tier) {
        if (!Buffer.isBuffer(url)) {
          throw new MetainfoError('Invalid announce URL in announce-list');
        }
        tierUrls.push(url.toString('utf8'));
      }
      announceList.push(tierUrls);
    }
  }
  
  // Extract info dictionary
  const infoValue = torrent.info;
  if (typeof infoValue !== 'object' || infoValue === null || Array.isArray(infoValue) || Buffer.isBuffer(infoValue)) {
    throw new MetainfoError('Missing or invalid info dictionary');
  }
  
  const info = infoValue as { [key: string]: BencodeValue };
  
  // Extract name
  const nameValue = info.name;
  if (!Buffer.isBuffer(nameValue)) {
    throw new MetainfoError('Missing or invalid name in info dictionary');
  }
  const name = nameValue.toString('utf8');
  
  // Check for multi-file layout and reject (MVP limitation)
  if (info.files) {
    throw new MetainfoError('Multi-file torrents are not supported in MVP');
  }
  
  // Extract length (single-file only)
  const lengthValue = info.length;
  if (typeof lengthValue !== 'number') {
    throw new MetainfoError('Missing or invalid length in info dictionary');
  }
  const length = lengthValue;
  
  if (length <= 0) {
    throw new MetainfoError('File length must be positive');
  }
  
  // Extract piece length
  const pieceLengthValue = info['piece length'];
  if (typeof pieceLengthValue !== 'number') {
    throw new MetainfoError('Missing or invalid piece length in info dictionary');
  }
  const pieceLength = pieceLengthValue;
  
  if (pieceLength <= 0 || (pieceLength & (pieceLength - 1)) !== 0) {
    throw new MetainfoError('Piece length must be a positive power of 2');
  }
  
  // Extract pieces
  const piecesValue = info.pieces;
  if (!Buffer.isBuffer(piecesValue)) {
    throw new MetainfoError('Missing or invalid pieces in info dictionary');
  }
  const pieces = piecesValue;
  
  if (pieces.length % 20 !== 0) {
    throw new MetainfoError('Pieces buffer length must be a multiple of 20');
  }
  
  const numPieces = pieces.length / 20;
  const expectedNumPieces = Math.ceil(length / pieceLength);
  
  if (numPieces !== expectedNumPieces) {
    throw new MetainfoError(`Expected ${expectedNumPieces} pieces but found ${numPieces}`);
  }
  
  // Calculate info hash (SHA-1 of bencoded info dictionary)
  const infoEncoded = encode(infoValue);
  const infoHashV1 = crypto.createHash('sha1').update(infoEncoded).digest();
  
  return {
    announce,
    announceList,
    name,
    length,
    pieceLength,
    pieces,
    infoHashV1,
  };
}

export function getPieceMap(meta: TorrentMeta): Piece[] {
  const pieces: Piece[] = [];
  const numPieces = meta.pieces.length / 20;
  
  for (let i = 0; i < numPieces; i++) {
    const isLastPiece = i === numPieces - 1;
    const pieceLength = isLastPiece 
      ? meta.length - (meta.pieceLength * i)
      : meta.pieceLength;
    
    const hash = meta.pieces.subarray(i * 20, (i + 1) * 20);
    
    pieces.push({
      index: i,
      length: pieceLength,
      hash,
    });
  }
  
  return pieces;
}

export function getFileOffset(pieceIndex: number, pieceLength: number): number {
  return pieceIndex * pieceLength;
}

export function validatePieceIndex(pieceIndex: number, totalPieces: number): void {
  if (pieceIndex < 0 || pieceIndex >= totalPieces) {
    throw new MetainfoError(`Invalid piece index ${pieceIndex}, expected 0-${totalPieces - 1}`);
  }
}

export function getTotalPieces(meta: TorrentMeta): number {
  return meta.pieces.length / 20;
}