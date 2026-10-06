const crypto = require('node:crypto');
const http = require('node:http');

const TTL_MS = 10 * 60 * 1000;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_USES = 5;

function createStore() {
  const entries = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of entries) {
      if (entry.expires <= now) {
        entries.delete(token);
      }
    }
  }, 60 * 1000);
  timer.unref();

  return {
    create(data) {
      const token = crypto.randomBytes(16).toString('hex');
      entries.set(token, { ...data, uses: 0, expires: Date.now() + TTL_MS });
      return token;
    },
    get(token) {
      const entry = entries.get(token);
      if (!entry) {
        return null;
      }
      if (entry.expires <= Date.now()) {
        entries.delete(token);
        return null;
      }
      return entry;
    },
    countByUser(userId) {
      const now = Date.now();
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.userId === userId && entry.expires > now) {
          count += 1;
        }
      }
      return count;
    },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;

    req.on('data', (chunk) => {
      if (failed) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new Error('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!failed) {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (err) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function createCaptureServer({ store, publicUrl, buildLua, onCode, onEmpty }) {
  return http.createServer(async (req, res) => {
    const send = (status, body, extraHeaders = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extraHeaders });
      res.end(body);
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && parts.length === 0) {
        send(200, 'ok');
        return;
      }

      if (req.method === 'GET' && parts.length === 2 && parts[0] === 's') {
        const entry = store.get(parts[1]);
        if (!entry) {
          send(404, 'not found');
          return;
        }
        send(
          200,
          buildLua({ url: entry.url, id: entry.id, endpoint: `${publicUrl}/c/${parts[1]}` })
        );
        return;
      }

      if (req.method === 'POST' && parts.length === 2 && parts[0] === 'c') {
        const entry = store.get(parts[1]);
        if (!entry) {
          send(404, 'not found');
          return;
        }
        if (entry.uses >= MAX_USES) {
          send(429, 'limit reached');
          return;
        }

        const body = await readBody(req, MAX_BODY);
        entry.uses += 1;
        send(200, 'ok');

        const empty = url.searchParams.get('status') === 'empty' || body.length === 0;
        if (empty) {
          await onEmpty(entry);
        } else {
          await onCode(entry, body);
        }
        return;
      }

      send(404, 'not found');
    } catch (err) {
      if (err && err.message === 'too_large') {
        send(413, 'too large', { Connection: 'close' });
        return;
      }
      console.error(err);
      if (!res.headersSent) {
        send(500, 'error');
      }
    }
  });
}

module.exports = { createStore, createCaptureServer };
