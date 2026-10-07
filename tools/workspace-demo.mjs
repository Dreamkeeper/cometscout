#!/usr/bin/env node
// Demo data for the workspace: a data folder with synthetic decodes, today's picks, an application history, two
// packs (CV PDFs built from profile.example/cv-library.json) for the example candidate and a label set "demo" for
// /label?set=demo. Every company, job and answer is invented. It never touches your own data/: it writes only into the folder you name, and only if that
// folder is empty (or with --force).
//   node tools/workspace-demo.mjs --out <folder> [--force]
//   then: COMETSCOUT_DATA=<folder> node cli.mjs serve        (PowerShell: $env:COMETSCOUT_DATA="<folder>"; node cli.mjs serve)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textPdf } from './text-pdf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.resolve(HERE, '..');

const day = (offset, from = new Date()) => { const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())); d.setUTCDate(d.getUTCDate() + offset); return d.toISOString().slice(0, 10); };
const q = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// The example candidate's week: ago is how many days back the job was decoded; later puts it off that many days.
const JOBS = [
  { key: 'voltaic', company: 'Voltaic Grid', role: 'Senior Product Manager, Grid Analytics', location: 'Remote, Europe', source: 'ats_boards', band: 1, url: 'https://jobs.example/voltaic-grid/senior-pm-grid-analytics',
    verdict: 'strong-fit', priority: 1, ago: 0,
    rationale: 'Grid analytics for distribution operators is the same problem Alex took from pilot to 40 paying utilities at Brightgrid; remote in Europe matches; no language gate.',
    fit: ['Grid-analytics product from pilot to 40 utilities', 'API and integrations depth', 'Remote in Europe, EU citizen'], gaps: ['Asks for experience selling to transmission operators, Alex sold to distributors'],
    action: 'Apply through the Greenhouse form today; lead with the Brightgrid pilot-to-revenue story.',
    text: 'Voltaic Grid builds forecasting and grid-analytics software for European distribution system operators. We are a team of 90 across Rotterdam, Valencia and remote.\n\nWhat you will do\n- Own the analytics product line used by 30 operators: discovery, roadmap, pricing input and launch.\n- Work daily with data engineers and the forecasting team on meter-data pipelines and APIs.\n- Talk to grid planners every week and turn what you hear into clear problem statements.\n\nWhat we look for\n- 5+ years of B2B product management, ideally in energy or another regulated, operations-heavy market.\n- Comfort with APIs, data products and technical trade-offs.\n- Experience with transmission or distribution operators is a plus.\n- Fluent English; Spanish or Dutch is a bonus.\n\nRemote within Europe, with two team weeks a year. Salary EUR 70,000 to 85,000.' },
  { key: 'cargolane', company: 'Cargolane', role: 'Product Owner, Carrier Integrations', location: 'Valencia, Spain (Hybrid)', source: 'rtj', band: 2, url: 'https://jobs.example/cargolane/po-carrier-integrations',
    verdict: 'strong-fit', priority: 2, ago: 1,
    rationale: 'Carrier integrations are exactly what Alex owned at Parcelpoint for 1,200 shippers; hybrid in Valencia is one of the two accepted cities.',
    fit: ['Owned carrier integrations at Parcelpoint', 'Hybrid in Valencia', 'Spanish native for the local team'], gaps: [],
    action: 'Apply on the Ashby form; mention the integration-health dashboard and the shipper count.',
    text: 'Cargolane connects mid-size European shippers with 140 parcel and freight carriers through one API.\n\nThe role\n- Own the carrier-integrations backlog: onboarding new carriers, label and tracking APIs, integration health.\n- Work with two engineering squads in Valencia; three office days a week.\n- Measure success by time to onboard a carrier and failed-label rate.\n\nYou bring\n- 4+ years as a product owner or PM on API or integration products.\n- Logistics or e-commerce experience.\n- English and Spanish.\n\nPay EUR 58,000 to 66,000 plus a yearly bonus.' },
  { key: 'meshwork', company: 'Meshwork Systems', role: 'Senior PM, IoT Device Platform', location: 'Remote (EU)', source: 'linkedin_alerts', band: 2, url: 'https://jobs.example/meshwork/senior-pm-iot-platform',
    verdict: 'investable-stretch', priority: 2, ago: 2,
    rationale: 'IoT data platform fits the connected-devices background, but the role leans on firmware update tooling, which Alex has not owned. The decode first said Alex owned Parcelpoint\'s platform; the fact rule flags it.',
    fit: ['Connected devices background', 'Remote in the EU'], gaps: ['Firmware over-the-air tooling', 'Hardware certification cycles'], flags: ['whole-platform'],
    action: 'Worth a tailored application if the CV leads with the IoT data work; be precise about the Parcelpoint scope.',
    text: 'Meshwork Systems runs a device platform for 2 million industrial sensors.\n\nYou will own the device lifecycle area: provisioning, over-the-air updates and fleet health. You will work with firmware, cloud and support teams across four time zones.\n\nRequirements: 6+ years in product, at least 2 on IoT or embedded products; experience with OTA update systems; English. Remote within the EU.' },
  { key: 'lumora', company: 'Lumora', role: 'Product Manager, AI Workflows', location: 'Remote, Europe', source: 'drop_dir', band: null, url: 'https://jobs.example/lumora/pm-ai-workflows',
    verdict: 'investable-stretch', priority: 3, ago: 3,
    rationale: 'AI-assisted operations software matches the anomaly-alerts launch; the company is early (25 people) and the domain is new.',
    fit: ['Shipped model-based alerts at Brightgrid', 'Works closely with engineers'], gaps: ['No direct experience with LLM evaluation'],
    action: 'Apply if the pool is thin this week; lead with the AI work section.',
    text: 'Lumora builds AI workflow tools for operations teams in utilities and logistics. 25 people, seed funded.\n\nThe PM will own the workflow builder: discovery with operations managers, evaluation of model output with the ML team, and pricing experiments.\n\nWe want someone who has shipped AI-assisted features into real operations, writes clearly and is happy in an early team. Remote in Europe.' },
  { key: 'tidewater', company: 'Tidewater Energy', role: 'Product Manager, Flexibility Markets', location: 'Madrid, Spain (Hybrid)', source: 'ats_boards', band: 3, url: 'https://jobs.example/tidewater/pm-flexibility',
    verdict: 'strong-fit', priority: 3, ago: 4, later: 3,
    rationale: 'Energy software and hybrid in Madrid fit; flexibility markets are adjacent to grid analytics.',
    fit: ['Energy software', 'Hybrid in Madrid'], gaps: ['Trading-desk users are new'],
    action: 'Apply after the Voltaic Grid application; reuse the energy framing.',
    text: 'Tidewater Energy trades flexibility from batteries and heat pumps on Spanish and Portuguese markets.\n\nAs PM you will own the bidding product used by our trading desk: requirements, roadmap and the API that aggregators use. Hybrid in Madrid, two days a week. English and Spanish.' },
  { key: 'quayside', company: 'Quayside Freight', role: 'Senior Product Manager, Pricing', location: 'Remote, EMEA', source: 'linkedin_alerts', band: 2, url: 'https://jobs.example/quayside/senior-pm-pricing',
    verdict: 'investable-stretch', priority: 3, ago: 5,
    rationale: 'Pricing is a named strength and logistics is a target domain; the role wants a deeper experimentation record than two pricing tests.',
    fit: ['Pricing work in B2B SaaS', 'Logistics domain'], gaps: ['Asks for an experimentation program, Alex ran two pricing experiments'],
    action: 'Apply with the pricing bullets; do not claim an experimentation program.',
    text: 'Quayside Freight is a digital freight forwarder for ocean and road shipments.\n\nOwn pricing and quoting: rate engine inputs, quote conversion, and the experiments that shape them. You will partner with revenue operations and data science.\n\n5+ years in product, pricing experience required. Remote across EMEA.' },
];
const OLD = [
  { dir: 'rejected', company: 'Cargolane', role: 'Data Scientist, Routing', location: 'Valencia, Spain', source: 'rtj', verdict: 'gate-reject (engineering title)', ago: 21 },
  { dir: 'rejected', company: 'Brassica Play', role: 'Product Manager, Sportsbook', location: 'Remote, Europe', source: 'linkedin_alerts', verdict: 'gate-reject (betting)', ago: 9 },
];

