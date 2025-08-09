import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { TorrentMeta, Piece, getPieceMap, getFileOffset } from './metainfo';

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface StorageStats {
  totalSize: number;
  allocatedSize: number;
  writtenSize: number;
  verifiedPieces: number;
  totalPieces: number;
  filePath: string;
  isComplete: boolean;
}

export interface PieceBuffer {
  pieceIndex: number;
  data: Buffer;
  receivedBlocks: Map<number, Buffer>; // offset -> block data
  expectedLength: number;
  isComplete: boolean;
}

export class TorrentStorage extends EventEmitter {
  private readonly torrentMeta: TorrentMeta;
  private readonly pieces: Piece[];
  private readonly outputPath: string;
  private readonly blockSize: number;

  // File handling
  private fileHandle?: fs.FileHandle;
  private filePath: string;
  private fileAllocated = false;

  // Piece management
  private readonly pieceBuffers: Map<number, PieceBuffer> = new Map();
  private readonly completedPieces: Set<number> = new Set();
  private readonly verifiedHashes: Map<number, Buffer> = new Map();
  
  // Statistics
  private writtenBytes = 0;
  private verifiedPieces = 0;

  constructor(
    torrentMeta: TorrentMeta,
    outputPath: string,
    blockSize: number = 16384
  ) {
    super();

    this.torrentMeta = torrentMeta;
    this.pieces = getPieceMap(torrentMeta);
    this.outputPath = outputPath;
    this.blockSize = blockSize;

    // Determine output file path
    if (path.extname(outputPath)) {
      // Specific file path provided
      this.filePath = outputPath;
    } else {
      // Directory provided, use torrent name
      this.filePath = path.join(outputPath, torrentMeta.name);
    }

    // Pre-calculate piece hashes for verification
    for (let i = 0; i < this.pieces.length; i++) {
      const hashStart = i * 20;
      const hashEnd = hashStart + 20;
      this.verifiedHashes.set(i, torrentMeta.pieces.subarray(hashStart, hashEnd));
    }
  }

  async initialize(): Promise<void> {
    try {
      // Ensure output directory exists
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });

      // Check if file already exists and is complete
      const existingStats = await this.checkExistingFile();
      
      if (existingStats.isComplete) {
        this.emit('already_complete');
        return;
      }

      // Open or create the file
      this.fileHandle = await fs.open(this.filePath, 'w+'); // Read/write, create if not exists

      // Allocate file space if needed
      await this.allocateFile();

