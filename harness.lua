local dir = arg[1]
local scriptId = arg[2]
local loaderUrl = arg[3]

if not dir or not scriptId or not loaderUrl then
  os.exit(2)
end

local unpack = unpack or table.unpack
local select, type, pairs, ipairs, tostring, tonumber = select, type, pairs, ipairs, tostring, tonumber
local pcall, error, setmetatable, getmetatable = pcall, error, setmetatable, getmetatable
local rawget, rawset, rawequal, next = rawget, rawset, rawequal, next
local ioOpen = io.open
local osClock, osTime, osDate, osExit = os.clock, os.time, os.date, os.exit
local floor = math.floor
local sSub, sGsub, sMatch, sGmatch, sRep = string.sub, string.gsub, string.match, string.gmatch, string.rep
local concat, tremove = table.concat, table.remove
local cocreate, coresume, coyield, corunning, costatus =
  coroutine.create, coroutine.resume, coroutine.yield, coroutine.running, coroutine.status
local realSetfenv, realGetfenv, realLoadstring, realLoad = setfenv, getfenv, loadstring, load
local realCollect = collectgarbage
local sethook = debug.sethook
local realBit = bit

if jit and jit.off then
  jit.off()
end

local CPU_LIMIT = 35
local MEM_LIMIT_KB = 600 * 1024
local VIRTUAL_LIMIT = 10
local MAX_STEPS = 300000
local HOOK_COUNT = 200000
local MAX_CAPTURE_FILES = 8
local MAX_CAPTURE_SIZE = 8 * 1024 * 1024
local MAX_STRING = 64 * 1024 * 1024
local MAX_PROXIES = 200000

local function readFile(path)
  local f = ioOpen(path, "rb")
  if not f then
    return nil
  end
  local data = f:read("*a")
  f:close()
  return data
end

local function writeFile(path, data)
  local f = ioOpen(path, "wb")
  if not f then
    return false
  end
  f:write(data)
  f:close()
  return true
end

local logLines = {}

