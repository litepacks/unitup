import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import readline from 'node:readline';

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
  const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter((p) => p && fs.existsSync(p));
  const maxLines = typeof options.lines === 'number' && options.lines > 0 ? options.lines : 100;
  const grepPattern = options.grep ? new RegExp(options.grep, 'i') : null;

  if (paths.length === 0) {
    if (options.follow) {
      const emitter = new EventEmitter();
      setTimeout(() => emitter.emit('error', new Error('No log files found to follow.')), 10);
      return emitter;
    }
    return 'No logs found.';
  }

  // Collect all lines from existing files
  const allEntries = [];
  for (const filePath of paths) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
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
    // Return an event emitter that polls/watches log files and streams new lines to stdout/events
    const emitter = new EventEmitter();
    const filePositions = new Map();

    for (const p of paths) {
      try {
        const stat = fs.statSync(p);
        filePositions.set(p, stat.size);
      } catch {
        filePositions.set(p, 0);
      }
    }

    // Print initial lines
    for (const l of sliced) {
      console.log(l);
      emitter.emit('line', l);
    }

    const interval = setInterval(() => {
      for (const p of paths) {
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
            // File truncated / rotated
            filePositions.set(p, 0);
          }
        } catch {
          // ignore
        }
      }
    }, 500);

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
