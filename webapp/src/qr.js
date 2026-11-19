/**
 * Zero-dependency ISO/IEC 18004 QR Code SVG generator (Byte mode, ECC Level M, Versions 1–9).
 * Supports UTF-8 URLs up to 180 bytes with Reed-Solomon ECC, BCH format/version info,
 * and standard 8-mask penalty minimization.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const work = new Uint8Array(data.length + ecLen);
  work.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = work[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        work[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return work.slice(data.length);
}

// ISO/IEC 18004 Table 9 specs for ECC Level M (format indicator 0b00), Versions 1..9.
const VERSION_SPECS_M = [
  null,
  { version: 1, ecPerBlock: 10, groups: [[1, 16]], align: [] },
  { version: 2, ecPerBlock: 16, groups: [[1, 28]], align: [6, 18] },
  { version: 3, ecPerBlock: 26, groups: [[1, 44]], align: [6, 22] },
  { version: 4, ecPerBlock: 18, groups: [[2, 32]], align: [6, 26] },
  { version: 5, ecPerBlock: 24, groups: [[2, 43]], align: [6, 30] },
  { version: 6, ecPerBlock: 16, groups: [[4, 27]], align: [6, 34] },
  { version: 7, ecPerBlock: 18, groups: [[4, 31]], align: [6, 22, 38] },
  { version: 8, ecPerBlock: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42] },
  { version: 9, ecPerBlock: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46] }
];

function utf8Bytes(text) {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(String(text || ''));
  }
  const encoded = unescape(encodeURIComponent(String(text || '')));
  const out = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) {
    out[i] = encoded.charCodeAt(i);
  }
  return out;
}

function chooseVersion(byteLen) {
  for (let v = 1; v < VERSION_SPECS_M.length; v++) {
    const spec = VERSION_SPECS_M[v];
    const totalDataCw = spec.groups.reduce((acc, [cnt, cw]) => acc + cnt * cw, 0);
    // Byte mode header = 4 mode bits + 8 length bits = 12 bits; +4 terminator fits inside data cw.
    const maxBytes = Math.floor((totalDataCw * 8 - 12) / 8);
    if (byteLen <= maxBytes) {
      return { spec, totalDataCw };
    }
  }
  throw new Error(`QR payload too long (${byteLen} bytes; max 180 bytes).`);
}

function buildDataCodewords(bytes, totalDataCw) {
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  pushBits(0b0100, 4); // Byte mode
  pushBits(bytes.length, 8);
  for (let i = 0; i < bytes.length; i++) {
    pushBits(bytes[i], 8);
  }

  const maxBits = totalDataCw * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < termLen; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(totalDataCw);
  const byteCount = bits.length / 8;
  for (let i = 0; i < byteCount; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    codewords[i] = b;
  }

  let padToggle = 0;
  for (let i = byteCount; i < totalDataCw; i++) {
    codewords[i] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }
  return codewords;
}

function interleaveBlocks(dataCodewords, spec) {
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  let maxDataLen = 0;

  for (const [count, cwLen] of spec.groups) {
    maxDataLen = Math.max(maxDataLen, cwLen);
    for (let i = 0; i < count; i++) {
      const block = dataCodewords.slice(offset, offset + cwLen);
      offset += cwLen;
      dataBlocks.push(block);
      eccBlocks.push(rsComputeEcc(block, spec.ecPerBlock));
    }
  }

  const out = [];
  for (let col = 0; col < maxDataLen; col++) {
    for (const blk of dataBlocks) {
      if (col < blk.length) out.push(blk[col]);
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col++) {
    for (const ecc of eccBlocks) {
      out.push(ecc[col]);
    }
  }
  return new Uint8Array(out);
}

function computeFormatBitsM(maskId) {
  const data = (0b00 << 3) | (maskId & 0x07); // Level M = 0b00
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) {
      rem ^= 0x1f25 << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function createMatrix(size) {
  return {
    size,
    modules: Array.from({ length: size }, () => new Uint8Array(size)),
    isFunc: Array.from({ length: size }, () => new Uint8Array(size))
  };
}

function setFuncModule(grid, r, c, dark) {
  grid.modules[r][c] = dark ? 1 : 0;
  grid.isFunc[r][c] = 1;
}

function drawFinderPattern(grid, topR, leftC) {
  const { size } = grid;
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = topR + dr;
      const c = leftC + dc;
      if (r < 0 || r >= size || c < 0 || c >= size) continue;
      const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      const dark = inOuter && (dist === 3 || dist <= 1);
      setFuncModule(grid, r, c, dark);
    }
  }
}

function drawAlignmentPattern(grid, centerR, centerC) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFuncModule(grid, centerR + dr, centerC + dc, dist === 2 || dist === 0);
    }
  }
}

function placeFunctionPatterns(grid, spec) {
  const { size } = grid;
  drawFinderPattern(grid, 0, 0);
  drawFinderPattern(grid, 0, size - 7);
  drawFinderPattern(grid, size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    setFuncModule(grid, 6, i, dark);
    setFuncModule(grid, i, 6, dark);
  }

  // Alignment patterns
  const pos = spec.align;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const r = pos[i];
      const c = pos[j];
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) {
        continue;
      }
      drawAlignmentPattern(grid, r, c);
    }
  }

  // Dark module & reserve format strips
  setFuncModule(grid, 4 * spec.version + 9, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFuncModule(grid, 8, i, false);
      setFuncModule(grid, i, 8, false);
    }
  }
  for (let i = size - 8; i < size; i++) {
    setFuncModule(grid, 8, i, false);
    if (i > size - 8) {
      setFuncModule(grid, i, 8, false);
    }
  }

  // Version info blocks for versions >= 7
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version);
    for (let i = 0; i < 18; i++) {
      const dark = ((vBits >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFuncModule(grid, a, b, dark);
      setFuncModule(grid, b, a, dark);
    }
  }
}

function placeCodewords(grid, allCodewords) {
  const { size, modules, isFunc } = grid;
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;

  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let offset = 0; offset < 2; offset++) {
        const c = rightCol - offset;
        if (isFunc[r][c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          const byteVal = allCodewords[bitIdx >> 3];
          bit = (byteVal >> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        modules[r][c] = bit;
      }
    }
    upward = !upward;
  }
}

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function writeFormatBits(modules, size, maskId) {
  const fmt = computeFormatBitsM(maskId);

  // Copy 1: top-left finder perimeter (LSB i=0 at (0,8) .. MSB i=14 at (8,0))
  for (let i = 0; i <= 5; i++) modules[i][8] = (fmt >> i) & 1;
  modules[7][8] = (fmt >> 6) & 1;
  modules[8][8] = (fmt >> 7) & 1;
  modules[8][7] = (fmt >> 8) & 1;
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = (fmt >> i) & 1;

  // Copy 2: top-right & bottom-left finder perimeters (LSB i=0 at (8,size-1) .. MSB i=14 at (size-1,8))
  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = (fmt >> i) & 1;
  for (let i = 8; i <= 14; i++) modules[size - 15 + i][8] = (fmt >> i) & 1;
}

function applyMaskClone(grid, maskId) {
  const { size, modules, isFunc } = grid;
  const maskFn = MASK_FNS[maskId];
  const out = modules.map((row, r) => {
    const copy = new Uint8Array(size);
    for (let c = 0; c < size; c++) {
      copy[c] = isFunc[r][c] ? row[c] : (row[c] ^ (maskFn(r, c) ? 1 : 0));
    }
    return copy;
  });
  writeFormatBits(out, size, maskId);
  return out;
}

function scoreLinePenalty(line) {
  let penalty = 0;
  let runColor = -1;
  let runLen = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === runColor) {
      runLen += 1;
      if (runLen === 5) penalty += 3;
      else if (runLen > 5) penalty += 1;
    } else {
      runColor = line[i];
      runLen = 1;
    }
  }
  return penalty;
}

function countFinderLikePatterns(line) {
  let count = 0;
  const n = line.length;
  for (let i = 0; i <= n - 11; i++) {
    // 10111010000 or 00001011101
    if (
      line[i] === 1 && line[i + 1] === 0 && line[i + 2] === 1 && line[i + 3] === 1 &&
      line[i + 4] === 1 && line[i + 5] === 0 && line[i + 6] === 1 &&
      line[i + 7] === 0 && line[i + 8] === 0 && line[i + 9] === 0 && line[i + 10] === 0
    ) {
      count += 1;
    }
    if (
      line[i] === 0 && line[i + 1] === 0 && line[i + 2] === 0 && line[i + 3] === 0 &&
      line[i + 4] === 1 && line[i + 5] === 0 && line[i + 6] === 1 &&
      line[i + 7] === 1 && line[i + 8] === 1 && line[i + 9] === 0 && line[i + 10] === 1
    ) {
      count += 1;
    }
  }
  return count;
}

function computePenalty(modules, size) {
  let penalty = 0;
  let darkCount = 0;
  const colBuf = new Uint8Array(size);

  // N1 + N3 on rows & cols
  for (let r = 0; r < size; r++) {
    const row = modules[r];
    penalty += scoreLinePenalty(row);
    penalty += countFinderLikePatterns(row) * 40;
    for (let c = 0; c < size; c++) {
      darkCount += row[c];
    }
  }
  for (let c = 0; c < size; c++) {
    for (let r = 0; r < size; r++) colBuf[r] = modules[r][c];
    penalty += scoreLinePenalty(colBuf);
    penalty += countFinderLikePatterns(colBuf) * 40;
  }

  // N2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const sum = modules[r][c] + modules[r][c + 1] + modules[r + 1][c] + modules[r + 1][c + 1];
      if (sum === 0 || sum === 4) penalty += 3;
    }
  }

  // N4: dark module balance around 50%
  const total = size * size;
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total);
  penalty += k * 10;

  return penalty;
}

/**
 * Encodes `text` into a QR code module matrix using Byte mode and ECC Level M.
 */
