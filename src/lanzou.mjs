/* Adapted from CYQawa/YunX LanzouApi.kt, commit cc9afe24c9409b239c361263b976f7aad77d1d9e.
 * Copyright (C) 2026 CYQawa; modifications licensed AGPL-3.0-or-later. See THIRD_PARTY_NOTICES.md. */
import { CookieJar } from 'tough-cookie';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

export const ACCOUNT_ORIGIN = 'https://accounts.woozooo.com';
export const PC_ORIGIN = 'https://pc.woozooo.com';
export const WEB_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
export const MANIFEST_NAME = 'manifest.lanzou.txt';

export class LanzouError extends Error {
  constructor(message, code = 'API_ERROR') { super(message); this.code = code; }
}

export function challengeCookie(html) {
  const arg = html.match(/\barg1\s*=\s*['"]([a-f\d]{40})['"]/i)?.[1];
  if (!arg) return null;
  const positions = [15,35,29,24,33,16,1,38,10,9,19,31,40,27,22,23,25,13,6,11,39,18,20,8,14,21,32,26,2,30,7,4,17,5,3,28,34,37,12,36];
  const reordered = positions.map(i => arg[i - 1]).join('');
  const mask = '3000176000856006061501533003690027800375';
  return Buffer.from(reordered, 'hex').map((b, i) => b ^ Buffer.from(mask, 'hex')[i]).toString('hex');
}

function strip(value) { return String(value ?? '').replace(/<[^>]*>/g, '').trim(); }
const firstNonBlank = (...values) => values.find(value => value != null && String(value).trim() !== '');
export function parseDisplaySize(value) {
  const match = String(value ?? '').trim().match(/^([\d.]+)\s*([KMGT]?)/i);
  if (!match || !Number.isFinite(Number(match[1]))) return 0;
  const power = match[2] ? 'KMGT'.indexOf(match[2].toUpperCase()) + 1 : 0;
  return Math.floor(Number(match[1]) * 1024 ** power);
}
function directoryEntry(item, isFolder, folderId) {
  if (!item || typeof item !== 'object') return null;
  const id = String((isFolder ? firstNonBlank(item.fol_id, item.id) : item.id) ?? '').trim();
  if (!id) return null;
  return { id, name: String((isFolder ? firstNonBlank(item.name, item.name_all) : firstNonBlank(item.name_all, item.name)) ?? ''), isFolder, parentId: folderId, displaySize: isFolder ? '' : String(item.size ?? ''), size: isFolder ? 0 : parseDisplaySize(item.size), modifiedTime: String(item.time ?? '') };
}
const JS_ATOM = String.raw`(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|[$A-Z_a-z][\w$]*|\d+)`;
const JS_VALUE = `${JS_ATOM}(?:\\s*\\+\\s*${JS_ATOM})*`;
function staticValue(html, expression, seen = new Set()) {
  const raw = expression.trim().replace(/^\(([^()]*)\)$/, '$1').trim();
  if (!new RegExp(`^${JS_VALUE}$`).test(raw)) return undefined;
  const values = [...raw.matchAll(new RegExp(JS_ATOM, 'g'))].map(([token]) => {
    if (/^['"]/.test(token)) return token.slice(1, -1).replace(/\\(x[\da-f]{2}|u[\da-f]{4}|[\s\S])/gi, (_, escape) => {
      if (/^[xu][\da-f]+$/i.test(escape)) return String.fromCharCode(parseInt(escape.slice(1), 16));
      return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f', v:'\v', '0':'\0' })[escape] ?? escape;
    });
    return /^\d+$/.test(token) ? token : variable(html, token, seen);
  });
  return values.some(value => value === undefined) ? undefined : values.join('');
}
function variable(html, name, seen = new Set()) {
  if (seen.has(name) || seen.size >= 8) return undefined;
  const visited = new Set(seen).add(name), key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...html.matchAll(new RegExp(`(?<![\\w$.])${key}\\s*=(?!=)\\s*(${JS_VALUE})(?=\\s*(?:[,;\\r\\n<}]|$))`, 'g'))];
  for (const match of matches.reverse()) {
    const value = staticValue(html, match[1], visited);
    if (value !== undefined) return value;
  }
}
function inputValue(html, name) {
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    if (input[0].match(/\bname=['"]([^'"]*)['"]/i)?.[1] === name)
      return input[0].match(/\bvalue=['"]([^'"]*)['"]/i)?.[1];
  }
}
export function dataObjects(html) {
  return [...html.matchAll(new RegExp(`(?:\\bdata|['"]data['"])\\s*:\\s*(\\{[^{}]*\\}|${JS_VALUE})`, 'gs'))].map(match => {
    let body = match[1];
    if (/^[$A-Z_a-z][\w$]*$/.test(body)) {
      const key = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = html.match(new RegExp(`(?<![\\w$.])${key}\\s*=\\s*\\{([^{}]*)\\}`, 's'))?.[1] ?? body;
    }
    const query = staticValue(html, body);
    if (query?.includes('action=')) return Object.fromEntries(new URLSearchParams(query));
    const data = {};
    for (const pair of body.matchAll(/(?:['"]([A-Za-z_][\w]*)['"]|([A-Za-z_][\w]*))\s*:\s*([^,}\r\n]+)/g)) {
      const value = staticValue(html, pair[3]);
      if (value !== undefined) data[pair[1] || pair[2]] = value;
    }
    return data;
  });
}
export function isLanzouHost(host) {
  return /^(?:[a-z0-9-]+\.)*(?:lanzou[a-z]?|lan[zs]o[ux]|lanzn)\.(?:com|net|org|cn)$/i.test(host);
}

export async function readBounded(response, max = 4 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > max) { await response.body?.cancel().catch(() => {}); throw new LanzouError('服务器响应超过允许大小'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class LanzouClient {
  constructor({ accountOrigin = ACCOUNT_ORIGIN, pcOrigin = PC_ORIGIN, fetchImpl = fetch, jar } = {}) {
    this.accountOrigin = accountOrigin; this.pcOrigin = pcOrigin;
    this.fetchImpl = fetchImpl; this.jar = jar ?? new CookieJar();
    this.uid = null; this.vei = null;
  }
  get loggedIn() { return Boolean(this.uid && this.vei); }
  async request(url, options = {}) {
    let current = new URL(url); let method = options.method || 'GET'; let body = options.body;
    for (let i = 0; i < 10; i++) {
      if (!['http:', 'https:'].includes(current.protocol)) throw new LanzouError('无效的网络地址');
      const headers = new Headers({ 'User-Agent': WEB_UA, 'Accept-Encoding': 'identity', ...options.headers });
      const cookies = await this.jar.getCookieString(current.href);
      if (cookies) headers.set('Cookie', cookies);
      const signal = AbortSignal.any([AbortSignal.timeout(options.timeout ?? 600000), ...(options.signal ? [options.signal] : [])]);
      const response = await this.fetchImpl(current.href, { method, body, headers, signal, redirect: 'manual', ...(body && typeof body !== 'string' && !(body instanceof URLSearchParams) && !Buffer.isBuffer(body) ? { duplex: 'half' } : {}) });
      for (const cookie of response.headers.getSetCookie()) await this.jar.setCookie(cookie, current.href).catch(() => {});
      if (response.status >= 300 && response.status < 400 && response.headers.has('location') && options.redirect !== 'manual') {
        const next = new URL(response.headers.get('location'), current);
        await response.body?.cancel();
        if (current.protocol === 'https:' && next.protocol !== 'https:') throw new LanzouError('服务器尝试跳转到不安全连接');
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        else if (body && typeof body.pipe === 'function') throw new LanzouError('上传地址发生跳转，请重新登录');
        current = next; continue;
      }
      return response;
    }
    throw new LanzouError('跳转次数过多');
  }
  async text(url, options = {}) { return (await this.textPage(url, options)).html; }
  async textPage(url, options = {}) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.request(url, { ...options, timeout: options.timeout ?? 45000 });
      if (response.status === 429) { await response.body?.cancel(); throw new LanzouError('请求过于频繁，请稍后继续', 'RATE_LIMIT'); }
      if (response.status >= 500) { await response.body?.cancel(); throw new LanzouError(`服务器暂时不可用（HTTP ${response.status}）`, 'NETWORK'); }
      const text = await readBounded(response);
      const cookie = challengeCookie(text);
      if (cookie && !text.includes('"zt"')) {
        await this.jar.setCookie(`acw_sc__v2=${cookie}; Path=/`, url); continue;
      }
      if (!response.ok) throw new LanzouError(`请求失败（HTTP ${response.status}）`, response.status === 401 || response.status === 403 ? 'AUTH_EXPIRED' : 'NETWORK');
      return { html: text, url: response.url || String(url) };
    }
    throw new LanzouError('需要在官网登录窗口完成验证', 'VERIFY_REQUIRED');
  }
  async json(url, options = {}) {
    const body = await this.text(url, options);
    try { return JSON.parse(body); }
    catch { throw new LanzouError(body.trimStart().startsWith('<') ? '服务器返回验证页面，请在官网登录窗口完成验证' : '服务器响应格式已变化', 'VERIFY_REQUIRED'); }
  }
  async login(account, password, signal) {
    if (!String(account).trim() || !password) throw new LanzouError('请输入账号和密码');
    this.uid = this.vei = null;
    const json = await this.json(`${this.accountOrigin}/accounts.php`, {
      method: 'POST', signal,
      headers: { Origin: this.accountOrigin, Referer: `${this.accountOrigin}/accounts.php?action=login&ref=pc.woozooo.com`, 'X-Requested-With': 'XMLHttpRequest' },
      body: new URLSearchParams({ task: 'uselogin', username: String(account).trim(), password, ref: 'pc.woozooo.com' })
    });
    if (String(json.zt) !== '1') throw new LanzouError(strip(json.msgs) || '登录失败，请检查账号密码');
    if (json.msgs) {
      const auth = new URL(json.msgs);
      if (auth.origin !== this.pcOrigin && auth.origin !== this.accountOrigin && !auth.hostname.endsWith('.woozooo.com')) throw new LanzouError('登录响应包含未知鉴权域名');
      await this.text(auth.href, { signal, headers: { Referer: `${this.accountOrigin}/` } });
    }
    return this.refresh(signal);
  }
  async refresh(signal) {
    this.uid = this.vei = null;
    const html = await this.text(`${this.pcOrigin}/mydisk.php?item=files&action=index`, { signal, headers: { Referer: `${this.pcOrigin}/mydisk.php` } });
    const uid = html.match(/uid['"]?\s*[=:]\s*['"]?(\d{1,20})/)?.[1];
    const vei = html.match(/vei['"]?\s*[=:]\s*['"]?([A-Za-z0-9_\-+/=]{1,256})/)?.[1];
    if (!uid || !vei) throw new LanzouError('登录已失效或尚未完成，请重新登录', 'AUTH_EXPIRED');
    this.uid = uid; this.vei = vei;
    return { loggedIn: true, uid };
  }
  async doupload(fields, signal, allowEnd = false) {
    if (!this.loggedIn) throw new LanzouError('请先登录蓝奏云', 'AUTH_EXPIRED');
    const json = await this.json(`${this.pcOrigin}/doupload.php?${new URLSearchParams({ uid: this.uid, vei: this.vei })}`, {
      method: 'POST', signal, body: new URLSearchParams(fields),
      headers: { Referer: `${this.pcOrigin}/mydisk.php`, Origin: this.pcOrigin, 'X-Requested-With': 'XMLHttpRequest' }
    });
    this.checkStatus(json, allowEnd);
    return json;
  }
  checkStatus(json, allowEnd = false) {
    const zt = Number(json.zt);
    if (zt === 1 || (allowEnd && zt === 2)) return;
    if (zt === 9) { this.uid = this.vei = null; throw new LanzouError('登录已过期，请登录后继续任务', 'AUTH_EXPIRED'); }
    if (zt === 4) throw new LanzouError('蓝奏云限制了请求频率，请稍后继续', 'RATE_LIMIT');
    throw new LanzouError(strip(json.info || json.msgs) || `蓝奏云操作失败（${zt}）`);
  }
  async readDirectory(fields, signal) {
    for (let retry = 0; ; retry++) {
      signal?.throwIfAborted();
      try { return await this.doupload(fields, signal, true); }
      catch (error) {
        if (signal?.aborted || retry === 2 || !['RATE_LIMIT', 'NETWORK'].includes(error.code)) throw error;
        await delay(600 * (retry + 1), undefined, { signal });
      }
    }
  }
  async listPage(folderId = '-1', page = 1, signal) {
    folderId = String(folderId).replace(/^d:/, '');
    if (!/^(?:-1|\d+)$/.test(folderId) || !Number.isSafeInteger(page) || page < 1 || page > 1000) throw new LanzouError('目录或页码无效');
    const entries = []; const seen = new Set();
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const read = async fields => {
      try { return await this.readDirectory(fields, combined); }
      catch (error) { controller.abort(error); throw error; }
    };
    const replies = await Promise.allSettled([
      page === 1 ? read({ task: '47', folder_id: folderId }) : null,
      read({ task: '5', folder_id: folderId, pg: String(page) })
    ]);
    if (replies.some(reply => reply.status === 'rejected')) throw controller.signal.reason;
    const [folders, json] = replies.map(reply => reply.value);
    if (folders) {
      for (const item of Array.isArray(folders.text) ? folders.text : []) {
        const entry = directoryEntry(item, true, folderId);
        if (entry && !seen.has(entry.id)) { seen.add(entry.id); entries.push(entry); }
      }
    }
    const files = (Array.isArray(json.text) ? json.text : []).map(item => directoryEntry(item, false, folderId)).filter(Boolean);
    seen.clear();
    for (const file of files) if (!seen.has(file.id)) { seen.add(file.id); entries.push(file); }
    if (Array.isArray(json.text) && json.text.length && !files.length) throw new LanzouError('文件列表没有有效条目，已停止翻页');
    return { entries, page, hasMore: Number(json.zt) !== 2 && files.length > 0 };
  }
  async list(folderId = '-1', signal) {
    const output = [];
    const seen = new Set();
    for (let pg = 1; pg <= 1000; pg++) {
      if (pg > 1) await delay(250, undefined, { signal });
      const result = await this.listPage(folderId, pg, signal);
      let added = 0;
      for (const entry of result.entries) {
        const key = `${entry.isFolder ? 'd' : 'f'}:${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key); output.push(entry); if (!entry.isFolder) added++;
      }
      if (pg > 1 && result.entries.some(entry => !entry.isFolder) && !added) throw new LanzouError('文件列表重复返回，已停止翻页');
      if (!result.hasMore) return output;
    }
    throw new LanzouError('文件列表超过分页上限');
  }
  async createFolder(name, signal, parentId = '-1') {
    if (!/^(?:-1|\d+)$/.test(String(parentId))) throw new LanzouError('无效的上级目录');
    const json = await this.doupload({ task: '2', parent_id: String(parentId), folder_name: name, folder_description: '蓝奏切片文件，请使用蓝奏切片软件下载并合并' }, signal);
    if (!/^\d+$/.test(String(json.text))) throw new LanzouError('创建文件夹后未取得有效 ID');
    return String(json.text);
  }
  async deleteEntry(id, isFolder, signal) {
    if (!/^\d+$/.test(String(id)) || typeof isFolder !== 'boolean') throw new LanzouError('文件参数无效');
    await this.doupload({ task: isFolder ? '3' : '6', [isFolder ? 'folder_id' : 'file_id']: String(id) }, signal);
  }
  async renameEntry(id, isFolder, name, signal) {
    if (!/^\d+$/.test(String(id)) || typeof isFolder !== 'boolean') throw new LanzouError('文件参数无效');
    await this.doupload(isFolder
      ? { task: '4', folder_id: String(id), folder_name: name, folder_description: '' }
      : { task: '46', file_id: String(id), file_name: name, type: '2' }, signal);
  }
  async upload(filePath, name, folderId, { signal, onProgress = () => {} } = {}) {
    if (!this.loggedIn) throw new LanzouError('请先登录', 'AUTH_EXPIRED');
    const size = (await stat(filePath)).size;
    const boundary = `----LanzouSlice${randomBytes(12).toString('hex')}`;
    const fields = { task: '1', vie: '2', ve: '2', id: 'WU_FILE_0', name, folder_id_bb_n: String(folderId) };
    let prefix = '';
    for (const [key, value] of Object.entries(fields)) prefix += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
    prefix += `--${boundary}\r\nContent-Disposition: form-data; name="upload_file"; filename="${name.replace(/["\r\n]/g, '_')}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const start = Buffer.from(prefix); const end = Buffer.from(`\r\n--${boundary}--\r\n`);
    const stream = Readable.from((async function* () {
      yield start; let sent = 0;
      for await (const chunk of createReadStream(filePath, { signal })) { sent += chunk.length; onProgress(sent, size); yield chunk; }
      yield end;
    })());
    const response = await this.request(`${this.pcOrigin}/html5up.php?${new URLSearchParams({ uid: this.uid, vei: this.vei })}`, {
      method: 'POST', signal, body: stream,
      headers: { Referer: `${this.pcOrigin}/mydisk.php`, Origin: this.pcOrigin, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(start.length + size + end.length) }
    });
    if (!response.ok) {
      await response.body?.cancel();
      const expired = [401,403].includes(response.status);
      if (expired) this.uid = this.vei = null;
      throw new LanzouError(`上传失败（HTTP ${response.status}）`, expired ? 'AUTH_EXPIRED' : 'NETWORK');
    }
    const body = await readBounded(response);
    let json;
    try { json = JSON.parse(body); } catch { throw new LanzouError('上传返回验证页面，请通过官网登录后重试', 'VERIFY_REQUIRED'); }
    this.checkStatus(json);
    const id = json.text?.[0]?.id;
    if (id == null || !/^\d+$/.test(String(id))) throw new LanzouError('上传回执缺少有效文件 ID');
    return String(id);
  }
  async share(id, isFolder = false, signal) {
    const json = await this.doupload({ task: isFolder ? '18' : '22', file_id: String(id) }, signal);
    const info = json.info;
    if (!info || typeof info !== 'object') throw new LanzouError('分享链接返回格式异常');
    const raw = isFolder ? info.new_url : info.f_id;
    if (!raw) throw new LanzouError('未取得分享地址');
    const domain = info.is_newd || 'https://pan.lanzoui.com';
    return { url: new URL(raw, `${domain.includes('://') ? domain : `https://${domain}`}/`).href, password: info.pwd || '' };
  }
  async sharePage(url, password = '', signal) {
    const parsed = new URL(url);
    if (parsed.origin !== this.pcOrigin && (!isLanzouHost(parsed.hostname) || parsed.protocol !== 'https:')) throw new LanzouError('请输入有效的 HTTPS 蓝奏云分享链接');
    const response = await this.textPage(parsed.href, { signal });
    const finalURL = new URL(response.url), html = response.html;
    if (finalURL.origin !== this.pcOrigin && (!isLanzouHost(finalURL.hostname) || finalURL.protocol !== 'https:')) throw new LanzouError('分享页跳转到未知地址');
    if (/文件已取消|文件不存在/.test(html)) throw new LanzouError('分享已取消或不存在');
    const page = { url: finalURL.href, origin: finalURL.origin, html, isFolder: /filemoreajax|class=['"]filemore['"]|file_more/.test(html), needsPassword: /请输入密码|id=['"]pwbox['"]|input_password|function down_p\(/.test(html) };
    if (page.needsPassword && !password) throw new LanzouError('此分享需要提取码');
    return page;
  }
  async shareFiles(page, password = '', signal) {
    if (!page.isFolder) throw new LanzouError('请选择包含全部切片和清单的文件夹分享链接');
    const fields = Object.fromEntries(['lx','fid','t','k'].map(key => [key, variable(page.html, key)]));
    fields.fid ||= new URL(page.url).pathname.split('/').pop();
    if (!fields.lx || !fields.t || !fields.k) throw new LanzouError('无法读取分享目录参数，页面格式可能已变化');
    const files = []; const seen = new Set();
    for (let pg = 1; pg <= 500; pg++) {
      let json;
      for (let retry = 0; retry < 3; retry++) {
        if (pg > 1 || retry) await delay(600 * (retry + 1), undefined, { signal });
        json = await this.json(`${page.origin}/filemoreajax.php`, { method: 'POST', signal, body: new URLSearchParams({ ...fields, pwd: password, pg: String(pg) }), headers: { Referer: page.url, Origin: page.origin, 'X-Requested-With': 'XMLHttpRequest' } });
        if (Number(json.zt) !== 4) break;
      }
      if (Number(json.zt) === 3) throw new LanzouError('提取码不正确');
      this.checkStatus(json, true);
      if (!Array.isArray(json.text) || !json.text.length || Number(json.zt) === 2) return files;
      let added = 0;
      for (const item of json.text) {
        if (!item || typeof item !== 'object') continue;
        const reference = String(item.id ?? '').trim(); const id = reference.split('?')[0];
        if (!id || seen.has(id)) continue;
        seen.add(id); added++;
        files.push({ id, name: String(firstNonBlank(item.name_all, item.name) ?? ''), url: new URL(reference, `${page.origin}/`).href, isFolder: false, displaySize: String(item.size ?? ''), size: parseDisplaySize(item.size), modifiedTime: String(item.time ?? '') });
      }
      if (!added) throw new LanzouError('分享目录分页重复');
    }
    throw new LanzouError('分享目录超过分页上限');
  }
  async downloadLink(file, { page, password = '', signal } = {}) {
    let url = file.url;
    if (!url) { const share = await this.share(file.id, false, signal); url = share.url; password = share.password; }
    const landing = await this.sharePage(url, password, signal);
    let html = landing.html; let referer = landing.url;
    const visited = new Set([referer]);
    for (let depth = 0; depth < 3; depth++) {
      const hasSign = dataObjects(html).some(data => data.action === 'downprocess' && data.sign) || variable(html, 'wp_sign') || variable(html, 'sign') || inputValue(html, 'sign');
      if (hasSign && (/file=\d+/.test(html) || inputValue(html, 'file'))) break;
      if (/验证码|安全验证|人机验证|滑动验证|访问异常|captcha/i.test(html)) throw new LanzouError('下载页面要求人工验证，请在官网完成验证后重试', 'VERIFY_REQUIRED');
      const frames = [...html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"][^>]*>/gi)];
      const iframe = frames.find(frame => /(?:\b(?:id|name)\s*=\s*['"][^'"]*(?:fn|download)|\/fn[?/.]|download)/i.test(frame[0])) || frames.find(frame => new URL(frame[1].replaceAll('&amp;', '&'), referer).origin === landing.origin);
      if (!iframe) break;
      const next = new URL(iframe[1].replaceAll('&amp;', '&'), referer);
      if (next.origin !== landing.origin) throw new LanzouError('下载 iframe 来源异常');
      if (visited.has(next.href)) throw new LanzouError('下载 iframe 循环跳转');
      visited.add(next.href);
      const response = await this.textPage(next.href, { signal, headers: { Referer: referer } });
      if (new URL(response.url).origin !== landing.origin) throw new LanzouError('下载 iframe 来源异常');
      html = response.html; referer = response.url;
    }
    const fileId = html.match(/(?:ajaxm|ajaxfile)\.php\?file=(\d+)/)?.[1] || html.match(/file=(\d+)/)?.[1] || inputValue(html, 'file');
    if (!fileId) throw new LanzouError('无法识别文件下载参数');
    const withPassword = landing.needsPassword || page?.needsPassword || /function down_p\(/.test(html);
    if (withPassword && !password) throw new LanzouError('此文件需要提取码');
    const object = dataObjects(html).filter(d => d.action === 'downprocess' && d.sign).at(-1) || {};
    const sign = object.sign || variable(html, 'wp_sign') || variable(html, 'sign') || inputValue(html, 'sign');
    if (!sign) throw new LanzouError('下载页面缺少可识别的签名参数，可能是验证页或不支持的页面模板，请刷新重试', 'DOWNLOAD_PARAMS');
    const fields = { action: 'downprocess', sign };
    if (withPassword) Object.assign(fields, { p: password, kd: '1' });
    else {
      const ajax = variable(html, 'ajaxdata') || object.signs || '';
      const key = object.websignkey || ajax || variable(html, 'websignkey') || inputValue(html, 'websignkey');
      if (!key) throw new LanzouError('下载页面缺少 websignkey');
      Object.assign(fields, { websignkey: key, websign: object.websign || variable(html, 'websign') || '', kd: '1', ves: '1' });
      if (ajax) fields.signs = ajax;
    }
    const explicit = html.match(/['"]?url['"]?\s*:\s*['"]((?:\.\/)?[^'"]*ajax(?:m|file)\.php\?file=\d+[^'"]*)['"]/)?.[1];
    const candidate = explicit || [variable(html, 'domain1'), variable(html, 'domain2')].find(v => v?.includes('/ajax')) || html.match(/https?:\/\/[^'"\s]+\/(?:ajaxm|ajaxfile)\.php\?file=\d+/)?.[0] || `/${withPassword ? 'ajaxfile' : 'ajaxm'}.php?file=${fileId}`;
    const endpoint = new URL(candidate.replaceAll('&amp;', '&'), referer);
    if (endpoint.origin !== landing.origin && endpoint.hostname !== 'apifile.woozooo.com') throw new LanzouError('未知的下载参数接口');
    const json = await this.json(endpoint.href, { method: 'POST', signal, body: new URLSearchParams(fields), headers: { Referer: referer, Origin: landing.origin, 'X-Requested-With': 'XMLHttpRequest' } });
    this.checkStatus(json);
    const rel = String(json.url || '');
    if (!json.dom || !rel || rel.startsWith('/') || rel.includes('://')) throw new LanzouError(strip(json.inf) || '未取得有效下载地址');
    const dom = new URL(json.dom);
    return this.probe(`${dom.origin}/file/${rel}`, landing.origin, signal);
  }
  async probe(url, origin, signal) {
    const challenges = new Set(); const confirmations = new Set();
    for (let i = 0; i < 8; i++) {
      await this.jar.setCookie('down_ip=1; Path=/', url);
      const headers = { Referer: `${origin}/` };
      let response = await this.request(url, { method: 'HEAD', headers, signal, redirect: 'manual', timeout: 45000 });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new LanzouError('下载节点跳转缺少地址');
        url = new URL(location, url).href; continue;
      }
      if ([403,404,410].includes(response.status)) { await response.body?.cancel(); throw new LanzouError('下载地址过期，请重新取链', 'LINK_EXPIRED'); }
      if (response.status === 429) { await response.body?.cancel(); throw new LanzouError('下载请求过于频繁', 'RATE_LIMIT'); }
      const type = response.headers.get('content-type') || '';
      const size = Number(response.headers.get('content-range')?.split('/').pop() || response.headers.get('content-length') || 0);
      await response.body?.cancel();
      if (type.includes('text/html')) {
        const page = await this.request(url, { signal, headers, timeout: 45000 });
        if (page.ok && !(page.headers.get('content-type') || '').includes('text/html')) {
          const size = Number(page.headers.get('content-length') || 0);
          await page.body?.cancel();
          return { url, size, headers };
        }
        const html = await readBounded(page);
        const cookie = challengeCookie(html);
        if (cookie && !challenges.has(url)) { challenges.add(url); await this.jar.setCookie(`acw_sc__v2=${cookie}; Path=/`, url); continue; }
        if (html.includes('验证并下载') && !confirmations.has(url)) {
          confirmations.add(url);
          const data = dataObjects(html).find(d => d.file) || {};
          const file = data.file || inputValue(html, 'file');
          const sign = data.sign || variable(html, 'sign') || inputValue(html, 'sign');
          if (file && sign) {
            await delay(2000, undefined, { signal });
            const json = await this.json(new URL('ajax.php', url).href, { method: 'POST', signal, headers: { Referer: url, Origin: new URL(url).origin }, body: new URLSearchParams({ file, el: '2', sign }) });
            if (Number(json.zt) === 1 && json.url && json.url !== '?SignError') { url = new URL(json.url, url).href; continue; }
          }
        }
        throw new LanzouError('下载节点要求人工验证，请稍后重试或通过官网完成验证', 'VERIFY_REQUIRED');
      }
      if (response.ok && size > 0) return { url, size, headers };
      response = await this.request(url, { headers: { ...headers, Range: 'bytes=0-0' }, signal, timeout: 45000 });
      const probedSize = Number(response.headers.get('content-range')?.split('/').pop() || response.headers.get('content-length') || 0);
      const ok = response.ok && !(response.headers.get('content-type') || '').includes('text/html');
      await response.body?.cancel();
      if (!ok) throw new LanzouError('下载节点未返回文件内容');
      return { url, size: probedSize, headers };
    }
    throw new LanzouError('下载节点跳转或验证次数过多');
  }
}
