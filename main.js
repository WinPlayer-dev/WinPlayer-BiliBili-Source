/* ------------------------------ 常量 ------------------------------ */

const DEFAULT_API_HOST = "https://api.bilibili.com";
const PASSPORT_HOST = "https://passport.bilibili.com";
const SITE_HOME = "https://www.bilibili.com/";
/** 宽松 Referer：部分接口（如 view）带 www Referer 会被 WAF 直接 412，退回 api 域 Referer 可过 */
const API_REFERER = "https://api.bilibili.com/";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** DASH 音轨三档码率（playurl dash.audio[].id），与设置项 quality 对应 */
const AUDIO_QUALITY_IDS = { standard: 30216, higher: 30232, exhigh: 30280 };
/** 音轨 id → 宿主质量标识 */
const AUDIO_ID_LABELS = { 30216: "standard", 30232: "higher", 30280: "exhigh" };

/** WBI mixinKey 置换表（来源：bilibili-API-collect misc/sign/wbi.md） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];
const WBI_KEY_MAX_AGE = 24 * 60 * 60 * 1000; // 密钥每日更替，缓存一天
const NAV_CACHE_TTL = 60 * 1000; // nav（登录态/头像）缓存 1 分钟，避免频繁请求

const FAV_PAGE_SIZE = 20; // 收藏夹资源列表 ps 定义域 1-20
const SEASON_PAGE_SIZE = 30; // 合集分页 page_size 定义域 1-30
const VIEW_CACHE_TTL = 15 * 60 * 1000; // bvid → view（cid/pages）缓存 15 分钟
const VIEW_CACHE_MAX = 200;

const DEFAULT_HOT_KEYWORDS = ["音乐", "翻唱", "纯音乐", "现场", "热门"];

/* ------------------------------ 上下文与设置 ------------------------------ */

/** 由 init 注入的插件上下文 */
let context = null;

function requireContext() {
  if (!context) throw new Error("插件尚未初始化");
  return context;
}

function debugLog(...args) {
  try {
    context?.log?.("[bilibili]", ...args);
  } catch {
    /* 日志失败不能影响主流程 */
  }
}

/** 读取用户设置，空值回退到默认值 */
function readSetting(key, fallback) {
  const value = requireContext().settings?.[key];
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

/** 读取数值型设置（先夹取到 [min, max] 再取整） */
function readNumber(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = Number(readSetting(key, fallback));
  if (!Number.isFinite(raw)) return fallback;
  return Math.trunc(Math.min(max, Math.max(min, raw)));
}

function apiHost() {
  const raw = String(readSetting("apiHost", DEFAULT_API_HOST)).trim().replace(/\/+$/, "");
  return raw || DEFAULT_API_HOST;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------ Cookie 罐 ------------------------------ */

/**
 * 会话 Cookie 罐。
 *
 * B 站必须携带 buvid3（指纹 Cookie）才能调用搜索等接口，否则触发风控。该 Cookie 由
 * 首页 Set-Cookie 下发、会过期，所以放 ctx.storage 持久化并在缺失时自动补取。
 * 用户粘贴/扫码登录得到的凭证存 settings.cookie，优先级高于罐内同名条目。
 */
let jar = new Map();
let jarLoaded = false;
let siteCookieTried = false;

/** 把 Cookie 文本（支持换行、分号分隔）拆成 [名, 值] 数组 */
function splitPairs(cookieText) {
  const pairs = [];
  String(cookieText ?? "")
    .split(/\r?\n/)
    .forEach((line) => {
      line.split(/;\s*/).forEach((part) => {
        const eq = part.indexOf("=");
        if (eq <= 0) return;
        const name = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (name) pairs.push([name, value]);
      });
    });
  return pairs;
}

function serializePairs(pairs) {
  return pairs.map(([name, value]) => `${name}=${value}`).join("; ");
}

async function ensureJar() {
  if (jarLoaded) return;
  jarLoaded = true;
  try {
    const saved = await requireContext().storage.get("sessionCookie");
    if (typeof saved === "string" && saved) {
      for (const [name, value] of splitPairs(saved)) jar.set(name, value);
      debugLog(`恢复会话 Cookie：[${[...jar.keys()].join(", ")}]`);
    }
  } catch (error) {
    debugLog("读取会话 Cookie 失败", error);
  }
}

function persistJar() {
  try {
    const pending = requireContext().storage.set("sessionCookie", serializePairs([...jar]));
    // 后台写盘：失败只记日志，不产生未处理的 Promise 拒绝
    if (pending && typeof pending.catch === "function") {
      pending.catch((error) => debugLog("保存会话 Cookie 失败", error));
    }
  } catch (error) {
    debugLog("保存会话 Cookie 失败", error);
  }
}

/** 吸收响应头里的 Set-Cookie（B 站登录/首页都会用它下发关键 Cookie） */
function absorbSetCookie(response) {
  const raw = response?.headers?.["set-cookie"] ?? response?.headers?.["Set-Cookie"];
  if (!raw) return;
  const lines = Array.isArray(raw) ? raw : String(raw).split(/\n/);
  const names = [];
  for (const line of lines) {
    const pair = String(line).split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || !value) continue; // 空值视为删除指令，忽略以保住现有会话
    jar.set(name, value);
    names.push(name);
  }
  if (names.length) {
    debugLog(`吸收 Set-Cookie：[${names.join(", ")}]`);
    persistJar();
  }
}

/** 合并会话罐与用户凭证（用户凭证优先），返回 Map */
function mergedCookies() {
  const merged = new Map(jar);
  for (const [name, value] of splitPairs(String(readSetting("cookie", "")))) merged.set(name, value);
  return merged;
}

function buildCookieHeader() {
  return serializePairs([...mergedCookies()]);
}

function readCookieValue(name) {
  return mergedCookies().get(name) ?? "";
}

/**
 * 确保罐内有 buvid3（搜索、投稿列表等接口的风控前提）。
 * 顺序：首页 Set-Cookie → 官方 SPI 接口兜底；两步都放在同一个「只试一次」守卫内，
 * 保证递归调用（apiGet → ensureSiteCookies）不会死循环。
 */
async function ensureSiteCookies() {
  await ensureJar();
  if (jar.has("buvid3") || siteCookieTried) return;
  siteCookieTried = true;
  try {
    await rawRequest({
      url: SITE_HOME,
      method: "GET",
      responseType: "text",
      timeout: 10000,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "zh-CN,zh;q=0.9" },
    });
  } catch (error) {
    debugLog("拉取 bilibili.com 会话 Cookie 失败", error);
  }
  if (jar.has("buvid3")) return;
  try {
    const data = await apiGet("/x/frontend/finger/spi", {}, { label: "获取 buvid" });
    if (data?.b_3) jar.set("buvid3", data.b_3);
    if (data?.b_4) jar.set("buvid4", data.b_4);
    if (jar.has("buvid3")) persistJar();
  } catch (error) {
    debugLog("SPI 获取 buvid 失败", error);
  }
}