const slugify = (norm, s) => { let x = norm(s).replace(/\s+/g, '-'); while (Buffer.byteLength(x) > 60) x = x.slice(0, -1); return x.replace(/-+$/, '') || 'unknown'; };
const fileOf = (norm, j, d) => `${d}--${slugify(norm, j.company)}--${slugify(norm, j.role)}.md`;

function jobFile(j, d) {
  const fm = ['---', `company: ${q(j.company)}`, `role: ${q(j.role)}`, j.url ? `url: ${q(j.url)}` : null, `source: ${q(j.source)}`, `location: ${q(j.location)}`,
    j.band ? `band: ${q(j.band)}` : null, `found: ${d}`, '---'].filter(Boolean);
  const decode = ['## Decode Result', `Decoded ${d} by CometScout (claude/sonnet).`, `verdict: ${j.verdict}`, 'confidence: high', j.priority ? `apply_priority: ${j.priority}` : null,
    `rationale: ${j.rationale || 'Synthetic example.'}`, `fit_signals: ${(j.fit || []).join('; ')}`, `gaps: ${(j.gaps || []).join('; ') || 'none'}`, `action: ${j.action || 'Skip.'}`,
    j.flags?.length ? `fact_flags: ${j.flags.join(', ')}` : null].filter(x => x !== null);
  return [...fm, '', `# ${j.company} - ${j.role}`, '', j.text || 'Synthetic example job text.', '', ...decode, ''].join('\n');
}

