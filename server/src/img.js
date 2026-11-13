'use strict';

/**
 * 零依赖的图像处理：PNG(8bit RGB/RGBA) 解码 → 缩放 → 基线 JPEG 编码。
 *
 * 为什么不引 sharp 之类的库：项目坚持零第三方依赖（容器不用 npm install）。
 * 截屏的场景非常窄 —— 电视 screencap 输出的 PNG 固定是 8bit RGBA、非隔行，
 * 只需支持这一种；JPEG 编码也只做基线 + 4:2:0，标准霍夫曼表写死。
 *
 * 2.2MB 的 1080p PNG 缩到 960 宽、质量 75 的 JPEG 后大约 100~200KB，
 * 后台看画面足够清晰，5 分钟 30 张的存储压力也小得多。
 */

const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth 预测器 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * 解码 PNG（只支持 8bit、colorType 2/6、非隔行 —— screencap 的输出就是这个范围）。
 * @returns {{width:number, height:number, rgba:Uint8Array}}
 */
function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.slice(0, 8).equals(PNG_SIG)) {
    throw new Error('不是 PNG 文件');
  }
  let pos = 8;
  let width = 0, height = 0, colorType = 0, interlace = 0;
  const idats = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;   // 长度 + 类型 + 数据 + CRC
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('只支持 8bit PNG');
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idats.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG 头不完整');
  if (interlace) throw new Error('不支持隔行 PNG');
  if (colorType !== 6 && colorType !== 2) throw new Error('只支持 RGB/RGBA PNG');

  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);   // 统一转 RGBA

  let prev = Buffer.alloc(stride);
  let cur = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (f) {
        case 0: break;
        case 1: cur[i] = (cur[i] + a) & 0xff; break;
        case 2: cur[i] = (cur[i] + b) & 0xff; break;
        case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 0xff; break;
        default: throw new Error('未知 PNG 行过滤 ' + f);
      }
    }
    const ro = y * width * 4;
    if (channels === 4) {
      for (let x = 0; x < width; x++) {
        out[ro + x * 4] = cur[x * 4];
        out[ro + x * 4 + 1] = cur[x * 4 + 1];
        out[ro + x * 4 + 2] = cur[x * 4 + 2];
        out[ro + x * 4 + 3] = cur[x * 4 + 3];
      }
    } else {
      for (let x = 0; x < width; x++) {
        out[ro + x * 4] = cur[x * 3];
        out[ro + x * 4 + 1] = cur[x * 3 + 1];
        out[ro + x * 4 + 2] = cur[x * 3 + 2];
        out[ro + x * 4 + 3] = 255;
      }
    }
    const t = prev; prev = cur; cur = t;
  }
  return { width, height, rgba: out };
}

/**
 * 盒式缩放（整数倍时就是简单的方块平均，画质足够）。
 * @returns {{width:number, height:number, rgba:Uint8Array}}
 */
function resize(rgba, sw, sh, tw, th) {
  const out = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sh / th), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sw / tw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / tw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < sh; yy++) {
        for (let xx = x0; xx < x1 && xx < sw; xx++) {
          const p = (yy * sw + xx) * 4;
          r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2]; a += rgba[p + 3];
          n++;
        }
      }
      const q = (y * tw + x) * 4;
      out[q] = Math.round(r / n); out[q + 1] = Math.round(g / n);
      out[q + 2] = Math.round(b / n); out[q + 3] = Math.round(a / n);
    }
  }
  return { width: tw, height: th, rgba: out };
}

/** 按「最长边不超过 max」等比缩放，已经小于就不动 */
function fit(rgba, w, h, maxSide) {
  const m = Math.max(w, h);
  if (m <= maxSide) return { width: w, height: h, rgba };
  const k = maxSide / m;
  return resize(rgba, w, h, Math.round(w * k), Math.round(h * k));
}

// 标准量化表（质量 50 基准），横向 8 个一行
const QTY_BASE = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99
];
const QTC_BASE = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
];
// 之字扫描：8x8 行主序下标 → 扫描顺序
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63
];
// 标准霍夫曼表（JPEG 规范 K.3）
const HUFF_DC_LUM = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: range(12) };
const HUFF_DC_CHR = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: range(12) };
const HUFF_AC_LUM = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa
  ]
};
const HUFF_AC_CHR = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa
  ]
};

function range(n) { return Array.from({ length: n }, (_, i) => i); }

/** 质量缩放：q<50 按 5000/q，否则 200-2q */
function scaleQuant(base, quality) {
  const q = Math.min(100, Math.max(1, quality | 0));
  const s = q < 50 ? 5000 / q : 200 - 2 * q;
  return base.map(v => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
}

/** 由 bits/vals 生成 {code, size} 表 */
function buildHuff(t) {
  const codes = [];
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < t.bits[len - 1]; i++) codes[t.vals[k++]] = { code: code++, size: len };
    code <<= 1;
  }
  return codes;
}