export function encodeQrMatrix(text) {
  const bytes = utf8Bytes(text);
  const { spec, totalDataCw } = chooseVersion(bytes.length);
  const dataCodewords = buildDataCodewords(bytes, totalDataCw);
  const allCodewords = interleaveBlocks(dataCodewords, spec);

  const size = 17 + 4 * spec.version;
  const grid = createMatrix(size);
  placeFunctionPatterns(grid, spec);
  placeCodewords(grid, allCodewords);

  let bestMask = 0;
  let bestModules = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMaskClone(grid, mask);
    const p = computePenalty(candidate, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  return {
    version: spec.version,
    size,
    mask: bestMask,
    modules: bestModules
  };
}

/**
 * Renders a crisp, standards-compliant inline SVG QR code for `text`.
 */
export function renderQrSvg(text, { sizePx = 156, quiet = 4, darkColor = '#1E242B', lightColor = '#FFFFFF', label = 'QR code' } = {}) {
  const { size, modules } = encodeQrMatrix(text);
  const total = size + quiet * 2;
  const paths = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        paths.push(`M${c + quiet},${r + quiet}h1v1h-1z`);
      }
    }
  }
  const safeLabel = String(label || 'QR code')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges" role="img" aria-label="${safeLabel}"><rect width="${total}" height="${total}" fill="${lightColor}"/><path d="${paths.join('')}" fill="${darkColor}"/></svg>`;
}

