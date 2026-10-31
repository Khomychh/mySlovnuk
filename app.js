// Словник — PWA для особистого списку слів
// Дані: localStorage. Бекап: прихована папка Google Диска (appDataFolder).

const $ = (s, r = document) => r.querySelector(s);
const MIN = 60_000;
const DAY = 86_400_000;
const KEY = 'slovnyk.v1';
const TOKEN_KEY = 'slovnyk.gtoken';
const BACKUP_NAME = 'slovnyk-backup.json';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';

// Кожна мова — окрема колода зі своїми словами, чергою й налаштуваннями.
// Ключ колоди — базовий код мови ('en', 'de'); акцент обирається голосом.
const langDefaults = { voiceURI: '', rate: 0.95, autoSpeak: true, autoExamples: true, goal: 10, updatedAt: 0 };
const baseLang = l => (l || 'en').replace('_', '-').split('-')[0].toLowerCase();

// Перехід зі старого формату, де мова була одна на весь словник
function migrate(d) {
  const s = d.settings || {};
  if (!s.langs) {
    const b = baseLang(s.lang || 'en-US');
    const region = /-/.test(s.lang || '') ? s.lang.replace('_', '-') : '';
    s.langs = { [b]: { ...langDefaults, region, voiceURI: s.voiceURI || '', rate: s.rate ?? 0.95, autoSpeak: s.autoSpeak ?? true, updatedAt: s.updatedAt || 0 } };
    s.active = s.active || b;
    for (const k of ['lang', 'voiceURI', 'rate', 'autoSpeak', 'newPerDay']) delete s[k];
  }
  s.active = s.active || Object.keys(s.langs)[0] || 'en';
  if (!s.langs[s.active]) s.langs[s.active] = { ...langDefaults };
  const words = (d.words || []).map(w => (w.lang || w.deleted ? w : { ...w, lang: s.active }));
  for (const w of words) if (w.lang && !s.langs[w.lang]) s.langs[w.lang] = { ...langDefaults };
  const meta = { ...d.meta };
  if (meta.newDay) { meta.newBy = { [s.active]: { day: meta.newDay, count: meta.newCount || 0 } }; delete meta.newDay; delete meta.newCount; }
  meta.newBy ||= {};
  delete s.clientId; // Client ID тепер лише в config.js
  for (const l of Object.keys(s.langs)) s.langs[l] = { ...langDefaults, ...s.langs[l] };
  // журнал днів окремо для кожної мови:
  // { мова: { 'YYYY-MM-DD': { goal, w: { [id]: { g: [оцінки], a: 1 якщо додано цього дня } } } } }
  return { words, settings: { updatedAt: 0, ...s }, meta, log: d.log || {} };
}

/* ---------------- Сховище ---------------- */
function load() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d) return migrate(d);
  } catch {}
  return migrate({});
}
const db = load();
const CLIENT_ID = (window.SLOVNYK_CONFIG?.googleClientId || '').trim();

const deck = () => db.settings.active;
const cfg = (l = deck()) => (db.settings.langs[l] ||= { ...langDefaults });

function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch { toast('Не вдалося зберегти на пристрої: пам\'ять браузера заповнена. Завантажте копію у файл.'); }
}
function persist() { saveLocal(); scheduleBackup(); }

const live = (l = deck()) => db.words.filter(w => !w.deleted && w.lang === l);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = t => new Date(t).toLocaleDateString('sv');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function plural(n, [one, few, many]) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
const nWords = n => `${n} ${plural(n, ['слово', 'слова', 'слів'])}`;

/* ---------------- Інтервальне повторення (SM-2, як в Anki) ---------------- */
function newWord(fields) {
  const now = Date.now();
  return { id: uid(), lang: deck(), ...fields, createdAt: now, updatedAt: now, ease: 2.5, interval: 0, reps: 0, lapses: 0, due: now, lastReview: 0 };
}

function schedule(w, g, now = Date.now()) {
  const c = { ...w };
  let ease = c.ease || 2.5;
  if (g === 0) {
    c.lapses = (c.lapses || 0) + 1;
    c.reps = 0;
    c.interval = 0;
    c.ease = Math.max(1.3, ease - 0.2);
    c.due = now + 10 * MIN;
  } else {
    const iv0 = c.interval || 0, r = c.reps || 0;
    const hard = r === 0 ? 1 : Math.max(iv0 + 1, Math.round(iv0 * 1.2));
    let good = r === 0 ? 1 : r === 1 ? 3 : Math.max(iv0 + 1, Math.round(iv0 * ease));
    let easy = r === 0 ? 4 : Math.max(iv0 + 2, Math.round(iv0 * ease * 1.3));
    // для вже повторених слів кнопки завжди дають різні інтервали: Важко < Добре < Легко
    if (r > 0) { good = Math.max(good, hard + 1); easy = Math.max(easy, good + 1); }
    let iv;
    if (g === 1) { iv = hard; ease = Math.max(1.3, ease - 0.15); }
    else if (g === 2) iv = good;
    else { iv = easy; ease += 0.15; }
    c.ease = ease;
    c.reps = (c.reps || 0) + 1;
    c.interval = iv;
    c.due = startOfDay(now) + iv * DAY;
  }
  c.lastReview = now;
  c.updatedAt = now;
  return c;
}

function fmtSpan(ms) {
  if (ms < 60 * MIN) return `${Math.max(1, Math.round(ms / MIN))} хв`;
  const d = Math.round(ms / DAY);
  if (d < 1) return `${Math.round(ms / (60 * MIN))} год`;
  if (d < 14) return `${d} д`;
  if (d < 60) return `${Math.round(d / 7)} тиж`;
  if (d < 365) return `${Math.round(d / 30)} міс`;
  return `${(d / 365).toFixed(d < 3650 ? 1 : 0).replace('.0', '')} р`;
}
function previewLabel(w, g) {
  const now = Date.now();
  const c = schedule(w, g, now);
  if (g === 0) return '10 хв';
  return fmtSpan(c.interval * DAY);
}
function dueLabel(w) {
  if (!w.lastReview) return { text: 'нове', now: false };
  const now = Date.now();
  if (w.due <= now) return { text: 'сьогодні', now: true };
  const days = Math.round((startOfDay(w.due) - startOfDay(now)) / DAY);
  if (days === 1) return { text: 'завтра', now: false };
  return { text: `за ${fmtSpan(days * DAY)}`, now: false };
}

function counts(l = deck()) {
  const now = Date.now();
  const words = live(l);
  const due = words.filter(w => w.lastReview && w.due <= now).length;
  const fresh = words.filter(w => !w.lastReview).length; // нових не обмежуємо
  const learned = words.filter(w => w.interval >= 21).length;
  return { total: words.length, due, fresh, learned };
}
function buildQueue() {
  const now = Date.now();
  const words = live();
  const due = words.filter(w => w.lastReview && w.due <= now).sort((a, b) => a.due - b.due);
  const fresh = words.filter(w => !w.lastReview).sort((a, b) => a.createdAt - b.createdAt);
  // нові слова вплітаємо між повтореннями: одне нове після кожних трьох
  const q = [];
  let i = 0, j = 0;
  while (i < due.length || j < fresh.length) {
    for (let k = 0; k < 3 && i < due.length; k++) q.push(due[i++].id);
    if (j < fresh.length) q.push(fresh[j++].id);
  }
  return q;
}

/* ---------------- Озвучення ---------------- */
let voices = [];
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
function loadVoices() { if (!synth) return; voices = synth.getVoices(); renderVoiceSettings(); }


