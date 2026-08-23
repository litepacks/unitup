import { EventEmitter } from 'node:events';
import fs from 'node:fs';

/**
 * Reads lines from one or more log files with tailing, filtering, and follow support.
 *
 * @param {string|string[]} filePaths
 * @param {object} [options]
 * @param {number} [options.lines=100]
 * @param {boolean} [options.follow=false]
 * @param {string} [options.grep]
 * @param {string} [options.since]
 * @param {boolean} [options.json=false]
 * @returns {Promise<string|EventEmitter>}
 */
export async function readServiceLogs(filePaths, options = {}) {
  const allCandidatePaths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const existingPaths = allCandidatePaths.filter((p) => fs.existsSync(p));
  existingPaths.sort((a, b) => {
    try {
      return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
    } catch {
      return 0;
    }
  });
  const maxLines = typeof options.lines === 'number' && options.lines > 0 ? options.lines : 100;
  const grepPattern = options.grep ? new RegExp(options.grep, 'i') : null;

  // Collect all lines from currently existing files
  const allEntries = [];
  for (const filePath of existingPaths) {
    try {
      const stat = fs.statSync(filePath);
      let content = '';

      // If file is larger than 1MB, read only the tail chunk
      if (stat.size > 1024 * 1024) {
        const chunkSize = Math.min(stat.size, Math.max(1024 * 1024, maxLines * 2048));
        const start = Math.max(0, stat.size - chunkSize);
        const buffer = Buffer.alloc(stat.size - start);
        const fd = fs.openSync(filePath, 'r');
        fs.readSync(fd, buffer, 0, buffer.length, start);
        fs.closeSync(fd);
        content = buffer.toString('utf8');
      } else {
        content = fs.readFileSync(filePath, 'utf8');
      }

      const lines = content.split('\n');
      for (const line of lines) {
        if (!line && line.trim() === '') continue;
        if (grepPattern && !grepPattern.test(line)) continue;
        allEntries.push(line);
      }
    } catch {
      // ignore
    }
  }

  // Slice tail lines
  const sliced = allEntries.slice(-maxLines);

  if (options.follow) {
    const emitter = new EventEmitter();
    const filePositions = new Map();

    for (const p of allCandidatePaths) {
      try {
        if (fs.existsSync(p)) {
          const stat = fs.statSync(p);
          filePositions.set(p, stat.size);
        } else {
          filePositions.set(p, 0);
        }
      } catch {
        filePositions.set(p, 0);
      }
    }

    // Print initial existing lines
    for (const l of sliced) {
      console.log(l);
      emitter.emit('line', l);
    }

    let isPolling = false;
    const interval = setInterval(() => {
      if (isPolling) return;
      isPolling = true;

      try {
        for (const p of allCandidatePaths) {
          try {
            if (!fs.existsSync(p)) continue;
            const stat = fs.statSync(p);
            const lastPos = filePositions.get(p) || 0;

            if (stat.size > lastPos) {
              const stream = fs.createReadStream(p, { start: lastPos, end: stat.size, encoding: 'utf8' });
              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk;
              });
              stream.on('end', () => {
                filePositions.set(p, stat.size);
                const newLines = buffer.split('\n');
                for (const line of newLines) {
                  if (!line || !line.trim()) continue;
                  if (grepPattern && !grepPattern.test(line)) continue;
                  console.log(line);
                  emitter.emit('line', line);
                }
              });
            } else if (stat.size < lastPos) {
              // File truncated or rotated
              filePositions.set(p, 0);
            }
          } catch {
            // ignore
          }
        }
      } finally {
        isPolling = false;
      }
    }, 250);

    emitter.stop = () => {
      clearInterval(interval);
      emitter.emit('close');
    };

    return emitter;
  }

  if (options.json) {
    return JSON.stringify(
      sliced.map((line) => ({ message: line })),
      null,
      2
    );
  }

  if (sliced.length === 0) {
    return 'No logs found.';
  }

  return sliced.join('\n');
}