local function log(message)
  if #logLines < 2000 then
    logLines[#logLines + 1] = sSub(tostring(message), 1, 400)
  end
end

local pages = {}
do
  local index = readFile(dir .. "/pages.txt")
  if index then
    for line in sGmatch(index, "[^\n]+") do
      local pageUrl, file = sMatch(line, "^(.-)\t(.+)$")
      if pageUrl then
        pages[pageUrl] = readFile(dir .. "/" .. file)
      end
    end
  end
end

local needed = {}
local neededSeen = {}

local function recordUrl(u)
  if not neededSeen[u] then
    neededSeen[u] = true
    if #needed < 50 then
      needed[#needed + 1] = u
    end
  end
end

local function fetchBody(u)
  u = tostring(u)
  local body = pages[u]
  if body then
    return body
  end
  recordUrl(u)
  log("request not served: " .. u)
  return ""
end

local lastCapture = nil
local captureCount = 0

local function flush()
  writeFile(dir .. "/log.txt", concat(logLines, "\n") .. "\n")
  local lines = {}
  for i = 1, #needed do
    lines[#lines + 1] = (sGsub(needed[i], "[\r\n]", " "))
  end
  writeFile(dir .. "/need.txt", concat(lines, "\n") .. "\n")
  if lastCapture and #lastCapture <= MAX_CAPTURE_SIZE then
    writeFile(dir .. "/final.bin", lastCapture)
  end
end

local function finish(reason)
  if reason then
    log("finish: " .. reason)
  end
  flush()
  osExit(0)
end

local startClock = osClock()

local function hookFn()
  if osClock() - startClock > CPU_LIMIT then
    finish("cpu limit reached")
  end
  if realCollect("count") > MEM_LIMIT_KB then
    finish("memory limit reached")
  end
end

if sethook then
  sethook(hookFn, "", HOOK_COUNT)
end

local function createThread(f)
  local co = cocreate(f)
  if sethook then
    sethook(co, hookFn, "", HOOK_COUNT)
  end
  return co
end

local function pack(...)
  return { n = select("#", ...), ... }
end

local function compile(code, name, envTable)
  if realSetfenv then
    local fn, err = realLoadstring(code, name)
    if not fn then
      return nil, err
    end
    realSetfenv(fn, envTable)
    return fn
  end
  return realLoad(code, name, "t", envTable)
end

local realRep = string.rep
string.rep = function(s, n, sep)
  n = tonumber(n) or 0
  if n > 0 then
    local unit = #tostring(s) + (sep and #tostring(sep) or 0)
    if unit * n > MAX_STRING then
      error("string length overflow", 2)
    end
  end
  return realRep(s, n, sep)
end
string.dump = nil

local proxyMeta = {}
local proxyNames = setmetatable({}, { __mode = "k" })
local proxyKids = setmetatable({}, { __mode = "k" })
local proxyOverrides = setmetatable({}, { __mode = "k" })
local proxyCount = 0
local sink = setmetatable({}, proxyMeta)
proxyNames[sink] = "sink"

local function newProxyObject(name)
  proxyCount = proxyCount + 1
  if proxyCount > MAX_PROXIES then
    return sink
  end
  local p = setmetatable({}, proxyMeta)
  proxyNames[p] = name
  return p
end

local function makeObject(name, overrides)
  local p = newProxyObject(name)
  if overrides then
    proxyOverrides[p] = overrides
  end
  return p
end

proxyMeta.__metatable = "The metatable is locked"
proxyMeta.__index = function(self, key)
  local override = proxyOverrides[self]
  if override and override[key] ~= nil then
    return override[key]
  end
  if key == nil or key ~= key or type(key) == "number" or key == "Parent" then
    return nil
  end
  local kids = proxyKids[self]
  if not kids then
    kids = {}
    proxyKids[self] = kids
  end
  local kid = kids[key]
  if kid == nil then
    kid = newProxyObject((proxyNames[self] or "?") .. "." .. tostring(key))
    kids[key] = kid
  end
  return kid
end
proxyMeta.__newindex = function() end
proxyMeta.__call = function(self)
  return newProxyObject((proxyNames[self] or "?") .. "()")
end
proxyMeta.__tostring = function(self)
  return proxyNames[self] or "Instance"
end
proxyMeta.__concat = function(a, b)
  return tostring(a) .. tostring(b)
end
proxyMeta.__len = function()
  return 0
end
proxyMeta.__lt = function()
  return false
end
proxyMeta.__le = function()
  return false
end
local function zero()
  return 0
end
proxyMeta.__add = zero
proxyMeta.__sub = zero
proxyMeta.__mul = zero
proxyMeta.__div = zero
proxyMeta.__mod = zero
proxyMeta.__pow = zero
proxyMeta.__unm = zero

local M32 = 4294967296

local function norm32(x)
  x = tonumber(x) or 0
  return floor(x) % M32
end

local function arithBit(a, b, mode)
  local r, p = 0, 1
  for _ = 1, 32 do
    local x, y = a % 2, b % 2
    local v
    if mode == 1 then
      v = (x == 1 and y == 1) and 1 or 0
    elseif mode == 2 then
      v = (x == 1 or y == 1) and 1 or 0
    else
      v = (x ~= y) and 1 or 0
    end
    r = r + v * p
    a = (a - x) / 2
    b = (b - y) / 2
    p = p * 2
  end
  return r
end

local function buildBit32()
  local b = {}
  local opAnd, opOr, opXor
  if realBit then
    local bband, bbor, bbxor = realBit.band, realBit.bor, realBit.bxor
    opAnd = function(x, y)
      return bband(x, y) % M32
    end
    opOr = function(x, y)
      return bbor(x, y) % M32
    end
    opXor = function(x, y)
      return bbxor(x, y) % M32
    end
  else
    opAnd = function(x, y)
      return arithBit(x, y, 1)
    end
    opOr = function(x, y)
      return arithBit(x, y, 2)
    end
    opXor = function(x, y)
      return arithBit(x, y, 3)
    end
  end

  local function fold(op, identity)
    return function(...)
      local r = identity
      for i = 1, select("#", ...) do
        r = op(r, norm32((select(i, ...))))
      end
      return r
    end
  end

  b.band = fold(opAnd, M32 - 1)
  b.bor = fold(opOr, 0)
  b.bxor = fold(opXor, 0)
  b.bnot = function(a)
    return M32 - 1 - norm32(a)
  end
  b.btest = function(...)
    return b.band(...) ~= 0
  end

  local function lshift(a, n)
    a = norm32(a)
    n = floor(tonumber(n) or 0)
    if n < 0 then
      return floor(a / 2 ^ (-n)) % M32
    end
    if n >= 32 then
      return 0
    end
    return (a * 2 ^ n) % M32
  end

  local function rshift(a, n)
    a = norm32(a)
    n = floor(tonumber(n) or 0)
    if n < 0 then
      return lshift(a, -n)
    end
    if n >= 32 then
      return 0
    end
    return floor(a / 2 ^ n) % M32
  end

  b.lshift = lshift
  b.rshift = rshift
  b.arshift = function(a, n)
    a = norm32(a)
    n = floor(tonumber(n) or 0)
    if n < 0 then
      return lshift(a, -n)
    end
    local negative = a >= 2147483648
    if n >= 32 then
      return negative and (M32 - 1) or 0
    end
    local r = floor(a / 2 ^ n)
    if negative then
      r = r + (M32 - 2 ^ (32 - n))
    end
    return r % M32
  end
  b.lrotate = function(a, n)
    a = norm32(a)
    n = floor(tonumber(n) or 0) % 32
    return (lshift(a, n) + rshift(a, 32 - n)) % M32
  end
  b.rrotate = function(a, n)
    return b.lrotate(a, -(floor(tonumber(n) or 0)))
  end
  b.extract = function(n, field, width)
    width = width or 1
    return floor(norm32(n) / 2 ^ field) % 2 ^ width
  end
  b.replace = function(n, v, field, width)
    width = width or 1
    n = norm32(n)
    local mask = 2 ^ width
    local old = floor(n / 2 ^ field) % mask
    return n + ((norm32(v) % mask) - old) * 2 ^ field
  end
  return b
end

local env = {}
local missingSeen = {}

setmetatable(env, {
  __index = function(_, key)
    local name = tostring(key)
    if not missingSeen[name] then
      missingSeen[name] = true
      log("missing global: " .. name)
    end
    return nil
  end,
})

local function copyTable(source)
  local copy = {}
  for k, v in pairs(source) do
    copy[k] = v
  end
  return copy
end

local sandboxString = copyTable(string)
local sandboxTable = copyTable(table)
local sandboxMath = copyTable(math)

sandboxTable.pack = sandboxTable.pack or pack
sandboxTable.unpack = sandboxTable.unpack or unpack
sandboxTable.find = sandboxTable.find or function(t, value, init)
  for i = init or 1, #t do
    if t[i] == value then
      return i
    end
  end
  return nil
end
sandboxTable.clear = sandboxTable.clear or function(t)
  for k in pairs(t) do
    t[k] = nil
  end
end
sandboxTable.clone = sandboxTable.clone or function(t)
  return copyTable(t)
end
sandboxTable.create = sandboxTable.create or function(n, value)
  local t = {}
  for i = 1, n do
    t[i] = value
  end
  return t
end
sandboxMath.clamp = sandboxMath.clamp or function(x, lo, hi)
  if x < lo then
    return lo
  end
  if x > hi then
    return hi
  end
  return x
end
sandboxMath.sign = sandboxMath.sign or function(x)
  if x > 0 then
    return 1
  end
  if x < 0 then
    return -1
  end
  return 0
end
sandboxMath.round = sandboxMath.round or function(x)
  return floor(x + 0.5)
end

local virtualNow = 0
local steps = 0
local scheduled = {}

local function resumeThread(co, ...)
  if costatus(co) ~= "suspended" then
    return
  end
  local ok, err = coresume(co, ...)
  if not ok then
    log("thread error: " .. tostring(err))
  end
end

local function schedule(co, at, args)
  scheduled[#scheduled + 1] = { co = co, time = at, args = args }
end

local function nextTask(limit)
  local bestIndex, best
  for i = 1, #scheduled do
    local item = scheduled[i]
    if item.time <= limit and (not best or item.time < best.time) then
      best, bestIndex = item, i
    end
  end
  return bestIndex, best
end

local function runUntil(limit)
  while true do
    steps = steps + 1
    if steps > MAX_STEPS then
      finish("step limit reached")
    end
    local index, item = nextTask(limit)
    if not item then
      break
    end
    tremove(scheduled, index)
    if item.time > virtualNow then
      virtualNow = item.time
    end
    if item.args then
      resumeThread(item.co, unpack(item.args, 1, item.args.n))
    else
      resumeThread(item.co)
    end
  end
  if limit > virtualNow then
    virtualNow = limit
  end
end

local function taskWait(seconds)
  seconds = tonumber(seconds) or 0.03
  if seconds < 0 then
    seconds = 0
  end
  local co, isMain = corunning()
  if co and not isMain then
    schedule(co, virtualNow + seconds, nil)
    coyield()
    return seconds
  end
  runUntil(virtualNow + seconds)
  return seconds
end

local function taskSpawn(f, ...)
  local co
  if type(f) == "thread" then
    co = f
  else
    co = createThread(f)
  end
  resumeThread(co, ...)
  return co
end

local function taskDefer(f, ...)
  local co
  if type(f) == "thread" then
    co = f
  else
    co = createThread(f)
  end
  schedule(co, virtualNow, pack(...))
  return co
end

local function taskDelay(seconds, f, ...)
  local co
  if type(f) == "thread" then
    co = f
  else
    co = createThread(f)
  end
  schedule(co, virtualNow + (tonumber(seconds) or 0), pack(...))
  return co
end

local function taskCancel(co)
  for i = #scheduled, 1, -1 do
    if scheduled[i].co == co then
      tremove(scheduled, i)
    end
  end
end

local function noop() end

local taskLib = {
  wait = taskWait,
  spawn = taskSpawn,
  defer = taskDefer,
  delay = taskDelay,
  cancel = taskCancel,
  synchronize = noop,
  desynchronize = noop,
}

local function httpGet(a, b)
  if type(a) == "string" then
    return fetchBody(a)
  end
  return fetchBody(b)
end

local function makeResponse(body)
  return { Success = true, StatusCode = 200, StatusMessage = "OK", Body = body or "", Headers = {} }
end

local function request(options)
  if type(options) ~= "table" then
    return makeResponse("")
  end
  local u = options.Url or options.url
  local method = tostring(options.Method or options.method or "GET"):upper()
  if u == nil then
    return makeResponse("")
  end
  if method == "GET" then
    return makeResponse(fetchBody(u))
  end
  log("request ignored: " .. method .. " " .. tostring(u))
  return makeResponse("")
end

local services = {}

local function getService(_, name)
  name = tostring(name)
  local service = services[name]
  if not service then
    if name == "HttpService" then
      service = makeObject("HttpService", {
        GetAsync = function(_, u)
          return fetchBody(u)
        end,
        RequestAsync = function(_, options)
          return request(options)
        end,
        JSONEncode = function()
          return "{}"
        end,
        JSONDecode = function()
          return {}
        end,
        GenerateGUID = function()
          return "00000000-0000-0000-0000-000000000000"
        end,
        UrlEncode = function(_, value)
          return tostring(value)
        end,
      })
    else
      service = makeObject("game:GetService(" .. name .. ")")
    end
    services[name] = service
  end
  return service
end

local game = makeObject("game", {
  HttpGet = httpGet,
  HttpGetAsync = httpGet,
  HttpPost = function()
    return ""
  end,
  GetService = getService,
  service = getService,
  PlaceId = 0,
  GameId = 0,
  JobId = "",
})

local function sandboxLoadstring(code, chunkName)
  if type(code) ~= "string" then
    return nil, "bad argument #1 to 'loadstring' (string expected)"
  end
  if sSub(code, 1, 1) == "\27" then
    return nil, "bytecode is not allowed"
  end
  if #code > 200 then
    lastCapture = code
    captureCount = captureCount + 1
    log("captured stage " .. captureCount .. " (" .. #code .. " bytes)")
    if captureCount <= MAX_CAPTURE_FILES and #code <= MAX_CAPTURE_SIZE then
      writeFile(dir .. "/cap_" .. captureCount .. ".bin", code)
    end
  end
  local name = chunkName
  if type(name) ~= "string" then
    name = "=loadstring"
  end
  return compile(code, name, env)
end

local function envGetfenv(f)
  if type(f) == "function" then
    local e = realGetfenv and realGetfenv(f)
    if e == nil or e == _G then
      return env
    end
    return e
  end
  return env
end

local function envSetfenv(f, e)
  if type(f) == "function" and realSetfenv and type(e) == "table" then
    return realSetfenv(f, e)
  end
  return f
end

local function sandboxPrint(...)
  local parts = {}
  for i = 1, select("#", ...) do
    parts[i] = tostring((select(i, ...)))
  end
  log("print: " .. concat(parts, " "))
end

local function sandboxType(x)
  if proxyNames[x] ~= nil then
    return "userdata"
  end
  return type(x)
end

local function sandboxTypeof(x)
  if proxyNames[x] ~= nil then
    return "Instance"
  end
  return type(x)
end

local function wrapCoroutine()
  local lib = {}
  lib.create = function(f)
    return createThread(f)
  end
  lib.wrap = function(f)
    local co = createThread(f)
    return function(...)
      local result = pack(coresume(co, ...))
      if not result[1] then
        error(result[2], 0)
      end
      return unpack(result, 2, result.n)
    end
  end
  lib.resume = coresume
  lib.yield = coyield
  lib.status = costatus
  lib.running = corunning
  lib.isyieldable = coroutine.isyieldable
  lib.close = coroutine.close
  return lib
end

local function setupEnvironment()
  local globals = {
    assert = assert,
    error = error,
    getmetatable = getmetatable,
    setmetatable = setmetatable,
    ipairs = ipairs,
    pairs = pairs,
    next = next,
    pcall = pcall,
    xpcall = xpcall,
    select = select,
    tonumber = tonumber,
    tostring = tostring,
    type = sandboxType,
    typeof = sandboxTypeof,
    unpack = unpack,
    rawequal = rawequal,
    rawget = rawget,
    rawset = rawset,
    rawlen = rawlen,
    newproxy = newproxy,
    math = sandboxMath,
    string = sandboxString,
    table = sandboxTable,
    coroutine = wrapCoroutine(),
    bit32 = buildBit32(),
    bit = realBit,
    os = { time = osTime, clock = osClock, date = osDate, difftime = function(a, b) return a - b end },
    print = sandboxPrint,
    warn = sandboxPrint,
    collectgarbage = function(opt)
      if opt == "count" then
        return realCollect("count")
      end
      return 0
    end,
    loadstring = sandboxLoadstring,
    getfenv = envGetfenv,
    setfenv = envSetfenv,
    task = taskLib,
    wait = taskWait,
    spawn = taskSpawn,
    delay = taskDelay,
    tick = function()
      return osTime() + virtualNow
    end,
    time = function()
      return virtualNow
    end,
    elapsedTime = function()
      return virtualNow
    end,
    game = game,
    Game = game,
    workspace = makeObject("workspace"),
    Workspace = makeObject("workspace"),
    script = makeObject("script"),
    require = function()
      return makeObject("require()")
    end,
    shared = {},
    _G = {},
    _VERSION = "Luau",
    getgenv = function()
      return env
    end,
    getrenv = function()
      return env
    end,
    getreg = function()
      return {}
    end,
    getgc = function()
      return {}
    end,
    identifyexecutor = function()
      return "Delta", "1.0"
    end,
    getexecutorname = function()
      return "Delta"
    end,
    request = request,
    http_request = request,
    syn = { request = request },
    http = { request = request },
    setclipboard = function(value)
      log("setclipboard called (" .. #tostring(value) .. " bytes)")
    end,
    toclipboard = noop,
    checkcaller = function()
      return true
    end,
    hookfunction = function(f)
      return f
    end,
    newcclosure = function(f)
      return f
    end,
    clonefunction = function(f)
      return f
    end,
    cloneref = function(x)
      return x
    end,
    islclosure = function()
      return true
    end,
    iscclosure = function()
      return false
    end,
    getrawmetatable = getmetatable,
    setreadonly = noop,
    isreadonly = function()
      return false
    end,
    gethui = function()
      return makeObject("gethui()")
    end,
    debug = {
      traceback = function(message)
        return tostring(message or "") .. "\nstack traceback:\n\t[C]: in ?"
      end,
      getinfo = function()
        return { currentline = 1, short_src = "loadstring", source = "=loadstring", what = "Lua", namewhat = "" }
      end,
      sethook = noop,
      gethook = noop,
      getlocal = noop,
      getupvalue = noop,
      setupvalue = noop,
      getmetatable = getmetatable,
      getregistry = function()
        return {}
      end,
    },
  }

  for name, value in pairs(globals) do
    rawset(env, name, value)
  end

  local robloxGlobals = {
    "Instance", "Vector3", "Vector2", "CFrame", "Color3", "UDim", "UDim2", "Enum", "TweenInfo",
    "Random", "Drawing", "Ray", "Region3", "BrickColor", "NumberRange", "NumberSequence",
    "ColorSequence", "Rect", "RaycastParams", "OverlapParams", "PhysicalProperties", "Axes", "Faces",
  }
  for _, name in ipairs(robloxGlobals) do
    rawset(env, name, makeObject(name))
  end
end

setupEnvironment()

local loaderBody = pages[loaderUrl]
if not loaderBody then
  finish("loader page missing")
end

local loaderFn, loaderErr = compile(loaderBody, "=loader", env)
if not loaderFn then
  log("loader compile error: " .. tostring(loaderErr))
  finish("loader compile failed")
end

local mainThread = createThread(function()
  local ok, err = pcall(loaderFn, scriptId)
  if ok then
    log("loader finished")
  else
    log("loader runtime error: " .. tostring(err))
  end
end)

resumeThread(mainThread)
runUntil(VIRTUAL_LIMIT)
finish()
