// Full job text from a URL: known ATS APIs first (richer, structured), the page itself otherwise.
// fetchDetail(url) -> { via, title, location, text, companyHint } | { via, unavailable } | { via: 'error', error, status?, terminal }
// `terminal` on an error means retrying will not help (401/403/451, a refused or oversized URL); anything else
// (429, 5xx, DNS, timeout) is worth another try on a later run.
// Also: parseSearchTitle (company/title/location out of a search result's page title), companyFromUrl (the board
// slug of a known ATS, title-cased) and isListingPage, used by sources that only have a title and a link.
import dns from 'node:dns/promises';
import net from 'node:net';
import { htmlText } from './queue.mjs';

// ATS APIs get an honest client name; job pages get a normal browser, since many sites block unknown agents.
const API_HEADERS = { 'User-Agent': 'jobpilot/0.1', 'Accept-Language': 'en-US,en;q=0.9' };
const PAGE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };
const MAX_BODY = 2 * 1024 * 1024;   // bytes; a job page or API answer is far smaller
const MAX_TEXT = 20000;             // characters of job text kept
const MAX_REDIRECTS = 5;
const TERMINAL = new Set([401, 403, 451]);
const GONE = new Set([404, 410]);
const timeout = () => AbortSignal.timeout(30000);
const titleCase = s => String(s || '').replace(/[-_]+/g, ' ').trim().replace(/\b\p{L}/gu, c => c.toUpperCase());
const UNESCAPE = { lt: '<', gt: '>', quot: '"', '#39': "'", amp: '&' };
const unescapeHtml = s => String(s || '').replace(/&(lt|gt|quot|#39|amp);/g, (_, e) => UNESCAPE[e]);   // one pass: "&amp;lt;" -> "&lt;"
const joinNonEmpty = (parts, sep = ', ') => parts.filter(Boolean).join(sep);
const str = v => typeof v === 'string' ? v.trim() : v && typeof v === 'object' && typeof v.name === 'string' ? v.name.trim() : '';
const capText = s => s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT).trimEnd()}\n(text cut at ${MAX_TEXT} characters)` : s;

class FetchError extends Error {
  constructor(message, { status, terminal = false } = {}) { super(message); this.status = status; this.terminal = terminal; }
}

function parseUrl(url) { try { return new URL(url); } catch { return null; } }

// --- fetch safety: http(s) only, never this machine or a private network ----------------------------------------
/** The 16 bytes of an IPv6 address (with "::" and an embedded dotted IPv4 tail), or null. */
function ipv6Bytes(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');   // a zone id ("fe80::1%eth0") says nothing about the range
  const v4 = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (!net.isIPv4(v4[2])) return null;
    const [a, b, c, d] = v4[2].split('.').map(Number);
    s = `${v4[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groups = h => h ? h.split(':') : [];
  const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.some(g => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.flatMap(g => { const n = parseInt(g, 16); return [n >> 8, n & 255]; });
}
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
      || (a === 192 && b === 0 && c === 0)          // 192.0.0.0/24, IETF protocol assignments
      || (a === 198 && (b === 18 || b === 19));     // 198.18.0.0/15, benchmarking
  }
  if (net.isIPv6(ip)) {
    const x = ipv6Bytes(ip); if (!x) return true;   // cannot tell where it points: refuse
    const zeros = (from, to) => x.slice(from, to).every(v => v === 0);
    const tailV4 = () => isPrivateIp(x.slice(12).join('.'));
    if (zeros(0, 12)) return tailV4();                                   // ::, ::1 and IPv4-compatible ::a.b.c.d
    if (zeros(0, 10) && x[10] === 255 && x[11] === 255) return tailV4();  // IPv4-mapped ::ffff:a.b.c.d
    if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b && zeros(4, 12)) return tailV4();   // NAT64 64:ff9b::/96
    return x[0] === 0xfe && x[1] >= 0x80   // link-local fe80::/10, site-local fec0::/10
      || (x[0] & 0xfe) === 0xfc;           // unique-local fc00::/7
  }
  return false;
}
/** Throws a terminal FetchError for a URL jobpilot must not fetch. `lookup` (real network only) also checks what the name resolves to. */
async function assertFetchable(u, lookup) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError(`refused: only http and https links are fetched (${u.protocol})`, { terminal: true });
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');   // "localhost." is localhost
  if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || isPrivateIp(host))
    throw new FetchError(`refused: ${host} is this machine or a private network`, { terminal: true });
  if (lookup && !net.isIP(host)) {
    const addrs = await lookup(host, { all: true });
    if (addrs.some(a => isPrivateIp(a.address))) throw new FetchError(`refused: ${host} resolves to a private address`, { terminal: true });
  }
}

