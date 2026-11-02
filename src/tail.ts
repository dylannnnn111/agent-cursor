// Follow the hook log as it grows. fs.watch alone misses events on some
// systems, so a light poll backs it up.

import * as fs from 'fs';
import * as path from 'path';

export class LogTail {
  private offset = 0;
  private partial = '';
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  private reading = false;

  constructor(private readonly file: string, private readonly onLine: (line: string) => void) {}

  start() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    // start at the end: old sessions aren't news
    try {
      this.offset = fs.statSync(this.file).size;
    } catch {
      this.offset = 0;
    }
    try {
      this.watcher = fs.watch(path.dirname(this.file), (_e, name) => {
        if (!name || name.toString() === path.basename(this.file)) this.read();
      });
    } catch {
      // polling still works
    }
    this.timer = setInterval(() => this.read(), 400);
  }

  private read() {
    if (this.reading) return;
    this.reading = true;
    try {
      let size: number;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        return;
      }
      if (size < this.offset) {
        // rotated by the hook
        this.offset = 0;
        this.partial = '';
      }
      if (size === this.offset) return;
      const fd = fs.openSync(this.file, 'r');
      try {
        const buf = Buffer.alloc(size - this.offset);
        fs.readSync(fd, buf, 0, buf.length, this.offset);
        this.offset = size;
        const text = this.partial + buf.toString('utf8');
        const lines = text.split('\n');
        this.partial = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) this.onLine(l);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      this.reading = false;
    }
  }

  dispose() {
    this.watcher?.close();
    if (this.timer) clearInterval(this.timer);
  }
}
