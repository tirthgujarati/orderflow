// Minimal LZMA ("alone" / .lzma format) decoder, enough for Dukascopy .bi5 files (spot price history).
// Format: 5-byte properties (lc/lp/pb + dictionary size), 8-byte uncompressed size, then the range-coded stream.
// Standard LZMA decoding (Igor Pavlov's algorithm), written out plainly: range decoder, literal coder, length coders,
// distance slots/align bits, 4 repeat distances and the 12-state machine.
export function lzmaDecode(src) {
  const inp = src instanceof Uint8Array ? src : new Uint8Array(src);
  let d = inp[0];
  const lc = d % 9; d = (d / 9) | 0; const lp = d % 5, pb = (d / 5) | 0;
  let dictSize = inp[1] | (inp[2] << 8) | (inp[3] << 16) | (inp[4] << 24) >>> 0; if (dictSize < 4096) dictSize = 4096;
  let outSize = 0, known = false;
  { let lo = 0, hi = 0; for (let i = 0; i < 4; i++) lo += inp[5 + i] * 2 ** (8 * i); for (let i = 0; i < 4; i++) hi += inp[9 + i] * 2 ** (8 * i); if (hi !== 0xffffffff || lo !== 0xffffffff) { outSize = hi * 4294967296 + lo; known = true; } }
  let pos = 13;
  // range decoder
  let range = 0xffffffff, code = 0;
  pos++;                                                          // first byte is always 0
  for (let i = 0; i < 4; i++) code = ((code << 8) | inp[pos++]) >>> 0;
  const normalize = () => { if (range < 0x1000000) { range = (range << 8) >>> 0; code = ((code << 8) | (pos < inp.length ? inp[pos++] : 0)) >>> 0; } };
  const bit = (probs, i) => {
    const bound = ((range >>> 11) * probs[i]) >>> 0;
    if (code < bound) { range = bound; probs[i] += (2048 - probs[i]) >> 5; normalize(); return 0; }
    range = (range - bound) >>> 0; code = (code - bound) >>> 0; probs[i] -= probs[i] >> 5; normalize(); return 1;
  };
  const direct = n => { let r = 0; while (n--) { range >>>= 1; let t = 0; if (code >= range) { code = (code - range) >>> 0; t = 1; } r = (r << 1) | t; normalize(); } return r >>> 0; };
  const tree = (probs, base, nbits) => { let m = 1; for (let i = 0; i < nbits; i++) m = (m << 1) | bit(probs, base + m); return m - (1 << nbits); };
  const rtree = (probs, base, nbits) => { let m = 1, sym = 0; for (let i = 0; i < nbits; i++) { const b = bit(probs, base + m); m = (m << 1) | b; sym |= b << i; } return sym; };
  const P = n => new Uint16Array(n).fill(1024);
  // models
  const lit = P(0x300 << (lc + lp));
  const isMatch = P(192), isRep = P(12), isRepG0 = P(12), isRepG1 = P(12), isRepG2 = P(12), isRep0Long = P(192);
  const slot = P(4 << 6), spec = P(115), align = P(16);
  const lenCoder = () => ({ choice: P(2), low: P(16 << 3), mid: P(16 << 3), high: P(256) });
  const lenM = lenCoder(), lenR = lenCoder();
  const decLen = (L, ps) => {
    if (!bit(L.choice, 0)) return tree(L.low, ps << 3, 3);
    if (!bit(L.choice, 1)) return 8 + tree(L.mid, ps << 3, 3);
    return 16 + tree(L.high, 0, 8);
  };
  // output window (whole output kept, files are small)
  let out = new Uint8Array(known ? outSize : Math.max(1 << 16, inp.length * 4)), n = 0;
  const put = b => { if (n >= out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = b; };
  let state = 0, rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;
  const pbMask = (1 << pb) - 1, lpMask = (1 << lp) - 1;
  while (!known || n < outSize) {
    const ps = n & pbMask;
    if (!bit(isMatch, (state << 4) + ps)) {                       // literal
      const prev = n > 0 ? out[n - 1] : 0, base = 0x300 * (((n & lpMask) << lc) + (prev >> (8 - lc)));
      let sym = 1;
      if (state >= 7) {                                           // after a match: use the byte at rep0 as context
        let mb = out[n - rep0 - 1];
        do { const mbit = (mb >> 7) & 1; mb <<= 1; const b = bit(lit, base + ((1 + mbit) << 8) + sym); sym = (sym << 1) | b; if (mbit !== b) break; } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(lit, base + sym);
      put(sym & 0xff);
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let len;
    if (bit(isRep, state)) {
      if (n === 0) throw new Error('lzma: bad rep');
      if (!bit(isRepG0, state)) {
        if (!bit(isRep0Long, (state << 4) + ps)) { state = state < 7 ? 9 : 11; put(out[n - rep0 - 1]); continue; }   // short rep
      } else {
        let dist;
        if (!bit(isRepG1, state)) { dist = rep1; }
        else { if (!bit(isRepG2, state)) { dist = rep2; } else { dist = rep3; rep3 = rep2; } rep2 = rep1; }
        rep1 = rep0; rep0 = dist;
      }
      len = decLen(lenR, ps); state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2; rep2 = rep1; rep1 = rep0;
      len = decLen(lenM, ps); state = state < 7 ? 7 : 10;
      const ls = len < 4 ? len : 3, ds = tree(slot, ls << 6, 6);
      if (ds < 4) rep0 = ds;
      else {
        const nb = (ds >> 1) - 1; let dist = ((2 | (ds & 1)) << nb) >>> 0;
        if (ds < 14) dist += rtree(spec, dist - ds - 1, nb);
        else { dist += direct(nb - 4) << 4; dist += rtree(align, 0, 4); }
        rep0 = dist >>> 0;
        if (rep0 === 0xffffffff) break;                           // end marker
      }
    }
    len += 2;
    if (rep0 >= n) throw new Error('lzma: distance beyond output');
    for (let i = 0; i < len && (!known || n < outSize); i++) put(out[n - rep0 - 1]);
  }
  return out.subarray(0, n);
}
