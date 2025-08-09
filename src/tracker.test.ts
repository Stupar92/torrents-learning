import * as http from 'http';
import * as crypto from 'crypto';
import { TrackerClient, generatePeerId, validatePeerId, TrackerError, Peer, AnnounceRequest } from './tracker';
import { encode } from './bencode';

describe('Tracker Module', () => {
  let server: http.Server;
  let serverPort: number;
  let serverUrl: string;

  beforeAll((done) => {
    server = http.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        serverPort = address.port;
        serverUrl = `http://localhost:${serverPort}`;
        done();
      }
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    server.removeAllListeners('request');
  });

  describe('generatePeerId', () => {
    test('generates valid peer ID with default prefix', () => {
      const peerId = generatePeerId();
      expect(peerId.length).toBe(20);
      expect(peerId.toString('ascii')).toMatch(/^-JS0001-/);
    });

    test('generates valid peer ID with custom prefix', () => {
      const peerId = generatePeerId('-TEST01-');
      expect(peerId.length).toBe(20);
      expect(peerId.toString('ascii')).toMatch(/^-TEST01-/);
    });

    test('throws on prefix too long', () => {
      expect(() => generatePeerId('this-prefix-is-way-too-long')).toThrow(TrackerError);
    });

    test('generates different peer IDs on successive calls', () => {
      const peerId1 = generatePeerId();
      const peerId2 = generatePeerId();
      expect(Buffer.compare(peerId1, peerId2)).not.toBe(0);
    });
  });

  describe('validatePeerId', () => {
    test('validates correct peer ID length', () => {
      const peerId = Buffer.alloc(20, 'a');
      expect(validatePeerId(peerId)).toBe(true);
    });

    test('rejects incorrect peer ID length', () => {
      expect(validatePeerId(Buffer.alloc(19, 'a'))).toBe(false);
      expect(validatePeerId(Buffer.alloc(21, 'a'))).toBe(false);
    });
  });

  describe('TrackerClient', () => {
    let client: TrackerClient;
    let mockRequest: AnnounceRequest;

    beforeEach(() => {
      client = new TrackerClient(5000); // Short timeout for tests
      mockRequest = {
        infoHash: crypto.randomBytes(20),
        peerId: generatePeerId(),
        port: 6881,
        uploaded: 0,
        downloaded: 0,
        left: 1000,
        compact: true,
        event: 'started',
        numWant: 50,
      };
    });

    describe('URL building', () => {
      test('builds correct announce URL with required parameters', async () => {
        let capturedUrl: string = '';
        
        server.on('request', (req, res) => {
          capturedUrl = req.url || '';
          const response = encode({
            interval: 1800,
            peers: Buffer.alloc(0), // Empty peer list
          });
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(response);
        });

        try {
          await client.announce(serverUrl + '/announce', mockRequest);
        } catch {
          // Ignore response parsing errors, we just want to check URL
        }

        expect(capturedUrl).toContain('info_hash=');
        expect(capturedUrl).toContain('peer_id=');
        expect(capturedUrl).toContain('port=6881');
        expect(capturedUrl).toContain('uploaded=0');
        expect(capturedUrl).toContain('downloaded=0');
        expect(capturedUrl).toContain('left=1000');
        expect(capturedUrl).toContain('compact=1');
        expect(capturedUrl).toContain('event=started');
        expect(capturedUrl).toContain('numwant=50');
      });

      test('properly URL encodes info hash and peer ID', async () => {
        const infoHash = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x20, 0x21]);
        const peerId = Buffer.from('-TEST01-12345678901');
        
        let capturedUrl: string = '';
        
        server.on('request', (req, res) => {
          capturedUrl = req.url || '';
          const response = encode({ interval: 1800, peers: Buffer.alloc(0) });
          res.writeHead(200);
          res.end(response);
        });

        try {
          await client.announce(serverUrl + '/announce', {
            ...mockRequest,
            infoHash,
            peerId,
          });
        } catch {
          // Ignore response parsing errors
        }

        expect(capturedUrl).toContain('info_hash=%00%01%ff%fe%20%21');
        expect(capturedUrl).toContain('peer_id=%2d%54%45%53%54%30%31%2d%31%32%33%34%35%36%37%38%39%30%31');
      });
    });

    describe('Response parsing', () => {
      test('parses successful response with compact peers', async () => {
        const peers = Buffer.concat([
          Buffer.from([192, 168, 1, 100]), Buffer.from([0x1A, 0xE1]), // 192.168.1.100:6881
          Buffer.from([10, 0, 0, 1]), Buffer.from([0x1A, 0xE2]),       // 10.0.0.1:6882
        ]);

        const response = encode({
          interval: 1800,
          'min interval': 900,
          complete: 5,
          incomplete: 10,
          peers,
        });

        server.on('request', (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(response);
        });

        const result = await client.announce(serverUrl + '/announce', mockRequest);

        expect(result.interval).toBe(1800);
        expect(result.minInterval).toBe(900);
        expect(result.complete).toBe(5);
        expect(result.incomplete).toBe(10);
        expect(result.peers).toHaveLength(2);
        expect(result.peers[0]).toEqual({ ip: '192.168.1.100', port: 6881 });
        expect(result.peers[1]).toEqual({ ip: '10.0.0.1', port: 6882 });
      });

      test('parses response with dictionary peers', async () => {
        const response = encode({
          interval: 1800,
          peers: [
            { ip: Buffer.from('192.168.1.100'), port: 6881 },
            { ip: Buffer.from('10.0.0.1'), port: 6882 },
          ],
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        const result = await client.announce(serverUrl + '/announce', mockRequest);

        expect(result.peers).toHaveLength(2);
        expect(result.peers[0]).toEqual({ ip: '192.168.1.100', port: 6881 });
        expect(result.peers[1]).toEqual({ ip: '10.0.0.1', port: 6882 });
      });

      test('handles empty peer list', async () => {
        const response = encode({
          interval: 1800,
          peers: Buffer.alloc(0), // Empty compact peers
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        const result = await client.announce(serverUrl + '/announce', mockRequest);

        expect(result.interval).toBe(1800);
        expect(result.peers).toHaveLength(0);
      });

      test('parses optional fields', async () => {
        const response = encode({
          interval: 1800,
          'min interval': 900,
          'tracker id': Buffer.from('unique-tracker-id'),
          complete: 100,
          incomplete: 50,
          'warning message': Buffer.from('This is a warning'),
          peers: Buffer.alloc(0),
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        const result = await client.announce(serverUrl + '/announce', mockRequest);

        expect(result.trackerId).toBe('unique-tracker-id');
        expect(result.warningMessage).toBe('This is a warning');
      });
    });

    describe('Error handling', () => {
      test('throws on tracker failure reason', async () => {
        const response = encode({
          'failure reason': Buffer.from('Torrent not registered'),
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Tracker failure reason: Torrent not registered');
      });

      test('throws on HTTP error status', async () => {
        server.on('request', (req, res) => {
          res.writeHead(404, 'Not Found');
          res.end();
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('HTTP 404: Not Found');
      });

      test('throws on invalid bencode response', async () => {
        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end('not bencode');
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Invalid bencode response');
      });

      test('throws on non-dictionary response', async () => {
        const response = encode([Buffer.from('not'), Buffer.from('a'), Buffer.from('dictionary')]);

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Response must be a dictionary');
      });

      test('throws on missing interval', async () => {
        const response = encode({
          peers: Buffer.alloc(0),
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Missing or invalid interval');
      });

      test('throws on missing peers', async () => {
        const response = encode({
          interval: 1800,
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Missing peers field');
      });

      test('throws on invalid compact peers length', async () => {
        const response = encode({
          interval: 1800,
          peers: Buffer.alloc(5), // Not multiple of 6
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Compact peers data length must be multiple of 6');
      });

      test('throws on invalid dictionary peer format', async () => {
        const response = encode({
          interval: 1800,
          peers: [
            { ip: 12345, port: 6881 }, // ip should be Buffer, not number
          ],
        });

        server.on('request', (req, res) => {
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Invalid peer IP format');
      });

      test('throws on connection timeout', async () => {
        const shortTimeoutClient = new TrackerClient(100);

        server.on('request', (req, res) => {
          // Don't respond, let it timeout
        });

        await expect(shortTimeoutClient.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Request timeout');
      }, 10000);

      test('throws on network error', async () => {
        await expect(client.announce('http://non-existent-host.invalid/announce', mockRequest))
          .rejects.toThrow('Request failed');
      });
    });

    describe('Retry mechanism', () => {
      test('retries on network errors and succeeds eventually', async () => {
        let attempts = 0;
        
        server.on('request', (req, res) => {
          attempts++;
          if (attempts < 2) {
            // Simulate network error by destroying connection
            req.socket.destroy();
            return;
          }
          
          // Succeed on second attempt
          const response = encode({
            interval: 1800,
            peers: Buffer.alloc(0),
          });
          res.writeHead(200);
          res.end(response);
        });

        const result = await client.announce(serverUrl + '/announce', mockRequest);
        
        expect(attempts).toBe(2);
        expect(result.interval).toBe(1800);
      });

      test('does not retry on tracker failure reason', async () => {
        let attempts = 0;
        
        server.on('request', (req, res) => {
          attempts++;
          const response = encode({
            'failure reason': Buffer.from('Torrent not found'),
          });
          res.writeHead(200);
          res.end(response);
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Tracker failure reason: Torrent not found');
          
        expect(attempts).toBe(1); // Should not retry
      });

      test('fails after max retries', async () => {
        let attempts = 0;
        
        server.on('request', (req, res) => {
          attempts++;
          req.socket.destroy(); // Always fail
        });

        await expect(client.announce(serverUrl + '/announce', mockRequest))
          .rejects.toThrow('Failed to announce after 3 attempts');
          
        expect(attempts).toBe(3);
      });
    });

    describe('Redirect handling', () => {
      test('follows HTTP redirects', async () => {
        let requestCount = 0;
        
        server.on('request', (req, res) => {
          requestCount++;
          
          if (requestCount === 1) {
            // First request: redirect
            res.writeHead(302, { Location: serverUrl + '/redirected' });
            res.end();
          } else {
            // Second request: success
            const response = encode({
              interval: 1800,
              peers: Buffer.alloc(0),
            });
            res.writeHead(200);
            res.end(response);
          }
        });

        const result = await client.announce(serverUrl + '/announce', mockRequest);
        
        expect(requestCount).toBe(2);
        expect(result.interval).toBe(1800);
      });
    });

    describe('Parameter variations', () => {
      test('handles request without optional parameters', async () => {
        const minimalRequest: AnnounceRequest = {
          infoHash: crypto.randomBytes(20),
          peerId: generatePeerId(),
          port: 6881,
          uploaded: 0,
          downloaded: 0,
          left: 1000,
          compact: true,
        };

        let capturedUrl: string = '';
        
        server.on('request', (req, res) => {
          capturedUrl = req.url || '';
          const response = encode({ interval: 1800, peers: Buffer.alloc(0) });
          res.writeHead(200);
          res.end(response);
        });

        await client.announce(serverUrl + '/announce', minimalRequest);

        expect(capturedUrl).toContain('numwant=50'); // Default value
        expect(capturedUrl).not.toContain('event=');
        expect(capturedUrl).not.toContain('no_peer_id=');
      });

      test('includes optional parameters when provided', async () => {
        const fullRequest: AnnounceRequest = {
          infoHash: crypto.randomBytes(20),
          peerId: generatePeerId(),
          port: 6881,
          uploaded: 100,
          downloaded: 200,
          left: 1000,
          compact: false,
          noPeerId: true,
          event: 'completed',
          numWant: 25,
        };

        let capturedUrl: string = '';
        
        server.on('request', (req, res) => {
          capturedUrl = req.url || '';
          const response = encode({ interval: 1800, peers: [] });
          res.writeHead(200);
          res.end(response);
        });

        await client.announce(serverUrl + '/announce', fullRequest);

        expect(capturedUrl).toContain('compact=0');
        expect(capturedUrl).toContain('no_peer_id=1');
        expect(capturedUrl).toContain('event=completed');
        expect(capturedUrl).toContain('numwant=25');
      });
    });
  });
});