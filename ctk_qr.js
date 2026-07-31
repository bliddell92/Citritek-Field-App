/**
 * Citritek Field App — Minimal QR encoder
 * =======================================
 *
 * Generates the QR code for "open this app on a phone" entirely in the
 * browser. No external service, so nothing is sent to a third party and
 * the feature can't break because someone else's API went down.
 *
 * Deliberately narrow scope — this only ever has to encode our own app URL:
 *   - Byte mode only
 *   - Error correction level M (~15% recovery)
 *   - Versions 1 to 6, i.e. up to 106 bytes (roughly 106 ASCII characters)
 *
 * Stopping at version 6 keeps this small: version 7 and above also need
 * version-information blocks, which we'd never use for a URL this short.
 *
 * Verified two ways: module-for-module against the Python `qrcode` reference
 * library with each of the 8 masks forced (byte-identical), and by decoding
 * the generated codes back with OpenCV's scanner.
 *
 * Note on mask selection: this picks the lowest-penalty mask per the spec's
 * four scoring rules. `python-qrcode` sometimes chooses a different one — an
 * independent implementation of the spec rules agrees with this file, so the
 * difference is in the reference library, not here. Either mask scans fine.
 */

(function (global) {
  'use strict';

  const BUILD = '0.9.0';   // must match ctk_schema.js, ctk_storage.js, index.html

  // total codewords, EC codewords per block, number of blocks — level M
  const SPEC = {
    1: { total: 26,  ecPerBlock: 10, blocks: 1 },
    2: { total: 44,  ecPerBlock: 16, blocks: 1 },
    3: { total: 70,  ecPerBlock: 26, blocks: 1 },
    4: { total: 100, ecPerBlock: 18, blocks: 2 },
    5: { total: 134, ecPerBlock: 24, blocks: 2 },
    6: { total: 172, ecPerBlock: 16, blocks: 4 },
  };

  // Alignment pattern centre for versions 2-6 (version 1 has none)
  const ALIGN = { 1: null, 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };

  // ---------------------------------------------------------------------------
  // GF(256) arithmetic for Reed-Solomon
  // ---------------------------------------------------------------------------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** Generator polynomial of the given degree. */
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Array(ecLen).fill(0);
    for (const byte of data) {
      const factor = byte ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecLen; i++) {
        res[i] ^= gfMul(gen[i + 1], factor);
      }
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // Data encoding
  // ---------------------------------------------------------------------------

  function toUtf8Bytes(str) {
    const out = [];
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else {
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63),
                 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (let v = 1; v <= 6; v++) {
      const s = SPEC[v];
      const dataCodewords = s.total - s.ecPerBlock * s.blocks;
      // 4 bits mode + 8 bits length + payload
      if (dataCodewords * 8 >= 4 + 8 + byteLen * 8) return v;
    }
    return null;
  }

  function buildCodewords(bytes, version) {
    const s = SPEC[version];
    const dataCodewords = s.total - s.ecPerBlock * s.blocks;

    const bits = [];
    const push = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };

    push(0b0100, 4);            // byte mode
    push(bytes.length, 8);      // char count (8 bits for versions 1-9)
    for (const b of bytes) push(b, 8);

    // Terminator, up to four zero bits
    const capacity = dataCodewords * 8;
    for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
    // Pad to a byte boundary
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      codewords.push(byte);
    }
    // Alternating pad bytes
    const PAD = [0xec, 0x11];
    let p = 0;
    while (codewords.length < dataCodewords) codewords.push(PAD[p++ % 2]);

    // Split into blocks, compute EC, then interleave
    const perBlock = dataCodewords / s.blocks;
    const dataBlocks = [], ecBlocks = [];
    for (let i = 0; i < s.blocks; i++) {
      const block = codewords.slice(i * perBlock, (i + 1) * perBlock);
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, s.ecPerBlock));
    }

    const out = [];
    for (let i = 0; i < perBlock; i++) {
      for (const b of dataBlocks) out.push(b[i]);
    }
    for (let i = 0; i < s.ecPerBlock; i++) {
      for (const b of ecBlocks) out.push(b[i]);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Module placement
  // ---------------------------------------------------------------------------

  function newMatrix(size) {
    const m = [];
    for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFinder(m, r, c) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        const inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
                       (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[rr][cc] = (inRing || inCore) ? 1 : 0;
      }
    }
  }

  function placeFunctionPatterns(m, version) {
    const size = m.length;

    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) {
      const bit = (i % 2 === 0) ? 1 : 0;
      if (m[6][i] === null) m[6][i] = bit;
      if (m[i][6] === null) m[i][6] = bit;
    }

    // Alignment pattern (versions 2-6 have exactly one)
    const a = ALIGN[version];
    if (a !== null) {
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          m[a + dr][a + dc] = (ring === 1) ? 0 : 1;
        }
      }
    }

    // Dark module
    m[size - 8][8] = 1;

    // Reserve format information areas
    for (let i = 0; i < 9; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (let i = 0; i < 8; i++) {
      if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = 0;
      if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = 0;
    }
  }

  /** Which cells are function patterns (and so not available for data). */
  function reservedMask(version, size) {
    const m = newMatrix(size);
    placeFunctionPatterns(m, version);
    const res = [];
    for (let r = 0; r < size; r++) {
      res.push(m[r].map((v) => v !== null));
    }
    return res;
  }

  function placeData(m, reserved, codewords) {
    const size = m.length;
    let bitIndex = 0;
    const totalBits = codewords.length * 8;

    let col = size - 1;
    let upward = true;
    while (col > 0) {
      if (col === 6) col--;   // skip the vertical timing column
      for (let i = 0; i < size; i++) {
        const row = upward ? (size - 1 - i) : i;
        for (let j = 0; j < 2; j++) {
          const c = col - j;
          if (reserved[row][c]) continue;
          let bit = 0;
          if (bitIndex < totalBits) {
            const byte = codewords[bitIndex >> 3];
            bit = (byte >> (7 - (bitIndex & 7))) & 1;
            bitIndex++;
          }
          m[row][c] = bit;
        }
      }
      col -= 2;
      upward = !upward;
    }
  }

  function maskBit(pattern, r, c) {
    switch (pattern) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function applyMask(m, reserved, pattern) {
    const size = m.length;
    const out = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (maskBit(pattern, r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  // Format information: 2 bits ECC level (M = 00) + 3 bits mask, BCH(15,5)
  function formatBits(mask) {
    const data = (0b00 << 3) | mask;
    let value = data << 10;
    for (let i = 4; i >= 0; i--) {
      if ((value >> (i + 10)) & 1) value ^= 0b10100110111 << i;
    }
    return ((data << 10) | value) ^ 0b101010000010010;
  }

  function placeFormat(m, mask) {
    const size = m.length;
    const bits = formatBits(mask);
    const get = (i) => (bits >> i) & 1;   // get(0) is the least significant bit

    // --- Copy 1, around the top-left finder ---
    // The horizontal run reads MSB-first left to right, skipping the timing
    // column at 6; the vertical run reads LSB-first bottom to top.
    for (let i = 0; i <= 5; i++) m[8][i] = get(14 - i);
    m[8][7] = get(8);
    m[8][8] = get(7);
    m[7][8] = get(6);
    for (let i = 0; i <= 5; i++) m[i][8] = get(i);

    // --- Copy 2, split between the other two finders ---
    for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = get(14 - i);
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = get(i);

    m[size - 8][8] = 1;   // dark module, always set, never a format bit
  }

  // ---------------------------------------------------------------------------
  // Mask penalty scoring
  // ---------------------------------------------------------------------------
  function penalty(m) {
    const size = m.length;
    let score = 0;

    // Rule 1 — runs of five or more of the same colour
    for (let r = 0; r < size; r++) {
      let runVal = m[r][0], runLen = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === runVal) runLen++;
        else { if (runLen >= 5) score += 3 + (runLen - 5); runVal = m[r][c]; runLen = 1; }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
    for (let c = 0; c < size; c++) {
      let runVal = m[0][c], runLen = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === runVal) runLen++;
        else { if (runLen >= 5) score += 3 + (runLen - 5); runVal = m[r][c]; runLen = 1; }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }

    // Rule 2 — 2x2 blocks of the same colour
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    // Rule 3 — finder-like patterns
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (arr, pat) => pat.every((v, i) => arr[i] === v);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c + 11 <= size; c++) {
        const slice = m[r].slice(c, c + 11);
        if (matches(slice, P1) || matches(slice, P2)) score += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r + 11 <= size; r++) {
        const slice = [];
        for (let i = 0; i < 11; i++) slice.push(m[r + i][c]);
        if (matches(slice, P1) || matches(slice, P2)) score += 40;
      }
    }

    // Rule 4 — deviation from an even balance of light and dark
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Encode a string as a QR matrix.
   * Returns { size, modules } where modules[r][c] is 1 (dark) or 0 (light),
   * or throws if the text is too long for version 6.
   */
  function encode(text) {
    const bytes = toUtf8Bytes(String(text));
    const version = pickVersion(bytes.length);
    if (!version) {
      throw new Error('Text too long for this QR encoder (max 106 bytes)');
    }
    const size = 17 + version * 4;
    const codewords = buildCodewords(bytes, version);
    const reserved = reservedMask(version, size);

    const base = newMatrix(size);
    placeFunctionPatterns(base, version);
    placeData(base, reserved, codewords);

    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const candidate = applyMask(base, reserved, mask);
      placeFormat(candidate, mask);
      const p = penalty(candidate);
      if (p < bestScore) { bestScore = p; best = candidate; }
    }

    return { size, version, modules: best };
  }

  /** Render a QR matrix as a standalone SVG string. */
  function toSVG(text, opts) {
    const o = opts || {};
    const scale = o.scale || 6;
    const quiet = o.quiet == null ? 4 : o.quiet;
    const dark = o.dark || '#1c1917';
    const light = o.light || '#ffffff';

    const { size, modules } = encode(text);
    const dim = (size + quiet * 2) * scale;

    let path = '';
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (modules[r][c]) {
          path += 'M' + ((c + quiet) * scale) + ',' + ((r + quiet) * scale) +
                  'h' + scale + 'v' + scale + 'h-' + scale + 'z';
        }
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + dim + '" height="' + dim +
           '" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges">' +
           '<rect width="' + dim + '" height="' + dim + '" fill="' + light + '"/>' +
           '<path d="' + path + '" fill="' + dark + '"/></svg>';
  }

  const CTKQR = { BUILD, encode, toSVG };
  global.CTKQR = CTKQR;
  if (typeof module !== 'undefined' && module.exports) module.exports = CTKQR;
})(typeof window !== 'undefined' ? window : globalThis);
