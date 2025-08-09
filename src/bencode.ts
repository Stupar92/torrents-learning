export type BencodeValue = number | Buffer | BencodeValue[] | { [key: string]: BencodeValue };

export class BencodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BencodeError';
  }
}

export function decode(data: Buffer): BencodeValue {
  const state = { offset: 0 };
  const result = decodeValue(data, state);
  
  if (state.offset !== data.length) {
    throw new BencodeError('Unexpected data after bencode value');
  }
  
  return result;
}

export function encode(value: BencodeValue): Buffer {
  return Buffer.concat(encodeValue(value));
}

function decodeValue(data: Buffer, state: { offset: number }): BencodeValue {
  if (state.offset >= data.length) {
    throw new BencodeError('Unexpected end of data');
  }
  
  const char = String.fromCharCode(data[state.offset]);
  
  if (char === 'i') {
    return decodeInteger(data, state);
  } else if (char === 'l') {
    return decodeList(data, state);
  } else if (char === 'd') {
    return decodeDictionary(data, state);
  } else if (char >= '0' && char <= '9') {
    return decodeString(data, state);
  } else {
    throw new BencodeError(`Unexpected character: ${char}`);
  }
}

function decodeInteger(data: Buffer, state: { offset: number }): number {
  state.offset++; // skip 'i'
  
  let endIndex = data.indexOf(0x65, state.offset); // find 'e'
  if (endIndex === -1) {
    throw new BencodeError('Integer not terminated with "e"');
  }
  
  const numberStr = data.subarray(state.offset, endIndex).toString('ascii');
  
  if (numberStr === '' || numberStr === '-') {
    throw new BencodeError('Invalid integer format');
  }
  
  // Check for leading zeros (except for "0")
  if (numberStr.length > 1 && numberStr[0] === '0') {
    throw new BencodeError('Invalid integer: leading zeros not allowed');
  }
  
  // Check for "-0"
  if (numberStr === '-0') {
    throw new BencodeError('Invalid integer: -0 not allowed');
  }
  
  const number = parseInt(numberStr, 10);
  
  if (isNaN(number)) {
    throw new BencodeError('Invalid integer format');
  }
  
  state.offset = endIndex + 1; // skip 'e'
  return number;
}

function decodeString(data: Buffer, state: { offset: number }): Buffer {
  const colonIndex = data.indexOf(0x3a, state.offset); // find ':'
  if (colonIndex === -1) {
    throw new BencodeError('String length not terminated with ":"');
  }
  
  const lengthStr = data.subarray(state.offset, colonIndex).toString('ascii');
  
  if (lengthStr === '' || (lengthStr.length > 1 && lengthStr[0] === '0')) {
    throw new BencodeError('Invalid string length format');
  }
  
  const length = parseInt(lengthStr, 10);
  
  if (isNaN(length) || length < 0) {
    throw new BencodeError('Invalid string length');
  }
  
  const startIndex = colonIndex + 1;
  const endIndex = startIndex + length;
  
  if (endIndex > data.length) {
    throw new BencodeError('String extends beyond data boundaries');
  }
  
  const result = data.subarray(startIndex, endIndex);
  state.offset = endIndex;
  
  return result;
}

function decodeList(data: Buffer, state: { offset: number }): BencodeValue[] {
  state.offset++; // skip 'l'
  
  const result: BencodeValue[] = [];
  
  while (state.offset < data.length && data[state.offset] !== 0x65) { // not 'e'
    result.push(decodeValue(data, state));
  }
  
  if (state.offset >= data.length) {
    throw new BencodeError('List not terminated with "e"');
  }
  
  state.offset++; // skip 'e'
  return result;
}

function decodeDictionary(data: Buffer, state: { offset: number }): { [key: string]: BencodeValue } {
  state.offset++; // skip 'd'
  
  const result: { [key: string]: BencodeValue } = {};
  let lastKey: string | null = null;
  
  while (state.offset < data.length && data[state.offset] !== 0x65) { // not 'e'
    // Keys must be strings
    const keyValue = decodeValue(data, state);
    if (!Buffer.isBuffer(keyValue)) {
      throw new BencodeError('Dictionary keys must be strings');
    }
    
    const key = keyValue.toString('binary');
    
    // Keys must be in lexicographical order
    if (lastKey !== null && key <= lastKey) {
      throw new BencodeError('Dictionary keys must be in ascending order');
    }
    
    lastKey = key;
    
    const value = decodeValue(data, state);
    result[key] = value;
  }
  
  if (state.offset >= data.length) {
    throw new BencodeError('Dictionary not terminated with "e"');
  }
  
  state.offset++; // skip 'e'
  return result;
}

function encodeValue(value: BencodeValue): Buffer[] {
  if (typeof value === 'number') {
    return [Buffer.from(`i${value}e`)];
  } else if (Buffer.isBuffer(value)) {
    return [Buffer.from(`${value.length}:`), value];
  } else if (Array.isArray(value)) {
    const parts: Buffer[] = [Buffer.from('l')];
    for (const item of value) {
      const itemParts = encodeValue(item);
      parts.push(...itemParts);
    }
    parts.push(Buffer.from('e'));
    return parts;
  } else if (typeof value === 'object' && value !== null) {
    const parts: Buffer[] = [Buffer.from('d')];
    
    // Sort keys for deterministic encoding
    const keys = Object.keys(value).sort();
    
    for (const key of keys) {
      const keyParts = encodeValue(Buffer.from(key, 'binary'));
      const valueParts = encodeValue(value[key]);
      parts.push(...keyParts);
      parts.push(...valueParts);
    }
    
    parts.push(Buffer.from('e'));
    return parts;
  } else {
    throw new BencodeError(`Cannot encode value of type: ${typeof value}`);
  }
}