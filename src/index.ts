// Main library exports
export { TorrentClient, ClientError } from './client';
export { parseTorrentFile, TorrentMeta, Piece, getPieceMap } from './metainfo';
export { TrackerClient, TrackerError } from './tracker';
export { PeerConnection, BitSet, MessageType } from './peer';
export { PieceScheduler, SchedulerError } from './scheduler';
export { TorrentStorage, StorageError } from './storage';
export { encode as bencodeEncode, decode as bencodeDecode } from './bencode';

// Type exports
export type { ClientOptions, ClientStats, PeerStats } from './client';
export type { AnnounceRequest, AnnounceResponse, Peer } from './tracker';
export type { PeerState, RequestMessage, PieceMessage, CancelMessage, HaveMessage, PeerInfo } from './peer';
export type { BlockRequest, PieceProgress, SchedulerStats } from './scheduler';
export type { StorageStats, PieceBuffer } from './storage';
export type { BencodeValue } from './bencode';

// Version info
export const VERSION = '1.0.0';