// Регіон за замовчуванням, коли голос не вибрано
const PREFERRED = { en: 'en-US', pt: 'pt-PT', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', zh: 'zh-CN', nl: 'nl-NL', sv: 'sv-SE' };
const voicesFor = l => voices.filter(v => baseLang(v.lang) === l);
function pickVoice(l) {
  const vs = voicesFor(l);
  const pref = (cfg(l).region || PREFERRED[l] || '').toLowerCase();
  return vs.find(v => v.voiceURI === cfg(l).voiceURI)
    || vs.find(v => v.lang.replace('_', '-').toLowerCase() === pref)
    || vs.find(v => v.default)
    || vs[0];
}
function utterance(text, l, btn) {
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(l);
  u.lang = v?.lang || cfg(l).region || PREFERRED[l] || l;
  if (v) u.voice = v;
  u.rate = cfg(l).rate;
  if (btn) {
    u.onstart = () => btn.classList.add('speaking');
    u.onend = u.onerror = () => btn.classList.remove('speaking');
  }
  return u;
}
function speak(text, btn, l = deck()) { speakSeq([text], l, [btn]); }
// Кілька фраз по черзі (приклади); кожна підсвічує свою кнопку
function speakSeq(texts, l = deck(), btns = []) {
  texts = texts.filter(Boolean);
  if (!synth) { toast('Цей браузер не вміє озвучувати текст'); return; }
  if (!texts.length) return;
  synth.cancel();
  document.querySelectorAll('.speaking').forEach(b => b.classList.remove('speaking'));
  // Chrome іноді ковтає фразу одразу після cancel()
  setTimeout(() => texts.forEach((t, i) => synth.speak(utterance(t, l, btns[i]))), 40);
}

/* ---------------- Приклади ---------------- */
// Вводяться в редакторі по рядку: «I love you | Я люблю тебе». Переклад після | необов'язковий.
function parseExamples(text) {
  return (text || '').split('\n').map(line => {
    const i = line.indexOf('|');
    return { t: (i < 0 ? line : line.slice(0, i)).trim(), tr: i < 0 ? '' : line.slice(i + 1).trim() };
  }).filter(e => e.t);
}
const parseForms = text => (text || '').split(',').map(x => x.trim()).filter(Boolean);
const formatExamples = list => (list || []).map(e => (e.tr ? `${e.t} | ${e.tr}` : e.t)).join('\n');
// Озвучення прикладів по черзі; кожен підсвічує свою кнопку. Форми автоматично не читаємо —
// їх можна послухати, торкнувшись кожної на картці.
function speakExamples(w) {
  speakSeq((w.examples || []).map(e => e.t), w.lang, [...root.querySelectorAll('.ex-play')]);
}
const hasExamples = w => !!w.examples?.length;

/* ---------------- Навігація ---------------- */
let currentView = 'review';
function go(view) {
  currentView = view;
  if (view !== 'review') setSessionLayout(false);
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.dock [data-go]').forEach(b => {
    if (b.dataset.go === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (view === 'review') renderReview();
  if (view === 'list') renderList();
  if (view === 'settings') renderSettings();
  if (view === 'progress') renderProgress();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('.dock [data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));
$('#addBtn').addEventListener('click', () => openEditor());

/* ---------------- Повторення ---------------- */
let session = null; // { queue: [id], total, done, revealed }
const root = $('#reviewRoot');

function renderReview() {
  if (session && session.queue.length) return renderCard();
  setSessionLayout(false);
  session = null;
  const c = counts();
  if (c.total === 0) {
    root.innerHTML = `
      <div class="intro glass">
        <h2>${esc(langLabel(deck()))}: слів поки немає</h2>
        <p>Додайте слово, яке хочете запам'ятати: переклад, транскрипцію та коментар. Застосунок сам нагадає, коли його повторити.</p>
        <button class="btn primary" type="button" data-act="add">Додати перше слово</button>
      </div>`;
    return;
  }
  const todo = c.due + c.fresh;
  const nextLine = () => {
    const next = live().filter(w => w.lastReview).sort((a, b) => a.due - b.due)[0];
    return next ? `Наступні слова чекатимуть ${esc(dueLabel(next).text)}.` : 'Додайте нові слова, щоб продовжити.';
  };
  // Підсумок показуємо й після виходу з сесії посередині — тоді з кнопкою «Продовжити»
  if (lastSummary && lastSummary.lang === deck()) {
    root.innerHTML = summaryHtml(lastSummary, nextLine(), todo);
    return;
  }
  if (todo === 0) {
    root.innerHTML = `
      <div class="intro glass">
        <h2>На сьогодні все</h2>
        <p>${nextLine()}</p>
        ${goalStrip()}
        <button class="btn ghost" type="button" data-act="add">Додати слово</button>
      </div>
      ${todayStatsPanel()}`;
    return;
  }
  root.innerHTML = startHtml(c, todo);
}

// Стос скляних карток: що більше слів сьогодні, то вищий стос (до трьох шарів)
function startHtml(c, todo) {
  const layers = Math.min(2, todo - 1);
  const duePct = Math.round((c.due / todo) * 100);
  const first = reviewsTotal() < 20; // новачкові — одне речення, як це працює
  const legend = [
    c.due ? `<span><i class="mix-dot due"></i>${c.due} на повторення</span>` : '',
    c.fresh ? `<span><i class="mix-dot new"></i>${c.fresh} ${plural(c.fresh, ['нове', 'нові', 'нових'])}</span>` : '',
  ].join('');
  return `
    <div class="start">
      <div class="stack" style="--layers:${layers}">
        ${layers >= 2 ? '<div class="stack-layer l2" aria-hidden="true"></div>' : ''}
        ${layers >= 1 ? '<div class="stack-layer l1" aria-hidden="true"></div>' : ''}
        <div class="stack-card glass">
          <h2>На вас ${plural(todo, ['чекає', 'чекають', 'чекають'])} ${nWords(todo)}</h2>
          <div class="mix" aria-hidden="true">
            ${c.due ? `<i class="mix-due" style="flex-basis:${duePct}%"></i>` : ''}${c.fresh ? '<i class="mix-new"></i>' : ''}
          </div>
          <p class="mix-legend">${legend}</p>
          <p class="stack-foot">${first ? 'Згадайте переклад, відкрийте його й оцініть, наскільки легко пригадали.' : `Приблизно ${estimateMinutes()} хв`}</p>
          <button class="btn primary start-btn" type="button" data-act="start">Вчити</button>
        </div>
      </div>
      ${goalStrip()}
    </div>
    ${todayStatsPanel()}`;
}

// Скільки оцінок уже поставлено в цій мові (для підказки новачкам)
function reviewsTotal(l = deck()) {
  let n = 0;
  for (const d of Object.values(db.log[l] || {})) for (const e of Object.values(d.w)) n += e.g?.length || 0;
  return n;
}
// Груба оцінка: повторення ~8 с, нове слово ~15 с, ще ~5 с, якщо озвучуються форми чи приклади
// Особистий темп: середній час на слово (з усіма показами через «Знову»), окремо для нових і повторень.
// Зберігається на пристрої, бо на телефоні й комп'ютері швидкість різна.
const PACE_MIN = 10; // скільки вимірів потрібно, щоб довіряти особистому середньому
function recordPace(l, kind, ms) {
  const p = ((db.meta.pace ||= {})[l] ||= {});
  const c = (p[kind] ||= { avg: 0, n: 0 });
  c.n++;
  c.avg += (ms - c.avg) / Math.min(c.n, 30); // спершу звичайне середнє, далі плавне — свіжі сесії важать більше
}
// Час на слово: ваш, якщо вже є досить вимірів; інакше груба оцінка 8 с (повторення) і 15 с (нове) + 5 с на приклади
function secondsFor(w) {
  const kind = w.lastReview ? 'rev' : 'new';
  const own = db.meta.pace?.[w.lang]?.[kind];
  if (own && own.n >= PACE_MIN) return own.avg / 1000;
  return (kind === 'rev' ? 8 : 15) + (hasExamples(w) && cfg(w.lang).autoExamples ? 5 : 0);
}
function estimateMinutes() {
  const byId = new Map(db.words.map(w => [w.id, w]));
  const sec = buildQueue().reduce((t, id) => t + secondsFor(byId.get(id)), 0);
  return Math.max(1, Math.round(sec / 60));
}
// Рядок цілі дня зі скельцями — той самий, що на вкладці «Прогрес»
function goalStrip() {
  const n = dayCount(dayKey(Date.now())), goal = goalOf();
  const done = n >= goal;
  const text = done
    ? `<b>Ціль досягнуто</b>`
    : `Ціль: <b>${n} з ${goal}</b>`;
  return `<div class="goal-strip ${done ? 'done' : ''}">
    <p class="goal-strip-text">${done ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : ''}<span>${text}</span></p>
    <div role="progressbar" aria-label="Ціль дня" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(n, goal)}">${pebblesHtml(n, goal)}</div>
  </div>`;
}
// Підсумок щойно завершеної сесії
let lastSummary = null;
function summaryHtml(sm, nextLine, todo) {
  const mins = Math.round((sm.ended - sm.started) / MIN);
  const took = mins < 1 ? 'за хвилину' : `за ${mins} хв`;
  const names = ['Знову', 'Важко', 'Добре', 'Легко'];
  const more = todo > 0;
  return `
    <div class="intro glass summary">
      <h2 tabindex="-1">${more ? 'Пройдено' : 'Готово'}: ${nWords(sm.words)} ${took}</h2>
      <p>${sm.fresh ? `${sm.fresh} ${plural(sm.fresh, ['нове', 'нові', 'нових'])}. ` : ''}${more ? `Ще ${todo} на сьогодні.` : nextLine}</p>
      ${answersHtml(sm.grades)}
      ${goalStrip()}
      <div class="row-btns">
        ${more
          ? '<button class="btn primary" type="button" data-act="start">Вчити</button><button class="btn ghost" type="button" data-act="progress">Прогрес</button>'
          : '<button class="btn primary" type="button" data-act="progress">Прогрес</button><button class="btn ghost" type="button" data-act="add">Додати слово</button>'}
      </div>
    </div>
    ${todayStatsPanel()}`;
}

root.addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') return openEditor();
  if (act === 'start') return startSession();
  if (act === 'progress') return go('progress');
  if (act === 'exit') return exitSession();
  if (e.target.closest('[data-day-more]')) { reviewDayAll = !reviewDayAll; renderReview(); root.querySelector('[data-day-more]')?.focus(); return; }
  if (act === 'speak-form') {
    e.stopPropagation();
    const w = currentWord(), b = e.target.closest('button');
    const f = [w.word, ...(w.forms || [])][+b.dataset.i];
    if (f) speak(f.replace(/\s*\/\s*/g, ', '), b, w.lang);
    return;
  }
  if (act === 'speak-ex') {
    e.stopPropagation();
    const w = currentWord(), b = e.target.closest('button');
    const ex = w?.examples?.[+b.dataset.i];
    if (ex) speak(ex.t, b, w.lang);
    return;
  }
  if (act === 'speak') { e.stopPropagation(); const w = currentWord(); if (w) speak(w.word, e.target.closest('button')); return; }
  if (act === 'edit') { e.stopPropagation(); const w = currentWord(); if (w) openEditor(w); return; }
  if (act === 'reveal' || (e.target.closest('.slab') && !session?.revealed)) return reveal();
  const g = e.target.closest('[data-g]');
  if (g) grade(+g.dataset.g);
});

function startSession() {
  const queue = buildQueue();
  if (!queue.length) return renderReview();
  const byId = new Map(db.words.map(w => [w.id, w]));
  session = {
    queue, total: queue.length, done: 0, revealed: false,
    stats: { grades: [0, 0, 0, 0], ids: new Set(), fresh: 0, started: Date.now() },
    // для особистого темпу: які слова були новими на старті й скільки часу пішло на кожне
    newIds: new Set(queue.filter(id => !byId.get(id)?.lastReview)), wordMs: {}, cardAt: Date.now(),
  };
  lastSummary = null;
  renderCard(true, true); // перша картка сесії теж з'являється рухом
}
const currentWord = () => session && db.words.find(w => w.id === session.queue[0]);

// Під час сесії сторінка не гортається: сесія займає рівно екран (висоту верхньої смуги міряємо)
function setSessionLayout(on) {
  document.body.classList.toggle('in-session', on);
  if (on) {
    const main = document.querySelector('main');
    document.documentElement.style.setProperty('--top-h', `${Math.ceil(main.getBoundingClientRect().top + window.scrollY + parseFloat(getComputedStyle(main).paddingTop))}px`);
    window.scrollTo(0, 0);
  }
}
function renderCard(fresh = true, enter = false) {
  const w = currentWord();
  if (!w) { session = null; return renderReview(); }
  setSessionLayout(currentView === 'review');
  const pct = Math.round((session.done / Math.max(session.total, 1)) * 100);
  const longest = Math.max(...w.word.split(/\s+/).map(t => t.length));
  const size = w.word.length > 18 || longest > 13 ? 'long' : longest > 8 ? 'mid' : '';
  root.innerHTML = `<div class="session">
    <div class="progress">
      <button class="icon-btn" type="button" data-act="exit" aria-label="Вийти з повторення" title="Вийти">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
      <span>${session.done} з ${session.total}</span>
      <span class="progress-bar"><i style="width:${pct}%"></i></span>
      <button class="icon-btn" type="button" data-act="edit" aria-label="Редагувати слово">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>
      </button>
    </div>
    <article class="slab glass ${session.revealed ? 'revealed' : ''} ${enter ? 'enter' : ''}" aria-live="polite"
      ${session.revealed ? '' : 'role="button" tabindex="0" aria-label="Показати переклад"'}>
      <div class="slab-body">
      <h2 class="word ${size}" lang="${esc(w.lang)}">${esc(w.word)}</h2>
      <!-- вимова поруч із транскрипцією: нічого не перекриває навіть у тісній картці -->
      <div class="ipa-row">
        ${w.transcription ? `<p class="ipa">${esc(w.transcription)}</p>` : ''}
        <button class="speak" type="button" data-act="speak" aria-label="Прослухати вимову">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>
        </button>
      </div>
      ${w.forms?.length ? `<p class="forms-ask">+ ${w.forms.length} ${plural(w.forms.length, ['форма', 'форми', 'форм'])}</p>` : ''}
      ${!session.revealed && reviewsTotal() < 20 ? '<p class="tap-hint" aria-hidden="true">Торкніться, щоб побачити переклад</p>' : ''}
      <div class="answer">
        <div class="answer-content" ${session.revealed ? '' : 'aria-hidden="true"'}>
          <p class="translation">${esc(w.translation)}</p>
          ${w.forms?.length ? `<div class="forms" lang="${esc(w.lang)}">${[w.word, ...w.forms].map((f, i) =>
            `<button type="button" class="form ${i === 0 ? 'base' : ''}" data-act="speak-form" data-i="${i}">${esc(f)}</button>`).join('')}</div>` : ''}
          ${w.comment ? `<p class="comment">${esc(w.comment)}</p>` : ''}
          ${w.examples?.length ? `<ul class="examples">${w.examples.map((ex, i) => `<li>
            <button type="button" class="ex-play" data-act="speak-ex" data-i="${i}" aria-label="Прослухати приклад ${i + 1}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/></svg>
            </button>
            <span class="ex-text"><span class="ex-t" lang="${esc(w.lang)}">${esc(ex.t)}</span>${ex.tr ? `<span class="ex-tr">${esc(ex.tr)}</span>` : ''}</span>
          </li>`).join('')}</ul>` : ''}
        </div>
      </div>
      </div>
    </article>
    <div class="actions">
      ${session.revealed ? gradesHtml(w) : ''}
    </div>
  </div>`;
  if (fresh) session.cardAt = Date.now();
  if (fresh && cfg().autoSpeak && !session.revealed) speak(w.word, root.querySelector('.speak'));
}

function gradesHtml(w) {
  const names = ['Знову', 'Важко', 'Добре', 'Легко'];
  // якщо після округлення дві кнопки виглядають однаково («1 тиж» і «1 тиж»), показуємо точні дні
  let labels = [0, 1, 2, 3].map(g => previewLabel(w, g));
  if (new Set(labels.slice(1)).size < 3) labels = labels.map((l, g) => (g === 0 ? l : `${schedule(w, g).interval} д`));
  return `<div class="grades" tabindex="-1" role="group" aria-label="Наскільки легко згадали">${names.map((n, g) =>
    `<button class="grade" type="button" data-g="${g}"><span class="grade-name">${n}</span><small>${labels[g]}</small></button>`).join('')}</div>`;
}

function reveal() {
  if (!session || session.revealed) return;
  session.revealed = true;
  const slab = root.querySelector('.slab');
  // картка плавно більшає під відповідь (від центру, бо стоїть посередині)
  const h0 = slab.offsetHeight;
  slab.classList.add('revealed');
  slab.removeAttribute('role'); slab.removeAttribute('tabindex'); slab.removeAttribute('aria-label');
  slab.querySelector('.tap-hint')?.remove();
  const h1 = slab.offsetHeight;
  if (h1 !== h0 && !matchMedia('(prefers-reduced-motion: reduce)').matches && slab.animate) {
    slab.animate([{ height: `${h0}px` }, { height: `${h1}px` }], { duration: 260, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  slab.querySelector('.answer-content').removeAttribute('aria-hidden');
  const actions = root.querySelector('.actions');
  const w = currentWord();
  actions.innerHTML = gradesHtml(w);
  if (hasExamples(w) && cfg(w.lang).autoSpeak && cfg(w.lang).autoExamples) speakExamples(w);
  actions.querySelector('.grades').focus({ preventScroll: true });
}

function grade(g) {
  const w = currentWord();
  if (!w || !session.revealed || session.locked) return;
  const wasNew = !w.lastReview;
  const updated = schedule(w, g);
  db.words[db.words.findIndex(x => x.id === w.id)] = updated;
  logEvent(updated, 'review', g);
  // час на картку: від показу до оцінки, не більше 90 с (раптом відволіклися)
  session.wordMs[w.id] = (session.wordMs[w.id] || 0) + Math.min(Date.now() - session.cardAt, 90_000);
  if (g !== 0) recordPace(w.lang, session.newIds.has(w.id) ? 'new' : 'rev', session.wordMs[w.id]);
  const st = session.stats;
  st.grades[g]++;
  if (!st.ids.has(w.id) && wasNew) st.fresh++;
  st.ids.add(w.id);
  session.queue.shift();
  if (g === 0) session.queue.splice(Math.min(session.queue.length, 4), 0, w.id); // повернеться через кілька карток
  else session.done++;
  session.revealed = false;
  persist();
  // Картка йде: після «Знову» — назад у стос, після інших оцінок — убік. Поки триває рух, натискання ігноруємо.
  const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200;
  const slab = root.querySelector('.slab');
  if (slab && delay) slab.classList.add(g === 0 ? 'leave-again' : 'leave-done');
  root.querySelector(`.grade[data-g="${g}"]`)?.classList.add('chosen'); // вибрана оцінка на мить заливається кольором
  session.locked = true;
  setTimeout(() => {
    if (!session) return; // вийшли з сесії, поки картка відлітала
    session.locked = false;
    if (!session.queue.length) return endSession();
    renderCard(true, true);
  }, delay);
}

// Кінець сесії — повний чи достроковий. Якщо нічого не оцінено, підсумок не потрібен.
function endSession() {
  const st = session.stats;
  lastSummary = st.ids.size
    ? { lang: deck(), grades: st.grades, words: st.ids.size, fresh: st.fresh, started: st.started, ended: Date.now() }
    : null;
  session = null;
  if (synth) synth.cancel();
  renderReview();
  root.querySelector('h2')?.focus?.();
}
function exitSession() { if (session) endSession(); }

document.addEventListener('keydown', e => {
  if (currentView === 'review' && !session && (e.key === 'Enter' || e.key === ' ')
      && !document.querySelector('dialog[open]') && !e.target.closest?.('input, textarea, select, button, a, summary')
      && root.querySelector('[data-act="start"]')) {
    e.preventDefault();
    return startSession();
  }
  if (currentView !== 'review' || !session || $('#editor').open) return;
  if (e.key === 'Escape') { e.preventDefault(); return exitSession(); }
  if (e.target.matches('input, textarea, select')) return;
  if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('button')) return; // кнопка натиснеться сама
  if (e.key === ' ' || e.key === 'Enter') {
    if (!session.revealed) { e.preventDefault(); reveal(); }
  } else if (/^[1-4]$/.test(e.key) && session.revealed) {
    e.preventDefault(); grade(+e.key - 1);
  } else if ((e.key === 'e' || e.key === 'E' || e.key === 'у' || e.key === 'У') && session.revealed) {
    const w = currentWord(); if (w && hasExamples(w)) speakExamples(w);
  } else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
    const w = currentWord(); if (w) speak(w.word, root.querySelector('.speak'));
  }
});

/* ---------------- Список ---------------- */
const listEl = $('#wordList');
// Порядок списку — налаштування пристрою: «Новіші» або «А–Я»
const SORT_KEY = 'slovnyk.sort';
const getSort = () => { try { return localStorage.getItem(SORT_KEY) === 'az' ? 'az' : 'new'; } catch { return 'new'; } };
function sortWords(list) {
  if (getSort() === 'az') {
    const coll = new Intl.Collator(deck(), { sensitivity: 'base' });
    return list.sort((a, b) => coll.compare(a.word, b.word));
  }
  // Слова, додані в ту саму хвилину (наприклад набором), лишаються в порядку додавання
  const idx = new Map(db.words.map((w, i) => [w.id, i]));
  const minute = t => Math.floor((t || 0) / MIN);
  return list.sort((a, b) => minute(b.createdAt) - minute(a.createdAt) || idx.get(a.id) - idx.get(b.id));
}
function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const all = sortWords(live());
  const items = q ? all.filter(w => [w.word, w.translation, w.comment, w.transcription, formatExamples(w.examples), (w.forms || []).join(' ')].some(s => (s || '').toLowerCase().includes(q))) : all;
  $('#listMeta').textContent = all.length === 0 ? '' : q ? `Знайдено ${items.length} з ${all.length}` : `${langLabel(deck())}: ${nWords(all.length)}`;
  $('#listSort').hidden = all.length < 2;
  const so = document.querySelector(`#listSort input[value="${getSort()}"]`); if (so) so.checked = true;
  listEl.classList.toggle('is-empty', !items.length);
  if (!all.length) {
    listEl.innerHTML = `<li class="empty">Тут з'являться ваші слова.<br><button class="btn primary" type="button" data-act="add">Додати слово</button></li>`;
    return;
  }
  if (!items.length) {
    const raw = $('#search').value.trim();
    listEl.innerHTML = `<li class="empty">Не знайдено «${esc(raw)}».<br><button class="btn ghost small" type="button" data-act="add-q">Додати «${esc(raw)}»</button></li>`;
    return;
  }
  listEl.innerHTML = items.map(w => {
    const d = dueLabel(w);
    // Статус: «сьогодні» — помітно; нове — лише крапка; решта — блідо
    const status = !w.lastReview
      ? '<span class="due-new" title="Нове слово"><span class="sr">нове</span></span>'
      : `<span class="due ${d.now ? 'now' : ''}">${d.text}</span>`;
    return `<li class="word-row" data-id="${w.id}">
      <button class="open" type="button" data-act="open">
        <span class="row-line1"><span class="row-word" lang="${esc(w.lang)}">${esc(w.word)}</span>${w.transcription ? `<span class="row-ipa">${esc(w.transcription)}</span>` : ''}</span>
        <span class="row-line2"><span class="row-tr">${esc(w.translation)}</span>${w.forms?.length ? `<span class="row-forms" lang="${esc(w.lang)}">${esc(w.forms.join(', '))}</span>` : ''}</span>
      </button>
      ${status}
      <button class="icon-btn row-say" type="button" data-act="say" aria-label="Прослухати ${esc(w.word)}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>
      </button>
    </li>`;
  }).join('');
}
$('#listSort').addEventListener('change', e => {
  try { localStorage.setItem(SORT_KEY, e.target.value); } catch {}
  renderList();
});
$('#search').addEventListener('input', renderList);
listEl.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'add') return openEditor();
  if (b.dataset.act === 'add-q') return openEditor(null, $('#search').value.trim());
  const w = db.words.find(x => x.id === b.closest('[data-id]')?.dataset.id);
  if (!w) return;
  if (b.dataset.act === 'say') speak(w.word, b, w.lang);
  if (b.dataset.act === 'open') openEditor(w);
});

