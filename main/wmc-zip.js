/**
 * WMC 启动器 · ZIP 读取（主进程，零第三方依赖）
 * ---------------------------------------------------------------------------
 * 为什么自己做：整合包解析只需要「列目录 + 读单个文件 + 解压」这三件事，
 * 自己实现可以避免为一个功能引入依赖；如果宿主项目里已经装了 adm-zip，
 * 下面的 ZipReader.openWithAdmZip() / loadAdmZip() 会自动优先使用它。
 *
 * 支持：stored（method 0）与 deflate（method 8）；Zip64 会给出明确提示而不是静默出错。
 * 安全：所有解压路径都过 isUnsafeName()，防止 zip-slip（../ 或绝对路径写到目录外）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_COMMENT = 0xffff;

/** 尝试加载 adm-zip（有就用，没有就走内置实现） */
function loadAdmZip() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require('adm-zip');
  } catch {
    return null;
  }
}

/** 目录穿越 / 绝对路径 / 非法字符检测（解压前必须调用） */
function isUnsafeName(name) {
  const raw = String(name || '');
  if (!raw || raw.includes('\0')) return true;
  if (raw.startsWith('/') || raw.startsWith('\\')) return true;
  if (/^[a-zA-Z]:/.test(raw)) return true;
  const parts = raw.split(/[\\/]+/);
  return parts.some((p) => p === '..');
}

class ZipReader {
  /**
   * @param {Buffer} buffer
   * @param {string} [label] 便于报错时说明来源
   */
  constructor(buffer, label = '(buffer)') {
    this.label = label;
    this.buffer = buffer;          // readEntry() 要用到，别漏
    this.entries = [];
    this.zip64 = false;

    const eocd = findEocd(buffer);
    if (!eocd) throw new Error(`${label}：不是有效的 zip（找不到中央目录结束标记）`);

    const total = buffer.readUInt16LE(eocd + 10);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    if (total === 0xffff || cdOffset === 0xffffffff) this.zip64 = true;

    let offset = cdOffset;
    for (let i = 0; i < total; i += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
        throw new Error(`${label}：中央目录第 ${i + 1} 条记录损坏`);
      }
      const method = buffer.readUInt16LE(offset + 10);
      const compSize = buffer.readUInt32LE(offset + 20);
      const uncompSize = buffer.readUInt32LE(offset + 24);
      const nameLen = buffer.readUInt16LE(offset + 28);
      const extraLen = buffer.readUInt16LE(offset + 30);
      const commentLen = buffer.readUInt16LE(offset + 32);
      const localOffset = buffer.readUInt32LE(offset + 42);
      const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);

      if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
        this.zip64 = true;
      }
      this.entries.push({
        name,
        method,
        compressedSize: compSize,
        size: uncompSize,
        localOffset,
        isDir: name.endsWith('/') || name.endsWith('\\'),
        unsafe: isUnsafeName(name),
      });
      offset += 46 + nameLen + extraLen + commentLen;
    }
  }

  /** 打开磁盘上的 zip 文件 */
  static open(filePath, options = {}) {
    const buffer = fs.readFileSync(filePath);
    if (options.preferAdmZip !== false) {
      const AdmZip = options.AdmZip || loadAdmZip();
      if (AdmZip) return new AdmZipAdapter(filePath, buffer, AdmZip);
    }
    return new ZipReader(buffer, path.basename(filePath));
  }

  static fromBuffer(buffer, label = '(buffer)') {
    return new ZipReader(buffer, label);
  }

  /** 条目名列表 */
  names() {
    return this.entries.map((e) => e.name);
  }

  has(name) {
    const wanted = String(name).replace(/\\/g, '/').toLowerCase();
    return this.entries.some((e) => e.name.replace(/\\/g, '/').toLowerCase() === wanted);
  }

  /** 按子串 / 正则找条目名 */
  find(pattern) {
    const test = pattern instanceof RegExp
      ? (n) => pattern.test(n)
      : (n) => n.toLowerCase().includes(String(pattern).toLowerCase());
    return this.entries.filter((e) => test(e.name)).map((e) => e.name);
  }

  entry(name) {
    const wanted = String(name).replace(/\\/g, '/').toLowerCase();
    return this.entries.find((e) => e.name.replace(/\\/g, '/').toLowerCase() === wanted) || null;
  }

  /** 读取单个条目为 Buffer */
  read(name) {
    const entry = this.entry(name);
    if (!entry) throw new Error(`${this.label}：zip 里没有 ${name}`);
    return this.readEntry(entry);
  }

  readText(name) {
    return this.read(name).toString('utf8');
  }

  /** 读取条目（解析本地头 → 取数据 → 按需解压） */
  readEntry(entry) {
    const buffer = this.buffer;
    const off = entry.localOffset;
    if (buffer.readUInt32LE(off) !== LOCAL_SIG) {
      throw new Error(`${this.label}：${entry.name} 的本地头损坏`);
    }
    const nameLen = buffer.readUInt16LE(off + 26);
    const extraLen = buffer.readUInt16LE(off + 28);
    const start = off + 30 + nameLen + extraLen;
    const raw = buffer.subarray(start, start + entry.compressedSize);

    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) {
      try {
        return zlib.inflateRawSync(raw);
      } catch (error) {
        throw new Error(`${this.label}：${entry.name} 解压失败（${error?.message || error}）`);
      }
    }
    throw new Error(`${this.label}：${entry.name} 使用了不支持的压缩方式 ${entry.method}（Zip64 / bzip2 等）`);
  }

  /**
   * 解压到目标目录（自动建目录 + zip-slip 防护）。
   * @returns {{extracted:number, skipped:Array<{name:string,reason:string}>}}
   */
  extractTo(targetDir, options = {}) {
    const { filter, overwrite = true, onFile } = options;
    const skipped = [];
    let extracted = 0;
    fs.mkdirSync(targetDir, { recursive: true });
    const rootReal = fs.realpathSync(targetDir);

    for (const entry of this.entries) {
      if (entry.isDir) continue;
      if (entry.unsafe) { skipped.push({ name: entry.name, reason: '不安全路径（zip-slip）' }); continue; }
      if (filter && !filter(entry.name)) { skipped.push({ name: entry.name, reason: '被过滤器排除' }); continue; }

      const dest = path.join(targetDir, entry.name);
      // 双保险：解析后的真实路径必须仍在目标目录内
      const destDir = path.dirname(dest);
      fs.mkdirSync(destDir, { recursive: true });
      const destReal = fs.realpathSync(destDir);
      if (destReal !== rootReal && !destReal.startsWith(rootReal + path.sep)) {
        skipped.push({ name: entry.name, reason: '解压后越出目标目录' });
        continue;
      }
      if (!overwrite && fs.existsSync(dest)) { skipped.push({ name: entry.name, reason: '已存在' }); continue; }

      fs.writeFileSync(dest, this.readEntry(entry));
      extracted += 1;
      if (typeof onFile === 'function') onFile(entry.name, extracted);
    }
    return { extracted, skipped };
  }
}