/** CV lines from the CV library, as pack/pack.mjs would order them (tagline, summary, experience, skills, education). */
function cvLines(lib, { ai = false } = {}) {
  const pick = list => (list || []).find(x => !!x.ai === ai) || (list || [])[0] || { text: '' };
  const L = [{ text: lib.name, size: 18, bold: true }, { text: lib.contact, size: 9 }, { text: pick(lib.taglines).text, size: 11, bold: true, gap: 8 }, { text: pick(lib.summaries).text, gap: 4 }];
  if (ai && lib.ai_work?.items?.length) { L.push({ text: lib.ai_work.heading || 'HIGHLIGHTS', size: 11, bold: true, gap: 10 }); for (const i of lib.ai_work.items) L.push({ text: `- ${i.lead || ''}${i.text}` }); }
  L.push({ text: 'EXPERIENCE', size: 11, bold: true, gap: 10 });
  for (const e of lib.experience || []) {
    L.push({ text: `${e.company}   ${e.dates}`, bold: true, gap: 6 });
    if (e.blurb) L.push({ text: e.blurb, size: 9 });
    for (const r of e.roles || []) { L.push({ text: r.title, bold: true, gap: 2 }); const groups = new Set(); for (const b of r.bullets || []) { if (b.group && groups.has(b.group)) continue; groups.add(b.group); L.push({ text: `- ${b.text}` }); } }
  }
  if (lib.skills?.length) { L.push({ text: 'SKILLS', size: 11, bold: true, gap: 10 }); for (const s of lib.skills) L.push({ text: `${s.label}: ${s.text}` }); }
  const edu = Array.isArray(lib.education) ? lib.education : lib.education ? [lib.education] : [];
  if (edu.length) { L.push({ text: 'EDUCATION', size: 11, bold: true, gap: 10 }); for (const e of edu) L.push({ text: [e.left, e.right].filter(Boolean).join('   ') }); }
  return L;
}

