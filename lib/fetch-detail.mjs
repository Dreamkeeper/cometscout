// Full job text from a URL: known ATS APIs first (richer, structured), the page itself otherwise.
// fetchDetail(url) -> { via, title, location, text, companyHint } | { via, unavailable } | { via: 'error', error }
// Also: parseSearchTitle (company/title/location out of a search result's page title) and companyFromUrl
// (the board slug of a known ATS, title-cased), used by sources that only have a title and a link.
import { htmlText } from './queue.mjs';

const UA = { 'User-Agent': 'jobpilot/0.1', 'Accept-Language': 'en-US,en;q=0.9' };
const timeout = () => AbortSignal.timeout(30000);
const titleCase = s => String(s || '').replace(/[-_]+/g, ' ').trim().replace(/\b\p{L}/gu, c => c.toUpperCase());
const unescapeHtml = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const joinNonEmpty = (parts, sep = ', ') => parts.filter(Boolean).join(sep);

function parseUrl(url) { try { return new URL(url); } catch { return null; } }

// --- known ATS routing: hostname + path -> { ats, ...captures } ------------------------------------------------
function route(u) {
  const host = u.hostname.toLowerCase(), path = u.pathname;
  let m;
  if (/^(job-boards|boards)(\.eu)?\.greenhouse\.io$/.test(host) && (m = path.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/)))
    return { ats: 'greenhouse', board: m[1], id: m[2] };
  if (host === 'jobs.ashbyhq.com' && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})\/?$/i)))
    return { ats: 'ashby', org: m[1], id: m[2] };
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && (m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})\/?$/i)))
    return { ats: 'lever', eu: /\.eu\./.test(host), co: m[1], id: m[2] };
  if (host === 'apply.workable.com' && (m = path.match(/^\/([^/]+)\/j\/([A-Za-z0-9]+)\/?$/)))
    return { ats: 'workable', acct: m[1], code: m[2] };
  if (/\.recruitee\.com$/.test(host) && (m = path.match(/^\/o\/([^/]+)\/?$/)))
    return { ats: 'recruitee', co: host.split('.')[0], slug: m[1] };
  return null;
}

/** The board/company slug of a known ATS URL, title-cased. null for anything else. */
export function companyFromUrl(url) {
  const u = parseUrl(url); if (!u) return null;
  const r = route(u); if (!r) return null;
  return titleCase(r.ats === 'greenhouse' ? r.board : r.ats === 'ashby' ? r.org : r.ats === 'lever' ? r.co : r.ats === 'workable' ? r.acct : r.co);
}

const GONE = { 404: 1, 410: 1 };

