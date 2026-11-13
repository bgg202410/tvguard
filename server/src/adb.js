'use strict';

/**
 * 零依赖的 ADB over TCP 客户端（只用 Node 标准库 net + crypto）。
 *
 * 为什么自己写：
 *   - 保活三件套（无障碍 / 设备管理员）在 TCL 上只能用 adb 命令开，
 *     而管理端跑在局域网内的服务器上、和电视同一局域网 —— 服务端可以直接 adb 过去自动修，
 *     不用家长再开电脑敲命令。
 *   - 项目坚持零第三方依赖，adbkit 之类装不进来，协议本身又不复杂，就手写了。
 *
 * 支持的流程：CNXN 握手 → AUTH（RSA 签名 / 公钥下发，覆盖开了 ro.adb.secure 的机器）
 *   → OPEN shell:xxx → 收 WRTE 输出 → CLSE 结束。
 *
 * 密钥存在 data/adb_key.json，首次连接自动生成；如果电视开了调试授权确认，
 * 第一次会弹「允许 USB 调试」，电视上点一次允许之后就永久记住了。
 */

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const KEY_FILE = path.join(DATA_DIR, 'adb_key.json');

// ADB 协议常量：按「线上字节直接拼出命令 ASCII」取值（写入时用小端）。
// 例如 CNXN 的线字节是 43 4e 58 4e，小端 u32 就是 0x4e584e43。
const A_CNXN = 0x4e584e43;
const A_AUTH = 0x48545541;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;

const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_RSAPUBLICKEY = 3;

const DEFAULT_PORT = 5555;
const DEFAULT_TIMEOUT = 12000;

/** ADB 数据包 = 24 字节头 + 数据。校验和是数据字节求和，magic 是命令取反。 */
function packet(cmd, arg0, arg1, data) {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(cmd, 0);
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(data ? data.length : 0, 12);
  let sum = 0;
  if (data) for (const b of data) sum += b;
  header.writeUInt32LE(sum >>> 0, 16);
  header.writeUInt32LE((cmd ^ 0xffffffff) >>> 0, 20);
  return data ? Buffer.concat([header, data]) : header;
}

function checksum(data) {
  let sum = 0;
  for (const b of data) sum += b;
  return sum >>> 0;
}

function loadKey() {
  // 手工编辑过的文件可能带 BOM 或首尾空白，容忍一下 —— 解析失败会导致
  // 重新生成一把「电视不认识」的新钥匙，越试越连不上，所以这里尽量救
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
    const j = JSON.parse(raw);
    if (j && j.privatePem && j.privatePem.includes('PRIVATE KEY')) return j;
  } catch (e) { /* 没有或格式不对就走 ensureKey 的兜底 */ }
  return null;
}

/**
 * 密钥自检：给后台「截图自检」用。
 * 电视只认「授权过的那把钥匙」，服务端自己生成的钥匙几乎必然连不上 ——
 * 所以把 name / 指纹 / 是否像自动生成都报出来，家长一眼能看出该不该换。
 */
function keyInfo() {
  const k = loadKey();
  if (!k) return { exists: false, valid: false, name: '', fingerprint: '', generated: false };
  const norm = String(k.privatePem).replace(/\s+/g, '');
  const name = String(k.name || '');
  return {
    exists: true,
    valid: true,
    name,
    generated: name === 'tvguard-server',
    fingerprint: crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16)
  };
}

/** 后台上传电脑上已授权的 adb 私钥，整份覆盖 data/adb_key.json（原子写） */
function setKey(input) {
  let pem = String(input == null ? '' : input).replace(/^\uFEFF/, '').trim();
  // 也允许直接把服务端的 adb_key.json 整份贴上来
  if (pem.startsWith('{')) {
    try {
      const j = JSON.parse(pem);
      pem = String(j.privatePem || '');
    } catch (e) { /* 按纯 PEM 处理 */ }
  }
  if (!pem.includes('PRIVATE KEY')) {
    throw new Error('不是 adb 私钥：内容里应有 BEGIN PRIVATE KEY / BEGIN RSA PRIVATE KEY');
  }
  crypto.createPrivateKey(pem);   // 解析不了就直接报错，别把坏钥匙写进去
  const k = { privatePem: pem, name: 'tvguard-server@pc' };
  const tmp = KEY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(k), 'utf8');
  fs.renameSync(tmp, KEY_FILE);
  return keyInfo();
}

