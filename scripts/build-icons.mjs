// Run with Electron: npm run build:icons. SVG is the editable source.
import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = path.join(root, '.tmp/icon-build-profile');
mkdirSync(profile, { recursive:true });
app.setPath('userData', profile);
app.disableHardwareAcceleration();
const timeout = setTimeout(() => { console.error('Icon rendering timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
const window = new BrowserWindow({width:256,height:256,useContentSize:true,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{offscreen:true,sandbox:true,contextIsolation:true,nodeIntegration:false}});
try {
  const source = await readFile(path.join(root, 'ui/assets/app-icon.svg'), 'utf8');
  await window.loadURL('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(source));
  await new Promise(resolve => setTimeout(resolve, 180));
  const capture = await window.webContents.capturePage();
  if (capture.isEmpty()) throw new Error('Application icon capture failed');
  const original = capture.resize({width:256,height:256,quality:'best'});
  await writeFile(path.join(root, 'ui/assets/app-icon.png'), original.toPNG());
  const sizes = [16,20,24,32,48,64,128,256];
  const frames = sizes.map(size => original.resize({width:size,height:size,quality:'best'}).toPNG());
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size,index) => {
    const at = 6 + index * 16;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(frames[index].length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += frames[index].length;
  });
  await writeFile(path.join(root, 'ui/assets/app-icon.ico'), Buffer.concat([header,...frames]));
  console.log('ICONS_BUILT', JSON.stringify({sizes,pngSize:original.getSize(),icoBytes:offset}));
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  window.destroy(); app.exit(process.exitCode || 0);
}
}).catch(error => { console.error(error); app.exit(1); });