/* ---------------- Редактор ---------------- */
const dlg = $('#editor');
const form = $('#editorForm');
let editingId = null;

function openEditor(w = null, prefill = '') {
  editingId = w?.id || null;
  $('#editorTitle').textContent = w ? 'Редагувати слово' : 'Нове слово';
  $('#editorDeck').textContent = langLabel(w?.lang || deck());
  $('#fWord').value = w?.word || prefill;
  $('#fTr').value = w?.translation || '';
  $('#fIpa').value = w?.transcription || '';
  $('#fNote').value = w?.comment || '';
  $('#fEx').value = formatExamples(w?.examples);
  $('#fForms').value = (w?.forms || []).join(', ');
  $('#formError').textContent = '';
  $('#fDelete').hidden = !w;
  $('#fDelete').classList.remove('confirm');
  $('#fDelete').textContent = 'Видалити';
  $('#fSave').textContent = w ? 'Зберегти зміни' : 'Зберегти слово';
  $('#fLookup').hidden = (w?.lang || deck()) !== 'en';
  hideSuggest();
  updateExSpeak();
  dlg.showModal();
  setTimeout(() => (w ? $('#fTr') : $('#fWord')).focus(), 30);
}
$('#editorClose').addEventListener('click', () => dlg.close());
// закриваємо лише від кліку по затемненню навколо аркуша
let downOutside = false;
const outside = e => { const r = dlg.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
dlg.addEventListener('pointerdown', e => { downOutside = e.target === dlg && outside(e); });
dlg.addEventListener('click', e => { if (downOutside && e.target === dlg && outside(e)) dlg.close(); downOutside = false; });
$('#fSpeak').addEventListener('click', e => speak($('#fWord').value.trim(), e.currentTarget, db.words.find(x => x.id === editingId)?.lang || deck()));

form.addEventListener('submit', e => {
  e.preventDefault();
  const fields = {
    word: $('#fWord').value.trim(),
    translation: $('#fTr').value.trim(),
    transcription: $('#fIpa').value.trim(),
    comment: $('#fNote').value.trim(),
    examples: parseExamples($('#fEx').value),
    forms: parseForms($('#fForms').value),
  };
  if (!fields.word) { $('#formError').textContent = 'Впишіть слово чи фразу.'; return $('#fWord').focus(); }
  if (!fields.translation) { $('#formError').textContent = 'Впишіть переклад, щоб було що згадувати.'; return $('#fTr').focus(); }
  if (editingId) {
    const i = db.words.findIndex(x => x.id === editingId);
    db.words[i] = { ...db.words[i], ...fields, updatedAt: Date.now() };
    toast('Зміни збережено');
  } else {
    const dup = live().find(x => x.word.toLowerCase() === fields.word.toLowerCase());
    if (dup && !form.dataset.dupOk) {
      form.dataset.dupOk = '1';
      $('#formError').textContent = `«${dup.word}» вже є у списку: «${dup.translation}»${dup.transcription ? `, ${dup.transcription}` : ''}. Якщо це інше значення, натисніть «Зберегти слово» ще раз, і буде окрема картка.`;
      return;
    }
    // додане слово вважаємо повтореним сьогодні: воно йде в ціль дня, а в черзі з'явиться завтра
    const added = schedule(newWord(fields), 2);
    db.words.push(added);
    logEvent(added, 'add');
    toast(`«${fields.word}» додано`);
  }
  delete form.dataset.dupOk;
  persist();
  dlg.close();
  refresh();
});
$('#fWord').addEventListener('input', () => { delete form.dataset.dupOk; $('#formError').textContent = ''; hideSuggest(); });

$('#fDelete').addEventListener('click', e => {
  const b = e.currentTarget;
  if (!b.classList.contains('confirm')) { b.classList.add('confirm'); b.textContent = 'Так, видалити'; return; }
  const i = db.words.findIndex(x => x.id === editingId);
  if (i > -1) {
    const word = db.words[i].word;
    db.words[i] = { id: editingId, deleted: true, updatedAt: Date.now() }; // слід для синхронізації
    if (session) session.queue = session.queue.filter(id => id !== editingId);
    persist();
    toast(`«${word}» видалено`);
  }
  dlg.close();
  refresh();
});

/* ---------------- Підказки в редакторі ---------------- */
// Транскрипції: dictionaryapi.dev (лише англійська), лише після натискання «Знайти».
// Переклад навмисно не підказуємо: машинні варіанти надто ненадійні для навчання.
const editLang = () => db.words.find(x => x.id === editingId)?.lang || deck();
const POS_UK = { noun: 'ім.', verb: 'дієсл.', adjective: 'прикм.', adverb: 'присл.', pronoun: 'займ.', preposition: 'прийм.', conjunction: 'спол.', interjection: 'виг.', exclamation: 'виг.', determiner: 'означ.', article: 'арт.', numeral: 'числ.' };
const ACCENT = { us: 'амер.', uk: 'брит.', au: 'австрал.', ca: 'канад.' };
const normIpa = t => t.replace(/[/[\]\s.ˌ]/g, '');

// Додає варіант до поля через кому, якщо його там ще немає
function addToField(input, value) {
  const cur = input.value.trim();
  const parts = cur ? cur.split(/\s*[,;]\s*/) : [];
  if (parts.some(p => p.toLowerCase() === value.toLowerCase())) return;
  input.value = cur ? `${cur}, ${value}` : value;
}
// groups: [{ title, idx: [номери варіантів] }] — для слів із кількома значеннями
function renderSuggest(box, items, note, groups) {
  box.hidden = false;
  box._items = items;
  const chip = i => `<button type="button" class="chip" data-i="${i}" aria-pressed="false">${items[i].html}</button>`;
  const body = !items.length ? ''
    : groups ? groups.map(g => `<div class="chip-group"><p class="chip-group-title">${g.title}</p><div class="chips">${g.idx.map(chip).join('')}</div></div>`).join('')
    : `<div class="chips">${items.map((_, i) => chip(i)).join('')}</div>`;
  box.innerHTML = body + (note ? `<p class="suggest-note">${note}</p>` : '');
}
function wireSuggest(box, input) {
  box.addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (!b) return;
    addToField(input, box._items[+b.dataset.i].value);
    b.classList.add('picked');
    b.setAttribute('aria-pressed', 'true');
  });
}
wireSuggest($('#ipaSuggest'), $('#fIpa'));
function hideSuggest() { $('#ipaSuggest').hidden = true; }

