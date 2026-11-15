import { packager } from '@electron/packager';
import { mkdir, writeFile, copyFile, readdir, readFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import path from 'node:path';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const releaseDir = path.resolve('dist', `v${version}`);
const result = await packager({
  dir: path.resolve('.'), out: releaseDir, tmpdir: path.resolve('.tmp/packager'), name: 'LanzouSlice', executableName: '蓝奏切片',
  platform:'win32', arch:'x64', overwrite:true, asar:true, prune:true,
  icon:path.resolve('ui/assets/app-icon.ico'),
  appCopyright:'Based on CYQawa/YunX. AGPL-3.0-or-later.',
  win32metadata:{ProductName:'蓝奏切片',FileDescription:'蓝奏云切片上传与并发下载合并'},
  ignore:[/^\/upstream(?:\/|$)/,/^\/\.tmp(?:\/|$)/,/^\/dist(?:\/|$)/,/^\/tests(?:\/|$)/,/^\/scripts(?:\/|$)/,/^\/\.git(?:\/|$)/,/^\/蓝奏云切片上传-可行性与实施计划\.md$/],
  download:{cacheRoot:path.resolve('.tmp/electron-cache')}
});
console.log('PACKAGED',JSON.stringify(result));
for (const output of result) {
  for (const filename of ['蓝奏切片.exe','icudtl.dat','resources.pak','chrome_100_percent.pak','chrome_200_percent.pak','v8_context_snapshot.bin','snapshot_blob.bin','ffmpeg.dll','dxcompiler.dll','d3dcompiler_47.dll','electron_wer.dll','vk_swiftshader.dll','vulkan-1.dll','locales/zh-CN.pak','locales/en-US.pak','resources/app.asar']) {
    const file = await stat(path.join(output, filename));
    if (!file.isFile() || !file.size) throw new Error(`打包运行文件缺失或为空：${filename}`);
  }
  await copyFile('LICENSE',path.join(output,'LICENSE-application.txt'));
  await copyFile('THIRD_PARTY_NOTICES.md',path.join(output,'THIRD_PARTY_NOTICES.md'));
  await copyFile('README.md',path.join(output,'使用说明.md'));
  await writeFile(path.join(output,'SOURCE.txt'),'Corresponding source: ../LanzouSlice-source.zip\r\nUpstream: https://github.com/CYQawa/YunX\r\nRevision: cc9afe24c9409b239c361263b976f7aad77d1d9e\r\nLicense: AGPL-3.0-or-later\r\n');
}
await mkdir(releaseDir,{recursive:true});
await writeFile(path.join(releaseDir,'使用说明.txt'),'蓝奏切片 Windows 便携版\r\n\r\n打开 LanzouSlice-win32-x64 文件夹，双击“蓝奏切片.exe”。\r\n请保留文件夹内的全部文件，不要只移动 exe。\r\n首次使用先登录蓝奏云，再选择文件上传。\r\n下载时在“下载与合并”里读取任务目录清单，选择保存位置。\r\n本软件使用 80 MiB 单片上限；所有切片下载和 SHA-256 校验完成后自动合并。\r\n完整源码、使用方法和验证范围见项目 README.md。\r\n');

async function zipPaths(paths, destination, prefix = '') {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(destination); const done = pipeline(zip.outputStream, output);
  zip.on('error', error => zip.outputStream.destroy(error));
  async function add(filename) {
    const entries = await readdir(filename,{withFileTypes:true}).catch(error => { if(error.code==='ENOTDIR')return null;throw error; });
    if (!entries) { zip.addFile(filename,path.relative(prefix,filename).replaceAll('\\','/')); return; }
    for (const entry of entries) if (!entry.isSymbolicLink()) await add(path.join(filename,entry.name));
  }
  for (const filename of paths) await add(filename);
  zip.end(); await done;
}
const sourceArchive = path.join(releaseDir,'LanzouSlice-source.zip');
await zipPaths(['src','ui','scripts','tests','package.json','package-lock.json','README.md','验证结果.md','LICENSE','THIRD_PARTY_NOTICES.md','upstream/yunx-source.json'],sourceArchive);
console.log('SOURCE_ARCHIVE',sourceArchive);
const portableArchive = path.join(releaseDir,'LanzouSlice-Windows-x64.zip');
await zipPaths(result,portableArchive,releaseDir);
console.log('PORTABLE_ARCHIVE',portableArchive);