/** adm-zip 适配器：接口与 ZipReader 保持一致，宿主有依赖时自动走它 */
class AdmZipAdapter {
  constructor(filePath, buffer, AdmZip) {
    this.label = path.basename(filePath);
    this.zip = new AdmZip(buffer);
    this.entries = this.zip.getEntries().map((e) => ({
      name: e.entryName,
      method: e.header?.method ?? 0,
      compressedSize: e.header?.compressedSize ?? 0,
      size: e.header?.size ?? 0,
      localOffset: 0,
      isDir: e.isDirectory,
      unsafe: isUnsafeName(e.entryName),
    }));
    this.zip64 = false;
  }

  static open(filePath, options = {}) {
    const AdmZip = options.AdmZip || loadAdmZip();
    if (!AdmZip) throw new Error('未安装 adm-zip');
    return new AdmZipAdapter(filePath, fs.readFileSync(filePath), AdmZip);
  }

  static fromBuffer(buffer, label = '(buffer)') {
    const AdmZip = loadAdmZip();
    if (!AdmZip) throw new Error('未安装 adm-zip');
    return new AdmZipAdapter(label, buffer, AdmZip);
  }

  names() { return this.entries.map((e) => e.name); }

  has(name) {
    const wanted = String(name).replace(/\\/g, '/').toLowerCase();
    return this.entries.some((e) => e.name.replace(/\\/g, '/').toLowerCase() === wanted);
  }

  find(pattern) {
    const test = pattern instanceof RegExp ? (n) => pattern.test(n) : (n) => n.toLowerCase().includes(String(pattern).toLowerCase());
    return this.entries.filter((e) => test(e.name)).map((e) => e.name);
  }

  read(name) {
    const hit = this.zip.getEntry(String(name).replace(/\\/g, '/'));
    if (!hit) throw new Error(`${this.label}：zip 里没有 ${name}`);
    return hit.getData();
  }

  readText(name) { return this.read(name).toString('utf8'); }

  extractTo(targetDir, options = {}) {
    const skipped = [];
    let extracted = 0;
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of this.zip.getEntries()) {
      if (entry.isDirectory) continue;
      if (isUnsafeName(entry.entryName)) { skipped.push({ name: entry.entryName, reason: '不安全路径（zip-slip）' }); continue; }
      if (options.filter && !options.filter(entry.entryName)) { skipped.push({ name: entry.entryName, reason: '被过滤器排除' }); continue; }
      const dest = path.join(targetDir, entry.entryName);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
      extracted += 1;
    }
    return { extracted, skipped };
  }
}

/** 从文件尾部找 EOCD（可能带注释，所以从后往前扫） */
function findEocd(buffer) {
  const start = Math.max(0, buffer.length - (MAX_COMMENT + 22));
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

module.exports = { ZipReader, AdmZipAdapter, isUnsafeName, loadAdmZip, findEocd };