async function viaGreenhouse(r, fetchFn) {
  const res = await fetchFn(`https://boards-api.greenhouse.io/v1/boards/${r.board}/jobs/${r.id}?content=true`, { signal: timeout(), headers: UA });
  if (GONE[res.status]) return { via: 'greenhouse', unavailable: 'posting gone' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { via: 'greenhouse', title: j.title, location: j.location?.name || '', text: htmlText(unescapeHtml(j.content)) };
}

async function viaAshby(r, fetchFn) {
  const res = await fetchFn(`https://api.ashbyhq.com/posting-api/job-board/${r.org}?includeCompensation=true`, { signal: timeout(), headers: UA });
  if (GONE[res.status]) return { via: 'ashby', unavailable: 'posting gone' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const job = (j.jobs || []).find(x => x.id === r.id || (x.jobUrl || '').includes(r.id));
  if (!job) return { via: 'ashby', unavailable: 'posting gone' };
  return { via: 'ashby', title: job.title, location: joinNonEmpty([job.location, job.workplaceType, job.isRemote ? 'remote' : ''], '; '),
    text: job.descriptionPlain || htmlText(job.descriptionHtml), companyHint: j.organizationName || undefined };
}

async function viaLever(r, fetchFn) {
  const res = await fetchFn(`https://api${r.eu ? '.eu' : ''}.lever.co/v0/postings/${r.co}/${r.id}?mode=json`, { signal: timeout(), headers: UA });
  if (GONE[res.status]) return { via: 'lever', unavailable: 'posting gone' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return { via: 'lever', title: j.text, location: joinNonEmpty([j.categories?.location, j.workplaceType], '; '),
    text: joinNonEmpty([j.descriptionPlain, ...(j.lists || []).map(l => `${l.text}\n${htmlText(l.content)}`), j.additionalPlain], '\n\n') };
}

async function viaWorkable(r, fetchFn) {
  const res = await fetchFn(`https://apply.workable.com/api/v2/accounts/${r.acct}/jobs/${r.code}`, { signal: timeout(), headers: UA });
  if (GONE[res.status]) return { via: 'workable', unavailable: 'posting gone' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  const loc = j.location || {};
  return { via: 'workable', title: j.title, location: joinNonEmpty([loc.city, loc.region, loc.country], ', ') + (loc.telecommuting ? ' (remote)' : ''),
    text: joinNonEmpty([htmlText(j.description), htmlText(j.requirements), htmlText(j.benefits)], '\n\n') };
}

async function viaRecruitee(r, fetchFn) {
  const res = await fetchFn(`https://${r.co}.recruitee.com/api/offers/${r.slug}`, { signal: timeout(), headers: UA });
  if (GONE[res.status]) return { via: 'recruitee', unavailable: 'posting gone' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = (await res.json()).offer || {};
  return { via: 'recruitee', title: j.title, location: joinNonEmpty([j.city, j.country], ', ') + (j.remote ? ' (remote)' : ''),
    text: joinNonEmpty([htmlText(j.description), htmlText(j.requirements_description)], '\n\n') };
}

// --- a plain page: JSON-LD JobPosting first, else visible text (must be more than a stub) -----------------------
function findJobPosting(html) {
  for (const [, raw] of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(raw); } catch { continue; }
    for (const item of Array.isArray(data) ? data : Array.isArray(data['@graph']) ? data['@graph'] : [data]) {
      const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
      if (types.includes('JobPosting')) return item;
    }
  }
  return null;
}
function jsonLdLocation(jp) {
  const locs = Array.isArray(jp.jobLocation) ? jp.jobLocation : jp.jobLocation ? [jp.jobLocation] : [];
  const parts = locs.map(l => joinNonEmpty([(l.address || l).addressLocality, (l.address || l).addressRegion, (l.address || l).addressCountry])).filter(Boolean);
  return parts.length ? parts.join(' / ') : jp.applicantLocationRequirements ? 'Remote' : '';
}

async function viaPage(url, fetchFn) {
  const res = await fetchFn(url, { signal: timeout(), headers: UA });
  if (GONE[res.status]) return { via: 'page', unavailable: 'posting gone' };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const jp = findJobPosting(html);
  if (jp) return { via: 'page', title: jp.title, location: jsonLdLocation(jp), text: htmlText(jp.description), companyHint: jp.hiringOrganization?.name || undefined };
  const title = htmlText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const text = htmlText(html);
  if (text.length <= 600) return { via: 'page', unavailable: 'too little text to read' };
  return { via: 'page', title, location: '', text };
}

/** fetchDetail(url) -> { via, title, location, text, companyHint } | { via, unavailable } | { via: 'error', error } */
export async function fetchDetail(url, { fetch: fetchFn = globalThis.fetch } = {}) {
  const u = parseUrl(url);
  if (!u) return { via: 'error', error: `not a URL: ${url}` };
  try {
    const r = route(u);
    if (r?.ats === 'greenhouse') return await viaGreenhouse(r, fetchFn);
    if (r?.ats === 'ashby') return await viaAshby(r, fetchFn);
    if (r?.ats === 'lever') return await viaLever(r, fetchFn);
    if (r?.ats === 'workable') return await viaWorkable(r, fetchFn);
    if (r?.ats === 'recruitee') return await viaRecruitee(r, fetchFn);
    return await viaPage(url, fetchFn);
  } catch (e) {
    return { via: 'error', error: e.message };
  }
}

// --- page titles of search results / job aggregators ------------------------------------------------------------
const trim = s => String(s ?? '').trim();
const parsed = (title, company, location = '') => ({ title: trim(title), company: trim(company), location: trim(location) });

/**
 * parseSearchTitle(title, isTitle) -> { company, title, location }
 * isTitle(candidateHalf) tells which half of an ambiguous "Co - X" / "X - Co" title is the job title
 * (the caller usually knows the real title already, from fetchDetail); it is optional.
 */
export function parseSearchTitle(raw, isTitle = () => false) {
  const title = trim(raw);
  let m;
  if ((m = title.match(/^Job Application for (.+?) at (.+)$/i))) return parsed(m[1], m[2]);
  if ((m = title.match(/^(.+?)\s+at\s+(.+?)\s+in\s+(.+?)\s*\|\s*JobFluent$/i))) return parsed(m[1], m[2], m[3]);
  if ((m = title.match(/^(.+?)\s+at\s+(.+?)\s*\|\s*Y Combinator's Work at a Startup$/i))) return parsed(m[1], m[2]);
  if ((m = title.match(/^(.+?)\s+hiring\s+(.+?)\s*•\s*(.+?)\s*\|\s*Himalayas$/i))) return parsed(m[2], m[1], m[3]);
  if ((m = title.match(/^\[Hiring\]\s*(.+?)\s*@\s*(.+)$/i))) return parsed(m[1], m[2]);
  if ((m = title.match(/^([^:]+):\s*(.+)$/))) return parsed(m[2], m[1]);
  if (title.includes(' - ')) {
    const parts = title.split(' - ').map(trim);
    if (parts.length > 2) return parsed(parts.slice(0, -1).join(' - '), parts[parts.length - 1]);
    const [a, b] = parts;
    if (isTitle(a) && !isTitle(b)) return parsed(a, b);
    if (isTitle(b) && !isTitle(a)) return parsed(b, a);
    return parsed(b, a);   // no signal either way: assume "Co - Title"
  }
  return parsed(title, '');
}

/** Search/listing pages are lists of jobs, not one job. */
export function isListingPage(url, title) {
  const u = parseUrl(url);
  const host = u ? u.hostname.toLowerCase() : '', path = u ? u.pathname : '';
  const urlLooksLikeListing = /\/jobs-[a-z0-9-]+\//i.test(path)
    || (/indeed\./.test(host) && /^\/jobs\b/i.test(path))
    || (/linkedin\./.test(host) && /\/jobs\/(search|collections)/i.test(path))
    || (/glassdoor\./.test(host) && /-jobs-srch/i.test(path));
  const titleLooksLikeListing = /\bjobs?\s+(for|in)\b|ofertas de empleo|\bvacantes\b|job openings/i.test(title || '');
  return urlLooksLikeListing || titleLooksLikeListing;
}