      this.emit('initialized', {
        filePath: this.filePath,
        fileSize: this.torrentMeta.length,
        totalPieces: this.pieces.length,
      });

    } catch (error) {
      throw new StorageError(`Failed to initialize storage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async checkExistingFile(): Promise<{ isComplete: boolean; size: number }> {
    try {
      const stats = await fs.stat(this.filePath);
      
      if (stats.size === this.torrentMeta.length) {
        // File exists with correct size, verify it's complete
        const isComplete = await this.verifyCompleteFile();
        return { isComplete, size: stats.size };
      }
      
      return { isComplete: false, size: stats.size };
    } catch (error) {
      // File doesn't exist or can't be accessed
      return { isComplete: false, size: 0 };
    }
  }

  private async verifyCompleteFile(): Promise<boolean> {
    let tempHandle: fs.FileHandle | undefined;
    
    try {
      // Open file for reading if we don't have a handle yet
      const handle = this.fileHandle || await fs.open(this.filePath, 'r');
      tempHandle = this.fileHandle ? undefined : handle;

      // Verify each piece hash
      for (const piece of this.pieces) {
        const offset = getFileOffset(piece.index, this.torrentMeta.pieceLength);
        const pieceData = Buffer.alloc(piece.length);
        
        const { bytesRead } = await handle.read(pieceData, 0, piece.length, offset);
        
        if (bytesRead !== piece.length) {
          return false;
        }

        const actualHash = crypto.createHash('sha1').update(pieceData).digest();
        const expectedHash = this.verifiedHashes.get(piece.index);
        
        if (!expectedHash || !actualHash.equals(expectedHash)) {
          return false;
        }
      }

      // All pieces verified successfully
      this.verifiedPieces = this.pieces.length;
      this.writtenBytes = this.torrentMeta.length;
      
      for (let i = 0; i < this.pieces.length; i++) {
        this.completedPieces.add(i);
      }

      return true;
    } catch (error) {
      return false;
    } finally {
      // Close temporary handle if we opened one
      if (tempHandle) {
        try {
          await tempHandle.close();
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  private async allocateFile(): Promise<void> {
    if (!this.fileHandle || this.fileAllocated) {
      return;
    }

    try {
      // Truncate/extend file to final size to pre-allocate space
      await this.fileHandle.truncate(this.torrentMeta.length);
      this.fileAllocated = true;

      this.emit('file_allocated', {
        filePath: this.filePath,
        size: this.torrentMeta.length,
      });

    } catch (error) {
      throw new StorageError(`Failed to allocate file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  addBlock(pieceIndex: number, blockOffset: number, blockData: Buffer): void {
    if (pieceIndex < 0 || pieceIndex >= this.pieces.length) {
      throw new StorageError(`Invalid piece index: ${pieceIndex}`);
    }

    const piece = this.pieces[pieceIndex];
    
    // Validate block offset and size
    if (blockOffset < 0 || blockOffset >= piece.length) {
      throw new StorageError(`Invalid block offset ${blockOffset} for piece ${pieceIndex}`);
    }

    const expectedBlockSize = Math.min(this.blockSize, piece.length - blockOffset);
    if (blockData.length !== expectedBlockSize) {
      throw new StorageError(`Invalid block size: expected ${expectedBlockSize}, got ${blockData.length}`);
    }

    // Get or create piece buffer
    let pieceBuffer = this.pieceBuffers.get(pieceIndex);
    if (!pieceBuffer) {
      pieceBuffer = {
        pieceIndex,
        data: Buffer.alloc(piece.length),
        receivedBlocks: new Map(),
        expectedLength: piece.length,
        isComplete: false,
      };
      this.pieceBuffers.set(pieceIndex, pieceBuffer);
    }

    // Check if block already received
    if (pieceBuffer.receivedBlocks.has(blockOffset)) {
      // Block already received, ignore duplicate
      return;
    }

    // Add block to piece buffer
    blockData.copy(pieceBuffer.data, blockOffset);
    pieceBuffer.receivedBlocks.set(blockOffset, blockData);

    // Check if piece is complete
    const expectedBlocks = Math.ceil(piece.length / this.blockSize);
    if (pieceBuffer.receivedBlocks.size === expectedBlocks) {
      pieceBuffer.isComplete = true;
      this.completePiece(pieceIndex);
    }

    this.emit('block_added', {
      pieceIndex,
      blockOffset,
      blockSize: blockData.length,
      pieceProgress: pieceBuffer.receivedBlocks.size / expectedBlocks,
    });
  }

  private async completePiece(pieceIndex: number): Promise<void> {
    const pieceBuffer = this.pieceBuffers.get(pieceIndex);
    const piece = this.pieces[pieceIndex];
    
    if (!pieceBuffer || !piece || !this.fileHandle) {
      return;
    }

    try {
      // Verify piece hash
      const actualHash = crypto.createHash('sha1').update(pieceBuffer.data).digest();
      const expectedHash = this.verifiedHashes.get(pieceIndex);

      if (!expectedHash || !actualHash.equals(expectedHash)) {
        this.emit('piece_hash_failed', {
          pieceIndex,
          expectedHash: expectedHash?.toString('hex'),
          actualHash: actualHash.toString('hex'),
        });

        // Remove invalid piece buffer
        this.pieceBuffers.delete(pieceIndex);
        return;
      }

      // Write piece to file at correct offset
      const fileOffset = getFileOffset(pieceIndex, this.torrentMeta.pieceLength);
      
      await this.fileHandle.write(pieceBuffer.data, 0, piece.length, fileOffset);
      
      // Ensure data is written to disk
      await this.fileHandle.sync();

      // Update tracking
      this.completedPieces.add(pieceIndex);
      this.verifiedPieces++;
      this.writtenBytes += piece.length;

      // Clean up piece buffer
      this.pieceBuffers.delete(pieceIndex);

      this.emit('piece_completed', {
        pieceIndex,
        length: piece.length,
        fileOffset,
        totalCompleted: this.completedPieces.size,
        totalPieces: this.pieces.length,
      });

      // Check if download is complete
      if (this.completedPieces.size === this.pieces.length) {
        await this.handleDownloadComplete();
      }

    } catch (error) {
      this.emit('piece_write_failed', {
        pieceIndex,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Remove failed piece buffer for retry
      this.pieceBuffers.delete(pieceIndex);
    }
  }

  private async handleDownloadComplete(): Promise<void> {
    try {
      // Final sync to ensure all data is written
      if (this.fileHandle) {
        await this.fileHandle.sync();
      }

      // Perform final verification
      const isValid = await this.verifyCompleteFile();
      
      if (isValid) {
        this.emit('download_completed', {
          filePath: this.filePath,
          totalSize: this.torrentMeta.length,
          totalPieces: this.pieces.length,
        });
      } else {
        this.emit('download_verification_failed', {
          filePath: this.filePath,
        });
      }

    } catch (error) {
      this.emit('download_completion_error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Public query methods
  hasPiece(pieceIndex: number): boolean {
    return this.completedPieces.has(pieceIndex);
  }

  getPieceProgress(pieceIndex: number): number {
    const pieceBuffer = this.pieceBuffers.get(pieceIndex);
    if (!pieceBuffer) {
      return this.completedPieces.has(pieceIndex) ? 1.0 : 0.0;
    }

    const piece = this.pieces[pieceIndex];
    const expectedBlocks = Math.ceil(piece.length / this.blockSize);
    return pieceBuffer.receivedBlocks.size / expectedBlocks;
  }

  getReceivedBlocks(pieceIndex: number): Set<number> {
    const pieceBuffer = this.pieceBuffers.get(pieceIndex);
    if (!pieceBuffer) {
      return new Set();
    }

    return new Set(pieceBuffer.receivedBlocks.keys());
  }

  getMissingBlocks(pieceIndex: number): number[] {
    if (pieceIndex < 0 || pieceIndex >= this.pieces.length) {
      return []; // Invalid piece index
    }

    if (this.completedPieces.has(pieceIndex)) {
      return [];
    }

    const piece = this.pieces[pieceIndex];
    const pieceBuffer = this.pieceBuffers.get(pieceIndex);
    const receivedBlocks = pieceBuffer ? new Set(pieceBuffer.receivedBlocks.keys()) : new Set();

    const missingBlocks: number[] = [];
    const numBlocks = Math.ceil(piece.length / this.blockSize);

    for (let i = 0; i < numBlocks; i++) {
      const blockOffset = i * this.blockSize;
      if (!receivedBlocks.has(blockOffset)) {
        missingBlocks.push(blockOffset);
      }
    }

    return missingBlocks;
  }

  getStats(): StorageStats {
    return {
      totalSize: this.torrentMeta.length,
      allocatedSize: this.fileAllocated ? this.torrentMeta.length : 0,
      writtenSize: this.writtenBytes,
      verifiedPieces: this.verifiedPieces,
      totalPieces: this.pieces.length,
      filePath: this.filePath,
      isComplete: this.completedPieces.size === this.pieces.length,
    };
  }

  getBytesDownloaded(): number {
    return this.writtenBytes;
  }

  getCompletionPercentage(): number {
    if (this.torrentMeta.length === 0) {
      return 100;
    }
    return (this.writtenBytes / this.torrentMeta.length) * 100;
  }

  isComplete(): boolean {
    return this.completedPieces.size === this.pieces.length;
  }

  getCompletedPieces(): Set<number> {
    return new Set(this.completedPieces);
  }

  // File operations
  async readPiece(pieceIndex: number): Promise<Buffer> {
    if (!this.fileHandle) {
      throw new StorageError('Storage not initialized');
    }

    if (!this.completedPieces.has(pieceIndex)) {
      throw new StorageError(`Piece ${pieceIndex} not completed`);
    }

    const piece = this.pieces[pieceIndex];
    const offset = getFileOffset(pieceIndex, this.torrentMeta.pieceLength);
    const pieceData = Buffer.alloc(piece.length);

    try {
      const { bytesRead } = await this.fileHandle.read(pieceData, 0, piece.length, offset);
      
      if (bytesRead !== piece.length) {
        throw new StorageError(`Failed to read complete piece ${pieceIndex}`);
      }

      return pieceData;
    } catch (error) {
      throw new StorageError(`Failed to read piece ${pieceIndex}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async flush(): Promise<void> {
    if (this.fileHandle) {
      try {
        await this.fileHandle.sync();
      } catch (error) {
        throw new StorageError(`Failed to flush file: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }
  }

  // Cleanup
  async close(): Promise<void> {
    try {
      if (this.fileHandle) {
        await this.fileHandle.close();
        this.fileHandle = undefined;
      }
    } catch (error) {
      throw new StorageError(`Failed to close file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async destroy(): Promise<void> {
    await this.close();
    
    // Clear all buffers and state
    this.pieceBuffers.clear();
    this.completedPieces.clear();
    this.verifiedHashes.clear();
    
    this.removeAllListeners();
  }

  // Utility methods
  validatePieceIndex(pieceIndex: number): void {
    if (pieceIndex < 0 || pieceIndex >= this.pieces.length) {
      throw new StorageError(`Invalid piece index: ${pieceIndex}, valid range: 0-${this.pieces.length - 1}`);
    }
  }

  getBlockSize(pieceIndex: number, blockOffset: number): number {
    this.validatePieceIndex(pieceIndex);
    
    const piece = this.pieces[pieceIndex];
    const remainingBytes = piece.length - blockOffset;
    return Math.min(this.blockSize, remainingBytes);
  }

  getTotalBlocks(pieceIndex: number): number {
    this.validatePieceIndex(pieceIndex);
    
    const piece = this.pieces[pieceIndex];
    return Math.ceil(piece.length / this.blockSize);
  }

  // Recovery and maintenance
  async repairFile(): Promise<boolean> {
    if (!this.fileHandle) {
      return false;
    }

    try {
      let repairedPieces = 0;

      // Verify all pieces and identify corrupted ones
      for (const piece of this.pieces) {
        const offset = getFileOffset(piece.index, this.torrentMeta.pieceLength);
        const pieceData = Buffer.alloc(piece.length);
        
        const { bytesRead } = await this.fileHandle.read(pieceData, 0, piece.length, offset);
        
        if (bytesRead !== piece.length) {
          continue;
        }

        const actualHash = crypto.createHash('sha1').update(pieceData).digest();
        const expectedHash = this.verifiedHashes.get(piece.index);
        
        if (expectedHash && actualHash.equals(expectedHash)) {
          if (!this.completedPieces.has(piece.index)) {
            this.completedPieces.add(piece.index);
            this.verifiedPieces++;
            this.writtenBytes += piece.length;
            repairedPieces++;
          }
        } else {
          // Remove corrupted piece from completed set
          if (this.completedPieces.has(piece.index)) {
            this.completedPieces.delete(piece.index);
            this.verifiedPieces--;
            this.writtenBytes -= piece.length;
          }
        }
      }

      if (repairedPieces > 0) {
        this.emit('file_repaired', {
          repairedPieces,
          totalCompleted: this.completedPieces.size,
        });
      }

      return repairedPieces > 0;

    } catch (error) {
      this.emit('repair_failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }
}