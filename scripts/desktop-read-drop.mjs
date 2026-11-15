import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMockLanzou } from '../tests/mock-lanzou.mjs';
import { setTimeout as delay } from 'node:timers/promises';

await mkdir('.tmp', { recursive:true });
const profile = await mkdtemp(path.resolve('.tmp/read-drop-profile-'));
const output = path.resolve('.tmp/read-drop-smoke'); await mkdir(output,{recursive:true});
const firstFile = path.join(profile,'拖拽 [安装包] &+💾.exe'), secondFile = path.join(profile,'等待上传.bin');
await writeFile(firstFile, Buffer.alloc(32000,17)); await writeFile(secondFile,'second file');
let rootDelay = 0, bulkRows = 0, failDelete = false;
let recognitionFolder = '', recognitionDelay = 0, recognitionFail = false, recognitionEmpty = false;
const deleteAttempts = [];
const mock = await startMockLanzou({ rejectSpecialFolderNames:true, uploadDelay:700, slowDownloads:true, async directoryReply({task,folderId,page}) {
  if (folderId === recognitionFolder) {
    if (recognitionDelay) await delay(recognitionDelay);
    if (recognitionFail) return {zt:4};
    if (recognitionEmpty) return {zt:2,text:[]};
  }
  if (folderId === '-1' && rootDelay) await delay(rootDelay);
  if (folderId === '999') { await delay(600); return {zt:0,info:'离线目录读取失败（测试）'}; }
  if (task === '5' && folderId === '-1' && page === 1 && bulkRows) return {zt:1,text:Array.from({length:bulkRows},(_,i)=>({id:String(50000+i),name:`范围选择-${i+1}.txt`,size:16}))};
  if (task === '5' && folderId === '-1') return page < 3 ? {zt:1,text:[...(page===1?[{id:'9981',name:'批量文档一.txt',size:131072},{id:'9982',name:'批量文档二.txt',size:131072}]:[]),...Array.from({length:18},(_,index)=>({id:String(9000+page*100+index),name:`第${page === 1 ? '一' : '二'}页文件-${String(index+1).padStart(2,'0')}${index === 1 ? '-长文件名 [安装包] &+'.repeat(12) : ''}.bin`,size:'1.5 M',time:'2026-11-14'}))]} : {zt:2,text:[]};
}, pageReply({ url, fields }) {
  if (url.pathname === '/fixture/stats') return {json: { requests: mock.requests.filter(request => request.task).map(({task,folderId,page}) => ({task,folderId,page})), deleteAttempts, batchFolderChildExists:mock.folders.has('882')||mock.files.has('8810'), currentSliceChildExists:mock.folders.has('883') }};
  if (url.pathname === '/fixture/control') {
    if (url.searchParams.has('recognitionFolder')) recognitionFolder = url.searchParams.get('recognitionFolder');
    if (url.searchParams.has('recognitionDelay')) recognitionDelay = Number(url.searchParams.get('recognitionDelay'));
    if (url.searchParams.has('recognitionFail')) recognitionFail = url.searchParams.get('recognitionFail') === '1';
    if (url.searchParams.has('recognitionEmpty')) recognitionEmpty = url.searchParams.get('recognitionEmpty') === '1';
    rootDelay = Number(url.searchParams.get('rootDelay') || 0);
    if (url.searchParams.has('bulkRows')) bulkRows = Number(url.searchParams.get('bulkRows'));
    if (url.searchParams.has('failDelete')) failDelete = url.searchParams.get('failDelete') === '1';
    if (url.searchParams.has('sliceChild')) { mock.folders.set('883','切片目录内的普通文件夹'); mock.parents.set('883',url.searchParams.get('sliceChild')); }
    if (url.searchParams.get('batchDelete') === '1') {
      mock.folders.set('881','批量删除文件夹'); mock.parents.set('881','888');
      mock.folders.set('882','批量删除子目录'); mock.parents.set('882','881');
      for (const [id,name,folderId] of [['8801','选中文件一 &+.txt','888'],['8802','选中文件二.txt','888'],['8803','保留的未选文件.txt','888'],['8810','目录内文件.txt','882']]) mock.files.set(id,{id,folderId,name,data:Buffer.alloc(16,62)});
    }
    return {json:{ok:true}};
  }
  if (url.pathname === '/doupload.php' && ['3','6'].includes(fields.get('task'))) {
    const id=fields.get(fields.get('task')==='3'?'folder_id':'file_id'); deleteAttempts.push({task:fields.get('task'),id});
    if (failDelete && id === '8802') return {json:{zt:4}};
  }
  const member = url.pathname.match(/^\/i(\d+)$/)?.[1];
  if (member) return `<iframe id='fn' src='/fn/download?file=${member}'></iframe>`;
  if (url.pathname === '/fn/download') return String.raw`<script>var prefix='si';const $token=prefix+'gned';var key='k\x65y';const payload={action:'downprocess',sign:$token,websignkey:key};$.ajax({url:'/ajaxm.php?file=${url.searchParams.get('file')}',"data":payload});</script>`;
} });
mock.folders.set('999','读取失败目录'); mock.folders.set('888','可进入目录');
mock.folders.set('777','普通子目录'); mock.parents.set('777','888');
mock.files.set('9876',{id:'9876',folderId:'888',name:'普通文档.txt',data:Buffer.alloc(16,78)});
try {
  mock.files.set('9981',{id:'9981',folderId:'-1',name:'批量文档一.txt',data:Buffer.alloc(128*1024,43)});
  mock.files.set('9982',{id:'9982',folderId:'-1',name:'批量文档二.txt',data:Buffer.alloc(128*1024,44)});
  mock.files.set('9100',{id:'9100',folderId:'-1',name:'第一页文件-01.bin',data:Buffer.alloc(128*1024,45)});
  const packaged = process.argv[2];
  const executable = path.resolve(packaged || 'node_modules/electron/dist/electron.exe');
  const args = [...(packaged ? [] : ['.']), '--smoke-test', `--test-data=${profile}`, `--smoke-output=${output}`, `--smoke-api=${mock.origin}`, `--smoke-drop-file=${firstFile}`, `--smoke-second-file=${secondFile}`];
  const child=spawn(executable,args,{stdio:'pipe',windowsHide:true});
  child.stdout.on('data',chunk=>process.stdout.write(chunk)); child.stderr.on('data',chunk=>process.stderr.write(chunk));
  const timer=setTimeout(()=>child.kill(),120000);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(timer));
  assert.equal(code,0,'Electron feature checks failed');
  for (let part = 1; part <= 5; part++) assert.equal(mock.uploads.get(`part-${String(part).padStart(6,'0')}.zip`),part === 1 ? 6 : 1);
  assert.equal(mock.uploads.get('manifest.lanzou.txt'),6); assert.equal(mock.maxUploads,3); assert.equal(mock.uploadOrder.at(-2),'manifest.lanzou.txt'); assert.match(mock.uploadOrder.at(-1),/^sliceindex1[a-f0-9]+\.txt$/);
  console.log('READ_DROP_DESKTOP_OK',JSON.stringify({output,profile,network:'loopback protocol fixture; not a live Lanzou account'}));
} finally { await mock.close(); }