// DCT 余弦表：cos((2x+1)uπ/16)
const COS = (() => {
  const t = [];
  for (let u = 0; u < 8; u++) {
    t[u] = [];
    for (let x = 0; x < 8; x++) t[u][x] = Math.cos((2 * x + 1) * u * Math.PI / 16);
  }
  return t;
})();
const C0 = 1 / Math.SQRT2;   // C(0) = 1/√2，其余为 1

function fdct(block) {
  const tmp = new Float64Array(64), out = new Float64Array(64);
  // 行方向
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[u][x];
      tmp[y * 8 + u] = s * (u === 0 ? C0 : 1) / 2;
    }
  }
  // 列方向
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + x] * COS[u][y];
      out[u * 8 + x] = s * (u === 0 ? C0 : 1) / 2;
    }
  }
  return out;
}

/** 位写入器：MSB 先出，0xFF 后补 0x00 */
function BitWriter() {
  this.chunks = [];
  this.cur = Buffer.alloc(4096);
  this.n = 0;
  this.acc = 0;
  this.cnt = 0;
}
BitWriter.prototype.put = function (code, size) {
  this.acc = (this.acc << size) | (code & ((1 << size) - 1));
  this.cnt += size;
  while (this.cnt >= 8) {
    const b = (this.acc >> (this.cnt - 8)) & 0xff;
    this.cur[this.n++] = b;
    if (b === 0xff) this.cur[this.n++] = 0;
    if (this.n >= this.cur.length - 8) {
      this.chunks.push(Buffer.from(this.cur.slice(0, this.n)));
      this.n = 0;
    }
    this.cnt -= 8;
  }
};
BitWriter.prototype.flush = function () {
  // 补齐最后一个字节
  if (this.cnt > 0) this.put((1 << (8 - this.cnt)) - 1, 8 - this.cnt);
  this.chunks.push(Buffer.from(this.cur.slice(0, this.n)));
  return Buffer.concat(this.chunks);
};

function seg(marker, payload) {
  const len = payload.length + 2;
  return Buffer.concat([
    Buffer.from([0xff, marker, len >> 8, len & 0xff]),
    payload
  ]);
}

/**
 * RGBA → 基线 JPEG（4:2:0）。
 * @param rgba {Uint8Array} 长度 = w*h*4
 * @returns {Buffer} JPEG 文件
 */
