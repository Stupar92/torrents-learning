import { decode, encode, BencodeError } from './bencode';

describe('Bencode Decoder', () => {
  describe('Integers', () => {
    test('decodes positive integer', () => {
      const result = decode(Buffer.from('i42e'));
      expect(result).toBe(42);
    });

    test('decodes negative integer', () => {
      const result = decode(Buffer.from('i-42e'));
      expect(result).toBe(-42);
    });

    test('decodes zero', () => {
      const result = decode(Buffer.from('i0e'));
      expect(result).toBe(0);
    });

    test('throws on invalid integer format', () => {
      expect(() => decode(Buffer.from('ie'))).toThrow(BencodeError);
      expect(() => decode(Buffer.from('i-e'))).toThrow(BencodeError);
      expect(() => decode(Buffer.from('iabce'))).toThrow(BencodeError);
    });

    test('throws on leading zeros', () => {
      expect(() => decode(Buffer.from('i042e'))).toThrow(BencodeError);
    });

    test('throws on -0', () => {
      expect(() => decode(Buffer.from('i-0e'))).toThrow(BencodeError);
    });

    test('throws on unterminated integer', () => {
      expect(() => decode(Buffer.from('i42'))).toThrow(BencodeError);
    });
  });

  describe('Strings', () => {
    test('decodes string', () => {
      const result = decode(Buffer.from('4:spam'));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).toString()).toBe('spam');
    });

    test('decodes empty string', () => {
      const result = decode(Buffer.from('0:'));
      expect(Buffer.isBuffer(result)).toBe(true);
      expect((result as Buffer).length).toBe(0);
    });

    test('decodes binary data', () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      const encoded = Buffer.concat([Buffer.from('4:'), binaryData]);
      const result = decode(encoded);
      expect(Buffer.isBuffer(result)).toBe(true);
      expect(Buffer.compare(result as Buffer, binaryData)).toBe(0);
    });

    test('throws on invalid string length', () => {
      expect(() => decode(Buffer.from(':spam'))).toThrow(BencodeError);
      expect(() => decode(Buffer.from('04:spam'))).toThrow(BencodeError);
      expect(() => decode(Buffer.from('-1:'))).toThrow(BencodeError);
    });

    test('throws on unterminated string length', () => {
      expect(() => decode(Buffer.from('4spam'))).toThrow(BencodeError);
    });

    test('throws on string extending beyond data', () => {
      expect(() => decode(Buffer.from('10:short'))).toThrow(BencodeError);
    });
  });

  describe('Lists', () => {
    test('decodes empty list', () => {
      const result = decode(Buffer.from('le'));
      expect(Array.isArray(result)).toBe(true);
      expect((result as []).length).toBe(0);
    });

    test('decodes list with integers', () => {
      const result = decode(Buffer.from('li42ei-42ei0ee'));
      expect(result).toEqual([42, -42, 0]);
    });

    test('decodes list with strings', () => {
      const result = decode(Buffer.from('l4:spam4:eggse'));
      const expected = [Buffer.from('spam'), Buffer.from('eggs')];
      expect(Array.isArray(result)).toBe(true);
      expect((result as Buffer[]).length).toBe(2);
      expect(Buffer.compare((result as Buffer[])[0], expected[0])).toBe(0);
      expect(Buffer.compare((result as Buffer[])[1], expected[1])).toBe(0);
    });

    test('decodes nested lists', () => {
      const result = decode(Buffer.from('lli42eeli43eee'));
      expect(result).toEqual([[42], [43]]);
    });

    test('throws on unterminated list', () => {
      expect(() => decode(Buffer.from('li42e'))).toThrow(BencodeError);
    });
  });

  describe('Dictionaries', () => {
    test('decodes empty dictionary', () => {
      const result = decode(Buffer.from('de'));
      expect(typeof result).toBe('object');
      expect(result).not.toBeNull();
      expect(Object.keys(result as object).length).toBe(0);
    });

    test('decodes dictionary with string keys and values', () => {
      const result = decode(Buffer.from('d4:spam4:eggse'));
      expect(typeof result).toBe('object');
      const dict = result as { [key: string]: Buffer };
      expect(Object.keys(dict)).toEqual(['spam']);
      expect(Buffer.compare(dict['spam'], Buffer.from('eggs'))).toBe(0);
    });

    test('decodes dictionary with integer values', () => {
      const result = decode(Buffer.from('d3:agei25ee'));
      expect(result).toEqual({ age: 25 });
    });

    test('decodes nested dictionary', () => {
      const result = decode(Buffer.from('d4:dictd3:keyi42eee'));
      expect(result).toEqual({ dict: { key: 42 } });
    });

    test('throws on non-string keys', () => {
      expect(() => decode(Buffer.from('di42ei43ee'))).toThrow(BencodeError);
    });

    test('throws on keys not in ascending order', () => {
      expect(() => decode(Buffer.from('d1:bi1e1:ai2ee'))).toThrow(BencodeError);
    });

    test('throws on unterminated dictionary', () => {
      expect(() => decode(Buffer.from('d3:agei25e'))).toThrow(BencodeError);
    });
  });

  describe('Complex structures', () => {
    test('decodes complex nested structure', () => {
      // Simplified test with properly ordered keys
      const result = decode(Buffer.from('d8:announce9:localhost4:infod6:lengthi1000e4:name8:test.txtee'));
      
      expect(typeof result).toBe('object');
      const dict = result as { [key: string]: any };
      expect(Buffer.compare(dict.announce as Buffer, Buffer.from('localhost'))).toBe(0);
      expect(Buffer.compare(dict.info.name as Buffer, Buffer.from('test.txt'))).toBe(0);
      expect(dict.info.length).toBe(1000);
    });
  });

  describe('Error handling', () => {
    test('throws on unexpected end of data', () => {
      expect(() => decode(Buffer.from(''))).toThrow(BencodeError);
    });

    test('throws on unexpected character', () => {
      expect(() => decode(Buffer.from('x'))).toThrow(BencodeError);
    });

    test('throws on extra data after valid bencode', () => {
      expect(() => decode(Buffer.from('i42eextra'))).toThrow(BencodeError);
    });
  });
});