/* ------------------------------ MD5（WBI 签名用） ------------------------------ */

/** 手写 UTF-8 编码（沙箱内不引入任何依赖） */
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(++i);
      code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return out;
}

/** RFC 1321 MD5，返回小写 hex */
function md5Hex(input) {
  const bytes = utf8Bytes(String(input));
  const bitLen = bytes.length * 8;
  const totalLen = (((bytes.length + 8) >> 6) + 1) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 8, bitLen >>> 0, true);
  view.setUint32(totalLen - 4, Math.floor(bitLen / 4294967296), true);

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
    20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
    10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const M = new Uint32Array(16);
  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(offset + i * 4, true);
    let A = a;
    let B = b;
    let C = c;
    let D = d;
    for (let i = 0; i < 64; i++) {
      let F;
      let g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + (((F << S[i]) | (F >>> (32 - S[i]))) >>> 0)) >>> 0;
    }
    a = (a + A) >>> 0;
    b = (b + B) >>> 0;
    c = (c + C) >>> 0;
    d = (d + D) >>> 0;
  }

  let hex = "";
  for (const word of [a, b, c, d]) {
    for (let i = 0; i < 4; i++) hex += ((word >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

/* ------------------------------ WBI 签名 ------------------------------ */

let wbiKeys = null; // { imgKey, subKey, at }

function getMixinKey(imgKey, subKey) {
  const raw = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index] ?? "").join("").slice(0, 32);
}

/**
 * 取 WBI 签名密钥：优先内存 → storage 缓存（24h 内）→ nav 接口现取。
 * 密钥每日更替，签名请求被风控时由 apiGet 调 force 版本强刷。
 */
async function getWbiKeys(force = false) {
  if (!force && wbiKeys && Date.now() - wbiKeys.at < WBI_KEY_MAX_AGE) return wbiKeys;

  let cached = null;
  if (!force) {
    try {
      cached = await requireContext().storage.get("wbiKeys");
    } catch {
      /* 缓存读不到就现取 */
    }
  }
  if (
    cached &&
    typeof cached === "object" &&
    cached.imgKey &&
    cached.subKey &&
    Date.now() - (Number(cached.at) || 0) < WBI_KEY_MAX_AGE
  ) {
    wbiKeys = cached;
    return wbiKeys;
  }

  try {
    // nav 未登录时返回 code=-101，但 data 里依旧带 wbi_img，必须放行
    const data = await apiGet("/x/web-interface/nav", {}, { label: "获取 WBI 密钥", tolerate: [-101] });
    const imgUrl = String(data?.wbi_img?.img_url ?? "");
    const subUrl = String(data?.wbi_img?.sub_url ?? "");
    const imgKey = imgUrl.split("/").pop()?.split(".")[0] ?? "";
    const subKey = subUrl.split("/").pop()?.split(".")[0] ?? "";
    if (imgKey && subKey) {
      wbiKeys = { imgKey, subKey, at: Date.now() };
      try {
        await requireContext().storage.set("wbiKeys", wbiKeys);
      } catch {
        /* 只是缓存写失败，内存里还有一份 */
      }
      return wbiKeys;
    }
    debugLog("nav 未返回 wbi_img", data);
  } catch (error) {
    debugLog("拉取 WBI 密钥失败", error);
  }

  // 现取失败时退回旧缓存 / 旧内存值，至少让签名请求继续可用
  if (cached?.imgKey && cached?.subKey) {
    wbiKeys = cached;
    return wbiKeys;
  }
  if (wbiKeys) return wbiKeys;
  throw new Error("获取 B 站 WBI 签名密钥失败（nav 未返回 wbi_img）");
}

/** 生成 `查询串&w_rid=...`（B 站要求参数按 key 升序、值过滤 !'()* 并带 wts） */
async function signedQuery(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const mixin = getMixinKey(imgKey, subKey);
  const merged = { ...params, wts: Math.floor(Date.now() / 1000) };
  const cleaned = {};
  for (const key of Object.keys(merged).sort()) {
    cleaned[key] = String(merged[key] ?? "").replace(/[!'()*]/g, "");
  }
  const query = Object.entries(cleaned)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  // 注意：签名只覆盖 query 本身（不含 `?`），返回时才补问号
  return `?${query}&w_rid=${md5Hex(query + mixin)}`;
}

/* ------------------------------ 统一请求 ------------------------------ */

function buildHeaders({ cookie, post = false, relaxed = false } = {}) {
  const headers = {
    "User-Agent": BROWSER_UA,
    Referer: relaxed ? API_REFERER : SITE_HOME,
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  const cookieHeader = cookie ?? buildCookieHeader();
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (post) headers.Origin = "https://www.bilibili.com";
  return headers;
}

function buildQuery(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function buildFormBody(body) {
  const parts = [];
  for (const [key, value] of Object.entries(body ?? {})) {
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

/** 统一读回响应体：data 已解析则直接用，否则回退 text 再 JSON.parse */
function normalizePayload(response) {
  if (response?.data && typeof response.data === "object") return response.data;
  const text =
    typeof response?.text === "string" ? response.text : typeof response?.data === "string" ? response.data : "";
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      /* 非 JSON（如风控 HTML 页）走 null 分支 */
    }
  }
  return null;
}

/** 把 B 站错误码翻译成人话 */
function describeBiliError(code, message, label) {
  const detail = message ? `：${message}` : "";
  switch (code) {
    case -101:
      return "账号未登录，请先扫码登录或在插件设置中粘贴 Cookie";
    case -102:
      return "账号被限制，无法执行该操作";
    case -104:
      return "请求需要验证码（风控），请稍后重试或在浏览器登录后重试";
    case -111:
      return "bili_jct 校验失败，登录凭证已失效，请重新登录";
    case -400:
      return `${label}请求参数错误`;
    case -403:
      return `${label}拒绝访问（-403）`;
    case -404:
      return `${label}接口不存在（-404），请检查接口地址设置`;
    case -412:
      return "请求被 B 站风控拦截（-412），请稍后重试";
    case -352:
      return "触发 B 站风控校验（-352/v_voucher），请在浏览器登录 bilibili.com 后重试";
    case -712:
      return "稿件不可播放（版权或区域限制）";
    case 62002:
      return "稿件不可见或已失效";
    case 62004:
      return "稿件正在审核中，暂时无法播放";
    case 2001000:
      return "收藏夹参数错误（ID 无效？）";
    default:
      return `${label}失败（code ${code}）${detail}`;
  }
}

/** 经 ctx.request 发请求，并顺手吸收 Set-Cookie */
async function rawRequest(input) {
  const response = await requireContext().request({
    responseType: "auto",
    timeout: 15000,
    ...input,
  });
  absorbSetCookie(response);
  return response;
}

/**
 * GET 接口：可选 WBI 签名；code!==0 抛可读错误。
 * 撞风控（HTTP 412 / -352 / -412 / v_voucher）时的自救阶梯：
 *   ① 签名接口先强刷每日 WBI 密钥重试（防换钥导致 w_rid 失效）
 *   ② 仍失败则换宽松 Referer 重试（www Referer 在部分接口上会触发 412）
 * `tolerate` 里的错误码视为「照常返回 data」：如 nav 未登录 code=-101 但 data 带 wbi_img。
 */
async function apiGet(path, params = {}, options = {}) {
  const { wbi = false, label = "B站接口", retried = false, relaxed = false, host, tolerate = [] } = options;
  await ensureSiteCookies();
  const query = wbi ? await signedQuery(params) : buildQuery(params);
  const url = `${host ?? apiHost()}${path}${query}`;
  const response = await rawRequest({ url, method: "GET", headers: buildHeaders({ relaxed }) });
  const payload = normalizePayload(response);

  const voucher = payload?.data && typeof payload.data === "object" ? payload.data.v_voucher : undefined;
  const blocked =
    response.status === 412 ||
    (typeof payload?.code === "number" && (payload.code === -352 || payload.code === -412)) ||
    Boolean(voucher);

  if (blocked) {
    if (wbi && !retried) {
      debugLog(
        `${label}疑似撞风控，强刷 WBI 密钥后重试`,
        typeof payload?.code === "number" ? payload.code : `HTTP ${response.status}`,
        voucher ?? "",
      );
      await getWbiKeys(true);
      return apiGet(path, params, { ...options, retried: true });
    }
    if (!relaxed) {
      debugLog(
        `${label}疑似撞风控，改用宽松 Referer 重试`,
        typeof payload?.code === "number" ? payload.code : `HTTP ${response.status}`,
      );
      return apiGet(path, params, { ...options, relaxed: true });
    }
  }

  if (!payload) {
    if (response.status === 412) throw new Error(`${label}被 B 站风控拦截（HTTP 412），请稍后重试`);
    throw new Error(`${label}返回了无法解析的响应（HTTP ${response?.status ?? "?"}）`);
  }
  if (typeof payload.code === "number" && payload.code !== 0 && !tolerate.includes(payload.code)) {
    throw new Error(describeBiliError(payload.code, payload.message, label));
  }
  return payload.data ?? null;
}

/** POST 表单接口（x-www-form-urlencoded，收藏夹增删、登出等）；412 时同样换宽松 Referer 重试一次 */
async function apiPost(path, body, options = {}) {
  const { label = "B站接口", host, relaxed = false } = options;
  await ensureSiteCookies();
  const url = `${host ?? apiHost()}${path}`;
  const response = await rawRequest({
    url,
    method: "POST",
    headers: {
      ...buildHeaders({ post: true, relaxed }),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: buildFormBody(body),
  });
  if (response.status === 412 && !relaxed) {
    debugLog(`${label}疑似撞风控（HTTP 412），改用宽松 Referer 重试`);
    return apiPost(path, body, { ...options, relaxed: true });
  }
  const payload = normalizePayload(response);
  if (!payload) {
    if (response.status === 412) throw new Error(`${label}被 B 站风控拦截（HTTP 412），请稍后重试`);
    throw new Error(`${label}返回了无法解析的响应（HTTP ${response?.status ?? "?"}）`);
  }
  if (typeof payload.code === "number" && payload.code !== 0) {
    throw new Error(describeBiliError(payload.code, payload.message, label));
  }
  return payload.data ?? null;
}

/* ------------------------------ 通用转换 ------------------------------ */

/** 去掉搜索结果里的 `<em class="keyword">` 高亮标签与 HTML 实体 */
function stripHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

/** CDN 图床常用协议相对地址（//i0.hdslb.com/...），统一补 https；顺手升级 http */
function httpsify(url) {
  if (!url) return undefined;
  const text = String(url).trim();
  if (!text) return undefined;
  if (text.startsWith("//")) return `https:${text}`;
  if (text.startsWith("http://")) return `https://${text.slice(7)}`;
  return text;
}

/** 时长解析：数字按秒、"222:28" / "1:02:03" 按时分秒 → 毫秒 */
function parseClock(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value * 1000));
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (/^\d+$/.test(text)) return Math.max(0, parseInt(text, 10) * 1000);
  const parts = text.split(":").map((part) => parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.max(0, Math.round(seconds * 1000));
}

/** 解析歌曲 ID：`BV...`、`BV...#p2`、`av123` / `123`（后两者走 aid 查询） */
function parseTrackId(id) {
  const text = String(id ?? "").trim();
  if (!text) throw new Error("缺少歌曲 ID");
  const bv = /^(BV[0-9A-Za-z]+)(?:#p(\d+))?$/i.exec(text);
  if (bv) return { bvid: bv[1], page: Math.max(1, parseInt(bv[2] ?? "1", 10) || 1) };
  const av = /^(?:av)?(\d+)(?:#p(\d+))?$/i.exec(text);
  if (av) return { aid: Number(av[1]), page: Math.max(1, parseInt(av[2] ?? "1", 10) || 1) };
  throw new Error(`无法识别的歌曲 ID「${text}」`);
}

/** 解析专辑 ID：`s{mid}_{seasonId}` */
function parseSeasonId(id) {
  const match = /^s(\d+)_(\d+)$/.exec(String(id ?? "").trim());
  if (!match) throw new Error(`无法识别的专辑 ID「${id}」（本插件专辑 = B 站视频合集）`);
  return { mid: match[1], seasonId: match[2] };
}

/** 关键词切成小写 token，用于专辑名模糊匹配 */
function keywordTokens(keyword) {
  return String(keyword)
    .split(/[\s,，、]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function formatLrcTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const whole = Math.floor(safe);
  const mm = String(Math.floor(whole / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  const cs = String(Math.floor((safe - whole) * 100)).padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

/* ------------------------------ 稿件信息缓存 ------------------------------ */

/** bvid → view 响应（cid/pages/title/owner），多 P 解析与取直链都会用到 */
const viewCache = new Map();

async function fetchView({ bvid, aid }) {
  const key = bvid ?? `av${aid}`;
  const hit = viewCache.get(key);
  if (hit && Date.now() - hit.at < VIEW_CACHE_TTL) return hit.data;

  const params = bvid ? { bvid } : { aid, avid: aid };
  // 实测：view 接口带 www Referer 会稳定返回 412，直接用宽松 Referer 请求
  const data = await apiGet("/x/web-interface/view", params, { label: "获取视频信息", relaxed: true });
  if (!data) throw new Error("B 站未返回视频信息（稿件可能已失效）");
  if (!data.cid && !(Array.isArray(data.pages) && data.pages.length)) {
    throw new Error("B 站未返回该视频的分 P 信息（cid）");
  }
  viewCache.set(key, { data, at: Date.now() });
  if (viewCache.size > VIEW_CACHE_MAX) {
    viewCache.delete(viewCache.keys().next().value);
  }
  return data;
}

/** playurl（fnval=16 取 DASH，fnval=1 退回 MP4 整流） */
async function fetchPlayUrl({ bvid, aid, cid, fnval }) {
  return apiGet(
    "/x/player/playurl",
    { bvid, avid: aid, cid, fnver: 0, fnval, fourk: 0 },
    { label: "获取播放直链" },
  );
}

/* ------------------------------ 统一数据转换 ------------------------------ */

function toTrackFromVideoSearch(item) {
  const bvid = item?.bvid;
  if (!bvid) return null;
  const track = {
    id: bvid,
    name: stripHtml(item.title) || "未知标题",
    artists: [item.author || "未知UP主"],
    cover: httpsify(item.pic),
    duration: parseClock(item.duration),
    extra: {
      aid: item.id,
      typename: item.typename ?? "",
      pubdate: item.pubdate ?? 0,
      play: item.play ?? 0,
    },
  };
  if (item.mid) track.artistIds = [String(item.mid)];
  if (item.typename) track.album = item.typename; // 分区名当纯文本专辑（不可跳转）
  if (item.is_pay || item.badgepay) track.vip = true;
  return track;
}

function toTrackFromVlist(v, { upName, mid, seasonNames } = {}) {
  if (!v?.bvid) return null;
  const track = {
    id: v.bvid,
    name: stripHtml(v.title) || "未知标题",
    artists: [v.author || upName || "未知UP主"],
    cover: httpsify(v.pic),
    duration: parseClock(v.length),
    extra: { aid: v.aid, play: v.play ?? 0, created: v.created ?? 0 },
  };
  if (mid) track.artistIds = [String(mid)];
  const seasonId = v.season_id ? String(v.season_id) : "";
  if (seasonId && seasonNames?.has(seasonId)) {
    track.album = seasonNames.get(seasonId);
    track.albumId = `s${mid}_${seasonId}`; // 指向所在合集
  }
  return track;
}

function toTrackFromArchive(archive, { upName, mid, albumName, albumId } = {}) {
  if (!archive?.bvid) return null;
  const track = {
    id: archive.bvid,
    name: stripHtml(archive.title) || "未知标题",
    artists: [archive.author || upName || "未知UP主"],
    cover: httpsify(archive.pic),
    duration: parseClock(archive.duration),
    extra: { aid: archive.aid, pubdate: archive.pubdate ?? 0 },
  };
  if (mid) track.artistIds = [String(mid)];
  if (albumName) track.album = albumName;
  if (albumId) track.albumId = albumId;
  return track;
}

function toTrackFromPopular(item) {
  if (!item?.bvid) return null;
  const track = {
    id: item.bvid,
    name: stripHtml(item.title) || "未知标题",
    artists: [item.owner?.name || "未知UP主"],
    cover: httpsify(item.pic),
    duration: parseClock(item.duration),
    extra: { aid: item.aid, pubdate: item.pubdate ?? 0, tname: item.tname ?? "" },
  };
  if (item.owner?.mid) track.artistIds = [String(item.owner.mid)];
  if (item.tname) track.album = item.tname;
  return track;
}

/**
 * 收藏夹条目 → 歌曲。
 * `page` > 1 表示收藏的是第 N 个分 P（B 站对单 P 稿件也返回 1），拼成分 P ID。
 * 只收视频稿件（type=2）；失效稿件（attr=1）也保留，点播时由 getSongUrl 报可读错误。
 */
function toTrackFromFavMedia(media) {
  if (!media || media.type !== 2 || !media.bvid) return null;
  const page = Number(media.page) || 1;
  const track = {
    id: page > 1 ? `${media.bvid}#p${page}` : media.bvid,
    name: stripHtml(media.title) || "未知标题",
    artists: [media.upper?.name || "未知UP主"],
    cover: httpsify(media.cover),
    duration: parseClock(media.duration),
    extra: { avid: media.id, attr: media.attr ?? 0, intro: media.intro ?? "" },
  };
  if (media.upper?.mid) track.artistIds = [String(media.upper.mid)];
  return track;
}

function toPlaylistFromFolder(folder, fallbackId) {
  const id = folder?.id ?? fallbackId;
  if (id === undefined || id === null || id === "") return null;
  const playlist = {
    id: String(id),
    name: folder?.title || "未知收藏夹",
    cover: httpsify(folder?.cover),
    trackCount: typeof folder?.media_count === "number" ? folder.media_count : undefined,
    creator: folder?.upper?.name,
  };
  if (folder?.intro) playlist.description = folder.intro;
  return playlist;
}

/** 合集名：去掉「合集·」前缀，meta.title（如「周杰伦」）优先于 meta.name（如「合集·周杰伦」） */
function cleanSeasonName(meta) {
  const raw = String(meta?.title || meta?.name || "").trim();
  return raw.replace(/^合集[·・]\s*/, "") || "未命名合集";
}

function toAlbumFromSeason(season, upName) {
  const meta = season?.meta;
  if (!meta?.season_id) return null;
  const album = {
    id: `s${meta.mid}_${meta.season_id}`,
    name: cleanSeasonName(meta),
    trackCount:
      typeof meta.total === "number"
        ? meta.total
        : typeof meta.media_count === "number"
          ? meta.media_count
          : undefined,
    artistIds: meta.mid ? [String(meta.mid)] : undefined,
    artistNames: upName ? [upName] : undefined,
  };
  const cover = httpsify(meta.cover);
  if (cover) album.cover = cover;
  if (meta.description) album.description = meta.description;
  const ptime = Number(meta.ptime || meta.pubtime || 0);
  if (ptime > 0) album.publishTime = Math.round(ptime * 1000);
  return album;
}

function toArtistFromBiliUser(item) {
  if (!item?.mid) return null;
  const artist = {
    id: String(item.mid),
    name: item.uname || "未知UP主",
    avatar: httpsify(item.upic),
    briefDesc: item.usign || undefined,
  };
  if (typeof item.videos === "number") artist.songCount = item.videos;
  return artist;
}

/* ------------------------------ 关键接口小工具 ------------------------------ */

async function fetchVideoSearch(keyword, page) {
  return apiGet(
    "/x/web-interface/wbi/search/type",
    { search_type: "video", keyword, page },
    { wbi: true, label: `搜索视频「${keyword}」` },
  );
}

/** UP 主的合集列表（仅 seasons，系列视频列表不支持） */
async function fetchSeasonList(mid, pageNum = 1, pageSize = 20) {
  const data = await apiGet(
    "/x/polymer/web-space/seasons_series_list",
    { mid, page_num: pageNum, page_size: clamp(pageSize, 1, 30) },
    { label: "获取UP主合集" },
  );
  return Array.isArray(data?.items_lists?.seasons_list) ? data.items_lists.seasons_list : [];
}

/** UP 主昵称（card 接口，失败返回空串） */
async function fetchUpName(mid) {
  try {
    const data = await apiGet("/x/web-interface/card", { mid, photo: false }, { label: "获取UP主信息" });
    return data?.card?.name || "";
  } catch (error) {
    debugLog("获取UP主昵称失败", error);
    return "";
  }
}

/** nav 接口：登录态与头像来源（60s 内存缓存） */
let navCache = null; // { at, profile }

async function fetchNavProfile(force = false) {
  if (!force && navCache && Date.now() - navCache.at < NAV_CACHE_TTL) return navCache.profile;
  const data = await apiGet("/x/web-interface/nav", {}, { label: "获取账号信息", tolerate: [-101] });
  const profile = data?.isLogin
    ? { mid: data.mid, uname: data.uname || "", face: data.face || "" }
    : null;
  navCache = { at: Date.now(), profile };
  return profile;
}

/* ------------------------------ 能力：搜索 ------------------------------ */

/**
 * 搜索。
 * - 默认（type 缺省 / "song"）：视频搜索，即「单曲」。
 * - type "playlist"：B 站没有公开的歌单搜索接口，返回空（歌单=收藏夹，登录后在
 *   平台歌单里用；也可以先搜视频再进 UP 主主页）。
 * - type "album"：取视频搜索前几个 UP 主的合集，关键词过滤（无命中则原样返回）。
 * - type "artist"：bili_user 搜索（歌手 = UP 主）。
 */
async function search(params = {}) {
  const keyword = String(params.keyword ?? "").trim();
  if (!keyword) {
    return { songs: [], playlists: [], albums: [], artists: [], total: 0, hasMore: false };
  }
  const type = params.type;
  if (type === "playlist") return { songs: [], playlists: [], total: 0, hasMore: false };
  if (type === "album") return searchAlbums(keyword);
  if (type === "artist") return searchArtists(keyword, params);
  return searchSongs(keyword, params);
}

async function searchSongs(keyword, params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const data = await fetchVideoSearch(keyword, page);
  const items = Array.isArray(data?.result) ? data.result : [];
  const songs = items.map(toTrackFromVideoSearch).filter(Boolean);
  const numPages = Number(data?.numPages) || 0;
  return {
    songs,
    playlists: [],
    total: Number(data?.numResults) || songs.length,
    hasMore: numPages > 0 ? page < numPages : songs.length >= 20,
  };
}

async function searchArtists(keyword, params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const data = await apiGet(
    "/x/web-interface/wbi/search/type",
    { search_type: "bili_user", keyword, page },
    { wbi: true, label: `搜索UP主「${keyword}」` },
  );
  const items = Array.isArray(data?.result) ? data.result : [];
  const artists = items.map(toArtistFromBiliUser).filter(Boolean);
  const numPages = Number(data?.numPages) || 0;
  return {
    songs: [],
    artists,
    total: Number(data?.numResults) || artists.length,
    hasMore: numPages > 0 ? page < numPages : false,
  };
}

async function searchAlbums(keyword) {
  const data = await fetchVideoSearch(keyword, 1);
  const items = Array.isArray(data?.result) ? data.result : [];

  // 取前几个 UP 主的合集当作「专辑」候选（B 站没有独立的专辑搜索接口）
  const upNames = new Map();
  const mids = [];
  for (const item of items) {
    const mid = item?.mid ? String(item.mid) : "";
    if (!mid || upNames.has(mid)) continue;
    upNames.set(mid, item.author || "");
    mids.push(mid);
    if (mids.length >= 4) break;
  }

  const lists = await Promise.all(
    mids.map((mid) =>
      fetchSeasonList(mid).catch((error) => {
        debugLog(`获取 UP ${mid} 合集失败`, error);
        return [];
      }),
    ),
  );

  const albums = [];
  lists.forEach((list, index) => {
    for (const season of list) {
      const album = toAlbumFromSeason(season, upNames.get(mids[index]));
      if (album) albums.push(album);
    }
  });

  // 关键词命中优先；一条都不命中就把候选全放出来（专辑 Tab 至少有内容可看）
  const tokens = keywordTokens(keyword);
  const matched = tokens.length
    ? albums.filter((album) =>
        tokens.some((token) =>
          `${album.name}${album.description ?? ""}`.toLowerCase().includes(token),
        ),
      )
    : albums;
  const chosen = matched.length ? matched : albums;
  chosen.sort((a, b) => (b.trackCount ?? 0) - (a.trackCount ?? 0));
  return { albums: chosen.slice(0, 24), total: chosen.length, hasMore: false };
}

/* ------------------------------ 能力：播放直链 ------------------------------ */

function resolveTargetQuality(quality) {
  const key = String(quality || readSetting("quality", "exhigh"));
  return AUDIO_QUALITY_IDS[key] ?? AUDIO_QUALITY_IDS.exhigh;
}

/** 选不超过目标码率的最高档；一档都没有（理论上不会）退回最低档 */
function pickAudio(list, targetId) {
  const usable = (Array.isArray(list) ? list : []).filter((a) => a && (a.baseUrl || a.base_url));
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0));
  return sorted.find((a) => (Number(a.id) || 0) <= targetId) ?? sorted[sorted.length - 1];
}

/**
 * 取播放直链：view（bvid → cid，多 P 按 #pN 取对应分 P）→ playurl 选音轨。
 * 直链约 120 分钟过期，宿主每次播放都会重新调用，不做长期缓存。
 */
async function getSongUrl(params = {}) {
  const { bvid, aid, page } = parseTrackId(params.id);
  const view = await fetchView({ bvid, aid });

  let cid = view.cid;
  if (page > 1) {
    const pages = Array.isArray(view.pages) ? view.pages : [];
    const part = pages[page - 1];
    if (!part?.cid) {
      throw new Error(`该稿件只有 ${pages.length || 1} 个分P，找不到第 ${page} 页`);
    }
    cid = part.cid;
  }

  const targetId = resolveTargetQuality(params.quality);
  const dash = await fetchPlayUrl({ bvid: view.bvid, aid: view.aid, cid, fnval: 16 });
  const audio = pickAudio(dash?.dash?.audio, targetId);
  if (audio) {
    return {
      url: httpsify(audio.baseUrl || audio.base_url),
      quality: AUDIO_ID_LABELS[Number(audio.id)] ?? "standard",
      br: audio.bandwidth,
    };
  }

  // DASH 无音轨（个别付费/受限稿件）→ 退回带音轨的 MP4 整流
  const mp4 = await fetchPlayUrl({ bvid: view.bvid, aid: view.aid, cid, fnval: 1 }).catch(() => null);
  const durl = mp4?.durl?.[0]?.url;
  if (durl) return { url: httpsify(durl), quality: "standard" };

  throw new Error(
    `「${stripHtml(view.title) || "该稿件"}」取不到可播放的音频流（可能需要大会员、存在版权或区域限制）`,
  );
}

/* ------------------------------ 能力：歌单（收藏夹） ------------------------------ */

/** 收藏夹详情 + 全部视频（ps 固定 20，逐页拉，受 maxTracks 限制） */
async function getPlaylist(params = {}) {
  const id = String(params.id ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error(`无法识别的歌单 ID「${id}」（B 站歌单 = 收藏夹，需数字 mlid）`);
  }
  const maxTracks = readNumber("maxTracks", 200, { min: 0, max: 2000 });
  const onlyPage = params.page !== undefined && params.page !== null ? Math.max(1, Number(params.page) || 1) : 0;

  const collected = [];
  let info = null;
  let total = 0;
  let hasMore = false;
  let pn = onlyPage || 1;
  let rounds = 0;

  for (;;) {
    const data = await apiGet(
      "/x/v3/fav/resource/list",
      { media_id: id, pn, ps: FAV_PAGE_SIZE, platform: "web" },
      { label: `读取收藏夹 ${id}` },
    );
    if (!data) throw new Error(`收藏夹 ${id} 不存在或不公开`);
    if (!info) info = data.info;
    if (typeof data.info?.media_count === "number") total = data.info.media_count;
    for (const media of data.medias ?? []) {
      const track = toTrackFromFavMedia(media);
      if (track) collected.push(track);
    }
    hasMore = Boolean(data.has_more);
    rounds += 1;
    pn += 1;

    if (onlyPage) break; // 指定分页只拉一页
    if (!hasMore) break;
    if (rounds >= 100) break; // 安全上限（2000 条）
    if (maxTracks > 0 && collected.length >= maxTracks) break;
  }

  const tracks = maxTracks > 0 ? collected.slice(0, maxTracks) : collected;
  const playlist = toPlaylistFromFolder(info, id) ?? { id, name: "未知收藏夹" };
  if (total > 0) playlist.trackCount = total;
  return { ...playlist, tracks };
}

/* ------------------------------ 能力：专辑（合集） ------------------------------ */

/** 合集详情：分页拉归档列表，直到拉完 / 达到 maxTracks */
async function getAlbum(params = {}) {
  const { mid, seasonId } = parseSeasonId(params.id);
  const maxTracks = readNumber("maxTracks", 200, { min: 0, max: 2000 });
  const cap = maxTracks > 0 ? maxTracks : 2000;

  let pageNum = 1;
  let total = 0;
  let meta = null;
  let upName = "";
  const archives = [];

  for (;;) {
    const data = await apiGet(
      "/x/polymer/web-space/seasons_archives_list",
      { mid, season_id: seasonId, page_num: pageNum, page_size: SEASON_PAGE_SIZE },
      { label: "读取合集" },
    );
    if (!data) throw new Error(`合集 ${seasonId} 不存在或已隐藏`);
    if (!meta && data.meta) meta = data.meta;
    if (typeof data.page?.total === "number") total = data.page.total;

    const list = Array.isArray(data.archives) ? data.archives : [];
    for (const archive of list) archives.push(archive);
    pageNum += 1;

    if (!list.length) break;
    if (total > 0 && archives.length >= total) break;
    if (archives.length >= cap) break;
    if (pageNum > 67) break; // 30 * 67 ≈ 2000 条安全上限
  }

  if (!upName && meta?.mid) upName = await fetchUpName(meta.mid);

  const name = meta ? cleanSeasonName(meta) : "未命名合集";
  const album = {
    id: `s${mid}_${seasonId}`,
    name,
    trackCount: total > 0 ? total : archives.length,
    artistIds: [mid],
    artistNames: upName ? [upName] : undefined,
  };
  const cover = httpsify(meta?.cover);
  if (cover) album.cover = cover;
  if (meta?.description) album.description = meta.description;
  const ptime = Number(meta?.ptime || meta?.pubtime || 0);
  if (ptime > 0) album.publishTime = Math.round(ptime * 1000);

  const tracks = archives
    .slice(0, cap)
    .map((archive) => toTrackFromArchive(archive, { upName, mid, albumName: name, albumId: album.id }))
    .filter(Boolean);
  return { ...album, tracks };
}

/* ------------------------------ 能力：歌手（UP 主） ------------------------------ */

/** 歌手详情：card（资料）+ 最多播放投稿（热门歌曲）+ 合集列表 */
async function getArtist(params = {}) {
  const mid = String(params.id ?? "").trim();
  if (!/^\d+$/.test(mid)) throw new Error(`无法识别的歌手（UP主）ID「${params.id}」`);

  const [card, hot, seasons] = await Promise.all([
    apiGet("/x/web-interface/card", { mid, photo: false }, { label: "获取UP主信息" }).catch((error) => {
      debugLog("card 失败", error);
      return null;
    }),
    apiGet(
      "/x/space/wbi/arc/search",
      { mid, pn: 1, ps: 20, order: "click", platform: "web" },
      { wbi: true, label: "获取UP主投稿" },
    ).catch((error) => {
      debugLog("投稿列表失败", error);
      return null;
    }),
    fetchSeasonList(mid).catch((error) => {
      debugLog("合集列表失败", error);
      return [];
    }),
  ]);

  const name = card?.card?.name || "未知UP主";
  const artist = {
    id: mid,
    name,
    avatar: httpsify(card?.card?.face),
    briefDesc: card?.card?.sign || undefined,
    hotTracks: [],
  };
  if (typeof card?.archive_count === "number") artist.songCount = card.archive_count;

  // 合集名映射：给热门歌曲补上 album / albumId 跳转
  const seasonNames = new Map();
  for (const season of seasons) {
    if (season?.meta?.season_id) seasonNames.set(String(season.meta.season_id), cleanSeasonName(season.meta));
  }
  artist.albumCount = Number(seasons?.page?.total) || seasonNames.size || undefined;

  const vlist = Array.isArray(hot?.list?.vlist) ? hot.list.vlist : [];
  artist.hotTracks = vlist
    .map((v) => toTrackFromVlist(v, { upName: name, mid, seasonNames }))
    .filter(Boolean);
  return artist;
}

/** 歌手的合集分页（仅 seasons；B 站「系列」无 meta，不作为专辑暴露） */
async function getArtistAlbums(params = {}) {
  const mid = String(params.id ?? "").trim();
  if (!/^\d+$/.test(mid)) return { albums: [], total: 0, hasMore: false };

  const pageNum = Math.max(1, Number(params.page) || 1);
  const pageSize = clamp(Number(params.pageSize) || 20, 1, 30);
  const data = await apiGet(
    "/x/polymer/web-space/seasons_series_list",
    { mid, page_num: pageNum, page_size: pageSize },
    { label: "获取UP主合集" },
  );
  const lists = data?.items_lists ?? {};
  const seasons = Array.isArray(lists.seasons_list) ? lists.seasons_list : [];
  if (!seasons.length) return { albums: [], total: 0, hasMore: false };

  const upName = await fetchUpName(mid);
  const albums = seasons.map((season) => toAlbumFromSeason(season, upName)).filter(Boolean);
  const total = Number(data?.page?.total) || 0;
  return {
    albums,
    total: total || albums.length,
    // page.total 混计了系列，仅作粗略 hasMore 判断
    hasMore: total > 0 ? pageNum * pageSize < total : seasons.length >= pageSize,
  };
}

/* ------------------------------ 能力：推荐 / 热搜 / 歌词 ------------------------------ */

/** 热门推荐（popular 接口，一次一页） */
async function getRecommendations(params = {}) {
  const page = Math.max(1, Number(params.page) || 1);
  const ps = clamp(Number(params.pageSize) || readNumber("pageSize", 20, { min: 1, max: 50 }), 1, 50);
  let data;
  try {
    data = await apiGet("/x/web-interface/popular", { ps, pn: page }, { label: "获取热门推荐" });
  } catch (error) {
    if (ps === 20) throw error;
    debugLog(`popular ps=${ps} 失败，退回 20 重试`, error);
    data = await apiGet("/x/web-interface/popular", { ps: 20, pn: page }, { label: "获取热门推荐" });
  }
  const songs = (Array.isArray(data?.list) ? data.list : []).map(toTrackFromPopular).filter(Boolean);
  return { songs, playlists: [] };
}

/** 热搜词（search/square，失败回退 storage 缓存，再回退内置词表） */
async function getHotKeywords() {
  try {
    const data = await apiGet("/x/web-interface/search/square", { limit: 10 }, { label: "获取热搜词" });
    const list = Array.isArray(data?.trending?.list) ? data.trending.list : [];
    const keywords = list.map((item) => String(item?.keyword ?? "").trim()).filter(Boolean);
    if (keywords.length) {
      try {
        await requireContext().storage.set("hotKeywords", keywords);
      } catch {
        /* 缓存写失败不影响返回 */
      }
      return keywords;
    }
  } catch (error) {
    debugLog("获取热搜词失败", error);
  }
  try {
    const saved = await requireContext().storage.get("hotKeywords");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {
    /* 没有缓存就用内置词表 */
  }
  return DEFAULT_HOT_KEYWORDS;
}

/** 优先选 AI 中文字幕，其次中文字幕，否则第一条 */
function pickSubtitle(subtitles) {
  const hasUrl = subtitles.filter((s) => s?.subtitle_url);
  if (!hasUrl.length) return null;
  const byLan = (prefix) => hasUrl.find((s) => String(s.lan ?? "").startsWith(prefix));
  return (
    byLan("ai-zh") || byLan("zh") || hasUrl.find((s) => String(s.lan_doc ?? "").includes("中")) || hasUrl[0]
  );
}

/** 字幕 JSON（body: [{from,to,content}]）→ LRC */
function subtitleToLrc(body) {
  const lines = [];
  const seen = new Set();
  for (const seg of Array.isArray(body) ? body : []) {
    const text = String(seg?.content ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const stamp = formatLrcTime(seg.from);
    const key = `${stamp}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`[${stamp}]${text}`);
  }
  return lines.length ? lines.join("\n") : "";
}

/**
 * 歌词：B 站没有歌词，用 AI 字幕尽力转 LRC。
 * 未登录时字幕列表大概率为空 → 返回 null（宿主按无歌词处理，不打断播放）。
 */
async function getLyrics(params = {}) {
  try {
    const { bvid, aid, page } = parseTrackId(params.id);
    const view = await fetchView({ bvid, aid });
    const pages = Array.isArray(view.pages) ? view.pages : [];
    const cid = page > 1 ? pages[page - 1]?.cid : view.cid;
    if (!cid) return null;

    const data = await apiGet(
      "/x/player/wbi/v2",
      { bvid: view.bvid, aid: view.aid, cid },
      { wbi: true, label: "获取字幕" },
    ).catch((error) => {
      debugLog("字幕接口失败", error);
      return null;
    });

    const subtitles = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];
    const subtitle = pickSubtitle(subtitles);
    if (!subtitle?.subtitle_url) return null;

    const response = await rawRequest({
      url: httpsify(subtitle.subtitle_url),
      method: "GET",
      headers: buildHeaders({ cookie: "" }),
      timeout: 10000,
    });
    const payload = normalizePayload(response);
    const lrc = subtitleToLrc(payload?.body);
    return lrc ? { lrc } : null;
  } catch (error) {
    debugLog("获取歌词失败", error);
    return null;
  }
}

/* ------------------------------ 能力：登录 / 头像 ------------------------------ */

/** 生成登录二维码（passport 二维码登录，有效期 3 分钟） */
async function getLoginQr() {
  const data = await apiGet(
    "/x/passport-login/web/qrcode/generate",
    {},
    { label: "生成登录二维码", host: PASSPORT_HOST },
  );
  if (!data?.url || !data?.qrcode_key) throw new Error("B 站未返回二维码内容");
  return {
    content: data.url,
    key: data.qrcode_key,
    expiresIn: 180000,
    hint: "使用哔哩哔哩手机 App 扫码登录",
  };
}

/**
 * 轮询扫码状态。
 * code：0 成功 / 86101 未扫码 / 86090 已扫待确认 / 86038 过期。
 * 成功时登录 Cookie（SESSDATA、bili_jct、DedeUserID…）由 Set-Cookie 下发进罐，
 * 连同 buvid3 等会话 Cookie 一起序列化为凭证，宿主会写入 settings.cookie。
 */
async function pollLogin(params = {}) {
  const key = String(params.key ?? "").trim();
  if (!key) return { status: "error", message: "缺少二维码会话标识（key）" };

  let data;
  try {
    data = await apiGet(
      "/x/passport-login/web/qrcode/poll",
      { qrcode_key: key },
      { label: "轮询登录状态", host: PASSPORT_HOST },
    );
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }

  const code = Number(data?.code);
  if (code === 0) {
    const credential = serializePairs([...mergedCookies()]);
    if (!credential.includes("SESSDATA=")) {
      return { status: "error", message: "扫码成功但未收到登录 Cookie，请改用手工粘贴 Cookie" };
    }
    navCache = null; // 登录后立即刷新登录态缓存
    let profile = null;
    try {
      profile = await fetchNavProfile(true);
    } catch (error) {
      debugLog("登录后获取用户信息失败", error);
    }
    return {
      status: "success",
      credential,
      profile: profile
        ? { id: String(profile.mid ?? ""), nickname: profile.uname, avatar: httpsify(profile.face) }
        : undefined,
    };
  }
  if (code === 86101) return { status: "waiting" };
  if (code === 86090) return { status: "confirming" };
  if (code === 86038) return { status: "expired", message: "二维码已过期，请重新生成" };
  return {
    status: "error",
    message: data?.message ? `轮询登录失败：${data.message}（${code}）` : `轮询登录失败（code ${code}）`,
  };
}

/** 登录态：有凭证才查 nav，避免无谓请求 */
async function getLoginState() {
  await ensureJar();
  const hasCredential = Boolean(readSetting("cookie", "")) || jar.has("SESSDATA");
  if (!hasCredential) return { loggedIn: false };

  const cached = navCache && Date.now() - navCache.at < NAV_CACHE_TTL ? navCache.profile : null;
  try {
    const profile = cached ?? (await fetchNavProfile());
    if (!profile) return { loggedIn: false };
    return {
      loggedIn: true,
      profile: { id: String(profile.mid ?? ""), nickname: profile.uname, avatar: httpsify(profile.face) },
    };
  } catch (error) {
    debugLog("查询登录态失败", error);
    return { loggedIn: false };
  }
}

/** 退出登录：登 passport/logout（尽力而为），清掉罐与本地缓存 */
async function logout() {
  await ensureJar();
  const csrf = readCookieValue("bili_jct");
  if (csrf) {
    try {
      await apiPost(
        "/x/passport-login/web/logout",
        { csrf },
        { label: "退出登录", host: PASSPORT_HOST },
      );
    } catch (error) {
      debugLog("登出接口失败（忽略）", error);
    }
  }
  navCache = null;
  jar = new Map();
  viewCache.clear();
  siteCookieTried = false; // 下次请求重新补 buvid
  try {
    await requireContext().storage.set("sessionCookie", "");
  } catch {
    /* 清缓存失败可忽略 */
  }
}

/** 头像（nav 的 face 字段，i*.hdslb.com 允许直接引用） */
async function getAvatar() {
  try {
    const profile = await fetchNavProfile();
    if (!profile?.face) return null;
    return { image: httpsify(profile.face), label: profile.uname || undefined };
  } catch (error) {
    debugLog("获取头像失败", error);
    return null;
  }
}

/* ------------------------------ 能力：平台歌单（收藏夹增删） ------------------------------ */

/** 平台歌单开关（manifest 设置 platformPlaylists，默认开启；关闭后收藏夹列表返回空、增删直接报错） */
function platformPlaylistsEnabled() {
  const value = readSetting("platformPlaylists", true);
  if (typeof value === "string") return value !== "false" && value !== "0" && value !== "";
  return value !== false;
}

/** 自己的收藏夹列表（登录后可见全部，含私有夹） */
async function getUserPlaylists() {
  if (!platformPlaylistsEnabled()) return [];
  await ensureJar();
  const profile = await fetchNavProfile();
  if (!profile?.mid) throw new Error("未登录：请先扫码登录或在插件设置中粘贴 Cookie");

  const data = await apiGet(
    "/x/v3/fav/folder/created/list-all",
    { up_mid: profile.mid },
    { label: "获取收藏夹列表" },
  );
  const list = Array.isArray(data?.list) ? data.list : [];
  return list.map((folder) => toPlaylistFromFolder(folder, undefined)).filter((playlist) => playlist?.id);
}

/** 收藏 / 取消收藏视频到指定收藏夹（x/v3/fav/resource/deal 统一端点） */
async function mutateFavorite(mode, params = {}) {
  if (!platformPlaylistsEnabled()) {
    throw new Error("平台歌单功能已关闭（可在插件设置中打开「平台歌单（收藏夹同步）」）");
  }
  const playlistId = String(params.playlistId ?? "").trim();
  const trackId = String(params.trackId ?? "").trim();
  if (!playlistId || !trackId) throw new Error("缺少 playlistId 或 trackId");
  if (!/^\d+$/.test(playlistId)) throw new Error(`收藏夹 ID 无效：${playlistId}`);

  await ensureJar();
  const hasCredential = Boolean(readSetting("cookie", "")) || jar.has("SESSDATA");
  if (!hasCredential) throw new Error("未登录：请先扫码登录或在插件设置中粘贴 Cookie");

  const csrf = readCookieValue("bili_jct");
  if (!csrf) throw new Error("Cookie 缺少 bili_jct（CSRF Token），无法执行收藏操作");

  const { bvid, aid } = parseTrackId(trackId);
  const view = await fetchView({ bvid, aid });

  const body = { rid: view.aid, type: 2, csrf, platform: "web" };
  if (mode === "add") body.add_media_ids = playlistId;
  else body.del_media_ids = playlistId;

  return apiPost("/x/v3/fav/resource/deal", body, {
    label: mode === "add" ? "收藏视频" : "取消收藏",
  });
}

async function addToUserPlaylist(params = {}) {
  await mutateFavorite("add", params);
}

async function removeFromUserPlaylist(params = {}) {
  await mutateFavorite("del", params);
}

/* ------------------------------ 预热 ------------------------------ */

/** 后台预热：会话 Cookie（buvid3）与 WBI 密钥。永不抛错，不阻塞 init */
async function warmup() {
  try {
    await ensureSiteCookies();
  } catch (error) {
    debugLog("预热会话 Cookie 失败", error);
  }
  try {
    await getWbiKeys();
  } catch (error) {
    debugLog("预热 WBI 密钥失败（稍后按需重试）", error);
  }
}

/* ------------------------------ 模块导出 ------------------------------ */

export default {
  async init(ctx) {
    context = ctx;
    jar = new Map();
    jarLoaded = false;
    siteCookieTried = false;
    navCache = null;
    wbiKeys = null;
    viewCache.clear();

    await ensureJar(); // 恢复上次的会话 Cookie（buvid3 等），保持风控环境连续
    void warmup(); // 网络预热放后台，失败不阻断启动

    ctx.log(
      `哔哩哔哩音源已就绪（接口 ${apiHost()}，音质 ${readSetting("quality", "exhigh")}）` +
        `${readSetting("cookie", "") ? "" : "，未设置登录 Cookie（可扫码登录以使用收藏夹与字幕歌词）"}`,
    );
  },

  search,
  getSongUrl,
  getPlaylist,
  getAlbum,
  getArtist,
  getArtistAlbums,
  getRecommendations,
  getLyrics,
  getHotKeywords,

  getLoginQr,
  pollLogin,
  getLoginState,
  logout,
  getAvatar,

  getUserPlaylists,
  addToUserPlaylist,
  removeFromUserPlaylist,

  async dispose() {
    context = null;
    jar = new Map();
    jarLoaded = false;
    siteCookieTried = false;
    navCache = null;
    wbiKeys = null;
    viewCache.clear();
  },
};
