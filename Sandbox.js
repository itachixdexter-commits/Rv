const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HOST, USER_AGENT } = require('./lib');

const LUA_BIN = process.env.LUA_BIN || 'luajit';
const HARNESS = path.join(__dirname, 'harness.lua');
const MAX_PAGE = 5 * 1024 * 1024;
const MAX_PAGES = 12;
const MAX_ROUNDS = 4;
const RUN_TIMEOUT_MS = 45 * 1000;
const MAX_LOG = 100 * 1024;

const DEP_HOSTS = [
  'raw.githubusercontent.com',
  'cdn.jsdelivr.net',
  'pastebin.com',
  'paste.ee',
  'rawcdn.githack.com',
];

async function doFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': USER_AGENT },
      ...opts,
    });
    if (!res.ok) {
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0 || buffer.length > MAX_PAGE) {
      return null;
    }
    return buffer;
  } catch {
    return null;
  }
}

async function fetchPage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== HOST) {
    return null;
  }
  return doFetch(parsed.href, { redirect: 'error' });
}

async function fetchDep(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== HOST && !DEP_HOSTS.includes(host)) {
    return null;
  }
  return doFetch(parsed.href);
}

async function readOptional(file) {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

async function cleanRound(dir) {
  const names = await fs.readdir(dir);
  for (const name of names) {
    if (/^(cap_\d+\.bin|final\.bin|need\.txt|log\.txt)$/.test(name)) {
      await fs.rm(path.join(dir, name), { force: true });
    }
  }
}

async function writePages(dir, pages) {
  const lines = [];
  let index = 0;
  for (const [url, body] of pages) {
    index += 1;
    const file = `page_${index}.bin`;
    await fs.writeFile(path.join(dir, file), body);
    lines.push(`${url}\t${file}`);
  }
  await fs.writeFile(path.join(dir, 'pages.txt'), `${lines.join('\n')}\n`);
}

function runLua(dir, id, url) {
  return new Promise((resolve) => {
    execFile(
      LUA_BIN,
      [HARNESS, dir, id, url],
      {
        cwd: dir,
        timeout: RUN_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH },
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        resolve({ err, stderr: String(stderr || '').slice(0, 2000) });
      }
    );
  });
}

const crypto = require('node:crypto');

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function readStages(dir, depPages) {
  const names = (await fs.readdir(dir))
    .filter((name) => /^cap_\d+\.bin$/.test(name))
    .sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));

  const stages = [];
  for (const name of names) {
    const data = await readOptional(path.join(dir, name));
    if (data && data.length > 0) {
      stages.push(data);
    }
  }

  const depHashes = new Set();
  if (depPages) {
    for (const buf of depPages.values()) {
      depHashes.add(sha1(buf));
    }
  }

  const isDepContent = (buf) => depHashes.has(sha1(buf));
  const seen = new Set();
  const unique = stages.filter((s) => {
    const h = sha1(s);
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });

  const payload = unique.filter((s) => !isDepContent(s));
  const main = payload[payload.length - 1] || unique[unique.length - 1] || null;
  const extra = unique.filter((s) => main && Buffer.compare(s, main) !== 0 && !isDepContent(s));
  return { main, extra };
}

async function decode({ url, id }, deps = {}) {
  const download = deps.fetchPage || fetchPage;

  const loader = await download(url);
  if (!loader) {
    return { ok: false, main: null, extra: [], log: 'could not download the loader from Encrypt-X' };
  }

  let dir;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'encryptx-'));
    const pages = new Map([[url, loader]]);
    const logs = [];

    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      await cleanRound(dir);
      await writePages(dir, pages);

      const run = await runLua(dir, id, url);
      const logBuffer = await readOptional(path.join(dir, 'log.txt'));
      let entry = `--- round ${round} ---\n${logBuffer ? logBuffer.toString('utf8') : '(no log)'}`;
      if (run.err) {
        entry += `\n[process] ${run.err.killed ? 'killed (timeout)' : run.err.message}`;
      }
      if (run.stderr) {
        entry += `\n[stderr] ${run.stderr}`;
      }
      logs.push(entry);

      const { main, extra } = await readStages(dir, pages);
      if (main) {
        return { ok: true, main, extra, log: logs.join('\n').slice(0, MAX_LOG) };
      }

      const needBuffer = await readOptional(path.join(dir, 'need.txt'));
      const wanted = needBuffer
        ? needBuffer
            .toString('utf8')
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !pages.has(line))
            .slice(0, 10)
        : [];

      let added = 0;
      for (const wantedUrl of wanted) {
        if (pages.size >= MAX_PAGES) {
          break;
        }
        const body = await (deps.fetchDep || fetchDep)(wantedUrl);
        if (body) {
          pages.set(wantedUrl, body);
          added += 1;
        } else {
          logs.push(`[blocked or unavailable] ${wantedUrl.slice(0, 200)}`);
        }
      }

      if (added === 0) {
        break;
      }
    }

    return { ok: false, main: null, extra: [], log: logs.join('\n').slice(0, MAX_LOG) };
  } catch (err) {
    console.error(err);
    return { ok: false, main: null, extra: [], log: `internal error: ${err.message}` };
  } finally {
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { decode, fetchPage, fetchDep };
