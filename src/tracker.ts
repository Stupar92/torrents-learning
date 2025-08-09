import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import * as url from 'url';
import { decode, BencodeValue } from './bencode';

export class TrackerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerError';
  }
}

export interface Peer {
  ip: string;
  port: number;
}

export interface AnnounceRequest {
  infoHash: Buffer;
  peerId: Buffer;
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  compact: boolean;
  noPeerId?: boolean;
  event?: 'started' | 'stopped' | 'completed';
  numWant?: number;
}

export interface AnnounceResponse {
  interval: number;
  minInterval?: number;
  trackerId?: string;
  complete?: number;
  incomplete?: number;
  peers: Peer[];
  warningMessage?: string;
  failureReason?: string;
}

export class TrackerClient {
  private static readonly DEFAULT_TIMEOUT = 15000;
  private static readonly MAX_RETRIES = 3;
  private static readonly BACKOFF_BASE = 1000;

  constructor(private readonly timeout: number = TrackerClient.DEFAULT_TIMEOUT) {}

  async announce(trackerUrl: string, request: AnnounceRequest): Promise<AnnounceResponse> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < TrackerClient.MAX_RETRIES; attempt++) {
      try {
        return await this.doAnnounce(trackerUrl, request);
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on certain errors
        if (error instanceof TrackerError && error.message.includes('failure reason')) {
          throw error;
        }
        
        // Wait with exponential backoff before retry
        if (attempt < TrackerClient.MAX_RETRIES - 1) {
          const delay = TrackerClient.BACKOFF_BASE * Math.pow(2, attempt);
          await this.delay(delay);
        }
      }
    }
    
    throw new TrackerError(`Failed to announce after ${TrackerClient.MAX_RETRIES} attempts: ${lastError?.message}`);
  }

  private async doAnnounce(trackerUrl: string, request: AnnounceRequest): Promise<AnnounceResponse> {
    const requestUrl = this.buildAnnounceUrl(trackerUrl, request);
    const response = await this.makeHttpRequest(requestUrl);
    return this.parseAnnounceResponse(response);
  }

  private buildAnnounceUrl(trackerUrl: string, request: AnnounceRequest): string {
    const parsedUrl = new URL(trackerUrl);
    
    // Build query parameters manually to avoid double-encoding
    const params: string[] = [];
    params.push(`info_hash=${this.urlEncodeBuffer(request.infoHash)}`);
    params.push(`peer_id=${this.urlEncodeBuffer(request.peerId)}`);
    params.push(`port=${request.port}`);
    params.push(`uploaded=${request.uploaded}`);
    params.push(`downloaded=${request.downloaded}`);
    params.push(`left=${request.left}`);
    params.push(`compact=${request.compact ? '1' : '0'}`);
    
    if (request.noPeerId) {
      params.push('no_peer_id=1');
    }
    
    if (request.event) {
      params.push(`event=${request.event}`);
    }
    
    if (request.numWant !== undefined) {
      params.push(`numwant=${request.numWant}`);
    } else {
      params.push('numwant=50'); // Default
    }
    
    // Combine existing query with new parameters
    const existingQuery = parsedUrl.search.substring(1); // Remove '?'
    const allParams = existingQuery ? [existingQuery, ...params] : params;
    
    parsedUrl.search = '?' + allParams.join('&');
    
    return parsedUrl.toString();
  }

  private urlEncodeBuffer(buffer: Buffer): string {
    let result = '';
    for (let i = 0; i < buffer.length; i++) {
      const byte = buffer[i];
      // Use percent encoding for all bytes to ensure proper transmission
      result += '%' + byte.toString(16).padStart(2, '0');
    }
    return result;
  }

  private async makeHttpRequest(requestUrl: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsedUrl = url.parse(requestUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;
      
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.path,
        method: 'GET',
        timeout: this.timeout,
        headers: {
          'User-Agent': 'torrent-poc/1.0.0',
        },
      };

      const req = client.request(options, (res) => {
        // Follow redirects (basic support)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.makeHttpRequest(res.headers.location)
            .then(resolve)
            .catch(reject);
          return;
        }
        
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new TrackerError(`HTTP ${res.statusCode}: ${res.statusMessage}`));
          return;
        }

        const chunks: Buffer[] = [];
        
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          resolve(data);
        });
      });

      req.on('error', (error) => {
        reject(new TrackerError(`Request failed: ${error.message}`));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new TrackerError('Request timeout'));
      });

      req.end();
    });
  }

  private parseAnnounceResponse(data: Buffer): AnnounceResponse {
    let decoded: BencodeValue;
    
    try {
      decoded = decode(data);
    } catch (error) {
      throw new TrackerError(`Invalid bencode response: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
      throw new TrackerError('Response must be a dictionary');
    }
    
    const response = decoded as { [key: string]: BencodeValue };
    
    // Check for failure reason
    if (response['failure reason']) {
      const failureReason = response['failure reason'];
      if (!Buffer.isBuffer(failureReason)) {
        throw new TrackerError('Invalid failure reason format');
      }
      throw new TrackerError(`Tracker failure reason: ${failureReason.toString('utf8')}`);
    }
    
    // Extract required fields
    const intervalValue = response.interval;
    if (typeof intervalValue !== 'number') {
      throw new TrackerError('Missing or invalid interval');
    }
    
    const peersValue = response.peers;
    if (!peersValue) {
      throw new TrackerError('Missing peers field');
    }
    
    // Parse peers
    const peers = this.parsePeers(peersValue);
    
    // Extract optional fields
    const result: AnnounceResponse = {
      interval: intervalValue,
      peers,
    };
    
    if (typeof response['min interval'] === 'number') {
      result.minInterval = response['min interval'];
    }
    
    if (Buffer.isBuffer(response['tracker id'])) {
      result.trackerId = response['tracker id'].toString('utf8');
    }
    
    if (typeof response.complete === 'number') {
      result.complete = response.complete;
    }
    
    if (typeof response.incomplete === 'number') {
      result.incomplete = response.incomplete;
    }
    
    if (Buffer.isBuffer(response['warning message'])) {
      result.warningMessage = response['warning message'].toString('utf8');
    }
    
    return result;
  }

  private parsePeers(peersValue: BencodeValue): Peer[] {
    if (Buffer.isBuffer(peersValue)) {
      // Compact format: 6N bytes (4 bytes IP + 2 bytes port per peer)
      return this.parseCompactPeers(peersValue);
    } else if (Array.isArray(peersValue)) {
      // Dictionary format (non-compact)
      return this.parseDictionaryPeers(peersValue);
    } else {
      throw new TrackerError('Invalid peers format');
    }
  }

  private parseCompactPeers(data: Buffer): Peer[] {
    if (data.length % 6 !== 0) {
      throw new TrackerError('Compact peers data length must be multiple of 6');
    }
    
    const peers: Peer[] = [];
    
    for (let i = 0; i < data.length; i += 6) {
      // Read 4 bytes for IPv4 address
      const ip = [
        data[i],
        data[i + 1],
        data[i + 2],
        data[i + 3],
      ].join('.');
      
      // Read 2 bytes for port (big-endian)
      const port = data.readUInt16BE(i + 4);
      
      peers.push({ ip, port });
    }
    
    return peers;
  }

  private parseDictionaryPeers(peersArray: BencodeValue[]): Peer[] {
    const peers: Peer[] = [];
    
    for (const peerValue of peersArray) {
      if (typeof peerValue !== 'object' || peerValue === null || Array.isArray(peerValue)) {
        throw new TrackerError('Invalid peer dictionary format');
      }
      
      const peerDict = peerValue as { [key: string]: BencodeValue };
      
      const ipValue = peerDict.ip;
      const portValue = peerDict.port;
      
      if (!Buffer.isBuffer(ipValue)) {
        throw new TrackerError('Invalid peer IP format');
      }
      
      if (typeof portValue !== 'number') {
        throw new TrackerError('Invalid peer port format');
      }
      
      const ip = ipValue.toString('utf8');
      const port = portValue;
      
      peers.push({ ip, port });
    }
    
    return peers;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export function generatePeerId(prefix = '-JS0001-'): Buffer {
  if (prefix.length > 20) {
    throw new TrackerError('Peer ID prefix too long');
  }
  
  const suffixLength = 20 - prefix.length;
  const suffix = crypto.randomBytes(Math.ceil(suffixLength * 3 / 4))
    .toString('base64')
    .replace(/[+/]/g, '0') // Replace URL-unsafe characters
    .substring(0, suffixLength);
  
  return Buffer.from(prefix + suffix, 'ascii');
}

export function validatePeerId(peerId: Buffer): boolean {
  return peerId.length === 20;
}