/** Response body as text, at most MAX_BODY bytes. */
async function readBody(res) {
  const tooLarge = () => new FetchError('refused: response larger than 2 MB', { terminal: true });
  if (Number(res.headers?.get?.('content-length')) > MAX_BODY) { res.body?.cancel?.().catch(() => {}); throw tooLarge(); }
  if (res.body?.getReader) {
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const t = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
  if (Buffer.byteLength(t) > MAX_BODY) throw tooLarge();
  return t;
}

/** GET with redirects followed by hand, so every hop passes the safety check. -> { res, finalUrl } */
async function get(url, headers, ctx) {
  let cur = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = parseUrl(cur); if (!u) throw new FetchError(`bad redirect target: ${cur}`, { terminal: true });
    await assertFetchable(u, ctx.lookup);
    const res = await ctx.fetch(cur, { signal: timeout(), headers, redirect: 'manual' });
    const loc = res.status >= 300 && res.status < 400 ? res.headers?.get?.('location') : null;
    if (!loc) return { res, finalUrl: res.url || cur };
    res.body?.cancel?.().catch(() => {});
    cur = new URL(loc, cur).href;
  }
  throw new FetchError('too many redirects', { terminal: true });
}
/** null when the response is a usable 2xx; an "unavailable" answer for 404/410; throws for anything else. */
function gone(res, via) {
  if (GONE.has(res.status)) return { via, unavailable: 'posting gone' };
  if (!res.ok) throw new FetchError(`HTTP ${res.status}`, { status: res.status, terminal: TERMINAL.has(res.status) });
  return null;
}
async function getJson(url, via, ctx) {
  const { res } = await get(url, API_HEADERS, ctx);
  const g = gone(res, via); if (g) return { gone: g };
  return { json: JSON.parse(await readBody(res)) };
}

// --- known ATS routing: hostname + path -> { ats, ...captures } ------------------------------------------------
// The path is matched from the start but may go on (Ashby .../<uuid>/application, Lever .../<uuid>/apply).
function route(u) {
  const host = u.hostname.toLowerCase(), path = u.pathname;
  let m;
  if (/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(host) && (m = path.match(/^\/([^/]+)\/jobs\/(\d+)(?:\/|$)/)))
    return { ats: 'greenhouse', board: m[1], id: m[2] };
  if (host === 'jobs.ashbyhq.com' && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})(?:\/|$)/i)))
    return { ats: 'ashby', org: m[1], id: m[2] };
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})(?:\/|$)/i)))
    return { ats: 'lever', eu: /\.eu\./.test(host), co: m[1], id: m[2] };
  if (host === 'apply.workable.com' && (m = path.match(/^\/([^/]+)\/j\/([A-Za-z0-9]+)(?:\/|$)/)))
    return { ats: 'workable', acct: m[1], code: m[2] };
  if (/\.recruitee\.com$/.test(host) && (m = path.match(/^\/o\/([^/]+)(?:\/|$)/)))
    return { ats: 'recruitee', co: host.split('.')[0], slug: m[1] };
  return null;
}

/** The board/company slug of a known ATS URL, title-cased. null for anything else. */
export function companyFromUrl(url) {
  const u = parseUrl(url); if (!u) return null;
  const r = route(u); if (!r) return null;
  return titleCase(r.ats === 'greenhouse' ? r.board : r.ats === 'ashby' ? r.org : r.ats === 'lever' ? r.co : r.ats === 'workable' ? r.acct : r.co);
}

