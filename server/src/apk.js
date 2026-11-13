'use strict';

/**
 * 电视端 APK 的收发包管理。
 *
 * 干三件事：
 *   1. 收上传的 APK 存进 data/apk/，从包里读出包名、versionCode、versionName（不依赖 aapt）；
 *   2. 维护「当前分发哪个版本」的指针，电视端轮询这个指针决定要不要升级；
 *   3. 只留最新 + 3 个历史版本，防着最新版翻车时能退回去。
 *
 * 版本号是手写二进制的 AndroidManifest 解析出来的，见 [parseApk]。解析失败不猜，
 * 直接拒收 —— 猜错了会让所有电视升到一个「比当前低」的版本，永远升不上去。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/** 最新 1 个 + 3 个历史，和产品约定一致 */
const MAX_VERSIONS = 4;

function init(dataDir) {
  const dir = path.join(dataDir, 'apk');
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    indexFile: path.join(dir, 'index.json'),
    get index() { return readIndex(this.indexFile); }
  };
}

function readIndex(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      active: j.active || '',
      items: Array.isArray(j.items) ? j.items : []
    };
  } catch (e) {
    return { active: '', items: [] };
  }
}

function writeIndex(file, idx) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 从 zip 的 central directory 里取一个条目的原始数据（APK 本身就是 zip） */
function readZipEntry(buf, want) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 APK（找不到 zip 目录）');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (name === want) {
      const lnLen = buf.readUInt16LE(localOff + 26);
      const leLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnLen + leLen;
      const raw = buf.slice(start, start + compSize);
      return method === 8 ? zlib.inflateRawSync(raw) : raw;
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  throw new Error('APK 里没有 ' + want);
}

