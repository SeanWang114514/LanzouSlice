import path from 'node:path';
import { stat } from 'node:fs/promises';

export async function openTaskFolder(task, shell) {
  if (!task || !['upload', 'download'].includes(task.type)) throw new Error('任务不存在，请刷新任务列表');
  const file = task.type === 'upload' ? task.sourcePath : task.resultPath;
  const directory = task.type === 'upload' && file ? path.dirname(file) : task.outputDir;
  if (!directory || !path.isAbsolute(directory) || (file && !path.isAbsolute(file))) throw new Error('任务没有有效的本地目录');
  if (file) {
    const info = await stat(file).catch(error => {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      throw error;
    });
    if (info?.isFile()) { shell.showItemInFolder(file); return null; }
  }
  const info = await stat(directory).catch(error => {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new Error('所在文件夹不存在，可能已被移动或删除');
    throw error;
  });
  if (!info.isDirectory()) throw new Error('任务保存位置不是文件夹');
  const error = await shell.openPath(directory);
  if (error) throw new Error(`无法打开所在文件夹：${error}`);
  return null;
}
