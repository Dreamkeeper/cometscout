// Form answers the pack must not draft: a salary expectation. The model is told to leave it blank, and this makes sure
// it is: the pay floor is a minimum, never the figure to ask for, so the answer stays empty and its note gives the floor
// from the profile and the posting's range (if it states one) for the candidate to decide. Kept apart from pack.mjs
// (which runs when imported) so it can be tested.

const PAY = /salary|compensation|remuneration|\bpay\b|\bwage|gehalt|verg(?:ü|ue)tung|зарплат|заработн|оклад|доход/i;
const ASK = /expect|desired|requirement|range|asking|target|wish|how much|ожида|желаем|vorstellung|wunsch/i;
// a choice about the pay, not the figure: currency, frequency, gross or net, the kind of contract
const ABOUT = /currency|frequency|period|\btype\b|gross|\bnet\b|format|basis|валют|периодичн|währung/i;
// a field that is the bare word ("Salary", "Gehalt:", "Зарплата (EUR)")
const BARE = /^\s*(salary|gehalt|зарплата)\s*(\([^)]*\))?\s*[:?]?\s*$/i;
/**
 * True for a form field that asks for the salary figure the candidate expects ("Salary expectations", "Desired
 * compensation (EUR)", a bare "Salary"). Never a field with options to choose from (choices: true), and never a field
 * about the pay's currency, frequency or kind ("Compensation currency", "Pay frequency", "Salary type (gross/net)").
 */
export const isSalaryField = (field, { choices = false } = {}) => {
  const f = String(field || '');
  if (choices || ABOUT.test(f) || !PAY.test(f)) return false;
  return ASK.test(f) || BARE.test(f);
};

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
 * profile; range: the posting's salary as the job file states it (front matter salary), or null; choices: the labels
 * of the form's fields that have options (never emptied).
 */
export function holdSalary(answers, { floor = null, range = null, choices = new Set() } = {}) {
  const flags = [];
  const out = (answers || []).map(a => {
    if (!isSalaryField(a?.field, { choices: choices.has(a?.field) })) return a;
    const note = `Left blank for you to decide. Your floor (profile): ${floor || 'not in your profile'}. The posting: ${range ? String(range).trim() : 'states no range'}.`;
    flags.push(`Salary: "${a.field}" is left blank for you to decide (your floor is a minimum, not the figure to ask for).`);
    return { ...a, answer: '', own_words: false, note };
  });
  return { answers: out, flags };
}