const PACKS = {
  voltaic: {
    positioning: 'Grid-analytics product taken from pilot to 40 paying utilities, API depth, energy domain',
    cover_letter: 'text', ai: false,
    flags: ['Answer "Why Voltaic Grid?": check the operator count (30) against the posting before sending.', 'Answer "Why Voltaic Grid?" lint warning: fluff ("passionate", Empty words; say what was done instead.).'],
    answers: [
      { field: 'Why Voltaic Grid?', own_words: true, answer: 'I am passionate about grid data. I spent three years taking a grid-analytics product from a pilot with two distributors to 40 paying utilities. Your forecasting work for distribution operators is the next step of that problem, and I would like to work on it with a team that talks to grid planners every week.' },
      { field: 'Describe a product you took from pilot to revenue.', answer: 'At Brightgrid I led the analytics product from a two-utility pilot to 40 paying customers. I ran discovery with grid planners, cut the onboarding from eight weeks to three with an import API, and set the first pricing tiers with sales.' },
      { field: 'Notice period', answer: 'Four weeks.', note: 'From the profile: start with 4 weeks\' notice.' },
    ],
    cl: 'Dear Voltaic Grid team,\n\nI have spent the last three years on grid analytics for regional distributors at Brightgrid, from a pilot with two utilities to 40 paying customers. The role you describe, owning analytics for 30 operators with the forecasting team, is the work I know best and want to keep doing.\n\nI work closest to engineers and the people who use the product, and I judge results by adoption and revenue. I would be glad to talk about how that could help your next releases.\n\nBest regards,\nAlex Rivera',
    lint: { cv: { errors: [], warns: [] }, cover_letter: { errors: [], warns: [] }, answers: [{ field: 'Why Voltaic Grid?', errors: [], warns: [{ id: 'fluff', match: 'passionate', why: 'Empty words; say what was done instead.' }] }] },
  },
  cargolane: {
    positioning: 'Carrier integrations owned for 1,200 shippers, integration-health metrics',
    cover_letter: 'no', ai: false, flags: [],
    answers: [
      { field: 'Which carrier APIs have you worked with?', answer: 'At Parcelpoint I owned the carrier-integrations product: label, tracking and rate APIs for the carriers our 1,200 shippers used, plus the integration-health dashboard that cut failed labels.' },
      { field: 'Can you work from our Valencia office three days a week?', answer: 'Yes. I live in Valencia.' },
    ],
    lint: { cv: { errors: [], warns: [] }, cover_letter: { errors: [], warns: [] }, answers: [] },
  },
};

