/**
 * Decompression for strings produced by lz-string's `compressToUTF16` codec.
 *
 * Vendored from lz-string (https://github.com/pieroxy/lz-string, MIT, © Pieroxy)
 * rather than imported as a dependency: lz-string ships as a UMD module whose
 * default export does not survive the adapter's esbuild CJS→IIFE interop, so the
 * bundled function comes back `undefined`. Vendoring the single decompression
 * path we need keeps the adapter bundle self-contained and bundler-agnostic.
 *
 * Only `decompressFromUTF16` is included — OneNote's WAC viewer caches page HTML
 * with `compressToUTF16`, and the adapter never compresses.
 */

const fromCharCode = String.fromCharCode;

interface DecompressState {
  val: number;
  position: number;
  index: number;
}

/**
 * Core LZW decompressor.
 *
 * @param length      Number of code units in the compressed input.
 * @param resetValue  Bit-position reset value (codec-specific: 16384 for UTF-16).
 * @param getNextValue Reads the integer value of the code unit at `index`.
 */
const decompress = (length: number, resetValue: number, getNextValue: (index: number) => number): string | null => {
  const dictionary: (string | number)[] = [0, 1, 2];
  let enlargeIn = 4;
  let dictSize = 4;
  let numBits = 3;
  let entry = '';
  const result: string[] = [];
  let w: string | number = '';
  let bits: number;
  let c: string | number = '';
  const data: DecompressState = { val: getNextValue(0), position: resetValue, index: 1 };

  const readBits = (numBitsToRead: number): number => {
    let value = 0;
    const max = 2 ** numBitsToRead;
    let pow = 1;
    while (pow !== max) {
      const resb = data.val & data.position;
      data.position >>= 1;
      if (data.position === 0) {
        data.position = resetValue;
        data.val = getNextValue(data.index++);
      }
      value |= (resb > 0 ? 1 : 0) * pow;
      pow <<= 1;
    }
    return value;
  };

  bits = readBits(2);
  switch (bits) {
    case 0:
      c = fromCharCode(readBits(8));
      break;
    case 1:
      c = fromCharCode(readBits(16));
      break;
    case 2:
      return '';
  }
  dictionary[3] = c;
  w = c;
  result.push(c as string);

  while (true) {
    if (data.index > length) return '';

    bits = readBits(numBits);
    c = bits;
    switch (c) {
      case 0:
        dictionary[dictSize++] = fromCharCode(readBits(8));
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 1:
        dictionary[dictSize++] = fromCharCode(readBits(16));
        c = dictSize - 1;
        enlargeIn--;
        break;
      case 2:
        return result.join('');
    }

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }

    if (dictionary[c as number]) {
      entry = dictionary[c as number] as string;
    } else if (c === dictSize) {
      entry = (w as string) + (w as string).charAt(0);
    } else {
      return null;
    }
    result.push(entry);

    dictionary[dictSize++] = (w as string) + entry.charAt(0);
    enlargeIn--;

    w = entry;

    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
};

/** Decompresses a string produced by lz-string's `compressToUTF16`. */
export const decompressFromUTF16 = (compressed: string | null | undefined): string | null => {
  if (compressed == null) return '';
  if (compressed === '') return null;
  return decompress(compressed.length, 16384, index => compressed.charCodeAt(index) - 32);
};