function encodeJpeg(rgba, w, h, quality) {
  quality = quality || 75;
  const qtY = scaleQuant(QTY_BASE, quality);
  const qtC = scaleQuant(QTC_BASE, quality);
  const dcLum = buildHuff(HUFF_DC_LUM), dcChr = buildHuff(HUFF_DC_CHR);
  const acLum = buildHuff(HUFF_AC_LUM), acChr = buildHuff(HUFF_AC_CHR);

  // 色度半采样平面：先累加 2x2 的和，再统一除 4（边缘不满 2x2 时按实际个数平均）
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  const Y = new Float64Array(w * h);
  const CbSum = new Float64Array(cw * ch), CrSum = new Float64Array(cw * ch);
  const CbN = new Uint16Array(cw * ch), CrN = new Uint16Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      const i = y * w + x;
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      const ci = Math.floor(y / 2) * cw + Math.floor(x / 2);
      CbSum[ci] += -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      CrSum[ci] += 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
      CbN[ci]++; CrN[ci]++;
    }
  }
  const Cb = new Float64Array(cw * ch), Cr = new Float64Array(cw * ch);
  for (let i = 0; i < Cb.length; i++) { Cb[i] = CbSum[i] / CbN[i]; Cr[i] = CrSum[i] / CrN[i]; }

  const bw = new BitWriter();
  const block = new Float64Array(64);
  // DC 差分预测器必须每个分量独立（Y / Cb / Cr 各一个）。
  // 之前 Cb 和 Cr 共用 'c'，两者的 DC 预测互相污染，解出来是逐 16x16 块的色彩错乱。
  const prevDC = { y: 0, cb: 0, cr: 0 };

  const writeBlock = (getSample, qt, dcTab, acTab, key) => {
    for (let by = 0; by < 8; by++) {
      for (let bx = 0; bx < 8; bx++) block[by * 8 + bx] = getSample(bx, by) - 128;
    }
    const freq = fdct(block);
    // 量化 + 之字扫描
    const zz = new Int16Array(64);
    for (let i = 0; i < 64; i++) {
      const v = freq[ZIGZAG[i]] / qt[ZIGZAG[i]];
      zz[i] = v >= 0 ? Math.round(v) : -Math.round(-v);
    }
    // DC（差分预测）
    let diff = zz[0] - prevDC[key];
    prevDC[key] = zz[0];
    let cat = 0;
    let av = Math.abs(diff);
    while (av) { av >>= 1; cat++; }
    const dcH = dcTab[cat];
    bw.put(dcH.code, dcH.size);
    if (cat) {
      let v = diff;
      if (v < 0) v += (1 << cat) - 1;
      bw.put(v, cat);
    }
    // AC
    let run = 0;
    for (let i = 1; i < 64; i++) {
      const v = zz[i];
      if (v === 0) { run++; continue; }
      while (run > 15) { bw.put(acTab[0xf0].code, acTab[0xf0].size); run -= 16; }
      let c = 0, av2 = Math.abs(v);
      while (av2) { av2 >>= 1; c++; }
      const sym = (run << 4) | c;
      const acH = acTab[sym];
      bw.put(acH.code, acH.size);
      let vv = v;
      if (vv < 0) vv += (1 << c) - 1;
      bw.put(vv, c);
      run = 0;
    }
    // 末位系数非零时不需要 EOB（解码方按 63 系数计数自然结束）
    if (run > 0) { const eob = acTab[0x00]; bw.put(eob.code, eob.size); }
  };

  // MCU 循环：16x16 = 4 个 Y 块 + 1 Cb + 1 Cr
  const mcuW = 16, mcuH = 16;
  const clamped = (v, hi) => Math.min(hi - 1, Math.max(0, v));
  for (let my = 0; my < h; my += mcuH) {
    for (let mx = 0; mx < w; mx += mcuW) {
      for (let q = 0; q < 4; q++) {
        const ox = mx + (q % 2) * 8, oy = my + (q < 2 ? 0 : 8);
        writeBlock((bx, by) => Y[clamped(oy + by, h) * w + clamped(ox + bx, w)],
          qtY, dcLum, acLum, 'y');
      }
      writeBlock((bx, by) => Cb[clamped(Math.floor((my + by * 2) / 2), ch) * cw + clamped(Math.floor((mx + bx * 2) / 2), cw)],
        qtC, dcChr, acChr, 'cb');
      writeBlock((bx, by) => Cr[clamped(Math.floor((my + by * 2) / 2), ch) * cw + clamped(Math.floor((mx + bx * 2) / 2), cw)],
        qtC, dcChr, acChr, 'cr');
    }
  }

  // 组装文件。DQT 表内容按之字顺序输出（JPEG 规范要求）
  const qtYzz = Buffer.from(ZIGZAG.map(i => qtY[i]));
  const qtCzz = Buffer.from(ZIGZAG.map(i => qtC[i]));
  // DHT 段的 TcTh 字节 = (class<<4) | tableId：class 0 = DC 表，1 = AC 表。
  // 注意参数顺序是 (表号 th, 类别 tc)，之前写成 (tc, th) 导致 AC 表被注册成 DC 表，
  // SOS 里引用的 AC0 根本不存在，解码器报 "Bogus Huffman table definition"。
  const dht = (th, tc, t) => seg(0xc4, Buffer.concat([
    Buffer.from([(tc << 4) | th]), Buffer.from(t.bits), Buffer.from(t.vals)
  ]));
  // 采样因子必须和「每个 MCU 实际写了几块」一致：
  // Y = 2x2 → 4 块；Cb/Cr = 1x1 → 各 1 块（色度平面本身就是半分辨率的 cw×ch）。
  // 这里之前把 Cb/Cr 也写成 0x22，解码器按 4 块去读、实际只有 1 块，
  // 直接抛 "Sampling factors too large for interleaved scan"，浏览器只能显示空白。
  const sof = seg(0xc0, Buffer.from([
    8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3,
    1, 0x22, 0,   // Y：4:2:0 采样 2x2（MCU 16x16 含 4 个 Y 块），量化表 0
    2, 0x11, 1,   // Cb：1x1（半分辨率平面，每 MCU 1 块），量化表 1
    3, 0x11, 1    // Cr
  ]));
  const sos = seg(0xda, Buffer.from([
    3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0
  ]));
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xdb, Buffer.concat([Buffer.from([0x00]), qtYzz])),
    seg(0xdb, Buffer.concat([Buffer.from([0x01]), qtCzz])),
    sof,
    // (表号, 类别, 表)：DC0 / DC1 / AC0 / AC1 —— 与 SOS 里的 0x00、0x11 一一对应
    dht(0, 0, HUFF_DC_LUM), dht(1, 0, HUFF_DC_CHR),
    dht(0, 1, HUFF_AC_LUM), dht(1, 1, HUFF_AC_CHR),
    sos,
    bw.flush(),
    Buffer.from([0xff, 0xd9])
  ]);
}

module.exports = { decodePng, resize, fit, encodeJpeg };