/** Write the demo into `out` (a data folder). Returns { files, picks, packs }. `now` fixes the dates (tests). */
export async function writeDemo(out, { now = new Date(), force = false } = {}) {
  if (fs.existsSync(out) && fs.readdirSync(out).length && !force) throw new Error(`${out} is not empty; choose an empty folder (or add --force to write over the demo files there)`);
  const { norm } = await import('../lib/text.mjs');
  for (const d of ['inbox', 'decoded', 'rejected', 'digests', 'packs', 'state', 'runs']) fs.mkdirSync(path.join(out, d), { recursive: true });
  const lib = JSON.parse(fs.readFileSync(path.join(CODE, 'profile.example', 'cv-library.json'), 'utf8'));
  const today = day(0, now), files = {};
  for (const j of JOBS) { const d = day(-j.ago, now); files[j.key] = fileOf(norm, j, d); fs.writeFileSync(path.join(out, 'decoded', files[j.key]), jobFile(j, d)); }
  for (const j of OLD) { const d = day(-j.ago, now); fs.writeFileSync(path.join(out, j.dir, fileOf(norm, j, d)), jobFile({ ...j, rationale: 'Synthetic example: a hard gate.', action: 'Skip.' }, d)); }
  // Today's picks are the two the evening run chose; Quayside Freight was a pick two days ago.
  const picks = { [files.voltaic]: { shown: 1, last: today }, [files.cargolane]: { shown: 2, last: today }, [files.quayside]: { shown: 1, last: day(-2, now) } };
  fs.writeFileSync(path.join(out, 'state', 'picks.json'), JSON.stringify(picks, null, 1));
  const apps = {
    'manual:voltaic grid|solutions consultant': { company: 'Voltaic Grid', role: 'Solutions Consultant', status: 'rejected', updated: day(-40, now), note: 'role went to an internal candidate',
      events: [{ date: day(-55, now), type: 'applied', source: 'cli' }, { date: day(-40, now), type: 'rejection', source: 'gmail' }] },
    [files.tidewater]: { company: 'Tidewater Energy', role: JOBS.find(j => j.key === 'tidewater').role, events: [{ date: today, type: 'later', until: day(3, now), source: 'workspace' }] },
  };
  fs.writeFileSync(path.join(out, 'state', 'applications.json'), JSON.stringify(apps, null, 1));
  const packsJson = {};
  for (const [key, p] of Object.entries(PACKS)) {
    const j = JOBS.find(x => x.key === key), dir = `${today}--${slugify(norm, j.company)}--${slugify(norm, j.role)}`, abs = path.join(out, 'packs', dir);
    fs.mkdirSync(abs, { recursive: true });
    const base = `Alex Rivera CV - ${j.company} (${j.role.replace(/[\\/:*?"<>|]/g, '-')})`;
    fs.writeFileSync(path.join(abs, `${base}.pdf`), textPdf(cvLines(lib, { ai: p.ai }), { title: base }));
    const md = [`# ${j.company}: ${j.role}`, '', `Link: ${j.url}`, `Built ${today} by CometScout (claude/opus). Form: greenhouse. Cover letter: ${p.cover_letter}.`, '',
      `**CV leads with:** ${p.positioning}`, '', '## Check before sending', ...(p.flags.length ? p.flags.map(f => `- ${f}`) : ['- nothing flagged']), '',
      '## Form answers (drafts)', ...p.answers.flatMap(a => [`### ${a.field}${a.own_words ? ' (rewrite in your own words)' : ''}`, '', a.answer, ...(a.note ? [`_${a.note}_`] : []), '']),
      ...(p.cover_letter === 'text' ? ['## Cover letter (paste as text)', p.cl, ''] : []), '## Lint', 'CV: no lint hits.', '', `Files: ${base}.pdf`].join('\n');
    fs.writeFileSync(path.join(abs, 'answers.md'), md);
    fs.writeFileSync(path.join(abs, 'pack.json'), JSON.stringify({ model: 'opus', built: `${today}T18:20:00.000Z`, form: 'greenhouse', cover_letter: p.cover_letter, pages: 2,
      raw: { positioning: p.positioning }, flags: p.flags, answers: p.answers, lint: p.lint }, null, 2));
    packsJson[files[key]] = { built: today, dir };
  }
  fs.writeFileSync(path.join(out, 'state', 'packs.json'), JSON.stringify(packsJson, null, 2));
  // A label set with every demo job (evals/sets.mjs format: the text only, no verdict), for /label?set=demo.
  const sampled = [];
  for (const d of ['decoded', 'rejected']) for (const f of fs.readdirSync(path.join(out, d)).sort()) {
    const t = fs.readFileSync(path.join(out, d, f), 'utf8'); sampled.push({ file: f, date: f.slice(0, 10), text: t.slice(0, t.indexOf('## Decode Result')).trimEnd() + '\n' });
  }
  const order = sampled.map((j, i) => ({ j, k: (i * 5) % sampled.length })).sort((a, b) => a.k - b.k).map(x => x.j);   // mixed, so the order says nothing about the verdict
  fs.mkdirSync(path.join(out, 'evals', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(out, 'evals', 'demo', 'sample.json'), JSON.stringify({ set: 'demo', created: today, seed: 1, size: order.length, from: null, to: null, include: [], jobs: order }, null, 1) + '\n');
  // A pack as the older pipeline wrote it: "<date>--<company>", answers.md only, not in packs.json.
  const old = `${day(-2, now)}--meshwork-systems`;
  fs.mkdirSync(path.join(out, 'packs', old), { recursive: true });
  fs.writeFileSync(path.join(out, 'packs', old, 'answers.md'), ['# Meshwork Systems: Senior PM, IoT Device Platform', '', '**CV leads with:** Connected-devices data work', '',
    '## Check before sending', '- The posting asks for OTA update experience; the CV does not claim it.', '- Be precise about the Parcelpoint scope (carrier integrations only).', '',
    '## Form answers (drafts)', '### What draws you to device platforms? (rewrite in your own words)', '', 'I have worked on connected devices and their data for seven years, and fleet health is where product decisions show up fastest.', '',
    '### Earliest start date', '', 'Four weeks after an offer.', ''].join('\n'));
  return { files, picks: Object.keys(picks).filter(f => picks[f].last === today), packs: [...Object.values(packsJson).map(p => p.dir), old], labelSet: 'demo' };
}

const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const args = process.argv.slice(2), i = args.indexOf('--out');
  if (i < 0 || !args[i + 1]) { console.log('Usage: node tools/workspace-demo.mjs --out <empty folder> [--force]'); process.exit(1); }
  const out = path.resolve(args[i + 1]);
  try {
    const r = await writeDemo(out, { force: args.includes('--force') });
    console.log(`Demo data in ${out}: ${Object.keys(r.files).length} decodes, ${r.picks.length} picks for today, ${r.packs.length} packs, label set "${r.labelSet}" (open /label?set=${r.labelSet}).`);
    console.log(`Start the workspace on it:\n  COMETSCOUT_DATA="${out}" node cli.mjs serve\n  (PowerShell: $env:COMETSCOUT_DATA="${out}"; node cli.mjs serve)`);
  } catch (e) { console.log(`workspace-demo: ${e.message}`); process.exit(1); }
}
