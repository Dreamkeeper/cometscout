// Form answers the pack must not draft: a salary expectation. The model is told to leave it blank, and this makes sure
// it is: the pay floor is a minimum, never the figure to ask for, so the answer stays empty and its note gives the floor
// from the profile and the posting's range (if it states one) for the candidate to decide. Kept apart from pack.mjs
// (which runs when imported) so it can be tested.

const PAY = /salary|compensation|remuneration|\bpay\b|\bwage|gehalt|verg(?:ü|ue)tung|зарплат|заработн|оклад|доход/i;
const ASK = /expect|desired|requirement|range|asking|target|wish|how much|ожида|желаем|vorstellung|wunsch/i;
/** True for a form field that asks for a salary expectation ("Salary expectations", "Desired compensation (EUR)"). */
export const isSalaryField = field => { const f = String(field || ''); return PAY.test(f) && (ASK.test(f) || f.length <= 40); };

/** The pay floor as profile.md states it ("Pay floor: EUR 60,000 gross a year ..."), or null. */
export function payFloor(facts) {
  for (const l of String(facts || '').split(/\r?\n/)) {
    const m = l.match(/(?:pay|salary|compensation)\s+floor\s*:\s*(.+)$|minimum\s+(?:pay|salary)\s*:\s*(.+)$/i);
    if (m) return (m[1] || m[2]).trim().replace(/\.\s.*$/, '').replace(/\.$/, '');
  }
  return null;
}

/**
 * The answers with every salary-expectation answer emptied and explained: { answers, flags }. floor: payFloor of the
 * profile; range: the posting's salary as the job file states it (front matter salary), or null.
 */
export function holdSalary(answers, { floor = null, range = null } = {}) {
  const flags = [];
  const out = (answers || []).map(a => {
    if (!isSalaryField(a?.field)) return a;
    const note = `Left blank for you to decide. Your floor (profile): ${floor || 'not in your profile'}. The posting: ${range ? String(range).trim() : 'states no range'}.`;
    flags.push(`Salary: "${a.field}" is left blank for you to decide (your floor is a minimum, not the figure to ask for).`);
    return { ...a, answer: '', own_words: false, note };
  });
  return { answers: out, flags };
}
