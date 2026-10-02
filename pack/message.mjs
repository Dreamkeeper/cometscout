// The Telegram text for a built pack, kept apart from pack.mjs (which runs when imported) so it can be tested.
import { translator } from '../lib/i18n.mjs';

// Headings in settings.locale (lib/i18n.mjs), model text as written.
export function packMessage(r, t = translator()) {
  const head = [t('pack.header', { company: r.fm.company, role: r.fm.role }), r.fm.url, '', ...(r.flags.length ? [t('pack.check'), ...r.flags.map(x => `• ${x}`), ''] : [])];
  const ans = r.answers.map(a => `▸ ${a.field}${a.own_words ? t('pack.own_words') : ''}\n\n${a.answer}`);
  return [...head, ...(ans.length ? [t('pack.answers'), '', ans.join('\n\n')] : [r.form ? t('pack.no_questions') : t('pack.form_unreadable')]), ...(r.clNeed === 'text' && r.clText ? ['', t('pack.cover_letter'), '', r.clText] : [])].join('\n');
}
