import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// Protocol fixture: exercises real HTTP, multipart and ZIP bytes; never contacts Lanzou.
export async function startMockLanzou({ ignoreRange = false, uncertainUpload = false, challengeLogin = false, slowDownloads = false, rejectSpecialFolderNames = false, uncertainFolderCreate = false, directoryReply, pageReply, uploadDelay = 0 } = {}) {
  const folders = new Map(); const files = new Map(); const uploads = new Map(); const parents = new Map();
  let nextId = 10, uncertain = uncertainUpload, uncertainFolder = uncertainFolderCreate, activeDownloads = 0, maxDownloads = 0, activeUploads = 0, maxUploads = 0;
  const requests = [], folderAttempts = [], uploadOrder = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const request = { path: url.pathname, method: req.method, range: req.headers.range, cookie: req.headers.cookie };
      requests.push(request);
      const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = Buffer.concat(chunks);
      const fields = new URLSearchParams(body.toString());
      const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      const html = value => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(value); };
      const loggedIn = () => req.headers.cookie?.includes('ylogin=account');
      const origin = `http://${req.headers.host}`;
      if (pageReply) {
        const reply = await pageReply({ url, fields, headers: req.headers, origin });
        if (typeof reply === 'string') return html(reply);
        if (reply?.redirect) { res.writeHead(302, { Location: reply.redirect }); return res.end(); }
        if (reply?.json) return json(reply.json);
      }
      if (url.pathname === '/accounts.php') {
        if (challengeLogin && !req.headers.cookie?.includes('acw_sc__v2=')) return html("<script>var arg1='0123456789abcdef0123456789abcdef01234567';</script>");
        if (fields.get('username') !== 'test' || fields.get('password') !== 'only-for-fixture') return json({ zt: 0, msgs: '账号密码错误' });
        return json({ zt: '1', msgs: `${origin}/auth` });
      }
      if (url.pathname === '/auth') {
        res.setHeader('Set-Cookie', ['ylogin=account; Path=/; HttpOnly', 'phpdisk_info=session; Path=/; HttpOnly', 'PHPSESSID=fixed; Path=/']); return html('ok');
      }
      if (url.pathname === '/mydisk.php') return html(loggedIn() ? "<script>var uid='123';var vei='session-key=';</script>" : '<input type="password">');
      if (url.pathname === '/doupload.php') {
        Object.assign(request, { task: fields.get('task'), folderId: fields.get('folder_id'), page: fields.get('pg'), fileId: fields.get('file_id'), fields: Object.fromEntries(fields) });
        if (!loggedIn()) return json({ zt: 9 });
        if (url.searchParams.get('uid') !== '123' || url.searchParams.get('vei') !== 'session-key=') return json({ zt: 9 });
        const folder = fields.get('folder_id');
        if (directoryReply && ['47', '5'].includes(fields.get('task'))) {
          const reply = await directoryReply({ task: fields.get('task'), folderId: folder, page: Number(fields.get('pg') || 1) });
          if (reply) return json(reply);
        }
        switch (fields.get('task')) {
          case '47': return json({ zt: 1, text: [...folders].filter(([id]) => (parents.get(id) || '-1') === folder).map(([id,name]) => ({ fol_id: id, name })) });
          case '5': return json({ zt: fields.get('pg') === '1' ? 1 : 2, text: fields.get('pg') === '1' ? [...files.values()].filter(f => f.folderId === folder).map(f => ({ id: f.id, name_all: f.name, size: f.data.length })) : [] });
          case '2': {
            const name = fields.get('folder_name'); folderAttempts.push(name);
            if (rejectSpecialFolderNames && !/^[a-z0-9]+$/i.test(name)) return json({ zt: 0, info: '名称含有特殊字符' });
            const id = String(nextId++); folders.set(id, name); parents.set(id, fields.get('parent_id') || '-1');
            if (uncertainFolder) { uncertainFolder = false; res.writeHead(502); return res.end('uncertain folder acknowledgement'); }
            return json({ zt: 1, text: id });
          }
          case '3': {
            if (!folders.has(folder)) return json({ zt: 0, info: '文件夹不存在' });
            const deleted = new Set([folder]); let changed = true;
            while (changed) { changed = false; for (const [id, parent] of parents) if (deleted.has(parent) && !deleted.has(id)) { deleted.add(id); changed = true; } }
            for (const id of deleted) { folders.delete(id); parents.delete(id); }
            for (const [id, file] of files) if (deleted.has(file.folderId)) files.delete(id);
            return json({ zt: 1 });
          }
          case '6': {
            if (!files.delete(fields.get('file_id'))) return json({ zt: 0, info: '文件不存在' });
            return json({ zt: 1 });
          }
          case '4': {
            if (!folders.has(folder)) return json({ zt: 0, info: '文件夹不存在' });
            folders.set(folder, fields.get('folder_name')); return json({ zt: 1 });
          }
          case '46': {
            const file = files.get(fields.get('file_id'));
            if (!file) return json({ zt: 0, info: '文件不存在' });
            file.name = fields.get('file_name'); return json({ zt: 1 });
          }
          case '22': return json({ zt: 1, info: { f_id: `i${fields.get('file_id')}`, is_newd: origin, pwd: '' } });
          case '18': return json({ zt: 1, info: { new_url: `folder${fields.get('file_id')}`, is_newd: origin, pwd: '' } });
          default: return json({ zt: 0, info: 'unknown task' });
        }
      }
      if (url.pathname === '/html5up.php') {
        if (!loggedIn()) return json({ zt: 9 });
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const pieces = body.toString('latin1').split(`--${boundary}`);
        const values = {}; let payload;
        for (const piece of pieces) {
          const offset = piece.indexOf('\r\n\r\n'); if (offset < 0) continue;
          const header = piece.slice(0, offset); const name = header.match(/name="([^"]+)"/)?.[1];
          const content = Buffer.from(piece.slice(offset + 4, -2), 'latin1');
          if (header.includes('filename=')) payload = content; else if (name) values[name] = content.toString();
        }
        if (!payload || values.task !== '1' || values.vie !== '2' || values.ve !== '2' || !folders.has(values.folder_id_bb_n)) return json({ zt: 0, info: 'bad multipart' });
        activeUploads++; maxUploads = Math.max(maxUploads, activeUploads);
        res.once('close', () => { activeUploads--; });
        if (uploadDelay) await delay(typeof uploadDelay === 'function' ? uploadDelay(values.name) : uploadDelay);
        if (res.destroyed) return;
        const id = String(nextId++); files.set(id, { id, folderId: values.folder_id_bb_n, name: values.name, data: payload });
        uploads.set(values.name, (uploads.get(values.name) || 0) + 1);
        uploadOrder.push(values.name);
        if (uncertain && values.name.endsWith('.zip')) { uncertain = false; res.writeHead(502); return res.end('uncertain acknowledgement'); }
        return json({ zt: 1, text: [{ id }] });
      }
      const folderMatch = url.pathname.match(/^\/folder(\d+)$/);
      if (folderMatch) return html(`<script>var lx='1';var fid='${folderMatch[1]}';var t='time';var k='key';</script>filemoreajax`);
      if (url.pathname === '/filemoreajax.php') return json({ zt: fields.get('pg') === '1' ? 1 : 2, text: fields.get('pg') === '1' ? [...files.values()].filter(f => f.folderId === fields.get('fid')).map(f => ({ id: `i${f.id}?token=member`, name_all: f.name })) : [] });
      const member = url.pathname.match(/^\/i(\d+)$/);
      if (member) return html(`<title>${files.get(member[1])?.name || ''} - 蓝奏云</title><script>var token='signed';var key='key';var ajaxdata='key';$.ajax({url:'/ajaxm.php?file=${member[1]}',data:{action:'downprocess',sign:token,websignkey:key,websign:'',kd:1}});</script>`);
      if (url.pathname === '/ajaxm.php') {
        if (fields.get('sign') !== 'signed' || fields.get('websignkey') !== 'key') return json({ zt: 0, info: 'missing signature' });
        return json({ zt: 1, dom: origin, url: url.searchParams.get('file') });
      }
      const download = url.pathname.match(/^\/file\/(\d+)$/);
      if (download) {
        const file = files.get(download[1]); if (!file) { res.writeHead(404); return res.end(); }
        let offset = 0, code = 200;
        if (req.headers.range && !ignoreRange) { offset = Number(req.headers.range.match(/bytes=(\d+)-/)?.[1] || 0); code = 206; }
        if (offset >= file.data.length && file.data.length) { res.writeHead(416); return res.end(); }
        const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': file.data.length - offset, 'Accept-Ranges': 'bytes' };
        if (code === 206) headers['Content-Range'] = `bytes ${offset}-${file.data.length - 1}/${file.data.length}`;
        res.writeHead(code, headers); if (req.method === 'HEAD') return res.end();
        activeDownloads++; maxDownloads = Math.max(maxDownloads, activeDownloads);
        try {
          for (let i = offset; i < file.data.length; i += 4096) {
            if (slowDownloads) await delay(typeof slowDownloads === 'number' ? slowDownloads : 2);
            if (res.destroyed) break;
            if (!res.write(file.data.subarray(i, i + 4096))) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
          }
          res.end();
        } finally { activeDownloads--; }
        return;
      }
      res.writeHead(404); res.end();
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, folders, files, parents, uploads, requests, folderAttempts, uploadOrder, get activeUploads() { return activeUploads; }, get maxUploads() { return maxUploads; }, resetUploadPeak() { maxUploads = activeUploads; }, get maxDownloads() { return maxDownloads; }, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