$('#fLookup').addEventListener('click', async e => {
  const word = $('#fWord').value.trim();
  const box = $('#ipaSuggest');
  if (!word) { $('#formError').textContent = 'Спершу впишіть слово.'; return $('#fWord').focus(); }
  const b = e.currentTarget;
  b.disabled = true; b.textContent = 'Шукаю…';
  try {
    const r = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`);
    if (r.status === 404) return renderSuggest(box, [], `Транскрипцію для «${esc(word)}» не знайдено. Впишіть її вручну.`);
    if (!r.ok) throw new Error('net');
    const entries = await r.json();
    // Кожен запис словника — окреме значення (омографи: lead /lɛd/ свинець і /liːd/ вести)
    const pref = { 'en-gb': 'uk', 'en-us': 'us', 'en-au': 'au', 'en-ca': 'ca' }[(pickVoice('en')?.lang || 'en-US').replace('_', '-').toLowerCase()] || 'us';
    const variants = [];
    entries.forEach((en, ei) => {
      const pos = [...new Set((en.meanings || []).map(m => POS_UK[m.partOfSpeech] || m.partOfSpeech))].join(', ');
      const def = en.meanings?.[0]?.definitions?.[0]?.definition || '';
      const phs = [...(en.phonetics || []).filter(p => p.text), ...(en.phonetic ? [{ text: en.phonetic }] : [])];
      for (const p of phs) {
        const acc = (p.audio || '').match(/-(us|uk|au|ca)\.mp3$/)?.[1] || '';
        const key = normIpa(p.text);
        const same = variants.find(v => v.key === key);
        if (same) { if (acc && !same.acc) same.acc = acc; continue; }
        variants.push({ key, text: p.text.trim(), acc, pos, def, ei });
      }
    });
    if (!variants.length) return renderSuggest(box, [], `Транскрипцію для «${esc(word)}» не знайдено. Впишіть її вручну.`);
    const multi = new Set(variants.map(v => v.ei)).size > 1;
    // у межах значення: спершу вимова вашого голосу, далі без позначки, далі інші; вузька [фонетика] — в кінці
    const rank = v => (v.acc === pref ? 0 : !v.acc ? 1 : 2) + (v.text.startsWith('[') ? 3 : 0);
    variants.sort((a, b) => a.ei - b.ei || rank(a) - rank(b));
    const shown = variants.slice(0, 8);
    const items = shown.map(v => ({
      value: v.text,
      html: `<span class="ipa">${esc(v.text)}</span>${v.acc ? `<span class="chip-tag">${ACCENT[v.acc]}</span>` : ''}`,
    }));
    let groups;
    if (multi) {
      groups = [];
      shown.forEach((v, i) => {
        let g = groups.find(x => x.ei === v.ei);
        if (!g) {
          const def = v.def.length > 70 ? v.def.slice(0, 68).trimEnd() + '…' : v.def;
          g = { ei: v.ei, idx: [], title: `${v.pos ? `<b>${esc(v.pos)}</b> ` : ''}<span lang="en">${esc(def)}</span>` };
          groups.push(g);
        }
        g.idx.push(i);
      });
    }
    const note = multi
      ? 'Різні значення вимовляються по-різному: виберіть своє. Інше значення краще окремою карткою.'
      : shown.length > 1 ? 'Можна вибрати кілька.' : '';
    renderSuggest(box, items, note, groups);
  } catch {
    renderSuggest(box, [], navigator.onLine ? 'Словник не відповідає. Спробуйте ще раз або впишіть транскрипцію вручну.' : 'Немає інтернету. Впишіть транскрипцію вручну.');
  } finally { b.disabled = false; b.textContent = 'Знайти'; }
});

// Прослухати приклади в редакторі
function updateExSpeak() { $('#fExSpeak').hidden = !parseExamples($('#fEx').value).length; }
$('#fEx').addEventListener('input', updateExSpeak);
$('#fExSpeak').addEventListener('click', e => speakSeq(parseExamples($('#fEx').value).map(x => x.t), editLang(), [e.currentTarget]));

function refresh() {
  if (currentView === 'list') renderList();
  if (currentView === 'settings') renderSettings();
  if (currentView === 'progress') renderProgress();
  if (currentView === 'review') {
    if (session) { const w = currentWord(); if (w) renderCard(false); else { session = null; renderReview(); } }
    else renderReview();
  }
}

/* ---------------- Мови й налаштування ---------------- */
const COMMON_LANGS = ['en', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'cs', 'sk', 'nl', 'sv', 'no', 'da', 'fi', 'el', 'tr', 'he', 'ar', 'ja', 'ko', 'zh', 'hu', 'ro', 'hr', 'sr', 'bg', 'lt', 'lv', 'et', 'ka', 'hi', 'id', 'vi', 'th'];
let langNames;
try { langNames = new Intl.DisplayNames(['uk'], { type: 'language' }); } catch {}
const langLabel = code => { try { const n = langNames?.of(code); return n ? n[0].toUpperCase() + n.slice(1) : code; } catch { return code; } };
const langLabelLower = code => langLabel(code).toLowerCase();
const byLabel = (a, b) => langLabel(a).localeCompare(langLabel(b), 'uk');
const decks = () => Object.keys(db.settings.langs).sort(byLabel);

/* ---------------- Вибір голосу ---------------- */
let regionNames;
try { regionNames = new Intl.DisplayNames(['uk'], { type: 'region' }); } catch {}
const regionLabel = r => { try { return (r && regionNames?.of(r)) || 'Інші'; } catch { return r || 'Інші'; } };
// Власна назва мови її ж мовою: Deutsch, Français, 日本語
const autonym = code => {
  try { const n = new Intl.DisplayNames([code], { type: 'language' }).of(code); return n ? n[0].toLocaleUpperCase(code) + n.slice(1) : code; }
  catch { return code; }
};
// Системні назви на зразок «Microsoft Libby Online (Natural) - English (United Kingdom)» → «Libby» + позначки
function voiceInfo(v) {
  const raw = v.name;
  const vendor = (raw.match(/^(Google|Microsoft|Apple)\b/i) || [])[1] || '';
  const gender = /female|woman/i.test(raw) ? 'жіночий' : /\bmale\b/i.test(raw) ? 'чоловічий' : '';
  let name = raw.replace(/^(Google|Microsoft|Apple)\s+/i, '').replace(/\s*\((Natural|Enhanced|Premium)\)/ig, '')
    .replace(/\s+Online\b/i, '').replace(/\s+-\s+.*$/, '').replace(/\b(Female|Male)\b/ig, '').trim();
  const l = baseLang(v.lang);
  // «UK English», «Deutsch» — це назва мови, а не голосу: тоді показуємо постачальника
  if (!name || /^(UK|US|AU|IN|CA)?\s*English$/i.test(name) || name.toLowerCase() === autonym(l).toLowerCase()) name = vendor || raw;
  return {
    name,
    meta: [gender, /natural|neural|premium|enhanced|online/i.test(raw) && 'природний', v.localService ? 'без інтернету' : 'через інтернет'].filter(Boolean).join(', '),
    region: (v.lang.replace('_', '-').split('-')[1] || '').toUpperCase(),
  };
}
const voiceOpen = new Set(); // групи, які користувач розгорнув сам
const sampleText = () => SAMPLES[deck()] || live()[0]?.word || 'Hello';
function previewVoice(v, btn) {
  if (!synth || !v) return;
  synth.cancel();
  document.querySelectorAll('.speaking').forEach(b => b.classList.remove('speaking'));
  const u = new SpeechSynthesisUtterance(sampleText());
  u.voice = v; u.lang = v.lang; u.rate = cfg().rate;
  if (btn) { u.onstart = () => btn.classList.add('speaking'); u.onend = u.onerror = () => btn.classList.remove('speaking'); }
  setTimeout(() => synth.speak(u), 40);
}
const playIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
function voiceRow(value, name, meta, on, playUri) {
  return `<div class="voice-row ${on ? 'on' : ''}">
    <label class="voice-pick"><input type="radio" name="voice" value="${esc(value)}" ${on ? 'checked' : ''}>
      <span class="voice-dot" aria-hidden="true"></span>
      <span class="voice-text"><span class="voice-name">${esc(name)}</span>${meta ? `<span class="voice-meta">${esc(meta)}</span>` : ''}</span>
    </label>
    ${playUri != null ? `<button type="button" class="voice-play" data-play="${esc(playUri)}" aria-label="Прослухати: ${esc(name)}" title="Прослухати">${playIcon}</button>` : ''}
  </div>`;
}
function renderVoiceSettings() {
  const box = $('#voiceList');
  if (!box) return;
  const l = deck();
  const vs = voicesFor(l);
  if (!vs.length) {
    box.innerHTML = `<p class="voice-empty">${voices.length ? `У цьому браузері немає голосу для мови «${esc(langLabelLower(l))}». Слова не озвучуватимуться.` : 'Голоси ще завантажуються…'}</p>`;
    return;
  }
  const chosen = vs.find(v => v.voiceURI === cfg(l).voiceURI);
  const auto = pickVoice(l);
  const autoInfo = voiceInfo(auto);
  // Згорнуто: лише поточний голос. Повний список — тільки після «Змінити»
  const cur = chosen ? voiceInfo(chosen) : autoInfo;
  const head = `<div class="voice-current">
    <span class="voice-text"><span class="voice-name">${esc(cur.name)}</span>
      <span class="voice-meta">${esc([chosen ? '' : 'автоматично', regionLabel(cur.region)].filter(Boolean).join(', '))}</span></span>
    <button type="button" class="voice-play" data-play="${esc((chosen || auto).voiceURI)}" aria-label="Прослухати: ${esc(cur.name)}" title="Прослухати">${playIcon}</button>
    <button type="button" class="btn ghost small" data-voice-toggle aria-expanded="${voicePickerOpen}" aria-controls="voiceRows">${voicePickerOpen ? 'Згорнути' : 'Змінити'}</button>
  </div>`;
  if (!voicePickerOpen) { box.innerHTML = head; return; }
  let html = voiceRow('', 'Автоматично', `Зараз: ${autoInfo.name}, ${regionLabel(autoInfo.region)}`, !chosen, chosen ? null : auto.voiceURI);
  // Групи за регіоном (акцентом): спершу та, де вибраний голос, далі звичний регіон, далі найбільші
  const groups = new Map();
  for (const v of vs) { const r = voiceInfo(v).region; if (!groups.has(r)) groups.set(r, []); groups.get(r).push(v); }
  const selRegion = voiceInfo(chosen || auto).region;
  const order = [...groups.keys()].sort((a, b) => (b === selRegion) - (a === selRegion) || groups.get(b).length - groups.get(a).length);
  const fewVoices = vs.length <= 8;
  for (const r of order) {
    const list = groups.get(r).map(v => ({ v, i: voiceInfo(v) }))
      .sort((a, b) => (/природний/.test(b.i.meta) - /природний/.test(a.i.meta)) || a.i.name.localeCompare(b.i.name));
    const open = fewVoices || r === selRegion || voiceOpen.has(r);
    html += `<details class="voice-group" data-region="${esc(r)}" ${open ? 'open' : ''}>
      <summary><span>${esc(regionLabel(r))}</span><span class="voice-count">${list.length}</span></summary>
      <div class="voice-rows">${list.map(({ v, i }) => voiceRow(v.voiceURI, i.name, i.meta, chosen === v, v.voiceURI)).join('')}</div>
    </details>`;
  }
  box.innerHTML = `${head}<div class="voice-options" id="voiceRows">${html}</div>`;
}
let voicePickerOpen = false;
$('#voiceList').addEventListener('change', e => {
  if (e.target.name !== 'voice') return;
  setCfg('voiceURI', e.target.value);
  voicePickerOpen = false; // вибрали — згортаємо
  renderVoiceSettings();
  previewVoice(pickVoice(deck()), $('#voiceList .voice-current .voice-play'));
  $('#voiceList [data-voice-toggle]')?.focus();
});
$('#voiceList').addEventListener('click', e => {
  if (e.target.closest('[data-voice-toggle]')) {
    voicePickerOpen = !voicePickerOpen;
    renderVoiceSettings();
    $('#voiceList [data-voice-toggle]')?.focus();
    return;
  }
  const b = e.target.closest('[data-play]');
  if (b) previewVoice(voices.find(v => v.voiceURI === b.dataset.play), b);
});
$('#voiceList').addEventListener('toggle', e => {
  const r = e.target.dataset?.region;
  if (r == null) return;
  if (e.target.open) voiceOpen.add(r); else voiceOpen.delete(r);
}, true);
/* ---------------- Тема ---------------- */
// Зберігається на пристрої (не синхронізується): на телефоні й ноутбуці можна по-різному
const THEME_KEY = 'slovnyk.theme';
const THEME_BG = { light: '#DDE6E1', dark: '#0E2C2D' };
const getTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; } };
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  // колір смуги браузера: примусова тема перекриває системну
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    m.content = t === 'auto' ? (m.media.includes('dark') ? THEME_BG.dark : THEME_BG.light) : THEME_BG[t];
  });
}
$('#themePick').addEventListener('change', e => {
  const t = e.target.value;
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  applyTheme(t);
});
applyTheme(getTheme());

/* ---------------- Встановлення як застосунок ---------------- */
// Chrome і Edge дають власну кнопку встановлення; Safari — лише вручну через «Поділитися»
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; renderInstall(); });
window.addEventListener('appinstalled', () => { installEvt = null; renderInstall(); toast('Застосунок встановлено'); });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const INSTALL_STEPS = {
  ios: ['iPhone чи iPad', ['Відкрийте сайт у Safari.', 'Натисніть «Поділитися»: квадрат зі стрілкою вгору.', 'Виберіть «На Початковий екран», потім «Додати».']],
  android: ['Android', ['Відкрийте сайт у Chrome.', 'Натисніть меню ⋮ угорі праворуч.', 'Виберіть «Встановити застосунок» або «Додати на головний екран».']],
  desktop: ['Комп’ютер', ['Відкрийте сайт у Chrome або Edge.', 'Натисніть значок встановлення праворуч в адресному рядку або меню ⋮ і «Встановити Словник».']],
  mac: ['Mac із Safari', ['У меню «Файл» виберіть «Додати на Dock».']],
};
function platform() {
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  if (/macintosh/i.test(ua) && /safari/i.test(ua) && !/chrome|crios|edg/i.test(ua)) return 'mac';
  return 'desktop';
}
const stepsHtml = list => list.map(t => `<li>${esc(t)}</li>`).join('');
function renderInstall() {
  const panel = $('#installPanel');
  if (!panel) return;
  const pf = platform();
  if (isStandalone()) {
    $('#installNote').textContent = 'Уже встановлено на цьому пристрої.';
    $('#installBtn').hidden = true;
    $('#installSteps').innerHTML = '';
    $('#installOtherBox').hidden = true;
    return;
  }
  $('#installNote').textContent = 'Відкривається як окремий застосунок і працює без інтернету.';
  $('#installBtn').hidden = !installEvt;
  // якщо браузер сам пропонує встановлення — досить кнопки; інакше кроки для цього пристрою
  $('#installSteps').innerHTML = installEvt ? '' : stepsHtml(INSTALL_STEPS[pf][1]);
  $('#installOtherBox').hidden = false;
  $('#installOther').innerHTML = Object.entries(INSTALL_STEPS)
    .filter(([k]) => installEvt || k !== pf)
    .map(([, [name, list]]) => `<p class="install-os">${esc(name)}</p><ol class="install-steps">${stepsHtml(list)}</ol>`).join('');
}
$('#installBtn').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  const { outcome } = await installEvt.userChoice.catch(() => ({}));
  if (outcome === 'accepted') installEvt = null;
  renderInstall();
});

function renderSettings() {
  const c = cfg();
  renderDecks();
  renderInstall();
  const th = document.querySelector(`#themePick input[value="${getTheme()}"]`); if (th) th.checked = true;
  $('#deckNote').textContent = `Для мови «${langLabelLower(deck())}».`;
  renderVoiceSettings();
  $('#setRate').value = c.rate;
  $('#rateOut').textContent = `${Number(c.rate).toFixed(2)}×`;
  $('#setAuto').checked = c.autoSpeak;
  $('#setAutoEx').checked = c.autoExamples;
  $('#setAutoEx').disabled = !c.autoSpeak;
  renderGoogle();
}
function setCfg(k, v) { const c = cfg(); c[k] = v; c.updatedAt = Date.now(); persist(); }
$('#setRate').addEventListener('input', e => { $('#rateOut').textContent = `${Number(e.target.value).toFixed(2)}×`; });
$('#setRate').addEventListener('change', e => setCfg('rate', +e.target.value));
$('#setAuto').addEventListener('change', e => { setCfg('autoSpeak', e.target.checked); $('#setAutoEx').disabled = !e.target.checked; });
$('#setAutoEx').addEventListener('change', e => setCfg('autoExamples', e.target.checked));
const SAMPLES = { en: 'Hello, how are you?', de: 'Guten Tag, wie geht es Ihnen?', fr: 'Bonjour, comment allez-vous ?', es: 'Hola, ¿qué tal?', it: 'Ciao, come stai?', pl: 'Dzień dobry, jak się masz?', cs: 'Dobrý den, jak se máte?', pt: 'Olá, tudo bem?', ja: 'こんにちは', zh: '你好', ko: '안녕하세요', tr: 'Merhaba, nasılsın?' };

/* ---------------- Перемикач мов (лише в налаштуваннях) ---------------- */
// Кожна мова — скельце: назва, кількість слів, скільки чекає сьогодні.
function renderDecks() {
  const list = decks();
  const grid = $('#deckGrid');
  grid.innerHTML = list.map(l => {
    const c = counts(l);
    const today = c.due + c.fresh;
    const on = l === deck();
    return `<button type="button" class="deck-tile ${on ? 'on' : ''}" data-pick="${esc(l)}" role="radio" aria-checked="${on}">
      <span class="deck-code" aria-hidden="true">${esc(l)}</span>
      <span class="deck-name">${esc(langLabel(l))}</span>
      <span class="deck-sub">${c.total ? nWords(c.total) : 'Без слів'}${today ? `<b>${today} сьогодні</b>` : ''}</span>
    </button>`;
  }).join('') + `<button type="button" class="deck-tile add" id="deckAddOpen" aria-expanded="${!$('#deckAdd').hidden}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
      <span class="deck-name">Додати мову</span>
    </button>`;
  renderLangGrid();
  const canRemove = list.length > 1 && counts().total === 0;
  $('#deckRemove').hidden = !canRemove;
  $('#deckRemove').textContent = `Прибрати мову «${langLabelLower(deck())}»`;
}
function switchDeck(l) {
  if (!db.settings.langs[l] || l === deck()) return;
  db.settings.active = l;
  saveLocal();
  session = null;
  lastSummary = null;
  $('#search').value = '';
  renderSettings();
  toast(`Тепер вивчаєте: ${langLabelLower(l)}`);
}
$('#deckGrid').addEventListener('click', e => {
  if (e.target.closest('#deckAddOpen')) {
    const box = $('#deckAdd');
    box.hidden = !box.hidden;
    e.target.closest('#deckAddOpen').setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) { $('#langSearch').value = ''; renderLangGrid(); $('#langSearch').focus(); }
    return;
  }
  const pick = e.target.closest('[data-pick]')?.dataset.pick;
  if (pick) switchDeck(pick);
});
// стрілки перемикають мову, як у звичайній групі перемикачів
$('#deckGrid').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const tiles = [...$('#deckGrid').querySelectorAll('.deck-tile')];
  const i = tiles.indexOf(document.activeElement);
  if (i < 0) return;
  e.preventDefault();
  tiles[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + tiles.length) % tiles.length].focus();
});
// Мови, які можна додати: українська назва, власна назва й позначка, якщо немає голосу
function renderLangGrid() {
  const have = new Set(decks());
  const q = ($('#langSearch').value || '').trim().toLowerCase();
  const all = [...new Set([...COMMON_LANGS, ...voices.map(v => baseLang(v.lang))])]
    .filter(l => l && l !== 'uk' && !have.has(l) && langLabel(l) !== l)
    .sort(byLabel);
  const shown = q ? all.filter(l => [langLabel(l), autonym(l), l].some(t => t.toLowerCase().includes(q))) : all;
  $('#langGrid').innerHTML = shown.length
    ? shown.map(l => {
        const own = autonym(l);
        const noVoice = voices.length && !voicesFor(l).length;
        // українська назва головна (за нею сортуємо), власна — під нею; якщо браузер її не знає, не дублюємо
        return `<button type="button" class="lang-opt" data-add="${esc(l)}">
          <span class="lang-uk">${esc(langLabel(l))}</span>
          ${own.toLowerCase() !== langLabel(l).toLowerCase() ? `<span class="lang-own" lang="${esc(l)}">${esc(own)}</span>` : ''}
          ${noVoice ? '<span class="lang-novoice">без голосу</span>' : ''}
        </button>`;
      }).join('')
    : `<p class="voice-empty">Мову «${esc(q)}» не знайдено.</p>`;
}
$('#langSearch').addEventListener('input', renderLangGrid);
$('#langGrid').addEventListener('click', e => {
  const l = e.target.closest('[data-add]')?.dataset.add;
  if (!l) return;
  db.settings.langs[l] = { ...langDefaults, updatedAt: Date.now() };
  if (db.meta.removedLangs) delete db.meta.removedLangs[l];
  $('#deckAdd').hidden = true;
  persist();
  switchDeck(l);
});
$('#deckRemove').addEventListener('click', () => {
  const l = deck();
  if (live(l).length || decks().length < 2) return;
  delete db.settings.langs[l];
  (db.meta.removedLangs ||= {})[l] = Date.now();
  db.settings.active = decks()[0];
  persist();
  renderSettings();
  toast(`Мову «${langLabelLower(l)}» прибрано`);
});

