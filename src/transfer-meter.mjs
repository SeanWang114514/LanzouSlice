// Runtime samples never include resumed cache bytes or local hashing/merging work.
export class TransferMeter {
  constructor(elapsedMs = 0, now = performance.now()) {
    this.elapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    this.started = now; this.bytes = 0; this.samples = []; this.lastTraffic = null;
  }
  add(bytes, now = performance.now()) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    if (!this.samples.length || now - this.lastTraffic >= 3000) this.samples = [{ time: now, bytes: this.bytes }];
    this.bytes += bytes; this.lastTraffic = now;
    if (now - this.samples.at(-1).time >= 250) this.samples.push({ time: now, bytes: this.bytes });
    while (this.samples.length > 1 && this.samples[1].time <= now - 5000) this.samples.shift();
  }
  read(task, now = performance.now()) {
    while (this.samples.length > 1 && this.samples[1].time <= now - 5000) this.samples.shift();
    const elapsedMs = this.elapsedMs + Math.max(0, now - this.started);
    const first = this.samples[0];
    const transferring = task.state === 'running' && ['uploading', 'downloading'].includes(task.phase);
    const speed = transferring && first && now - first.time >= 250 && now - this.lastTraffic < 3000 ? Math.max(0, (this.bytes - first.bytes) * 1000 / (now - first.time)) : 0;
    const remaining = Math.max(0, (task.totalBytes || 0) - (task.bytes || 0));
    return { elapsedMs, speedBytesPerSecond: speed, remainingSeconds: transferring && remaining > 0 && speed > 0 ? remaining / speed : null, transferredBytes: this.bytes };
  }
}