async function viaGreenhouse(r, ctx) {
  const { gone: g, json: j } = await getJson(`https://boards-api.greenhouse.io/v1/boards/${r.board}/jobs/${r.id}?content=true`, 'greenhouse', ctx);
  if (g) return g;
  return { via: 'greenhouse', title: j.title, location: j.location?.name || '', text: htmlText(unescapeHtml(j.content)) };   // content is entity-escaped HTML
}

async function viaAshby(r, ctx) {
  const { gone: g, json: j } = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${r.org}?includeCompensation=true`, 'ashby', ctx);
  if (g) return g;
  const job = (j.jobs || []).find(x => x && (x.id === r.id || (x.jobUrl || '').includes(r.id)));
  if (!job) return { via: 'ashby', unavailable: 'posting gone' };
  return { via: 'ashby', title: job.title, location: joinNonEmpty([job.location, job.workplaceType, job.isRemote ? 'remote' : ''], '; '),
    text: job.descriptionPlain || htmlText(job.descriptionHtml), companyHint: j.organizationName || undefined };
}

async function viaLever(r, ctx) {
  const { gone: g, json: j } = await getJson(`https://api${r.eu ? '.eu' : ''}.lever.co/v0/postings/${r.co}/${r.id}?mode=json`, 'lever', ctx);
  if (g) return g;
  return { via: 'lever', title: j.text, location: joinNonEmpty([j.categories?.location, j.workplaceType], '; '),
    text: joinNonEmpty([j.descriptionPlain, ...(j.lists || []).map(l => `${l.text}\n${htmlText(l.content)}`), j.additionalPlain], '\n\n') };
}

async function viaWorkable(r, ctx) {
  const { gone: g, json: j } = await getJson(`https://apply.workable.com/api/v2/accounts/${r.acct}/jobs/${r.code}`, 'workable', ctx);
  if (g) return g;
  const loc = j.location || {};
  const remote = loc.telecommuting || j.remote || j.workplace === 'remote';
  return { via: 'workable', title: j.title, location: joinNonEmpty([loc.city, loc.region, loc.country], ', ') + (remote ? ' (remote)' : ''),
    text: joinNonEmpty([htmlText(j.description), htmlText(j.requirements), htmlText(j.benefits)], '\n\n') };
}

async function viaRecruitee(r, ctx) {
  const { gone: g, json } = await getJson(`https://${r.co}.recruitee.com/api/offers/${r.slug}`, 'recruitee', ctx);
  if (g) return g;
  const j = json.offer || {};
  return { via: 'recruitee', title: j.title, location: joinNonEmpty([j.city, j.country], ', ') + (j.remote ? ' (remote)' : ''),
    text: joinNonEmpty([htmlText(j.description), htmlText(j.requirements_description)], '\n\n') };
}

// --- a plain page: JSON-LD JobPosting first, else visible text (must be more than a stub) -----------------------
function findJobPosting(html) {
  for (const [, raw] of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(raw); } catch { continue; }
    if (!data || typeof data !== 'object') continue;   // "null", a number, a string
    const items = (Array.isArray(data) ? data : [data]).flatMap(x => x && typeof x === 'object' && Array.isArray(x['@graph']) ? x['@graph'] : [x]);
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      if (types.includes('JobPosting')) return item;
    }
  }
  return null;
}
function jsonLdLocation(jp) {
  const locs = (Array.isArray(jp.jobLocation) ? jp.jobLocation : [jp.jobLocation]).filter(l => l && typeof l === 'object');
  const parts = locs.map(l => { const a = l.address && typeof l.address === 'object' ? l.address : l; return joinNonEmpty([str(a.addressLocality), str(a.addressRegion), str(a.addressCountry)]); }).filter(Boolean);
  const loc = parts.join(' / ');
  const remote = (Array.isArray(jp.jobLocationType) ? jp.jobLocationType : [jp.jobLocationType]).some(t => /telecommute/i.test(String(t || '')));
  if (remote) return loc ? `${loc} (remote)` : 'Remote';
  return loc || (jp.applicantLocationRequirements ? 'Remote' : '');
}
// Wording a site shows on a posting that is closed but still served with 200.
const CLOSED = /\bno longer (accepting|available|open)\b|\bposition has been filled\b|\bjob has expired\b|вакансия в архиве/i;