/** 读 AXML 的字符串池，UTF-8 / UTF-16 两种都要支持（不同 AGP 版本编出来不一样） */
function readStringPool(buf, p, headerSize) {
  const count = buf.readUInt32LE(p + 8);
  const flags = buf.readUInt32LE(p + 16);
  const stringsStart = buf.readUInt32LE(p + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out = [];

  for (let i = 0; i < count; i++) {
    const off = p + stringsStart + buf.readUInt32LE(p + headerSize + i * 4);
    if (utf8) {
      // 先 1~2 字节「字符数」，再 1~2 字节「字节数」，最后是数据
      let q = off;
      const n1 = buf.readUInt8(q);
      q += (n1 & 0x80) ? 2 : 1;
      let blen = buf.readUInt8(q);
      if (blen & 0x80) { blen = ((blen & 0x7f) << 8) | buf.readUInt8(q + 1); q += 2; }
      else q += 1;
      out.push(buf.toString('utf8', q, q + blen));
    } else {
      let q = off;
      let len = buf.readUInt16LE(q);
      if (len & 0x8000) { len = ((len & 0x7fff) << 16) | buf.readUInt16LE(q + 2); q += 4; }
      else q += 2;
      out.push(buf.toString('utf16le', q, q + len * 2));
    }
  }
  return out;
}

/** 找出 <manifest> 上的 package / versionCode / versionName */
function parseManifest(axml) {
  if (axml.length < 8 || axml.readUInt16LE(0) !== 0x0003) {
    throw new Error('AndroidManifest.xml 不是二进制 XML');
  }
  let p = 8;
  let strings = [];

  while (p + 8 <= axml.length) {
    const type = axml.readUInt16LE(p);
    const headerSize = axml.readUInt16LE(p + 2);
    const size = axml.readUInt32LE(p + 4);

    if (type === 0x0001) {
      strings = readStringPool(axml, p, headerSize);
    } else if (type === 0x0102) {
      // 第一个 start element 就是 <manifest>
      const nameIdx = axml.readUInt32LE(p + 20);
      const attrStart = axml.readUInt16LE(p + 24);
      const attrSize = axml.readUInt16LE(p + 26) || 20;
      const attrCount = axml.readUInt16LE(p + 28);
      const tag = strings[nameIdx] || '';
      if (tag !== 'manifest') throw new Error(`第一个标签是 <${tag}>，不是 <manifest>`);

      const base = p + 16 + attrStart;
      const out = { package: '', versionCode: 0, versionName: '' };
      for (let i = 0; i < attrCount; i++) {
        const ap = base + i * attrSize;
        if (ap + 20 > axml.length) break;
        const aName = strings[axml.readUInt32LE(ap + 4)] || '';
        const rawVal = axml.readInt32LE(ap + 8);
        const dataType = axml.readUInt8(ap + 15);
        const data = axml.readUInt32LE(ap + 16);
        // 0x03 = 字符串池引用；0x10 = int dec
        const asString = () => (rawVal >= 0 ? strings[rawVal] : (dataType === 0x03 ? strings[data] : '')) || '';
        if (aName === 'package') out.package = asString();
        else if (aName === 'versionCode') out.versionCode = dataType === 0x10 ? data : Number(asString()) || 0;
        else if (aName === 'versionName') out.versionName = asString();
      }
      return out;
    }
    if (size <= 0) break;
    p += size;
  }
  throw new Error('AndroidManifest.xml 里找不到 <manifest> 标签');
}

/** 读一个 APK 文件，返回 { package, versionCode, versionName } */
function parseApk(file) {
  const buf = fs.readFileSync(file);
  const info = parseManifest(readZipEntry(buf, 'AndroidManifest.xml'));
  if (!info.package) throw new Error('APK 里读不到包名');
  if (!info.versionCode) throw new Error('APK 里读不到 versionCode');
  return info;
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 存一个新版本。
 *
 * **只入库、不自动发布**：上传是上传，发布是发布。家长传完可以先看一眼版本号对不对，
 * 确认没问题再点列表里的「发布」把指针切过去 —— 否则传错包就直接推给电视，连反悔的机会都没有。
 * 解析失败直接抛错，调用方把原因显示给用户。
 */
function addVersion(store, srcFile, originalName) {
  const info = parseApk(srcFile);
  const idx = readIndex(store.indexFile);

  const dup = idx.items.find(x => x.versionCode === info.versionCode && x.package === info.package);
  if (dup) throw new Error(`已经传过 versionCode ${info.versionCode}（${dup.versionName}），改个版本号重新编译`);

  const safeName = `${info.package}-${info.versionCode}.apk`.replace(/[^\w.\-]/g, '_');
  const dest = path.join(store.dir, safeName);
  fs.copyFileSync(srcFile, dest);

  const item = {
    id: `${info.versionCode}-${Date.now()}`,
    package: info.package,
    versionCode: info.versionCode,
    versionName: info.versionName || String(info.versionCode),
    file: safeName,
    size: fs.statSync(dest).size,
    md5: md5(dest),
    uploadedAt: new Date().toISOString(),
    originalName: String(originalName || '').slice(0, 120)
  };

  idx.items.unshift(item);
  prune(store, idx);
  writeIndex(store.indexFile, idx);
  return item;
}

/** 只留最新 + (MAX_VERSIONS-1) 个历史；active 那个无论如何不删 */
function prune(store, idx) {
  idx.items.sort((a, b) => b.versionCode - a.versionCode);
  const keep = new Set(idx.items.slice(0, MAX_VERSIONS).map(x => x.id));
  if (idx.active) keep.add(idx.active);

  const dropped = idx.items.filter(x => !keep.has(x.id));
  idx.items = idx.items.filter(x => keep.has(x.id));
  dropped.forEach(x => {
    try { fs.unlinkSync(path.join(store.dir, x.file)); } catch (e) { /* 文件可能已被手动删 */ }
  });
}

function list(store) {
  const idx = readIndex(store.indexFile);
  idx.items.sort((a, b) => b.versionCode - a.versionCode);
  return {
    active: idx.active,
    max: MAX_VERSIONS,
    items: idx.items.map(x => Object.assign({ active: x.id === idx.active }, x))
  };
}

/** 回退 / 切换到某个版本 */
function activate(store, id) {
  const idx = readIndex(store.indexFile);
  const item = idx.items.find(x => x.id === id);
  if (!item) throw new Error('这个版本已经不在列表里了');
  idx.active = item.id;
  writeIndex(store.indexFile, idx);
  return item;
}

function remove(store, id) {
  const idx = readIndex(store.indexFile);
  const item = idx.items.find(x => x.id === id);
  if (!item) throw new Error('这个版本已经不在了');
  try { fs.unlinkSync(path.join(store.dir, item.file)); } catch (e) { /* 忽略 */ }
  idx.items = idx.items.filter(x => x.id !== id);
  // 删掉的正好是当前分发版本：把指针置空，电视端就查不到任何更新了。
  // 不自动指向别的版本 —— 那等于替你「发布」了一次，容易把电视升到不想升的包。
  if (idx.active === id) idx.active = '';
  writeIndex(store.indexFile, idx);
  return true;
}

/** 当前分发版本的元数据（可能就是空） */
function active(store) {
  const idx = readIndex(store.indexFile);
  const item = idx.items.find(x => x.id === idx.active);
  if (!item) return null;
  return Object.assign({ filePath: path.join(store.dir, item.file) }, item);
}

module.exports = {
  init,
  parseApk,
  addVersion,
  list,
  activate,
  remove,
  active,
  MAX_VERSIONS,
  /** 只给自测用：验证「最新 + 3 个历史」的裁剪规则 */
  _prune: prune
};
