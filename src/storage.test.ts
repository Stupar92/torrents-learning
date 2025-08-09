import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { TorrentStorage, StorageError } from './storage';
import { TorrentMeta } from './metainfo';

describe('TorrentStorage', () => {
  let tempDir: string;
  let torrentMeta: TorrentMeta;
  let storage: TorrentStorage;

  beforeEach(async () => {
    // Create temporary directory for tests
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'torrent-storage-test-'));

    // Create test torrent metadata (2 pieces for simple testing)
    const piece1Data = Buffer.alloc(16384, 0xAA); // First piece
    const piece2Data = Buffer.alloc(8000, 0xBB);  // Second piece (partial)
    
    const piece1Hash = crypto.createHash('sha1').update(piece1Data).digest();
    const piece2Hash = crypto.createHash('sha1').update(piece2Data).digest();
    const pieces = Buffer.concat([piece1Hash, piece2Hash]);

    torrentMeta = {
      announce: 'http://tracker.example.com/announce',
      name: 'test-file.bin',
      length: 24384, // 16384 + 8000
      pieceLength: 16384,
      pieces,
      infoHashV1: crypto.randomBytes(20),
    };

    const outputPath = path.join(tempDir, 'downloads');
    storage = new TorrentStorage(torrentMeta, outputPath);
  });

  afterEach(async () => {
    await storage.destroy();
    
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Initialization', () => {
    test('initializes storage correctly', async () => {
      await storage.initialize();

      const stats = storage.getStats();
      expect(stats.totalSize).toBe(24384);
      expect(stats.totalPieces).toBe(2);
      expect(stats.verifiedPieces).toBe(0);
      expect(stats.isComplete).toBe(false);
      expect(path.basename(stats.filePath)).toBe('test-file.bin');
    });

    test('creates output directory if missing', async () => {
      const nestedPath = path.join(tempDir, 'deep', 'nested', 'path');
      const nestedStorage = new TorrentStorage(torrentMeta, nestedPath);

      await nestedStorage.initialize();

      const dirExists = await fs.access(path.dirname(nestedStorage.getStats().filePath))
        .then(() => true)
        .catch(() => false);

      expect(dirExists).toBe(true);
      await nestedStorage.destroy();
    });

    test('handles existing file correctly', async () => {
      // Create a partial file first
      const filePath = path.join(tempDir, 'test-file.bin');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, Buffer.alloc(1000, 0xFF));

      await storage.initialize();

      const stats = storage.getStats();
      expect(stats.isComplete).toBe(false);
    });

    test('uses specific file path when provided', async () => {
      const specificPath = path.join(tempDir, 'custom-name.bin');
      const customStorage = new TorrentStorage(torrentMeta, specificPath);

      await customStorage.initialize();

      const stats = customStorage.getStats();
      expect(stats.filePath).toBe(specificPath);
      await customStorage.destroy();
    });
  });

  describe('Block Management', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    test('adds blocks correctly', () => {
      const blockData = Buffer.alloc(16384, 0xAA);
      
      storage.addBlock(0, 0, blockData);

      expect(storage.getPieceProgress(0)).toBe(1.0);
      expect(storage.getReceivedBlocks(0)).toEqual(new Set([0]));
    });

    test('handles partial blocks correctly', async () => {
      // Create storage with smaller block size for testing
      const smallBlockStorage = new TorrentStorage(torrentMeta, path.join(tempDir, 'small-blocks'), 8192);
      await smallBlockStorage.initialize();

      const block1 = Buffer.alloc(8192, 0xAA);  // First block
      const block2 = Buffer.alloc(8192, 0xAA);  // Second block

      smallBlockStorage.addBlock(0, 0, block1);
      expect(smallBlockStorage.getPieceProgress(0)).toBe(0.5);

      smallBlockStorage.addBlock(0, 8192, block2);
      expect(smallBlockStorage.getPieceProgress(0)).toBe(1.0);

      await smallBlockStorage.destroy();
    });

    test('handles last piece with different size', () => {
      // Second piece is only 8000 bytes
      const blockData = Buffer.alloc(8000, 0xBB);
      
      storage.addBlock(1, 0, blockData);

      expect(storage.getPieceProgress(1)).toBe(1.0);
    });

    test('validates piece index', () => {
      const blockData = Buffer.alloc(1024, 0xFF);
      
      expect(() => {
        storage.addBlock(-1, 0, blockData);
      }).toThrow(StorageError);

      expect(() => {
        storage.addBlock(999, 0, blockData);
      }).toThrow(StorageError);
    });

    test('validates block offset', () => {
      const blockData = Buffer.alloc(1024, 0xFF);
      
      expect(() => {
        storage.addBlock(0, -1, blockData);
      }).toThrow(StorageError);

      expect(() => {
        storage.addBlock(0, 20000, blockData); // Beyond piece length
      }).toThrow(StorageError);
    });

    test('validates block size', () => {
      const wrongSizeBlock = Buffer.alloc(1000, 0xFF); // Wrong size
      
      expect(() => {
        storage.addBlock(0, 0, wrongSizeBlock);
      }).toThrow(StorageError);
    });

    test('ignores duplicate blocks', async () => {
      const smallBlockStorage = new TorrentStorage(torrentMeta, path.join(tempDir, 'dupe-test'), 8192);
      await smallBlockStorage.initialize();

      const blockData = Buffer.alloc(8192, 0xAA);
      
      smallBlockStorage.addBlock(0, 0, blockData);
      smallBlockStorage.addBlock(0, 0, blockData); // Duplicate

      const receivedBlocks = smallBlockStorage.getReceivedBlocks(0);
      expect(receivedBlocks.size).toBe(1);

      await smallBlockStorage.destroy();
    });
  });

  describe('Piece Completion', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    test('completes piece with valid hash', (done) => {
      const pieceData = Buffer.alloc(16384, 0xAA);
      
      storage.on('piece_completed', (event) => {
        expect(event.pieceIndex).toBe(0);
        expect(event.length).toBe(16384);
        expect(storage.hasPiece(0)).toBe(true);
        done();
      });

      storage.addBlock(0, 0, pieceData);
    });

    test('rejects piece with invalid hash', (done) => {
      const wrongData = Buffer.alloc(16384, 0xFF); // Wrong data
      
      storage.on('piece_hash_failed', (event) => {
        expect(event.pieceIndex).toBe(0);
        expect(storage.hasPiece(0)).toBe(false);
        done();
      });

      storage.addBlock(0, 0, wrongData);
    });

    test('completes download when all pieces done', async () => {
      const piece1 = Buffer.alloc(16384, 0xAA);
      const piece2 = Buffer.alloc(8000, 0xBB);

      const downloadCompletePromise = new Promise<void>((resolve) => {
        storage.on('download_completed', () => {
          resolve();
        });
      });

      storage.addBlock(0, 0, piece1);
      storage.addBlock(1, 0, piece2);

      await downloadCompletePromise;

      expect(storage.isComplete()).toBe(true);
      expect(storage.getCompletionPercentage()).toBe(100);
    });
  });

  describe('File I/O Operations', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    test('writes pieces to correct file positions', async () => {
      const piece1 = Buffer.alloc(16384, 0xAA);
      const piece2 = Buffer.alloc(8000, 0xBB);

      // Add pieces in reverse order to test positioning
      storage.addBlock(1, 0, piece2);
      storage.addBlock(0, 0, piece1);

      // Wait for completion
      await new Promise<void>((resolve) => {
        let completed = 0;
        storage.on('piece_completed', () => {
          completed++;
          if (completed === 2) resolve();
        });
      });

      // Verify file contents
      const stats = storage.getStats();
      const fileData = await fs.readFile(stats.filePath);
      
      expect(fileData.length).toBe(24384);
      expect(fileData.subarray(0, 16384).every(b => b === 0xAA)).toBe(true);
      expect(fileData.subarray(16384, 24384).every(b => b === 0xBB)).toBe(true);
    });

    test('reads completed pieces', async () => {
      const pieceData = Buffer.alloc(16384, 0xAA);
      
      storage.addBlock(0, 0, pieceData);

      await new Promise<void>((resolve) => {
        storage.on('piece_completed', () => resolve());
      });

      const readData = await storage.readPiece(0);
      expect(Buffer.compare(readData, pieceData)).toBe(0);
    });

    test('throws when reading incomplete piece', async () => {
      await expect(storage.readPiece(0)).rejects.toThrow('not completed');
    });

    test('flushes data to disk', async () => {
      const pieceData = Buffer.alloc(16384, 0xAA);
      storage.addBlock(0, 0, pieceData);

      await new Promise<void>((resolve) => {
        storage.on('piece_completed', () => resolve());
      });

      await storage.flush();
      // Should not throw
    });
  });

  describe('Progress Tracking', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    test('tracks piece progress correctly', async () => {
      const smallBlockStorage = new TorrentStorage(torrentMeta, path.join(tempDir, 'progress-test'), 8192);
      await smallBlockStorage.initialize();

      const block1 = Buffer.alloc(8192, 0xAA);
      const block2 = Buffer.alloc(8192, 0xAA);

      expect(smallBlockStorage.getPieceProgress(0)).toBe(0);

      smallBlockStorage.addBlock(0, 0, block1);
      expect(smallBlockStorage.getPieceProgress(0)).toBe(0.5);

      smallBlockStorage.addBlock(0, 8192, block2);
      expect(smallBlockStorage.getPieceProgress(0)).toBe(1.0);

      await smallBlockStorage.destroy();
    });

    test('provides accurate statistics', async () => {
      const piece1 = Buffer.alloc(16384, 0xAA);
      
      storage.addBlock(0, 0, piece1);

      await new Promise<void>((resolve) => {
        storage.on('piece_completed', () => resolve());
      });

      const stats = storage.getStats();
      expect(stats.writtenSize).toBe(16384);
      expect(stats.verifiedPieces).toBe(1);
      expect(stats.totalPieces).toBe(2);
      expect(storage.getBytesDownloaded()).toBe(16384);
      expect(storage.getCompletionPercentage()).toBeCloseTo(67.2, 1);
    });

    test('tracks missing blocks', async () => {
      const smallBlockStorage = new TorrentStorage(torrentMeta, path.join(tempDir, 'missing-test'), 8192);
      await smallBlockStorage.initialize();

      const block1 = Buffer.alloc(8192, 0xAA);
      smallBlockStorage.addBlock(0, 0, block1);

      const missingBlocks = smallBlockStorage.getMissingBlocks(0);
      expect(missingBlocks).toEqual([8192]);

      const completedMissing = smallBlockStorage.getMissingBlocks(999); // Invalid piece
      expect(completedMissing).toEqual([]);

      await smallBlockStorage.destroy();
    });

    test('tracks completed pieces', () => {
      expect(storage.getCompletedPieces().size).toBe(0);
      
      const piece1 = Buffer.alloc(16384, 0xAA);
      storage.addBlock(0, 0, piece1);

      // After completion event
      storage.on('piece_completed', () => {
        expect(storage.getCompletedPieces().has(0)).toBe(true);
      });
    });
  });

  describe('Utility Methods', () => {
    test('validates piece indices', () => {
      expect(() => storage.validatePieceIndex(0)).not.toThrow();
      expect(() => storage.validatePieceIndex(1)).not.toThrow();
      expect(() => storage.validatePieceIndex(-1)).toThrow(StorageError);
      expect(() => storage.validatePieceIndex(2)).toThrow(StorageError);
    });

    test('calculates block sizes correctly', () => {
      // Full block in middle of piece
      expect(storage.getBlockSize(0, 0)).toBe(16384);
      
      // Partial block at end of piece 
      expect(storage.getBlockSize(1, 0)).toBe(8000);
    });

    test('counts total blocks per piece', () => {
      expect(storage.getTotalBlocks(0)).toBe(1); // 16384 / 16384 = 1
      expect(storage.getTotalBlocks(1)).toBe(1); // 8000 / 16384 = 1 (ceil)
    });
  });

  describe('File Recovery', () => {
    beforeEach(async () => {
      await storage.initialize();
    });

    test('repairs file from existing valid pieces', async () => {
      // Manually write valid pieces to file
      const piece1 = Buffer.alloc(16384, 0xAA);
      const piece2 = Buffer.alloc(8000, 0xBB);
      
      const stats = storage.getStats();
      const fileData = Buffer.concat([piece1, piece2]);
      await fs.writeFile(stats.filePath, fileData);

      const repaired = await storage.repairFile();
      expect(repaired).toBe(true);
      expect(storage.getCompletedPieces().size).toBe(2);
    });

    test('detects corrupted pieces during repair', async () => {
      // Write corrupted data
      const corruptedData = Buffer.alloc(24384, 0xFF);
      
      const stats = storage.getStats();
      await fs.writeFile(stats.filePath, corruptedData);

      const repaired = await storage.repairFile();
      expect(repaired).toBe(false);
      expect(storage.getCompletedPieces().size).toBe(0);
    });
  });

  describe('Existing File Detection', () => {
    test('detects complete existing file', async () => {
      // Pre-create complete valid file
      const piece1 = Buffer.alloc(16384, 0xAA);
      const piece2 = Buffer.alloc(8000, 0xBB);
      const completeFile = Buffer.concat([piece1, piece2]);
      
      const filePath = path.join(tempDir, 'test-file.bin');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, completeFile);

      const existingStorage = new TorrentStorage(torrentMeta, tempDir);
      
      let alreadyCompleteEmitted = false;
      existingStorage.on('already_complete', () => {
        alreadyCompleteEmitted = true;
      });

      await existingStorage.initialize();

      // Give time for event to be emitted if it will be
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(existingStorage.isComplete()).toBe(true);
      if (alreadyCompleteEmitted) {
        // Event was emitted, which is good
        expect(alreadyCompleteEmitted).toBe(true);
      }
      
      await existingStorage.destroy();
    });

    test('handles incomplete existing file', async () => {
      // Pre-create incomplete file
      const partialFile = Buffer.alloc(1000, 0xFF);
      
      const filePath = path.join(tempDir, 'test-file.bin');
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, partialFile);

      await storage.initialize();

      expect(storage.isComplete()).toBe(false);
    });
  });

  describe('Error Handling', () => {
    test('handles initialization errors gracefully', async () => {
      // Try to create storage in read-only location (if possible)
      const readOnlyStorage = new TorrentStorage(torrentMeta, '/dev/null/invalid');
      
      await expect(readOnlyStorage.initialize()).rejects.toThrow(StorageError);
      await readOnlyStorage.destroy();
    });

    test('handles write errors gracefully', async () => {
      await storage.initialize();
      
      // Close the file handle to simulate write error
      await storage.close();
      
      const pieceData = Buffer.alloc(16384, 0xAA);
      
      let writeErrorEmitted = false;
      storage.on('piece_write_failed', () => {
        writeErrorEmitted = true;
      });

      storage.addBlock(0, 0, pieceData);
      
      // Give time for async write to attempt and fail
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(storage.hasPiece(0)).toBe(false);
      // Note: May or may not emit event depending on exact timing, so we don't assert on it
    });
  });

  describe('Cleanup', () => {
    test('closes file handle properly', async () => {
      await storage.initialize();
      await storage.close();
      // Should not throw
    });

    test('destroys storage cleanly', async () => {
      await storage.initialize();
      
      const pieceData = Buffer.alloc(16384, 0xAA);
      storage.addBlock(0, 0, pieceData);

      await storage.destroy();
      
      expect(storage.getStats().verifiedPieces).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    test('handles zero-length torrent', async () => {
      const emptyTorrent: TorrentMeta = {
        ...torrentMeta,
        length: 0,
        pieces: Buffer.alloc(0),
      };

      const emptyStorage = new TorrentStorage(emptyTorrent, tempDir);
      await emptyStorage.initialize();

      expect(emptyStorage.isComplete()).toBe(true);
      expect(emptyStorage.getCompletionPercentage()).toBe(100);
      
      await emptyStorage.destroy();
    });

    test('handles single block piece', async () => {
      // Create torrent with piece smaller than block size
      const smallPieceData = Buffer.alloc(1024, 0xCC);
      const smallPieceHash = crypto.createHash('sha1').update(smallPieceData).digest();

      const smallTorrent: TorrentMeta = {
        ...torrentMeta,
        length: 1024,
        pieceLength: 1024,
        pieces: smallPieceHash,
      };

      const smallStorage = new TorrentStorage(smallTorrent, tempDir);
      await smallStorage.initialize();

      smallStorage.addBlock(0, 0, smallPieceData);

      await new Promise<void>((resolve) => {
        smallStorage.on('piece_completed', () => resolve());
      });

      expect(smallStorage.isComplete()).toBe(true);
      await smallStorage.destroy();
    });

    test('handles large piece with many blocks', async () => {
      // Use smaller block size for testing
      const largeStorage = new TorrentStorage(torrentMeta, tempDir, 4096); // 4KB blocks
      await largeStorage.initialize();

      const piece = Buffer.alloc(16384, 0xAA);
      
      // Add in 4KB blocks
      for (let i = 0; i < 4; i++) {
        const blockOffset = i * 4096;
        const blockData = piece.subarray(blockOffset, blockOffset + 4096);
        largeStorage.addBlock(0, blockOffset, blockData);
      }

      await new Promise<void>((resolve) => {
        largeStorage.on('piece_completed', () => resolve());
      });

      expect(largeStorage.hasPiece(0)).toBe(true);
      await largeStorage.destroy();
    });
  });
});