async function viaPage(url, ctx) {
  const { res, finalUrl } = await get(url, PAGE_HEADERS, ctx);
  const g = gone(res, 'page'); if (g) return g;
  const html = await readBody(res);
  const title = htmlText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (finalUrl !== url) {
    const f = parseUrl(finalUrl), o = parseUrl(url);
    if (isListingPage(finalUrl, '')) return { via: 'page', unavailable: 'redirected to a listing page' };
    if (f && o && f.pathname.replace(/\/+$/, '') === '' && o.pathname.replace(/\/+$/, '') !== '') return { via: 'page', unavailable: 'redirected to the home page' };
  }
  // Menus, headers and footers are on every page of a site; only the rest says anything about this job.
  const visible = htmlText(html.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' '));
  if (CLOSED.test(visible)) return { via: 'page', unavailable: 'posting closed' };
  const jp = findJobPosting(html);
  if (jp) return { via: 'page', title: str(jp.title), location: jsonLdLocation(jp), text: htmlText(jp.description), companyHint: str(jp.hiringOrganization) || undefined };
  if (visible.length <= 600) return { via: 'page', unavailable: 'too little text to read' };
  return { via: 'page', title, location: '', text: visible };
}

/**
 * fetchDetail(url, { fetch }) -> { via, title, location, text, companyHint } | { via, unavailable } | { via: 'error', error, status?, terminal }
 * With the real network (no `fetch` injected) the host name is also resolved and refused if it points at a private address.
 */
export async function fetchDetail(url, opts = {}) {
  const injected = typeof opts.fetch === 'function';
  const ctx = { fetch: injected ? opts.fetch : globalThis.fetch, lookup: opts.lookup ?? (injected ? null : dns.lookup) };
  const u = parseUrl(url);
  if (!u) return { via: 'error', error: `not a URL: ${url}`, terminal: true };
  try {
    const r = route(u);
    const d = r?.ats === 'greenhouse' ? await viaGreenhouse(r, ctx)
      : r?.ats === 'ashby' ? await viaAshby(r, ctx)
      : r?.ats === 'lever' ? await viaLever(r, ctx)
      : r?.ats === 'workable' ? await viaWorkable(r, ctx)
      : r?.ats === 'recruitee' ? await viaRecruitee(r, ctx)
      : await viaPage(url, ctx);
    if (typeof d.text === 'string') d.text = capText(d.text);
    return d;
  } catch (e) {
    return { via: 'error', error: e.message, ...(e.status ? { status: e.status } : {}), terminal: !!e.terminal };
  }
}

// --- page titles of search results / job aggregators ------------------------------------------------------------
const trim = s => String(s ?? '').trim();
const parsed = (title, company, location = '', rule = 'none') => ({ title: trim(title), company: trim(company), location: trim(location), rule });
const words = s => trim(s).split(/\s+/).filter(Boolean).length;
// Rules that guess from punctuation alone; a caller with better evidence (an ATS slug, JSON-LD) should prefer that.
export const HEURISTIC_RULES = new Set(['colon', 'at', 'dash', 'none']);

/**
 * parseSearchTitleRule(title, isTitle) -> { company, title, location, rule }: parseSearchTitle plus the name of the
 * rule that matched, so a caller can tell a site-specific format from a punctuation guess (HEURISTIC_RULES).
 */
