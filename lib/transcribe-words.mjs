// Common words for the transcription glossary (task 23): the glossary built from the user's data takes names, never
// vocabulary, so a word on these lists is never an automatic term, and an automatic term never replaces a word on them.
// COMMON_EN: frequent English words, and the ordinary words CVs and job posts are full of ("product", "manager",
// "hardware"); plurals are found by commonEnglish(). RU_LOANWORDS: everyday Russian loanwords of the same kind
// ("продакт", "менеджер"), next to COMMON_RU in lib/transcribe-merge.mjs. Pure data, no I/O.

export const COMMON_EN = new Set(`
a about above across act action active activity actually add added address after again against age ago agree ahead
air all allow almost alone along already also although always am among amount an analysis analyst analytics and
another answer any anyone anything app apply approach area around art as ask asked asking at available away back bad
balance bank base based basic be became because become been before began begin behind being believe below best better
between big bill bit black blue board body book both box brand break bring brought budget build building built
business but buy by call called came can car card care career carry case cause center central certain challenge
champion champions change channel charge check child choose city class clean clear client close cloud code cold
collect come common community company complete concept concern connect connected connection connectivity consider
contact content continue contract control core cost could country course create created creative culture current
customer customers cut daily data date day deal decide decision deep deliver delivery demand design designer detail
develop developer development device devices did different digital direct direction director discover discovery do
document does doing done door down draw drive during each early easy economy edge effect effort either else employee
employer end energy engineer engineering enough enter entire environment even event ever every everyone everything
example experience expert explain eye face fact factor fail fall family far fast feature features feel few field
figure file final finance financial find fine finish fire firm first fit five focus follow food for force form former
forward found four free friend from front full fund future game general get give global go goal goes good got
government great green ground group grow growth guide had half hand happen hard hardware has have he head health hear
heard heart help her here high him himself his history hold home hope hot hour house how however human idea if image
impact important improve in include including increase industry information inside instead interest international
into investment is issue it item its itself job join just keep key kind know knowledge known large last late later
launch lead leader leadership learn least leave left legal less let letter level library life light like line list
listen little live local long look lose loss lot love low machine made main maintain major make manage management
manager managers many market marketing matter may me mean measure media meet meeting member mention message method
middle might mind minute mobile model modern money month more morning most move much music must my name national
nature near need network never new news next nice night no none nor north not note nothing notice now number object
of off offer office often oh ok okay old on once one only open operation operations opportunity option or order
organization other others our out outside over own owner page paper part partner party pass past pay people per
perform performance perhaps period person personal phone pick picture piece place plan planning platform play player
please point policy political popular position positive possible power practice prepare present president pressure
pretty price pricing prime private probably problem process produce product production products professional program
project projects provide public pull purpose push put quality question quick quickly quite race raise range rate
rather reach read ready real really reason receive recent record red reduce region relationship relocation remain
remember remote report research resource respond response rest result return revenue review right rise risk road
roadmap roadmapping role roles room rule run safe sale sales same save say scale scene school science score screen
search season second section security see seek seem sell send senior sense series serious serve server servers service
services session set seven several shape share she shift ship short should show side sign signal similar simple simply
since single site six size skill skills small smart so social soft software solution solutions some someone something
sometimes son soon sort sound source south space speak special specialist specific speech spend sport staff stage stand
standard star start state statement stay step still stock stop store story strategy street strong structure student
study stuff style subject success successful such suggest summer supply support sure surface system systems table take
talk target task tasks tax team teams tech technical technology tell ten term terms test testing than thank that the
their them themselves then theory there these they thing things think third this those though thought thousand three
through throughout time today together too tool tools top total toward town track trade traditional training travel
treat tree trial true truth try turn two type under understand unit until up update updates upon us use used user users
usually value various very view visa voice wait walk wall want war watch water way we week weight well were west what
whatever when where whether which while white who whole whom whose why wide wife will win window wish with within
without woman word work worker working world worry would write writing wrong yard yeah year yes yet you young your
yourself battery firmware manufacturing supplier suppliers vendor vendors partners hub lab
january february march april june july august september october november december jan feb mar apr jun jul aug sep sept
oct nov dec monday tuesday wednesday thursday friday saturday sunday english spanish german french dutch russian
italian portuguese chinese europe european eu usa uk
`.split(/\s+/).filter(Boolean));

/** True for a frequent English word, also as a plural ("products", "batteries", "boxes"). */
export function commonEnglish(word) {
  const w = String(word || '').toLowerCase();
  if (!/^[a-z]+$/.test(w)) return false;
  if (COMMON_EN.has(w)) return true;
  if (w.length > 3 && w.endsWith('ies') && COMMON_EN.has(`${w.slice(0, -3)}y`)) return true;
  if (w.length > 3 && w.endsWith('es') && COMMON_EN.has(w.slice(0, -2))) return true;
  return w.length > 3 && w.endsWith('s') && COMMON_EN.has(w.slice(0, -1));
}

// Russian loanwords and work words that are ordinary Russian (not names): never replaced by an automatic term.
export const RU_LOANWORDS = new Set(`
продакт продакта продакту продактом продакты продактов проджект проджекта проджекты пиэм пиэма менеджер менеджера
менеджеру менеджером менеджеры менеджеров менеджмент маркетинг маркетолог дизайнер дизайнера аналитик аналитика
аналитики инженер инженера разработчик разработчика тестировщик фича фичи фичу фич релиз релиза релизы спринт спринта
бэклог бэклога дедлайн дедлайна митинг митинга созвон созвона кейс кейса кейсы стартап стартапа стартапы бренд бренда
бренды девайс девайса девайсы гаджет гаджета софт софта хард харда железо приложение приложения сервер сервера серверы
облако облака апдейт апдейта прошивка прошивки контракт контракта контракты оффер оффера офферы резюме вакансия вакансии
интервью собеседование фидбек фидбэк фидбека фидбэка ревью тимлид тимлида команда стратегия бюджет бюджета клиент клиента
пользователь пользователя пользователи продукт продукта продукты продукции рынок рынка канал канала каналы трафик
трафика лид лида лиды конверсия конверсии метрика метрики дашборд дашборда отчет отчёт отчета отчёта план плана платформа
`.split(/\s+/).filter(Boolean));
