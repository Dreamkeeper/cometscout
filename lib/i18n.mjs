// Labels for what jobpilot itself writes to the user: the digest, the picks block, verdict labels, pack messages in
// Telegram and the scorecard's Telegram text. settings.locale picks the table ("en" by default, or "ru").
// Model output (rationales, actions, form answers) is never translated. {name} is replaced with vars.name.
import { SETTINGS } from './config.mjs';

export const LABELS = {
  en: {
    'verdict.strong-fit': 'Strong fit', 'verdict.investable-stretch': 'Investable stretch', 'verdict.long-shot': 'Long shot',
    'verdict.weak-fit': 'Weak fit', 'verdict.gate-reject': 'Gate', 'verdict.unreadable': 'No job text',
    'picks.header': '🎯 Apply today ({n}; {open} open in the pipeline)',
    'picks.via': 'via {source}',
    'picks.how': 'How:',
    'picks.none': 'no picks ({open} open)',
    'digest.decoded': '{name}: {n} decoded {date}',
    'digest.dry_run': ' (dry run)',
    'digest.worth': 'Worth applying ({n})',
    'digest.fact_check': 'Fact check:',
    'digest.held': 'Held ({n})',
    'digest.why_held': 'Why held:',
    'digest.rejected': 'Rejected ({n})',
    'digest.weak_fit': 'weak fit',
    'digest.failed': 'Failed ({n}), will retry: {files}',
    'digest.gave_up': 'Gave up after {tries} failed tries ({n}), moved to rejected/: {files}',
    'digest.waiting': 'Waiting ({n}): decoder.cap {cap} reached, the rest are decoded next run.',
    'pack.header': '📎 Application pack: {company}, {role}',
    'pack.check': 'Check before sending:',
    'pack.own_words': ' (your words)',
    'pack.answers': 'Form answers:',
    'pack.no_questions': 'No form questions beyond personal data.',
    'pack.form_unreadable': 'Form not readable: open the link.',
    'pack.cover_letter': 'Cover letter (paste as text):',
    'report.header': 'Sources, last {days} days',
    'report.line': '{source}: {queued} queued, {worth} worth applying, {only} only here, {applied} applied',
    'report.price': '{price} a month',
    'report.per_only': '{price} per only-here role',
    'report.no_only': 'no only-here role',
    'report.renews': 'renews {date}',
    'report.not_feed': '{source}: {price} a month, not a job feed',
  },
  ru: {
    'verdict.strong-fit': 'Сильное совпадение', 'verdict.investable-stretch': 'Стоит попробовать', 'verdict.long-shot': 'Маловероятно',
    'verdict.weak-fit': 'Слабое совпадение', 'verdict.gate-reject': 'Фильтр', 'verdict.unreadable': 'Нет текста вакансии',
    'picks.header': '🎯 Откликнуться сегодня ({n}; всего открыто: {open})',
    'picks.via': 'источник: {source}',
    'picks.how': 'Как:',
    'picks.none': 'выбора на сегодня нет (открыто: {open})',
    'digest.decoded': '{name}: разобрано {n}, {date}',
    'digest.dry_run': ' (пробный запуск)',
    'digest.worth': 'Стоит откликнуться ({n})',
    'digest.fact_check': 'Проверка фактов:',
    'digest.held': 'Отложено ({n})',
    'digest.why_held': 'Почему отложено:',
    'digest.rejected': 'Отсеяно ({n})',
    'digest.weak_fit': 'слабое совпадение',
    'digest.failed': 'Ошибка разбора ({n}), повторим: {files}',
    'digest.gave_up': 'Не удалось разобрать за {tries} попыток ({n}), перенесено в rejected/: {files}',
    'digest.waiting': 'Ждут ({n}): достигнут лимит decoder.cap {cap}, остальные разберём в следующий запуск.',
    'pack.header': '📎 Пакет для отклика: {company}, {role}',
    'pack.check': 'Проверьте перед отправкой:',
    'pack.own_words': ' (ваши слова)',
    'pack.answers': 'Ответы для формы:',
    'pack.no_questions': 'В форме нет вопросов, кроме личных данных.',
    'pack.form_unreadable': 'Форму не удалось прочитать: откройте ссылку.',
    'pack.cover_letter': 'Сопроводительное письмо (вставьте текстом):',
    'report.header': 'Источники, окно {days} дн.',
    'report.line': '{source}: в очереди {queued}, стоит откликнуться {worth}, только здесь {only}, откликов {applied}',
    'report.price': '{price} в месяц',
    'report.per_only': '{price} за вакансию только отсюда',
    'report.no_only': 'вакансий только отсюда нет',
    'report.renews': 'продление {date}',
    'report.not_feed': '{source}: {price} в месяц, не источник вакансий',
  },
};
export const LOCALES = Object.keys(LABELS);
export const DEFAULT_LOCALE = 'en';
export const localeOk = (l = SETTINGS.locale) => !l || LOCALES.includes(l);

/** A translate function for one locale; an unknown locale or a missing key falls back to English. */
export function translator(locale = SETTINGS.locale || DEFAULT_LOCALE) {
  const table = LABELS[locale] || LABELS[DEFAULT_LOCALE];
  return (key, vars = {}) => String(table[key] ?? LABELS[DEFAULT_LOCALE][key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}
