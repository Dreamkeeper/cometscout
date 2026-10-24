// Parsers for the public job boards sources/ats-boards.mjs reads that are not plain JSON lists: Personio's XML feed and
// Gem's job board API. Pure functions (no network), so the tests feed them synthetic fixtures. Each returns the jobs
// as sources/ats-boards.mjs writes them: { role, url, location, places, posted, text }.
import { decodeEntities, htmlText } from './queue.mjs';

// ---------- Personio: https://<company>.jobs.personio.de/xml (also .com) ----------
// <workzag-jobs><position> with id, subcompany, office, additionalOffices/office, department, recruitingCategory, name,
// jobDescriptions/jobDescription (name, value: HTML in CDATA), employmentType, seniority, schedule, keywords,
// occupation, occupationCategory, createdAt. There is no remote field: an office or keyword such as "Remote" or
// "Home office" marks the job as remote. The job page is https://<host>/job/<id>.
const REMOTE = /\b(remote|home[\s-]?office|work from home|anywhere|mobile work)\b/i;
const cdata = s => String(s ?? '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
const inner = (xml, tag) => { const m = String(xml).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`)); return m ? m[1] : null; };
const all = (xml, tag) => [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map(m => m[1]);
const text = s => decodeEntities(cdata(s ?? '')).replace(/\s+/g, ' ').trim();

/** The hosts to try for a Personio board: "acme" is acme.jobs.personio.de, then .com; a full host is used as it is. */
export const personioHosts = board => (String(board).includes('.') ? [String(board).replace(/^https?:\/\//, '').replace(/\/.*$/, '')] : [`${board}.jobs.personio.de`, `${board}.jobs.personio.com`]);

/** Personio's XML feed from `host` as jobs; a position without an id or a name is skipped. */
export function parsePersonio(xml, host) {
  const out = [];
  for (const pos of all(xml, 'position')) {
    const descBlock = inner(pos, 'jobDescriptions') || '';
    const top = pos.replace(/<jobDescriptions(?:\s[^>]*)?>[\s\S]*?<\/jobDescriptions>/, '').replace(/<additionalOffices(?:\s[^>]*)?>[\s\S]*?<\/additionalOffices>/, '');
    const id = text(inner(top, 'id')), role = text(inner(top, 'name'));
    if (!id || !role) continue;
    const offices = [text(inner(top, 'office')), ...all(inner(pos, 'additionalOffices') || '', 'office').map(text)].filter(Boolean);
    const keywords = text(inner(top, 'keywords'));
    const remote = [...offices, keywords].some(x => REMOTE.test(x));
    const work = [text(inner(top, 'schedule')), remote ? 'remote' : ''].filter(Boolean).join('; ');
    const sections = all(descBlock, 'jobDescription').map(d => { const n = text(inner(d, 'name')), v = htmlText(cdata(inner(d, 'value') || '')); return [n, v].filter(Boolean).join('\n'); }).filter(Boolean);
    const facts = [['Department', text(inner(top, 'department'))], ['Employment', text(inner(top, 'employmentType'))], ['Seniority', text(inner(top, 'seniority'))], ['Experience', text(inner(top, 'yearsOfExperience'))]]
      .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    const places = (offices.length ? offices : remote ? ['Remote'] : []).map(o => [o, remote ? 'remote' : ''].filter(Boolean).join('; '));
    out.push({ role, url: `https://${host}/job/${encodeURIComponent(id)}`, location: [offices.join(' | '), work].filter(Boolean).join('; '), places,
      posted: text(inner(top, 'createdAt')), text: [...sections, facts.join('\n')].filter(Boolean).join('\n\n') });
  }
  return out;
}

// ---------- Gem: https://api.gem.com/job_board/v0/<board>/job_posts (public, no key) ----------
// A list of posts: title, absolute_url, location { name }, location_type (remote, hybrid, in_office ...), offices
// [{ name, location { name } }], content (HTML), content_plain, first_published_at, created_at, updated_at.
/** Gem's job board answer as jobs; a post without a title or a link is skipped. */
export function parseGem(list) {
  return (Array.isArray(list) ? list : []).filter(x => x && x.title && x.absolute_url).map(x => {
    const places = [x.location?.name, ...(Array.isArray(x.offices) ? x.offices : []).map(o => o?.location?.name || o?.name)].map(p => String(p || '').trim()).filter(Boolean);
    const unique = [...new Set(places)], work = String(x.location_type || '').replace(/_/g, ' ').trim();
    return { role: String(x.title).trim(), url: x.absolute_url, location: [unique.join(' | '), work].filter(Boolean).join('; '), places: unique.map(p => [p, work].filter(Boolean).join('; ')),
      posted: x.first_published_at || x.created_at || '', text: String(x.content_plain || '').trim() || htmlText(x.content) };
  });
}
