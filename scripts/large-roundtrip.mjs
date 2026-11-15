import { mkdir, open, copyFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import assert from 'node:assert/strict';
import { TransferEngine, sha256, MAX_PART_BYTES } from '../src/transfer.mjs';

const root = path.resolve('.tmp/large-roundtrip'); await mkdir(root, { recursive: true });
const source = path.join(root, '160MiB-plus-1.bin');
const file = await open(source, 'w'); const block = randomBytes(1024 * 1024);
for (let i = 0; i < 160; i++) await file.writeFile(block);
await file.writeFile(Buffer.from([123])); await file.close();
const remoteDir = path.join(root, 'remote'); await mkdir(remoteDir, { recursive: true });
const entries = []; let nextId = 1; let peakRSS = process.memoryUsage().rss;
const monitor = setInterval(() => { peakRSS = Math.max(peakRSS, process.memoryUsage().rss); }, 20);
const client = {
  loggedIn: true,
  async list(folderId) { return folderId === '-1' ? [] : entries; },
  async createFolder() { return '1'; },
  async upload(source, name) { const id=String(nextId++); await copyFile(source,path.join(remoteDir,id)); entries.push({id,name}); return id; },
  async share() { return {url:'fixture://offline'}; },
  async downloadLink(file) { return {url:file.id,headers:{}}; },
  async request(id) { return new Response(Readable.toWeb(createReadStream(path.join(remoteDir,id))),{status:200,headers:{'Content-Type':'application/octet-stream'}}); }
};
const engine = new TransferEngine({ client, dataDir: path.join(root,'data') }); await engine.init();
async function finish(id) { await engine.active.get(id)?.promise; const task=engine.tasks.get(id); assert.equal(task.state,'completed',task.error); return task; }
try {
  const before = Date.now();
  const upload = await finish(await engine.createUpload(source));
  assert.equal(upload.manifest.parts.length,3);
  assert.ok(upload.manifest.parts.every(p=>p.uploadSize<=MAX_PART_BYTES));
  const out = path.join(root,`out-${Date.now()}`); await mkdir(out);
  const bundle = await engine.inspectFolder(upload.folderId);
  const download = await finish(await engine.createDownload(bundle,out,4));
  assert.equal(await sha256(source), await sha256(download.resultPath));
  const result = { bytes:(await stat(source)).size, parts:upload.manifest.parts.map(p=>({payload:p.payloadSize,uploaded:p.uploadSize})),sha256:upload.manifest.sha256,elapsedMs:Date.now()-before,peakRSSMiB:Math.round(peakRSS/1024/1024),network:'offline file fixture; not a live Lanzou test'};
  console.log(JSON.stringify(result,null,2)); await writeFile(path.join(root,'result.json'),JSON.stringify(result,null,2));
} finally { clearInterval(monitor); }