export function parseSearchTitleRule(raw, isTitle = () => false) {
  const title = String(raw ?? '').replace(/\s+/g, ' ').trim();   // <title> often carries newlines and indentation
  let m;
  if ((m = title.match(/^Job Application for (.+?) at (.+)$/i))) return parsed(m[1], m[2], '', 'greenhouse');
  if ((m = title.match(/^(.+?)\s+at\s+(.+?)\s+in\s+(.+?)\s*\|\s*JobFluent$/i))) return parsed(m[1], m[2], m[3], 'jobfluent');
  if ((m = title.match(/^(.+?)\s+at\s+(.+?)\s*\|\s*Y Combinator's Work at a Startup$/i))) return parsed(m[1], m[2], '', 'yc');
  if ((m = title.match(/^(.+?)\s+at\s+(.+?)(?:\s*•\s*(.+?))?\s*\|\s*Wellfound\b.*$/i))) return parsed(m[1], m[2], m[3], 'wellfound');
  if ((m = title.match(/^(.+?)\s+hiring\s+(.+?)(?:\s*•\s*(.+?))?\s*\|\s*Himalayas$/i))) return parsed(m[2], m[1], m[3], 'himalayas');
  if ((m = title.match(/^\[Hiring\]\s*(.+?)\s*@\s*(.+)$/i))) return parsed(m[1], m[2], '', 'remotive');
  const dash = title.includes(' - ');
  // "Co: Title" (We Work Remotely), but only when the evidence says so: "Acme - Product Manager: Platform" and
  // "Product Manager: Payments at Acme" are a title with a colon in it.
  if ((m = title.match(/^([^:]+):\s*(.+)$/))) {
    const [, left, right] = m;
    if ((isTitle(right) && !isTitle(left)) || (!dash && words(left) <= 4 && !/\sat\s/i.test(right) && !isTitle(left))) return parsed(right, left, '', 'colon');
  }
  // "Title at Company" without a site suffix (Wellfound and others, as search results show them).
  if ((m = title.match(/^(.+)\s+at\s+(.+)$/i)) && ((!dash && !title.includes(' | ')) || isTitle(m[1]))) return parsed(m[1], m[2], '', 'at');
  if (dash) {
    const parts = title.split(' - ').map(trim);
    if (parts.length > 2) {
      const tail = parts.slice(1).join(' - '), head = parts.slice(0, -1).join(' - ');
      if (isTitle(tail) && !isTitle(head)) return parsed(tail, parts[0], '', 'dash');
      return parsed(head, parts[parts.length - 1], '', 'dash');   // also the default: "Title - More - Co" (Workable)
    }
    const [a, b] = parts;
    if (isTitle(a) && !isTitle(b)) return parsed(a, b, '', 'dash');
    if (isTitle(b) && !isTitle(a)) return parsed(b, a, '', 'dash');
    // No signal either way: assume "Co - Title" (Lever). Sites that use "Title - Co" come out swapped here unless the
    // caller passes isTitle (drop-dir does, with the title it fetched) or has a better company source.
    return parsed(b, a, '', 'dash');
  }
  return parsed(title, '');
}

/**
 * parseSearchTitle(title, isTitle) -> { company, title, location }
 * isTitle(candidateHalf) tells which half of an ambiguous "Co - X" / "X - Co" title is the job title
 * (the caller usually knows the real title already, from fetchDetail); it is optional.
 */
export function parseSearchTitle(raw, isTitle) {
  const { company, title, location } = parseSearchTitleRule(raw, isTitle);
  return { title, company, location };
}

/** Search/listing pages are lists of jobs, not one job. No generic /jobs/ rule: jobfluent uses /jobs/<slug> for real postings. */
export function isListingPage(url, title) {
  const u = parseUrl(url);
  const host = u ? u.hostname.toLowerCase() : '', path = u ? u.pathname : '';
  const urlLooksLikeListing = /\/jobs-[a-z0-9-]+\//i.test(path)
    || (/(^|\.)(michaelpage|pagepersonnel)\./.test(host) && /\/jobs\//i.test(path))
    || (/indeed\./.test(host) && /^\/jobs\b/i.test(path))
    || (/linkedin\./.test(host) && /\/jobs\/(search|collections)/i.test(path))
    || (/glassdoor\./.test(host) && /-jobs-srch/i.test(path));
  const titleLooksLikeListing = /\bjobs?\s+(for|in)\b|ofertas de empleo|\bempleos?\b|\bvacantes\b|job openings/i.test(String(title || '').replace(/\s+/g, ' '));
  return urlLooksLikeListing || titleLooksLikeListing;
}
