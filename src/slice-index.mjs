import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// A filename is only a discovery hint. The manifest remains the download authority.
const PREFIX = 'sliceindex1';
const MAX_NAME = 240;
const checksum = text => createHash('sha256').update(text).digest('hex').slice(0, 16);

export function createIndexName(manifest, manifestId) {
  const data = [manifest.originalName, manifest.originalSize, manifest.parts.length, String(manifestId)];
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(data))).toString('hex');
  const name = `${PREFIX}${encoded}${checksum(encoded)}.txt`;
  return name.length <= MAX_NAME ? name : null;
}

export function parseIndexName(name) {
  if (typeof name !== 'string' || name.length > MAX_NAME || !/^sliceindex1(?:[a-f0-9]{2})+[a-f0-9]{16}\.txt$/.test(name)) return null;
  try {
    const encoded = name.slice(PREFIX.length, -20), check = name.slice(-20, -4);
    if (checksum(encoded) !== check) return null;
    const data = JSON.parse(inflateRawSync(Buffer.from(encoded, 'hex'), { maxOutputLength: 16384 }).toString('utf8'));
    if (!Array.isArray(data) || data.length !== 4) return null;
    const [originalName, originalSize, totalParts, manifestId] = data;
    if (typeof originalName !== 'string' || !originalName || originalName.length > 4096 || !Number.isSafeInteger(originalSize) || originalSize < 0 || !Number.isInteger(totalParts) || totalParts < 1 || totalParts > 20000 || typeof manifestId !== 'string' || !/^\d+$/.test(manifestId)) return null;
    return { originalName, originalSize, totalParts, manifestId, indexName: name };
  } catch { return null; }
}

export function readSliceIndex(files) {
  const markers = files.filter(file => !file.isFolder && file.name.startsWith(PREFIX));
  if (markers.length !== 1) return null;
  const index = parseIndexName(markers[0].name);
  const manifests = files.filter(file => !file.isFolder && file.name === 'manifest.lanzou.txt');
  if (!index || manifests.length !== 1 || String(manifests[0].id) !== index.manifestId) return null;
  const parts = files.filter(file => !file.isFolder && /^part-\d{6}\.zip$/.test(file.name));
  const names = new Set(parts.map(file => file.name));
  if (parts.length !== index.totalParts || names.size !== index.totalParts) return null;
  for (let i = 1; i <= index.totalParts; i++) if (!names.has(`part-${String(i).padStart(6, '0')}.zip`)) return null;
  return index;
}