/** 首次调用生成 2048 位 RSA 密钥并落盘（data 卷挂载，容器重建也不丢）。 */
function ensureKey() {
  let k = loadKey();
  if (k) return k;
  // data/adb_key：放一台「电视已经授权过」的电脑的 adb 私钥（纯 PEM 文件，直接拷过来），
  // 电视就不用再弹「允许 USB 调试」确认框 —— 家长不用守在电视前点确认。
  const plain = path.join(DATA_DIR, 'adb_key');
  try {
    const pem = fs.readFileSync(plain, 'utf8');
    if (pem.includes('PRIVATE KEY')) {
      k = { privatePem: pem, name: 'tvguard-server' };
      fs.writeFileSync(KEY_FILE, JSON.stringify(k), 'utf8');
      return k;
    }
  } catch (e) { /* 没有这个文件就走生成 */ }
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  k = {
    privatePem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString('utf8'),
    name: 'tvguard-server'
  };
  fs.writeFileSync(KEY_FILE, JSON.stringify(k), 'utf8');
  return k;
}

/** 扩展欧几里得求 a 在 mod 2^32 下的逆元（RSA 模数必为奇数，逆元一定存在） */
function modInverse32(a) {
  const M = 1n << 32n;
  let [oldR, r] = [a, M];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % M) + M) % M;
}

/** 把 BigInt 按小端 32 位字写进 buffer */
function writeWordsLE(buf, off, val, words) {
  for (let i = 0; i < words; i++) {
    buf.writeUInt32LE(Number((val >> BigInt(i * 32)) & 0xffffffffn), off + i * 4);
  }
}

/**
 * 生成 ADB 认识的公钥字符串（ANDROID_PUBKEY 编码，不是 X.509）。
 *
 * 结构（全小端 32 位字）：
 *   len(=64) | n0inv(= -1/n mod 2^32) | n[64] | rr[64](= 2^4096 mod n) | e
 * 后面拼 ' ' + 名字 + '\0'，和 ~/.android/adbkey.pub 的格式一致。
 */
function adbPublicKeyString(privatePem, name) {
  const jwk = crypto.createPrivateKey(privatePem).export({ format: 'jwk' });
  const n = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
  const e = BigInt('0x' + Buffer.from(jwk.e, 'base64url').toString('hex'));
  const words = 64;                       // 2048 bit / 32
  const n0inv = (1n << 32n) - modInverse32(n & 0xffffffffn);
  const rr = (1n << BigInt(2048 * 2)) % n;
  const buf = Buffer.alloc(4 + 4 + words * 4 + words * 4 + 4);
  buf.writeUInt32LE(words, 0);
  buf.writeUInt32LE(Number(n0inv), 4);
  writeWordsLE(buf, 8, n, words);
  writeWordsLE(buf, 8 + words * 4, rr, words);
  buf.writeUInt32LE(Number(e), 8 + words * 8);
  return buf.toString('base64') + ' ' + (name || 'tvguard-server') + '\0';
}

// adb 的签名方式：RSA_sign(NID_sha1, token) 把 20 字节 token 当作「已经算好的 SHA-1 摘要」，
// 直接构 DigestInfo 再做 PKCS#1 v1.5 签名 —— 不能用 createSign('RSA-SHA1')，
// 那会把 token 再哈希一次，签出来的结果电视不认。
const DIGEST_INFO_SHA1 = Buffer.from('3021300906052b0e03021a05000414', 'hex');

function adbSignToken(privateKey, token) {
  return crypto.privateEncrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([DIGEST_INFO_SHA1, token])
  );
}

/**
 * 在 ip:port 上执行一条命令，返回原始输出。
 * opts.exec = true 时走 exec: 服务（不经过 pty，二进制输出不被改成 CRLF，screencap 必须用这个）；
 * 默认走 shell:（和电脑上 adb shell 一致）。
 * opts.binary = true 时返回 Buffer，否则按 utf8 文本返回。
 * @returns {Promise<string|Buffer>}
 */