describe('Bencode Encoder', () => {
  describe('Integers', () => {
    test('encodes positive integer', () => {
      const result = encode(42);
      expect(result).toEqual(Buffer.from('i42e'));
    });

    test('encodes negative integer', () => {
      const result = encode(-42);
      expect(result).toEqual(Buffer.from('i-42e'));
    });

    test('encodes zero', () => {
      const result = encode(0);
      expect(result).toEqual(Buffer.from('i0e'));
    });
  });

  describe('Strings', () => {
    test('encodes string', () => {
      const result = encode(Buffer.from('spam'));
      expect(result).toEqual(Buffer.from('4:spam'));
    });

    test('encodes empty string', () => {
      const result = encode(Buffer.from(''));
      expect(result).toEqual(Buffer.from('0:'));
    });

    test('encodes binary data', () => {
      const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      const result = encode(binaryData);
      const expected = Buffer.concat([Buffer.from('4:'), binaryData]);
      expect(Buffer.compare(result, expected)).toBe(0);
    });
  });

  describe('Lists', () => {
    test('encodes empty list', () => {
      const result = encode([]);
      expect(result).toEqual(Buffer.from('le'));
    });

    test('encodes list with integers', () => {
      const result = encode([42, -42, 0]);
      expect(result).toEqual(Buffer.from('li42ei-42ei0ee'));
    });

    test('encodes list with strings', () => {
      const result = encode([Buffer.from('spam'), Buffer.from('eggs')]);
      expect(result).toEqual(Buffer.from('l4:spam4:eggse'));
    });

    test('encodes nested lists', () => {
      const result = encode([[42], [43]]);
      expect(result).toEqual(Buffer.from('lli42eeli43eee'));
    });
  });

  describe('Dictionaries', () => {
    test('encodes empty dictionary', () => {
      const result = encode({});
      expect(result).toEqual(Buffer.from('de'));
    });

    test('encodes dictionary with string values', () => {
      const result = encode({ spam: Buffer.from('eggs') });
      expect(result).toEqual(Buffer.from('d4:spam4:eggse'));
    });

    test('encodes dictionary with integer values', () => {
      const result = encode({ age: 25 });
      expect(result).toEqual(Buffer.from('d3:agei25ee'));
    });

    test('encodes dictionary with sorted keys', () => {
      const result = encode({ z: 1, a: 2, m: 3 });
      expect(result).toEqual(Buffer.from('d1:ai2e1:mi3e1:zi1ee'));
    });
  });

  describe('Round-trip encoding/decoding', () => {
    test('integer round-trip', () => {
      const original = 42;
      const encoded = encode(original);
      const decoded = decode(encoded);
      expect(decoded).toBe(original);
    });

    test('string round-trip', () => {
      const original = Buffer.from('hello world');
      const encoded = encode(original);
      const decoded = decode(encoded);
      expect(Buffer.compare(decoded as Buffer, original)).toBe(0);
    });

    test('list round-trip', () => {
      const original = [1, Buffer.from('test'), [2, 3]];
      const encoded = encode(original);
      const decoded = decode(encoded);
      expect(decoded).toEqual(original);
    });

    test('dictionary round-trip', () => {
      const original = {
        number: 42,
        string: Buffer.from('value'),
        list: [1, 2, 3],
        nested: { key: Buffer.from('nested') }
      };
      const encoded = encode(original);
      const decoded = decode(encoded);
      expect(decoded).toEqual(original);
    });
  });

  describe('Error handling', () => {
    test('throws on unsupported type', () => {
      expect(() => encode(null as any)).toThrow(BencodeError);
      expect(() => encode(undefined as any)).toThrow(BencodeError);
      expect(() => encode(Symbol('test') as any)).toThrow(BencodeError);
    });
  });
});