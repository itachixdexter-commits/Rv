const HOST = 'encrypt-x.pages.dev';
const USER_AGENT = 'Roblox/WinInet';

function parseEncryptXLink(input) {
  if (typeof input !== 'string') {
    return null;
  }

  const cleaned = input.trim().replace(/^<+/, '').replace(/>+$/, '');

  let parsed;
  try {
    parsed = new URL(cleaned);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== HOST) {
    return null;
  }
  if (parsed.pathname.replace(/\/+$/, '').toLowerCase() !== '/scripts') {
    return null;
  }

  let id = null;
  for (const [key, value] of parsed.searchParams) {
    if (key.toLowerCase() === 'id') {
      id = value;
      break;
    }
  }

  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return null;
  }

  return { id, url: `https://${HOST}/Scripts?Id=${id}` };
}

async function checkScriptExists(url) {
  try {
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': USER_AGENT },
    });

    if (res.status === 404 || res.status === 410) {
      return false;
    }
    if (!res.ok) {
      return true;
    }

    const text = await res.text();
    if (!text.trim()) {
      return false;
    }
    if (/^\s*<(?:!doctype|html)/i.test(text)) {
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

function buildLua({ url, id, endpoint }) {
  return `local url = "${url}"
local endpoint = "${endpoint}"
local oldLoadstring = rawget(getgenv(), "loadstring")
local oldSetclipboard = rawget(getgenv(), "setclipboard")
local capturedCode = nil

rawset(getgenv(), "loadstring", function(code)
    if type(code) == "string" and #code > 200 then
        capturedCode = code
    end
    return oldLoadstring(code)
end)

local function report(suffix, body)
    local send = request or http_request or (syn and syn.request) or (http and http.request)
    if send then
        pcall(send, {
            Url = endpoint .. suffix,
            Method = "POST",
            Headers = {["Content-Type"] = "text/plain"},
            Body = body
        })
    end
end

task.spawn(function()
    local okGet, encrypted = pcall(function()
        return game:HttpGet(url)
    end)

    if okGet and type(encrypted) == "string" then
        local success, fn = pcall(oldLoadstring, encrypted)
        if success and fn then
            pcall(fn, "${id}")
        end
    end

    task.wait(6)

    if capturedCode then
        rawset(getgenv(), "setclipboard", oldSetclipboard)
        if oldSetclipboard then
            pcall(oldSetclipboard, capturedCode)
        end
        report("", capturedCode)
    else
        report("?status=empty", "empty")
    end

    rawset(getgenv(), "loadstring", oldLoadstring)
end)
`;
}

module.exports = { HOST, USER_AGENT, parseEncryptXLink, checkScriptExists, buildLua };
