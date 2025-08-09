import * as fs from 'fs';
import * as crypto from 'crypto';
import { parseTorrentBuffer, parseTorrentFile, getPieceMap, getFileOffset, validatePieceIndex, getTotalPieces, MetainfoError } from './metainfo';
import { encode } from './bencode';

describe('Metainfo Parser', () => {
  const createTestTorrent = (overrides: any = {}) => {
    // Calculate proper number of pieces for default values
    const length = overrides.info?.length || 1000;
    const pieceLength = overrides.info?.['piece length'] || 256;
    const expectedPieces = Math.ceil(length / pieceLength);
    const defaultPieces = Buffer.alloc(expectedPieces * 20, 0xaa);

    const info = {
      name: Buffer.from('test.txt'),
      length: 1000,
      'piece length': 256,
      pieces: defaultPieces,
      ...overrides.info,
    };

    const torrent = {
      announce: Buffer.from('http://tracker.example.com/announce'),
      info,
      ...overrides,
    };

    // Filter out undefined values to avoid bencode errors
    const cleanTorrent: any = {};
    Object.keys(torrent).forEach(key => {
      if (torrent[key as keyof typeof torrent] !== undefined) {
        cleanTorrent[key] = torrent[key as keyof typeof torrent];
      }
    });

    if (cleanTorrent.info) {
      const cleanInfo: any = {};
      Object.keys(cleanTorrent.info).forEach(key => {
        if (cleanTorrent.info[key] !== undefined) {
          cleanInfo[key] = cleanTorrent.info[key];
        }
      });
      cleanTorrent.info = cleanInfo;
    }

    return encode(cleanTorrent);
  };

  describe('parseTorrentBuffer', () => {
    test('parses valid single-file torrent', () => {
      const torrentData = createTestTorrent();
      const result = parseTorrentBuffer(torrentData);

      expect(result.announce).toBe('http://tracker.example.com/announce');
      expect(result.name).toBe('test.txt');
      expect(result.length).toBe(1000);
      expect(result.pieceLength).toBe(256);
      expect(result.pieces.length).toBe(80); // 4 pieces * 20 bytes each
      expect(result.infoHashV1.length).toBe(20);
    });

    test('calculates correct info hash', () => {
      const info = {
        name: Buffer.from('test.txt'),
        length: 256,
        'piece length': 256,
        pieces: Buffer.alloc(20, 0xaa), // Single piece for 256 bytes
      };

      const torrentData = createTestTorrent({ info });
      const result = parseTorrentBuffer(torrentData);

      // Calculate expected hash
      const infoEncoded = encode(info);
      const expectedHash = crypto.createHash('sha1').update(infoEncoded).digest();

      expect(Buffer.compare(result.infoHashV1, expectedHash)).toBe(0);
    });

    test('parses announce-list when present', () => {
      const announceList = [
        [Buffer.from('http://tracker1.example.com/announce')],
        [Buffer.from('http://tracker2.example.com/announce'), Buffer.from('http://tracker3.example.com/announce')],
      ];

      const torrentData = createTestTorrent({ 'announce-list': announceList });
      const result = parseTorrentBuffer(torrentData);

      expect(result.announceList).toEqual([
        ['http://tracker1.example.com/announce'],
        ['http://tracker2.example.com/announce', 'http://tracker3.example.com/announce'],
      ]);
    });

    test('handles multiple pieces correctly', () => {
      const pieces = Buffer.concat([
        Buffer.alloc(20, 0xaa), // First piece hash
        Buffer.alloc(20, 0xbb), // Second piece hash
        Buffer.alloc(20, 0xcc), // Third piece hash
        Buffer.alloc(20, 0xdd), // Fourth piece hash
      ]);

      const torrentData = createTestTorrent({
        info: {
          name: Buffer.from('large-file.txt'),
          length: 1000,
          'piece length': 256,
          pieces,
        },
      });

      const result = parseTorrentBuffer(torrentData);
      expect(result.pieces.length).toBe(80); // 4 pieces * 20 bytes each
    });

    describe('Error handling', () => {
      test('throws on invalid bencode data', () => {
        const invalidData = Buffer.from('not bencode');
        expect(() => parseTorrentBuffer(invalidData)).toThrow(MetainfoError);
      });

      test('throws on non-dictionary root', () => {
        const invalidData = encode([Buffer.from('not'), Buffer.from('a'), Buffer.from('dictionary')]);
        expect(() => parseTorrentBuffer(invalidData)).toThrow(MetainfoError);
      });

      test('throws on missing announce', () => {
        const info = {
          name: Buffer.from('test.txt'),
          length: 256,
          'piece length': 256,
          pieces: Buffer.alloc(20, 0xaa),
        };
        const torrentData = encode({ info }); // Missing announce
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid announce URL');
      });

      test('throws on invalid announce type', () => {
        const torrentData = createTestTorrent({ announce: 123 });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid announce URL');
      });

      test('throws on missing info dictionary', () => {
        const torrentData = encode({ announce: Buffer.from('http://example.com') }); // Missing info
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid info dictionary');
      });

      test('throws on invalid info dictionary type', () => {
        const torrentData = encode({
          announce: Buffer.from('http://example.com'),
          info: Buffer.from('not a dict')
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid info dictionary');
      });

      test('throws on missing name', () => {
        const torrentData = encode({
          announce: Buffer.from('http://example.com'),
          info: { length: 256, 'piece length': 256, pieces: Buffer.alloc(20) }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid name');
      });

      test('throws on multi-file torrent', () => {
        const torrentData = createTestTorrent({
          info: {
            name: Buffer.from('multi-file'),
            files: [
              { length: 500, path: [Buffer.from('file1.txt')] },
              { length: 500, path: [Buffer.from('file2.txt')] },
            ],
            'piece length': 256,
            pieces: Buffer.alloc(40), // 2 pieces
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Multi-file torrents are not supported');
      });

      test('throws on missing length', () => {
        const torrentData = createTestTorrent({
          info: {
            name: Buffer.from('test.txt'),
            'piece length': 256,
            pieces: Buffer.alloc(20),
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid length');
      });

      test('throws on invalid length', () => {
        const torrentData = encode({
          announce: Buffer.from('http://example.com'),
          info: {
            name: Buffer.from('test.txt'),
            length: 0,
            'piece length': 256,
            pieces: Buffer.alloc(20)
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('File length must be positive');
      });

      test('throws on missing piece length', () => {
        const torrentData = createTestTorrent({
          info: {
            name: Buffer.from('test.txt'),
            length: 1000,
            pieces: Buffer.alloc(20),
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid piece length');
      });

      test('throws on invalid piece length (not power of 2)', () => {
        const torrentData = encode({
          announce: Buffer.from('http://example.com'),
          info: {
            name: Buffer.from('test.txt'),
            length: 1000,
            'piece length': 100, // Not a power of 2
            pieces: Buffer.alloc(200) // 10 pieces
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Piece length must be a positive power of 2');
      });

      test('throws on missing pieces', () => {
        const torrentData = createTestTorrent({
          info: {
            name: Buffer.from('test.txt'),
            length: 1000,
            'piece length': 256,
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Missing or invalid pieces');
      });

      test('throws on invalid pieces length', () => {
        const torrentData = encode({
          announce: Buffer.from('http://example.com'),
          info: {
            name: Buffer.from('test.txt'),
            length: 1000,
            'piece length': 256,
            pieces: Buffer.alloc(19) // Not multiple of 20
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Pieces buffer length must be a multiple of 20');
      });

      test('throws on piece count mismatch', () => {
        const torrentData = encode({
          announce: Buffer.from('http://example.com'),
          info: {
            name: Buffer.from('test.txt'),
            length: 1000,
            'piece length': 256,
            pieces: Buffer.alloc(40), // 2 pieces, but should be 4 for 1000 bytes / 256 piece length
          }
        });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Expected 4 pieces but found 2');
      });

      test('throws on invalid announce-list format', () => {
        const torrentData = createTestTorrent({ 'announce-list': Buffer.from('not an array') });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Invalid announce-list format');
      });

      test('throws on invalid announce-list tier format', () => {
        const torrentData = createTestTorrent({ 'announce-list': [Buffer.from('not an array')] });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Invalid announce-list tier format');
      });

      test('throws on invalid announce URL in list', () => {
        const torrentData = createTestTorrent({ 'announce-list': [[123]] });
        expect(() => parseTorrentBuffer(torrentData)).toThrow('Invalid announce URL in announce-list');
      });
    });
  });

  describe('parseTorrentFile', () => {
    const testFilePath = '/tmp/test-torrent.torrent';

    afterEach(() => {
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    });

    test('reads and parses torrent file', () => {
      const torrentData = createTestTorrent();
      fs.writeFileSync(testFilePath, torrentData);

      const result = parseTorrentFile(testFilePath);
      expect(result.name).toBe('test.txt');
      expect(result.length).toBe(1000);
    });

    test('throws on non-existent file', () => {
      expect(() => parseTorrentFile('/non/existent/file.torrent')).toThrow();
    });
  });

  describe('getPieceMap', () => {
    test('creates correct piece map for single piece', () => {
      const torrentData = createTestTorrent({
        info: {
          name: Buffer.from('small.txt'),
          length: 100,
          'piece length': 256,
          pieces: Buffer.alloc(20, 0xaa),
        }
      });

      const meta = parseTorrentBuffer(torrentData);
      const pieces = getPieceMap(meta);

      expect(pieces).toHaveLength(1);
      expect(pieces[0].index).toBe(0);
      expect(pieces[0].length).toBe(100); // Smaller than piece length
      expect(pieces[0].hash.length).toBe(20);
    });

    test('creates correct piece map for multiple pieces', () => {
      const pieces = Buffer.concat([
        Buffer.alloc(20, 0xaa),
        Buffer.alloc(20, 0xbb),
        Buffer.alloc(20, 0xcc),
      ]);

      const torrentData = createTestTorrent({
        info: {
          name: Buffer.from('multi-piece.txt'),
          length: 600,
          'piece length': 256,
          pieces,
        }
      });

      const meta = parseTorrentBuffer(torrentData);
      const pieceMap = getPieceMap(meta);

      expect(pieceMap).toHaveLength(3);
      
      // First two pieces should be full size
      expect(pieceMap[0].length).toBe(256);
      expect(pieceMap[1].length).toBe(256);
      
      // Last piece should be partial
      expect(pieceMap[2].length).toBe(88); // 600 - (256 * 2)
      
      // Check hashes are different
      expect(pieceMap[0].hash.every(b => b === 0xaa)).toBe(true);
      expect(pieceMap[1].hash.every(b => b === 0xbb)).toBe(true);
      expect(pieceMap[2].hash.every(b => b === 0xcc)).toBe(true);
    });
  });

  describe('Utility functions', () => {
    test('getFileOffset calculates correct offset', () => {
      expect(getFileOffset(0, 256)).toBe(0);
      expect(getFileOffset(1, 256)).toBe(256);
      expect(getFileOffset(5, 1024)).toBe(5120);
    });

    test('getTotalPieces returns correct count', () => {
      const torrentData = createTestTorrent({
        info: { 
          name: Buffer.from('test.txt'),
          length: 768, // 3 pieces * 256
          'piece length': 256,
          pieces: Buffer.alloc(60) // 3 pieces
        }
      });
      const meta = parseTorrentBuffer(torrentData);
      expect(getTotalPieces(meta)).toBe(3);
    });

    test('validatePieceIndex accepts valid indices', () => {
      expect(() => validatePieceIndex(0, 5)).not.toThrow();
      expect(() => validatePieceIndex(4, 5)).not.toThrow();
    });

    test('validatePieceIndex rejects invalid indices', () => {
      expect(() => validatePieceIndex(-1, 5)).toThrow(MetainfoError);
      expect(() => validatePieceIndex(5, 5)).toThrow(MetainfoError);
    });
  });
});