/* ---------------- Файл ---------------- */
function exportData() {
  const { clientId, active, ...settings } = db.settings;
  return { app: 'slovnyk', version: 3, exportedAt: Date.now(), words: db.words, settings, removedLangs: db.meta.removedLangs || {}, log: db.log };
}
function mergeIn(remote) {
  if (!remote || !Array.isArray(remote.words)) throw new Error('Файл не схожий на копію словника');
  // Старі копії (одна мова на словник) і файли без мови в словах
  const legacy = !remote.settings?.langs;
  const fallback = legacy && remote.settings?.lang ? baseLang(remote.settings.lang) : deck();
  const rLangs = legacy ? migrate({ settings: { ...remote.settings, lang: fallback } }).settings.langs : remote.settings.langs;

  const map = new Map(db.words.map(w => [w.id, w]));
  let added = 0;
  for (const raw of remote.words) {
    if (!raw?.id) continue;
    const rw = raw.lang || raw.deleted ? raw : { ...raw, lang: fallback };
    const lw = map.get(rw.id);
    if (!lw || (rw.updatedAt || 0) > (lw.updatedAt || 0)) {
      if (!lw && !rw.deleted) added++;
      map.set(rw.id, rw);
    }
  }
  db.words = [...map.values()];

  // Мови: для кожної беремо новіші налаштування; прибрані на іншому пристрої — прибираємо й тут
  const removed = { ...(db.meta.removedLangs || {}) };
  for (const [l, t] of Object.entries(remote.removedLangs || {})) removed[l] = Math.max(t, removed[l] || 0);
  for (const [l, rc] of Object.entries(rLangs || {})) {
    const lc = db.settings.langs[l];
    const newer = lc ? (rc.updatedAt || 0) > (lc.updatedAt || 0) : (rc.updatedAt || 0) >= (removed[l] || 0);
    if (newer) db.settings.langs[l] = { ...langDefaults, ...rc };
  }
  for (const [l, t] of Object.entries(removed)) {
    const lc = db.settings.langs[l];
    if (lc && (lc.updatedAt || 0) < t && !live(l).length && Object.keys(db.settings.langs).length > 1) delete db.settings.langs[l];
  }
  db.meta.removedLangs = removed;
  for (const w of db.words) if (w.lang && !w.deleted && !db.settings.langs[w.lang]) db.settings.langs[w.lang] = { ...langDefaults };
  if (!db.settings.langs[deck()]) db.settings.active = decks()[0];
  mergeLog(remote.log);
  return added;
}
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `slovnyk-${dayKey(Date.now())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#importFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const added = mergeIn(JSON.parse(await f.text()));
    persist();
    toast(added ? `Додано ${nWords(added)} з файлу` : 'Нових слів у файлі немає, наявні оновлено');
    refresh();
  } catch (err) {
    toast(err instanceof SyntaxError ? 'Не вдалося прочитати файл: це не JSON' : err.message);
  }
});

/* ---------------- Google Диск ---------------- */
const G = { token: null, exp: 0, busy: false, timer: null };
try { const t = JSON.parse(localStorage.getItem(TOKEN_KEY)); if (t && t.exp > Date.now()) Object.assign(G, t); } catch {}
const hasToken = () => G.token && Date.now() < G.exp - 60_000;

function loadGis() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => res();
    s.onerror = () => rej(new Error('Не вдалося завантажити вхід Google. Перевірте інтернет.'));
    document.head.append(s);
  });
}
async function signIn() {
  const cid = CLIENT_ID;
  if (!cid) throw new Error('Резервну копію в Google на цьому сайті ще не налаштовано.');
  await loadGis();
  return new Promise((res, rej) => {
    const tc = google.accounts.oauth2.initTokenClient({
      client_id: cid,
      scope: SCOPE,
      callback: r => {
        if (r.error) return rej(new Error('Google не надав доступу до Диска'));
        G.token = r.access_token;
        G.exp = Date.now() + (r.expires_in || 3600) * 1000;
        localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: G.token, exp: G.exp }));
        db.meta.googleLinked = true; saveLocal();
        res(G.token);
      },
      error_callback: err => rej(new Error(err?.type === 'popup_closed' ? 'Вікно входу Google закрито' : err?.type === 'popup_failed_to_open' ? 'Браузер заблокував вікно входу. Дозвольте спливні вікна для цього сайту.' : 'Вхід у Google не вдався')),
    });
    tc.requestAccessToken({ prompt: db.meta.googleLinked ? '' : 'consent' });
  });
}
async function gfetch(url, opts = {}) {
  if (!hasToken()) { const e = new Error('auth'); e.auth = true; throw e; }
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${G.token}` } });
  if (r.status === 401) { G.token = null; localStorage.removeItem(TOKEN_KEY); const e = new Error('auth'); e.auth = true; throw e; }
  if (!r.ok) throw new Error(`Google Диск відповів помилкою ${r.status}`);
  return r;
}
async function sync() {
  if (G.busy) return;
  G.busy = true;
  setSync('busy');
  try {
    const q = encodeURIComponent(`name='${BACKUP_NAME}'`);
    const list = await (await gfetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`)).json();
    const file = list.files?.[0];
    let added = 0;
    if (file) {
      const remote = await (await gfetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)).json();
      added = mergeIn(remote);
    }
    const body = JSON.stringify(exportData());
    if (file) {
      await gfetch(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
    } else {
      const fd = new FormData();
      fd.append('metadata', new Blob([JSON.stringify({ name: BACKUP_NAME, parents: ['appDataFolder'] })], { type: 'application/json' }));
      fd.append('file', new Blob([body], { type: 'application/json' }));
      await gfetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: fd });
    }
    db.meta.lastSync = Date.now();
    db.meta.dirty = false;
    saveLocal();
    setSync('ok');
    if (added) { toast(`З Google отримано ${nWords(added)}`); refresh(); }
    return true;
  } catch (e) {
    if (e.auth) setSync('auth');
    else { setSync('err', e.message); }
    throw e;
  } finally { G.busy = false; renderGoogle(); }
}
function scheduleBackup() {
  db.meta.dirty = true;
  saveLocal();
  clearTimeout(G.timer);
  if (!db.meta.googleLinked) return;
  if (!hasToken()) return setSync('auth');
  G.timer = setTimeout(() => sync().catch(() => {}), 3000);
}

const syncText = $('#syncText'), chip = $('#syncChip');
const hm = t => new Date(t).toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' });
function setSync(state, msg) {
  chip.dataset.state = state;
  syncText.textContent = {
    off: 'Google не підключено',
    busy: 'Зберігаю в Google…',
    ok: db.meta.lastSync ? `Збережено в Google о ${hm(db.meta.lastSync)}` : 'Google підключено',
    auth: 'Увійдіть у Google, щоб зберегти',
    err: 'Не вдалося зберегти в Google',
  }[state];
  chip.title = msg || '';
}
function initialSyncState() {
  chip.hidden = !CLIENT_ID; // без налаштованого Google значок угорі не потрібен
  if (!db.meta.googleLinked) return setSync('off');
  if (!hasToken()) return setSync(db.meta.dirty ? 'auth' : 'ok');
  setSync('ok');
}
function renderGoogle() {
  const linked = db.meta.googleLinked;
  $('#gConnect').hidden = linked && hasToken();
  $('#gConnect').disabled = !CLIENT_ID;
  $('#gSync').hidden = !linked;
  $('#gDisconnect').hidden = !linked;
  const status = $('#gStatus');
  if (!CLIENT_ID) status.textContent = 'На цьому сайті ще не налаштовано. Поки що зберігайте копію у файл.';
  else if (!linked) status.textContent = 'Копія на вашому Google Диску, щоб відновити словник на будь-якому пристрої.';
  else status.textContent = db.meta.lastSync
    ? `Збережено ${new Date(db.meta.lastSync).toLocaleString('uk', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. Оновлюється сама після кожної зміни.`
    : 'Підключено. Ще не синхронізовано.';
}
async function connectAndSync() {
  try {
    if (!hasToken()) await signIn();
    await sync();
    toast('Словник збережено в Google');
  } catch (e) {
    if (!e.auth) toast(e.message);
  }
  renderGoogle();
}
$('#gConnect').addEventListener('click', connectAndSync);
$('#gSync').addEventListener('click', connectAndSync);
chip.addEventListener('click', () => {
  if (chip.dataset.state === 'auth' || chip.dataset.state === 'err') return connectAndSync();
  go('settings');
});
$('#gDisconnect').addEventListener('click', () => {
  if (G.token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(G.token, () => {});
  G.token = null; G.exp = 0;
  localStorage.removeItem(TOKEN_KEY);
  db.meta.googleLinked = false; saveLocal();
  setSync('off'); renderGoogle();
  toast('Google відключено. Копія на Диску залишилася.');
});

/* ---------------- Ціль дня й прогрес (окремо для кожної мови) ---------------- */
// День зараховується, якщо повторено щонайменше goal різних слів.
// Додане цього дня слово рахується як повторене.
const goalOf = (l = deck()) => cfg(l).goal || 10;
const langLog = (l = deck()) => (db.log[l] ||= {});
const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const keyOfDate = d => dayKey(d.getTime());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const todayDate = () => fromKey(dayKey(Date.now()));

function logEvent(w, kind, g) {
  const day = dayKey(Date.now());
  const before = dayCount(day, w.lang);
  const d = (langLog(w.lang)[day] ||= { goal: goalOf(w.lang), w: {} });
  d.goal = goalOf(w.lang);
  const e = (d.w[w.id] ||= { g: [], a: 0 });
  if (kind === 'add') e.a = 1; else e.g.push(g);
  const after = dayCount(day, w.lang);
  if (before < d.goal && after >= d.goal) setTimeout(() => toast('Ціль на сьогодні досягнуто'), 400);
}
function mergeLog(remote) {
  if (!remote || typeof remote !== 'object') return;
  for (const [l, days] of Object.entries(remote)) {
    if (!days || typeof days !== 'object') continue;
    const mine = langLog(l);
    for (const [day, rd] of Object.entries(days)) {
      const ld = mine[day];
      if (!ld) { mine[day] = rd; continue; }
      ld.goal = ld.goal ?? rd.goal;
      for (const [id, re] of Object.entries(rd.w || {})) {
        const le = ld.w[id];
        if (!le) { ld.w[id] = re; continue; }
        le.a = Math.max(le.a || 0, re.a || 0);
        if ((re.g || []).length > (le.g || []).length) le.g = re.g;
      }
    }
  }
}
function dayCount(day, l = deck()) { const d = db.log[l]?.[day]; return d ? Object.keys(d.w).length : 0; }
function dayGoal(day, l = deck()) { return db.log[l]?.[day]?.goal ?? goalOf(l); }
function dayStatus(day, l = deck()) {
  const n = dayCount(day, l);
  return n === 0 ? 'none' : n >= dayGoal(day, l) ? 'done' : 'try';
}
const STATUS_TEXT = { done: 'ціль досягнуто', try: 'спроба', none: 'пропуск' };

function setGoal(n) {
  const v = Math.max(1, Math.min(500, Math.round(n) || 1));
  setCfg('goal', v);
  const today = langLog()[dayKey(Date.now())];
  if (today) today.goal = v; // минулі дні зберігають ціль, яка діяла тоді
  renderProgress();
}

function firstDay(l = deck()) {
  const keys = Object.keys(db.log[l] || {}).filter(k => dayCount(k, l) > 0).sort();
  return keys.length ? fromKey(keys[0]) : todayDate();
}
// Підсумок діапазону дат [from, to], обрізаного сьогоднішнім днем
function rangeStats(from, to) {
  const t = todayDate();
  const end = to > t ? t : to;
  const f = firstDay();
  const start = from < f ? f : from; // дні до початку навчання не рахуємо
  let done = 0, tried = 0, words = 0, days = 0;
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const k = keyOfDate(d);
    const st = dayStatus(k);
    days++;
    words += dayCount(k);
    if (st === 'done') done++; else if (st === 'try') tried++;
  }
  return { done, tried, words, days: Math.max(days, 0) };
}
function periodRange(kind, offset = 0) {
  const t = todayDate();
  if (kind === 'week') { const from = addDays(mondayOf(t), offset * 7); return { from, to: addDays(from, 6) }; }
  if (kind === 'month') { const from = new Date(t.getFullYear(), t.getMonth() + offset, 1); return { from, to: new Date(from.getFullYear(), from.getMonth() + 1, 0) }; }
  if (kind === 'year') { const y = t.getFullYear() + offset; return { from: new Date(y, 0, 1), to: new Date(y, 11, 31) }; }
  return { from: firstDay(), to: t };
}
const nDays = n => `${n} ${plural(n, ['день', 'дні', 'днів'])}`;
const fmtDay = (d, opts = { day: 'numeric', month: 'long' }) => d.toLocaleDateString('uk', opts);
const MONTHS_SHORT = ['січ', 'лют', 'бер', 'кві', 'тра', 'чер', 'лип', 'сер', 'вер', 'жов', 'лис', 'гру'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

let calMonth = null;     // перше число місяця в календарі
let selectedDay = null;  // ключ вибраного дня

function renderProgress() {
  const today = dayKey(Date.now());
  if (!selectedDay) selectedDay = today;
  if (!calMonth) { const t = todayDate(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1); }
  renderToday();
  renderPeriods();
  renderCalendar();
  renderDay();
}

// Один ряд скелець на всю ширину. Понад 20 вони стали б крихтами — тоді суцільна смужка.
function pebblesHtml(n, goal) {
  return goal <= 20
    ? `<div class="pebbles ${goal > 12 ? 'tight' : ''}" aria-hidden="true">${Array.from({ length: goal }, (_, i) =>
        `<i class="${i < n ? 'on' : i === n ? 'next' : ''}"></i>`).join('')}${n > goal ? `<span class="extra">+${n - goal}</span>` : ''}</div>`
    : `<div class="goal-bar" aria-hidden="true"><i style="width:${Math.min(100, (n / goal) * 100)}%"></i></div>`;
}
// Серія: дні поспіль із досягнутою ціллю. Сьогоднішній день серію не обриває, поки не скінчився.
function streaks() {
  const t = todayDate();
  let cur = 0;
  for (let d = dayStatus(keyOfDate(t)) === 'done' ? t : addDays(t, -1); dayStatus(keyOfDate(d)) === 'done'; d = addDays(d, -1)) cur++;
  let best = 0, run = 0;
  for (let d = firstDay(); d <= t; d = addDays(d, 1)) {
    run = dayStatus(keyOfDate(d)) === 'done' ? run + 1 : 0;
    if (run > best) best = run;
  }
  return { cur, best };
}
function streakLine() {
  const { cur, best } = streaks();
  if (!best) return '';
  if (!cur) return `<p class="streak">Найдовша серія: ${nDays(best)}</p>`;
  return `<p class="streak"><b>${nDays(cur)} поспіль</b>${best > cur ? `, найдовша серія ${nDays(best)}` : ', це ваш рекорд'}</p>`;
}
function renderToday() {
  const today = dayKey(Date.now());
  const n = dayCount(today), goal = goalOf();
  const done = n >= goal;
  const head = done ? 'Ціль досягнуто' : `Сьогодні ${n} з ${goal}`;
  const pebbles = pebblesHtml(n, goal);
  $('#todayCard').innerHTML = `
    <h2>${head}</h2>
    ${streakLine()}
    <div role="progressbar" aria-label="Ціль дня" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.min(n, goal)}">${pebbles}</div>
    <div class="goal-row">
      <span id="goalLabel">Ціль на день</span>
      <div class="stepper" role="group" aria-labelledby="goalLabel">
        <button type="button" class="icon-btn" data-goal="-1" aria-label="Зменшити ціль"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button>
        <input id="goalInput" type="number" inputmode="numeric" min="1" max="500" value="${goal}" aria-label="Слів на день">
        <button type="button" class="icon-btn" data-goal="1" aria-label="Збільшити ціль"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg></button>
      </div>
    </div>`;
}
$('#todayCard').addEventListener('click', e => {
  const b = e.target.closest('[data-goal]');
  if (b) setGoal(goalOf() + Number(b.dataset.goal));
});
// колесо миші над полем числа не повинно непомітно змінювати ціль
$('#todayCard').addEventListener('wheel', e => { if (e.target.id === 'goalInput') e.target.blur(); }, { passive: true });
$('#todayCard').addEventListener('change', e => { if (e.target.id === 'goalInput') setGoal(parseInt(e.target.value, 10)); });

function renderPeriods() {
  const tiles = [
    ['week', 'Цей тиждень'],
    ['month', fmtDay(todayDate(), { month: 'long' }).replace(/^./, c => c.toUpperCase())],
    ['year', `${todayDate().getFullYear()} рік`],
    ['all', 'Увесь час'],
  ];
  const yr = periodRange('year');
  const allSame = firstDay() >= yr.from; // увесь час = цей рік, поки вчите менше року
  const c = counts();
  $('#periodGrid').innerHTML = tiles.map(([kind, name]) => {
    if (kind === 'all' && allSame) {
      return `<div class="period static" aria-label="Вивчено ${nWords(c.learned)} з ${c.total}">
        <span class="period-name">Вивчено</span>
        <span class="period-num">${c.learned}</span>
        <span class="period-sub">з ${nWords(c.total)}</span>
      </div>`;
    }
    const { from, to } = periodRange(kind);
    const st = rangeStats(from, to);
    return `<button type="button" class="period" data-period="${kind}" aria-label="${name}: ціль досягнуто ${nDays(st.done)} з ${st.days}. Відкрити діаграму">
      <span class="period-name">${name}</span>
      <span class="period-num">${st.done}</span>
      <span class="period-sub">${plural(st.done, ['день', 'дні', 'днів'])} з ${st.days}</span>
    </button>`;
  }).join('');
}
$('#periodGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-period]');
  if (b) openChart(b.dataset.period, 0);
});

/* ---- Календар ---- */
function renderCalendar() {
  const t = todayDate();
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const title = calMonth.toLocaleDateString('uk', { month: 'long', year: 'numeric' }).replace(' р.', '');
  $('#calTitle').textContent = title[0].toUpperCase() + title.slice(1);
  $('#calNext').disabled = y === t.getFullYear() && m === t.getMonth();
  const f = firstDay();
  $('#calPrev').disabled = calMonth <= new Date(f.getFullYear(), f.getMonth(), 1);
  const lead = (calMonth.getDay() + 6) % 7;
  const daysIn = new Date(y, m + 1, 0).getDate();
  const todayKey = keyOfDate(t);
  let html = WEEKDAYS.map(w => `<span class="cal-wd" aria-hidden="true">${w}</span>`).join('');
  html += Array.from({ length: lead }, () => '<span class="cal-pad" aria-hidden="true"></span>').join('');
  for (let d = 1; d <= daysIn; d++) {
    const date = new Date(y, m, d);
    const k = keyOfDate(date);
    const future = date > t;
    const st = future ? 'future' : dayStatus(k);
    const n = dayCount(k);
    const label = `${fmtDay(date)}: ${future ? 'ще не настав' : `${nWords(n)}, ${STATUS_TEXT[st]}`}`;
    html += `<button type="button" class="cal-day ${st} ${k === todayKey ? 'is-today' : ''} ${k === selectedDay ? 'sel' : ''}" data-day="${k}" ${future ? 'disabled' : ''} aria-label="${label}" ${k === selectedDay ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${d}</button>`;
  }
  $('#calGrid').innerHTML = html;
}
$('#calPrev').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1); renderCalendar(); });
$('#calNext').addEventListener('click', () => { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1); renderCalendar(); });
$('#calGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  selectedDay = b.dataset.day;
  dayAll = false;
  renderCalendar();
  renderDay();
  if (matchMedia('(max-width: 700px)').matches) $('#dayPanel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
});

/* ---- Статистика дня ---- */
// Спільна для вкладок «Прогрес» і «Повторення». Список — лише нові слова, додані цього дня.
// withLine: рядок «N слів при цілі G» (на вкладці повторення ціль уже показують скельця)
function dayStatsBody(k, { withLine = true, expanded = false } = {}) {
  const d = langLog()[k];
  const entries = d ? Object.entries(d.w) : [];
  const n = entries.length;
  if (!n) return '';
  const goal = dayGoal(k), st = dayStatus(k);
  const byId = new Map(db.words.map(w => [w.id, w]));
  const fresh = entries.filter(([, e]) => e.a).map(([id]) => byId.get(id));
  const reviewed = n - fresh.length;
  const grades = [0, 0, 0, 0];
  for (const [, e] of entries) for (const g of e.g || []) grades[g]++;
  const names = ['Знову', 'Важко', 'Добре', 'Легко'];
  const shown = expanded ? fresh : fresh.slice(0, 5);
  return `
    ${withLine ? `<p class="day-line"><span class="st-mark ${st}" aria-hidden="true"></span>${nWords(n)} при цілі ${goal}: ${STATUS_TEXT[st]}.</p>` : ''}
    <div class="day-nums">
      <p class="day-num"><b>${reviewed}</b><span>повторено</span></p>
      <p class="day-num"><b>${fresh.length}</b><span>${plural(fresh.length, ['нове', 'нові', 'нових'])}</span></p>
    </div>
    ${answersHtml(grades)}
    ${fresh.length ? `<ul class="day-words">${shown.map(w => `<li>
      <span class="dw-text">
        <span class="dw-word" lang="${esc(deck())}">${w && !w.deleted ? esc(w.word) : 'Видалене слово'}</span>
        ${w && !w.deleted ? `<span class="dw-tr">${esc(w.translation)}</span>` : ''}
      </span>
    </li>`).join('')}</ul>` : ''}
    ${fresh.length > 5 ? `<button type="button" class="btn ghost small day-more" data-day-more>${expanded ? 'Згорнути' : `Показати всі ${fresh.length}`}</button>` : ''}`;
}
// Відповіді — окремо від слів: смужка з чотирьох частин (за кількістю натискань) і легенда з числами.
// Одне слово може мати кілька відповідей («Знову», потім «Добре»), тож суму зі словами не порівнюємо.
function answersHtml(grades) {
  const total = grades.reduce((a, b) => a + b, 0);
  if (!total) return '';
  const names = ['Знову', 'Важко', 'Добре', 'Легко'];
  const label = names.map((nm, i) => `${nm} ${grades[i]}`).join(', ');
  return `<div class="answers">
    <div class="ans-bar" role="img" aria-label="Відповіді: ${label}">${grades.map((c, i) => (c ? `<i class="ans-g${i}" style="flex-grow:${c}"></i>` : '')).join('')}</div>
    <ul class="ans-legend">${grades.map((c, i) => `<li class="${c ? '' : 'zero'}"><i class="ans-dot ans-g${i}" aria-hidden="true"></i>${names[i]} <b>${c}</b></li>`).join('')}</ul>
  </div>`;
}
function renderDay() {
  const k = selectedDay;
  const date = fromKey(k);
  const isToday = k === dayKey(Date.now());
  const weekday = date.toLocaleDateString('uk', { weekday: 'long' });
  const title = `${isToday ? 'Сьогодні' : weekday[0].toUpperCase() + weekday.slice(1)}, ${fmtDay(date)}`;
  const body = dayStatsBody(k, { expanded: dayAll })
    || `<p class="day-line">${isToday ? 'Сьогодні ще не було повторень.' : 'Цього дня повторень не було.'}</p>`;
  $('#dayPanel').innerHTML = `<h2>${title}</h2>${body}`;
}
// Те саме за сьогодні — на вкладці «Повторення»; поки нічого не повторено, блоку немає
let reviewDayAll = false;
function todayStatsPanel() {
  const body = dayStatsBody(dayKey(Date.now()), { withLine: false, expanded: reviewDayAll });
  return body ? `<div class="panel glass day-panel review-day"><h2>Сьогодні</h2>${body}</div>` : '';
}
let dayAll = false; // розгорнутий список слів дня
$('#dayPanel').addEventListener('click', e => {
  if (!e.target.closest('[data-day-more]')) return;
  dayAll = !dayAll;
  renderDay();
  $('#dayPanel [data-day-more]')?.focus();
});

/* ---- Діаграми за період ---- */
const chartDlg = $('#chartDlg');
let chartState = { kind: 'week', offset: 0 };

function chartData(kind, offset) {
  const t = todayDate();
  const { from, to } = periodRange(kind, offset);
  const bars = [];
  if (kind === 'week' || kind === 'month') {
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      const k = keyOfDate(d);
      const future = d > t;
      const n = future ? 0 : dayCount(k);
      const st = future ? 'future' : dayStatus(k);
      bars.push({
        key: k, value: n, status: st,
        label: kind === 'week' ? WEEKDAYS[(d.getDay() + 6) % 7] : String(d.getDate()),
        showLabel: kind === 'week' || d.getDate() === 1 || d.getDate() % 5 === 0,
        info: future ? `${fmtDay(d, { weekday: 'short', day: 'numeric', month: 'long' })}: ще не настав` : `${fmtDay(d, { weekday: 'short', day: 'numeric', month: 'long' })}: ${nWords(n)} при цілі ${dayGoal(k)}, ${STATUS_TEXT[st]}`,
      });
    }
    return { bars, unit: 'words', goal: goalOf(), from, to };
  }
  // рік і весь час: стовпчик = місяць, висота = днів із досягнутою ціллю
  const months = [];
  if (kind === 'year') for (let m = 0; m < 12; m++) months.push(new Date(from.getFullYear(), m, 1));
  else for (let d = new Date(from.getFullYear(), from.getMonth(), 1); d <= t; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d);
  for (const ms of months) {
    const me = new Date(ms.getFullYear(), ms.getMonth() + 1, 0);
    const future = ms > t;
    const s = future ? { done: 0, words: 0, days: 0 } : rangeStats(ms, me);
    const monthName = ms.toLocaleDateString('uk', { month: 'long', year: kind === 'all' ? 'numeric' : undefined });
    bars.push({
      key: keyOfDate(ms), value: s.done, status: future ? 'future' : s.done ? 'done' : 'none',
      max: me.getDate(),
      label: MONTHS_SHORT[ms.getMonth()] + (kind === 'all' && ms.getMonth() === 0 ? ` ${ms.getFullYear()}` : ''),
      showLabel: kind === 'year' || months.length <= 12 || ms.getMonth() % 3 === 0,
      info: future ? `${monthName}: ще не настав` : `${monthName}: ціль досягнуто ${nDays(s.done)} з ${s.days}, ${nWords(s.words)}`,
    });
  }
  return { bars, unit: 'days', from, to };
}

function chartTitle(kind, offset, from, to) {
  if (kind === 'week') return offset === 0 ? 'Цей тиждень' : offset === -1 ? 'Минулий тиждень' : `${fmtDay(from)} – ${fmtDay(to)}`;
  if (kind === 'month') { const s = from.toLocaleDateString('uk', { month: 'long', year: 'numeric' }).replace(' р.', ''); return s[0].toUpperCase() + s.slice(1); }
  if (kind === 'year') return `${from.getFullYear()} рік`;
  return 'Увесь час';
}

function renderChart() {
  const { kind, offset } = chartState;
  const data = chartData(kind, offset);
  const { from, to } = data;
  const st = rangeStats(from, to > todayDate() ? todayDate() : to);
  $('#chartTitle').textContent = chartTitle(kind, offset, from, to);
  $('#chartPrev').hidden = kind === 'all';
  $('#chartNext').hidden = kind === 'all';
  $('#chartPrev').disabled = from <= firstDay();
  $('#chartNext').disabled = offset >= 0;
  const avg = st.days ? Math.round(st.words / st.days) : 0;
  $('#chartSummary').textContent = st.days
    ? `Ціль ${nDays(st.done)} з ${st.days}. ${nWords(st.words)}, ${avg} на день.`
    : to < firstDay() ? 'У цей період ви ще не вчили цю мову.' : 'Цей період ще не настав.';

  let yMax, goalLine = null, yLabel;
  if (data.unit === 'words') {
    const peak = Math.max(data.goal, ...data.bars.map(b => b.value));
    yMax = Math.ceil(peak * 1.15) || 1;
    goalLine = data.goal;
    yLabel = 'слів за день';
  } else {
    yMax = 31;
    yLabel = 'днів із досягнутою ціллю';
  }
  const pct = v => `${Math.max(0, Math.min(100, (v / yMax) * 100))}%`;
  const many = data.bars.length > 14;
  $('#chartBody').innerHTML = `
    <div class="chart ${many ? 'dense' : ''}">
      <div class="chart-y" aria-hidden="true"><span style="bottom:100%">${yMax}</span><span style="bottom:0">0</span></div>
      <div class="chart-plot">
        ${goalLine ? `<div class="goal-line" style="bottom:${pct(goalLine)}"><span>ціль ${goalLine}</span></div>` : ''}
        ${data.bars.map((b, i) => `<button type="button" class="bar ${b.status}" data-i="${i}" aria-label="${esc(b.info)}">
          <i style="height:${b.value ? pct(b.value) : '0%'}"></i>
        </button>`).join('')}
      </div>
      <div class="chart-x" aria-hidden="true">${data.bars.map(b => `<span>${b.showLabel ? esc(b.label) : ''}</span>`).join('')}</div>
    </div>
    <p class="chart-axis-note">${yLabel[0].toUpperCase() + yLabel.slice(1)}</p>
    <p class="chart-info" id="chartInfo" aria-live="polite">Торкніться стовпчика.</p>`;
  chartDlg._bars = data.bars;
  chartDlg._kind = kind;
}
function showBarInfo(i) {
  const b = chartDlg._bars?.[i];
  if (!b) return;
  const canOpen = (chartDlg._kind === 'week' || chartDlg._kind === 'month') && b.status !== 'future';
  $('#chartInfo').innerHTML = `${esc(b.info)}${canOpen ? ` <button type="button" class="link-inline" data-open-day="${b.key}">Відкрити день</button>` : ''}`;
  $('#chartBody').querySelectorAll('.bar').forEach((el, j) => el.classList.toggle('hot', j === i));
}
$('#chartBody').addEventListener('pointerover', e => { const b = e.target.closest('.bar'); if (b) showBarInfo(+b.dataset.i); });
$('#chartBody').addEventListener('focusin', e => { const b = e.target.closest('.bar'); if (b) showBarInfo(+b.dataset.i); });
$('#chartBody').addEventListener('click', e => {
  const open = e.target.closest('[data-open-day]');
  if (open) {
    selectedDay = open.dataset.openDay;
    const d = fromKey(selectedDay);
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    chartDlg.close();
    renderCalendar(); renderDay();
    $('#dayPanel').scrollIntoView({ block: 'nearest' });
    return;
  }
  const b = e.target.closest('.bar');
  if (b) showBarInfo(+b.dataset.i);
});
function openChart(kind, offset) {
  chartState = { kind, offset };
  renderChart();
  chartDlg.showModal();
  $('#chartTitle').focus();
}
$('#chartPrev').addEventListener('click', () => { chartState.offset--; renderChart(); });
$('#chartNext').addEventListener('click', () => { if (chartState.offset < 0) { chartState.offset++; renderChart(); } });
$('#chartClose').addEventListener('click', () => chartDlg.close());
chartDlg.addEventListener('click', e => { if (e.target === chartDlg) chartDlg.close(); });

/* ---------------- Дрібниці ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Інша вкладка зберегла зміни: беремо їх, щоб вкладки не затирали одна одну
window.addEventListener('storage', e => {
  if (e.key === THEME_KEY) { applyTheme(getTheme()); if (currentView === 'settings') renderSettings(); return; }
  if (e.key !== KEY || !e.newValue) return;
  const fresh = load();
  db.words = fresh.words; db.settings = fresh.settings; db.meta = fresh.meta; db.log = fresh.log;
  if (session) session.queue = session.queue.filter(id => db.words.some(w => w.id === id && !w.deleted && w.lang === deck()));
  refresh();
});

// Повернулися до вкладки — підтягнути зміни з інших пристроїв
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && db.meta.googleLinked && hasToken() && Date.now() - (db.meta.lastSync || 0) > 5 * MIN) sync().catch(() => {});
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

if (synth) { loadVoices(); synth.addEventListener?.('voiceschanged', loadVoices); }
initialSyncState();
go('review');
if (db.meta.googleLinked && hasToken()) sync().catch(() => {});