function adbShell(ip, port, cmd, opts) {
  const o = opts || {};
  const timeout = o.timeout || DEFAULT_TIMEOUT;
  const service = (o.exec ? 'exec:' : 'shell:') + cmd;
  return new Promise((resolve, reject) => {
    let key;
    try { key = ensureKey(); } catch (e) { return reject(e); }
    const priv = crypto.createPrivateKey(key.privatePem);

    let maxdata = 4096;
    const localId = 1;
    let remoteId = 0;
    let pubSent = false;
    let done = false;
    const outs = [];
    let buf = Buffer.alloc(0);

    const sock = net.createConnection({ host: ip, port: Number(port) || DEFAULT_PORT });
    const fail = msg => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(new Error(msg));
    };
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      const all = Buffer.concat(outs);
      resolve(o.binary ? all : all.toString('utf8'));
    };
    const timer = setTimeout(() => fail('超时：' + Math.round(timeout / 1000) + ' 秒内没有等到电视响应'), timeout);

    const send = (c, a0, a1, data) => {
      try { sock.write(packet(c, a0, a1, data || null)); } catch (e) { fail('发送失败：' + e.message); }
    };

    sock.on('connect', () =>
      // 和官方客户端保持一致的握手参数，避免个别老 adbd 挑参数
      send(A_CNXN, 0x01000001, 1048576,
        Buffer.from('host::features=shell_v2,cmd,stat_v2,ls_v2,fixed_push_mkdir,appendcmd\0', 'utf8'))
    );

    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      drain();
    });
    sock.on('error', e => fail('连接失败：' + e.message));
    sock.on('close', () => finish());   // 设备没发 CLSE 直接断开也把已收到的还回去

    function drain() {
      while (buf.length >= 24) {
        const pcmd = buf.readUInt32LE(0);
        const a0 = buf.readUInt32LE(4);
        const a1 = buf.readUInt32LE(8);
        const len = buf.readUInt32LE(12);
        if (len > 4 * 1024 * 1024) return fail('协议异常：数据包过大');
        if (buf.length < 24 + len) return;
        const data = buf.slice(24, 24 + len);
        buf = buf.slice(24 + len);

        if (pcmd === A_CNXN) {
          maxdata = a1 || 4096;
          send(A_OPEN, localId, 0, Buffer.from(service + '\0', 'utf8'));
        } else if (pcmd === A_AUTH) {
          if (a0 === AUTH_TOKEN) {
            // 拿私钥对设备给的 token 签名；电视认得我们的公钥就放行
            const sig = adbSignToken(priv, data);
            send(A_AUTH, AUTH_SIGNATURE, 0, sig);
          } else if (a0 === AUTH_RSAPUBLICKEY) {
            if (pubSent) return fail('电视要求 USB 调试授权，但电视上没有完成确认（需在电视上点一次「允许」）');
            pubSent = true;
            send(A_AUTH, AUTH_RSAPUBLICKEY, 0, Buffer.from(adbPublicKeyString(key.privatePem, key.name), 'utf8'));
          }
          // AUTH_SIGNATURE 来自设备的情况忽略
        } else if (pcmd === A_OKAY) {
          if (a1 === localId) remoteId = a0;
        } else if (pcmd === A_WRTE) {
          if (a1 === localId) {
            outs.push(data);
            send(A_OKAY, localId, a0);
          }
        } else if (pcmd === A_CLSE) {
          if (a1 === localId || a0 === remoteId) finish();
        }
        // 其它命令忽略
      }
    }
  });
}

module.exports = { adbShell, adbExec, adbPublicKeyString, ensureKey, keyInfo, setKey, DEFAULT_PORT };

/** 截屏这类二进制输出走 exec: 服务（老 adb 的 shell: 会把 \n 改成 \r\n，PNG 直接损坏） */
function adbExec(ip, port, cmd, opts) {
  return adbShell(ip, port, cmd, Object.assign({}, opts, { exec: true, binary: true }));
}

// node src/adb.js 192.168.1.73 5555 "echo hello"
if (require.main === module) {
  const [, , ip, port] = process.argv;
  const cmd = process.argv.slice(4).join(' ') || 'echo ok';
  adbShell(ip || '127.0.0.1', port || DEFAULT_PORT, cmd)
    .then(r => { console.log(r.trim()); process.exit(0); })
    .catch(e => { console.error('ERR:', e.message); process.exit(1); });
}
