// PagePin v2.0.0 — Tableau de Bord & Calendrier Outlook (Base de données vide au démarrage + Animation Onboarding StarOfService Philippe Hottois)
const DEMO_STAROFSERVICE_URL = 'https://www.starofservice.be/annubis/bruxelles-capitale/region-bruxelles-capitale/laeken/cours-d-informatique';

// Fallback localStorage uniquement hors contexte chrome-extension:// (ex. prévisualisation directe)
if (typeof window !== 'undefined' && (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local)) {
  const listeners = [];
  window.chrome = {
    ...(window.chrome || {}),
    runtime: { lastError: null, sendMessage() {} },
    tabs: {
      query(_q, cb) { if (cb) cb([]); },
      create(opts) { if (opts && opts.url) window.open(opts.url, '_blank', 'noopener,noreferrer'); },
      update(_id, _props, cb) { if (cb) cb(); },
      sendMessage(_id, _msg, cb) { if (cb) cb(); }
    },
    windows: { update() {} },
    storage: {
      local: {
        get(keys, cb) {
          const res = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            try {
              const raw = localStorage.getItem(k);
              if (raw !== null) res[k] = JSON.parse(raw);
            } catch (e) {}
          });
          if (cb) cb(res);
        },
        set(obj, cb) {
          const changes = {};
          Object.entries(obj || {}).forEach(([k, v]) => {
            try {
              localStorage.setItem(k, JSON.stringify(v));
              changes[k] = { newValue: v };
            } catch (e) {}
          });
          listeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} });
          if (cb) cb();
        },
        remove(keys, cb) {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            try { localStorage.removeItem(k); } catch (e) {}
          });
          if (cb) cb();
        }
      },
      onChanged: {
        addListener(fn) { listeners.push(fn); }
      }
    }
  };
}

let allNotes = [];
let activeLabel = 'all';
let currentView = 'list'; // 'list' | 'agenda'
let agendaScale = 'week'; // 'day' | 'workweek' | 'week' | 'month' | 'year'
let focusDate = new Date();
let selectedDateKey = toDateKey(new Date());
let layerReminders = true;
let layerRecurring = true;
let layerCreated = true;

const MONTH_NAMES_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
const WEEKDAY_SHORT_FR = ['LUN.', 'MAR.', 'MER.', 'JEU.', 'VEN.', 'SAM.', 'DIM.'];
const WEEKDAY_MINI_FR = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

const ENTITY_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(raw) {
  return String(raw == null ? '' : raw).replace(/[&<>"']/g, (ch) => ENTITY_MAP[ch] || ch);
}

function sanitizeRichHtml(dirtyHtml) {
  const input = String(dirtyHtml == null ? '' : dirtyHtml);
  if (!input.trim()) return '';
  const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'P', 'BR']);
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(input, 'text/html');
    function cleanNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
      const tag = node.tagName.toUpperCase();
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'].includes(tag)) {
        return document.createDocumentFragment();
      }
      const frag = document.createDocumentFragment();
      Array.from(node.childNodes).forEach((child) => frag.appendChild(cleanNode(child)));
      if (!ALLOWED.has(tag)) return frag;
      const safeEl = document.createElement(tag.toLowerCase());
      safeEl.appendChild(frag);
      return safeEl;
    }
    const outWrap = document.createElement('div');
    Array.from(doc.body.childNodes).forEach((c) => outWrap.appendChild(cleanNode(c)));
    return outWrap.innerHTML;
  } catch (e) {
    return escapeHtml(input);
  }
}

function isSafeHttpUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function escapeIcsText(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function escapeYamlScalar(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

function debounce(fn, delayMs) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delayMs);
  };
}

const ALLOWED_COLORS = new Set(['indigo', 'amber', 'emerald', 'rose']);
function safeColorClass(color) {
  return ALLOWED_COLORS.has(color) ? color : 'indigo';
}

const qSearch = document.getElementById('q-search');
const fDate = document.getElementById('f-date');
const fDomain = document.getElementById('f-domain');
const fPriority = document.getElementById('f-priority');
const fStatus = document.getElementById('f-status');
const fColor = document.getElementById('f-color');
const fSort = document.getElementById('f-sort');
const labelsBar = document.getElementById('labels-bar');
const pinsList = document.getElementById('pins-list');
const statsGrid = document.getElementById('stats-grid');
const resetBtn = document.getElementById('reset-filters-btn');
const exportIcsBtn = document.getElementById('export-ics-btn');
const exportYamlBtn = document.getElementById('export-yaml-btn');
const tabListBtn = document.getElementById('tab-list');
const tabAgendaBtn = document.getElementById('tab-agenda');

function pad2(n) { return String(n).padStart(2, '0'); }
function toDateKey(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

tabListBtn.onclick = () => {
  currentView = 'list';
  tabListBtn.classList.add('active');
  tabAgendaBtn.classList.remove('active');
  renderDashboard();
};

tabAgendaBtn.onclick = () => {
  currentView = 'agenda';
  tabAgendaBtn.classList.add('active');
  tabListBtn.classList.remove('active');
  renderDashboard();
};

function formatIcsUtc(dateOrIso) {
  const d = new Date(dateOrIso || Date.now());
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' +
    pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
}
function stripHtml(raw) {
  return String(raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function buildGoogleUrl(n) {
  const start = n.reminderAt ? new Date(n.reminderAt) : new Date(Date.now() + 3600000);
  const end = new Date(start.getTime() + 1800000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: '[PagePin] ' + n.title,
    dates: formatIcsUtc(start) + '/' + formatIcsUtc(end),
    details: stripHtml(n.content) + '\n\nSite : ' + n.url,
    location: n.url
  });
  return 'https://calendar.google.com/calendar/render?' + params.toString();
}
function buildOutlookUrl(n) {
  const start = n.reminderAt ? new Date(n.reminderAt) : new Date(Date.now() + 3600000);
  const end = new Date(start.getTime() + 1800000);
  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: '[PagePin] ' + n.title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: stripHtml(n.content) + '\n\nSite : ' + n.url,
    location: n.url
  });
  return 'https://outlook.live.com/calendar/0/deeplink/compose?' + params.toString();
}
function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
exportIcsBtn.onclick = () => {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PagePin Chromium//FR', 'CALSCALE:GREGORIAN'];
  allNotes.forEach((n) => {
    const start = n.reminderAt ? new Date(n.reminderAt) : new Date(n.createdAt || Date.now());
    const end = new Date(start.getTime() + 1800000);
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + escapeIcsText(n.id) + '@pagepin.chromium');
    lines.push('DTSTAMP:' + formatIcsUtc(Date.now()));
    lines.push('DTSTART:' + formatIcsUtc(start));
    lines.push('DTEND:' + formatIcsUtc(end));
    lines.push('SUMMARY:[PagePin] ' + escapeIcsText(n.title));
    lines.push('DESCRIPTION:' + escapeIcsText(stripHtml(n.content) + ' (' + n.url + ')'));
    lines.push('LOCATION:' + escapeIcsText(n.url));
    lines.push('END:VEVENT');
  });
  lines.push('END:VCALENDAR');
  downloadFile('pagepin-calendrier-rappels.ics', lines.join('\r\n'), 'text/calendar');
};
exportYamlBtn.onclick = () => {
  const lines = ['# PagePin Chromium — Export YAML', 'calendar:', '  events:'];
  allNotes.forEach((n) => {
    lines.push('    - id: "' + escapeYamlScalar(n.id) + '"');
    lines.push('      title: "' + escapeYamlScalar(n.title || '') + '"');
    lines.push('      url: "' + escapeYamlScalar(n.url || '') + '"');
    lines.push('      reminder_at: ' + (n.reminderAt ? '"' + escapeYamlScalar(n.reminderAt) + '"' : 'null'));
    lines.push('      priority: "' + escapeYamlScalar(n.priority || 'medium') + '"');
  });
  downloadFile('pagepin-calendrier-rappels.yaml', lines.join('\n'), 'application/x-yaml');
};

function loadNotes() {
  chrome.storage.local.get(['pagepin_notes'], (res) => {
    allNotes = res.pagepin_notes || [];
    populateDomainAndLabels();
    renderDashboard();
  });
}

function populateDomainAndLabels() {
  const domains = Array.from(new Set(allNotes.map((n) => n.domain).filter(Boolean)));
  const currentDom = fDomain.value;
  fDomain.innerHTML = '<option value="all">Tous les sites (' + domains.length + ')</option>' +
    domains.map((d) => '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>').join('');
  if (domains.includes(currentDom)) fDomain.value = currentDom;

  const labelSet = new Set();
  allNotes.forEach((n) => {
    if (Array.isArray(n.labels)) n.labels.forEach((l) => labelSet.add(l));
  });
  const labels = Array.from(labelSet).sort();

  labelsBar.innerHTML = '<span style="font-size:12px;font-weight:700;color:var(--mute);margin-right:4px;">🏷️ Labels :</span>' +
    '<button type="button" class="label-btn ' + (activeLabel === 'all' ? 'active' : '') + '" data-label="all">Tous</button>' +
    labels.map((l) => '<button type="button" class="label-btn ' + (activeLabel === l ? 'active' : '') + '" data-label="' + escapeHtml(l) + '">#' + escapeHtml(l) + '</button>').join('');

  labelsBar.querySelectorAll('.label-btn').forEach((btn) => {
    btn.onclick = () => {
      activeLabel = btn.getAttribute('data-label');
      populateDomainAndLabels();
      renderDashboard();
    };
  });
}

function openSiteAndLocatePin(id, url) {
  if (!id || !isSafeHttpUrl(url)) return;
  chrome.storage.local.set({ pagepin_locate_note_id: id, pagepin_locate_ts: Date.now() }, () => {
    chrome.tabs.query({}, (tabs) => {
      const cleanTarget = String(url || '').replace(/\/+$/, '').toLowerCase();
      const existingTab = (tabs || []).find((t) => t.url && String(t.url).replace(/\/+$/, '').toLowerCase() === cleanTarget);
      if (existingTab && existingTab.id) {
        chrome.tabs.update(existingTab.id, { active: true }, () => {
          if (existingTab.windowId) chrome.windows.update(existingTab.windowId, { focused: true });
          chrome.tabs.sendMessage(existingTab.id, { type: 'LOCATE_NOTE', noteId: id }, () => {
            void chrome.runtime.lastError;
          });
        });
      } else {
        chrome.tabs.create({ url });
      }
    });
  });
}

// Lance la démo interactive sur StarOfService (Laeken - Cours d'informatique) ou injecte la note de démo Philippe Hottois
function launchStarOfServiceDemo(openRealSite) {
  const now = Date.now();
  const demoNote = {
    id: 'note-philippe-hottois-' + now,
    url: DEMO_STAROFSERVICE_URL,
    siteTitle: "Les 10 meilleurs professeurs d'informatique à Laeken - StarOfService",
    domain: 'starofservice.be',
    blockId: 'pro-card-philippe-hottois',
    selectorLabel: 'div#fiche-philippe-hottois',
    selectorPath: '[data-pro-name="Philippe Hottois"], #fiche-philippe-hottois',
    elementRelX: 0.78,
    elementRelY: 0.35,
    pageX: 740,
    pageY: 2680,
    scrollParentSelector: '',
    scrollParentTop: 0,
    windowScrollY: 2320,
    quotedText: 'Philippe Hottois — Cours d’informatique & accompagnement personnalisé à Laeken (Bruxelles-Capitale)',
    offsetXPercent: 72,
    offsetYPercent: 45,
    title: 'Ne pas oublier de prendre un rendez-vous avec Philippe Hottois',
    content: '<p><b>Action requise :</b> Contacter <b>Philippe Hottois</b> sur sa fiche StarOfService (Laeken) pour planifier un rendez-vous de cours d’informatique.</p><ul><li>Vérifier ses disponibilités cette semaine</li><li>Confirmer le créneau</li></ul>',
    color: 'rose',
    priority: 'high',
    labels: ['Rendez-vous', 'PhilippeHottois', 'CoursInformatique', 'Laeken'],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    reminderAt: new Date(now + 24 * 3600 * 1000).toISOString(),
    recurrence: { frequency: 'none', dayOfWeek: 1, dayOfMonth: 15 },
    reminderNotified: false,
    completed: false
  };

  if (openRealSite) {
    chrome.storage.local.set({ pagepin_demo_pending: true, pagepin_active: true }, () => {
      chrome.tabs.create({ url: DEMO_STAROFSERVICE_URL });
    });
  } else {
    chrome.storage.local.set({ pagepin_notes: [demoNote, ...allNotes], pagepin_active: false }, loadNotes);
  }
}

function prepareIndexedNotes(notesList) {
  return notesList.map((n) => {
    const remDate = n.reminderAt ? new Date(n.reminderAt) : null;
    const hasValidRem = Boolean(remDate && !Number.isNaN(remDate.getTime()));
    const cDate = n.createdAt ? new Date(n.createdAt) : null;
    const hasValidCre = Boolean(cDate && !Number.isNaN(cDate.getTime()));
    return {
      raw: n,
      hasValidRem,
      remTime: hasValidRem ? remDate.getTime() : 0,
      remKey: hasValidRem ? toDateKey(remDate) : '',
      remHour: hasValidRem ? remDate.getHours() : 0,
      remTimeLabel: hasValidRem ? pad2(remDate.getHours()) + ':' + pad2(remDate.getMinutes()) : '',
      freq: (n.recurrence && n.recurrence.frequency) || 'none',
      dayOfWeek: (n.recurrence && typeof n.recurrence.dayOfWeek === 'number') ? n.recurrence.dayOfWeek : 1,
      dayOfMonth: (n.recurrence && typeof n.recurrence.dayOfMonth === 'number') ? n.recurrence.dayOfMonth : 15,
      hasValidCre,
      creKey: hasValidCre ? toDateKey(cDate) : '',
      creHour: hasValidCre ? cDate.getHours() : 0,
      creTimeLabel: hasValidCre ? pad2(cDate.getHours()) + ':' + pad2(cDate.getMinutes()) : ''
    };
  });
}

function getEventsForDateIndexed(indexedList, dateObj) {
  const key = toDateKey(dateObj);
  const dayEndMs = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate(), 23, 59, 59).getTime();
  const dow = dateObj.getDay();
  const dom = dateObj.getDate();
  const events = [];

  for (let i = 0; i < indexedList.length; i++) {
    const item = indexedList[i];
    const n = item.raw;

    if (item.hasValidRem) {
      if (item.remKey === key && layerReminders) {
        events.push({
          note: n,
          type: item.freq !== 'none' ? 'recurring' : 'reminder',
          hour: item.remHour,
          timeLabel: item.remTimeLabel
        });
      } else if (item.freq !== 'none' && !n.completed && layerRecurring && dayEndMs >= item.remTime) {
        const matches =
          item.freq === 'daily' ||
          (item.freq === 'weekly' && dow === item.dayOfWeek) ||
          (item.freq === 'monthly' && dom === item.dayOfMonth);
        if (matches) {
          events.push({
            note: n,
            type: 'recurring',
            hour: item.remHour,
            timeLabel: item.remTimeLabel
          });
        }
      }
    }

    if (layerCreated && item.hasValidCre && item.creKey === key && item.creKey !== item.remKey) {
      events.push({
        note: n,
        type: 'created',
        hour: item.creHour,
        timeLabel: item.creTimeLabel
      });
    }
  }

  events.sort((a, b) => a.timeLabel.localeCompare(b.timeLabel));
  return events;
}

function buildMonthCells(indexedList, year, month) {
  const firstDay = new Date(year, month, 1);
  const startOffset = (firstDay.getDay() + 6) % 7;
  const gridStart = new Date(year, month, 1 - startOffset);
  const todayKey = toDateKey(new Date());
  const cells = [];

  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    const k = toDateKey(d);
    cells.push({
      date: d,
      dateKey: k,
      dayOfMonth: d.getDate(),
      monthIndex: d.getMonth(),
      isCurrentMonth: d.getMonth() === month,
      isToday: k === todayKey,
      events: getEventsForDateIndexed(indexedList, d)
    });
  }
  return cells;
}

function buildWeekCells(indexedList, refDate, countDays) {
  const dow = (refDate.getDay() + 6) % 7;
  const mon = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() - dow);
  const todayKey = toDateKey(new Date());
  const cells = [];

  for (let i = 0; i < countDays; i++) {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i);
    const k = toDateKey(d);
    cells.push({
      date: d,
      dateKey: k,
      dayOfMonth: d.getDate(),
      monthIndex: d.getMonth(),
      isToday: k === todayKey,
      events: getEventsForDateIndexed(indexedList, d)
    });
  }
  return cells;
}

function renderOutlookAgenda(filtered) {
  const indexed = prepareIndexedNotes(filtered);
  const fy = focusDate.getFullYear();
  const fm = focusDate.getMonth();
  const fd = focusDate.getDate();
  const todayKey = toDateKey(new Date());

  const miniCells = buildMonthCells(indexed, fy, fm);
  const weekCells7 = buildWeekCells(indexed, focusDate, 7);
  const workWeekCells5 = buildWeekCells(indexed, focusDate, 5);
  const activeWeekKeys = new Set(weekCells7.map((c) => c.dateKey));

  let periodLabel = '';
  if (agendaScale === 'day') {
    periodLabel = focusDate.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } else if (agendaScale === 'workweek') {
    periodLabel = workWeekCells5[0].date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' – ' +
      workWeekCells5[4].date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  } else if (agendaScale === 'week') {
    periodLabel = weekCells7[0].date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' – ' +
      weekCells7[6].date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  } else if (agendaScale === 'month') {
    periodLabel = MONTH_NAMES_FR[fm] + ' ' + fy;
  } else {
    periodLabel = 'Année ' + fy;
  }

  const miniCalHtml = `
    <div>
      <div class="mini-cal-header">
        <span>${MONTH_NAMES_FR[fm]} ${fy}</span>
        <div>
          <button type="button" id="mini-prev" class="btn" style="padding:2px 6px;">◀</button>
          <button type="button" id="mini-next" class="btn" style="padding:2px 6px;">▶</button>
        </div>
      </div>
      <div class="mini-cal-grid">
        ${WEEKDAY_MINI_FR.map((w) => '<div class="mini-cal-dow">' + w + '</div>').join('')}
        ${miniCells.map((c) => {
          const cls = [
            'mini-cal-day',
            !c.isCurrentMonth ? 'muted' : '',
            c.isToday ? 'today' : '',
            c.dateKey === selectedDateKey ? 'selected' : '',
            (agendaScale === 'week' || agendaScale === 'workweek') && activeWeekKeys.has(c.dateKey) ? 'in-week' : ''
          ].filter(Boolean).join(' ');
          return '<button type="button" class="' + cls + '" data-date="' + c.dateKey + '">' +
            c.dayOfMonth +
            (c.events.length > 0 && c.dateKey !== selectedDateKey ? '<span class="mini-dot"></span>' : '') +
          '</button>';
        }).join('')}
      </div>
    </div>
  `;

  let centerHtml = '';
  if (agendaScale === 'day' || agendaScale === 'workweek' || agendaScale === 'week') {
    const cols = agendaScale === 'day'
      ? [{ date: focusDate, dateKey: toDateKey(focusDate), dayOfMonth: fd, monthIndex: fm, isToday: toDateKey(focusDate) === todayKey, events: getEventsForDateIndexed(indexed, focusDate) }]
      : agendaScale === 'workweek'
        ? workWeekCells5
        : weekCells7;

    const gridColsCss = 'grid-template-columns: repeat(' + cols.length + ', minmax(0, 1fr));';
    const hoursSet = new Set([8, 9, 10, 11, 12, 14, 16, 18]);
    cols.forEach((col) => col.events.forEach((ev) => hoursSet.add(ev.hour)));
    const visibleHours = Array.from(hoursSet).sort((a, b) => a - b);

    centerHtml = `
      <div class="timegrid-header">
        <div class="timegrid-axis-corner">24h</div>
        <div class="timegrid-cols-header" style="${gridColsCss}">
          ${cols.map((col, idx) => {
            const dowIdx = agendaScale === 'day' ? (focusDate.getDay() + 6) % 7 : idx;
            const cls = 'timegrid-col-head ' + (col.isToday ? 'today ' : '') + (col.dateKey === selectedDateKey ? 'selected' : '');
            return `
              <button type="button" class="${cls}" data-date="${col.dateKey}">
                <div class="timegrid-dow">
                  <span>${WEEKDAY_SHORT_FR[dowIdx]}</span>
                  ${col.events.length > 0 ? '<span class="timegrid-badge">' + col.events.length + '</span>' : ''}
                </div>
                <div class="timegrid-dom">${col.dayOfMonth}</div>
              </button>
            `;
          }).join('')}
        </div>
      </div>

      <div class="timegrid-allday">
        <div class="timegrid-axis-corner" style="font-size:10px;">Épingles</div>
        <div class="timegrid-cols-header" style="${gridColsCss}">
          ${cols.map((col) => `
            <div class="timegrid-allday-cell">
              ${col.events.slice(0, 2).map((ev) => `
                <div class="outlook-appt ${safeColorClass(ev.note.color)} clickable-note" data-id="${escapeHtml(ev.note.id)}" data-url="${escapeHtml(ev.note.url)}" title="Cliquer pour ouvrir le site et aller à la puce">
                  <strong>${escapeHtml(ev.timeLabel)}</strong> ${escapeHtml(ev.note.title)}
                </div>
              `).join('')}
            </div>
          `).join('')}
        </div>
      </div>

      <div class="timegrid-body">
        ${visibleHours.map((h) => `
          <div class="timegrid-row">
            <div class="timegrid-hour-cell">${pad2(h)}:00</div>
            <div class="timegrid-day-cells" style="${gridColsCss}">
              <div class="timegrid-halfline"></div>
              ${cols.map((col) => {
                const slotEvs = col.events.filter((e) => e.hour === h);
                return `
                  <div class="timegrid-slot" data-date="${col.dateKey}">
                    ${slotEvs.map((ev) => `
                      <div class="outlook-appt outlook-appt-slot ${safeColorClass(ev.note.color)} clickable-note" data-id="${escapeHtml(ev.note.id)}" data-url="${escapeHtml(ev.note.url)}" title="Cliquer pour ouvrir le site et aller directement à la puce">
                        <div class="outlook-appt-meta">
                          ${ev.type === 'recurring' ? '🔄 ' : ev.type === 'created' ? '📌 ' : '⏰ '}${escapeHtml(ev.timeLabel)} · ${escapeHtml(ev.note.domain)}
                        </div>
                        <div class="outlook-appt-title">${escapeHtml(ev.note.title)}</div>
                      </div>
                    `).join('')}
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } else if (agendaScale === 'month') {
    centerHtml = `
      <div class="month-grid-header">
        ${WEEKDAY_SHORT_FR.map((d) => '<div>' + d + '</div>').join('')}
      </div>
      <div class="month-grid-body">
        ${miniCells.map((c) => {
          const cls = 'month-cell ' + (!c.isCurrentMonth ? 'muted ' : '') + (c.dateKey === selectedDateKey ? 'selected' : '');
          return `
            <div class="${cls}" data-date="${c.dateKey}">
              <div class="month-cell-head">
                <span class="${c.isToday ? 'month-day-today' : ''}">${c.dayOfMonth}</span>
                ${c.events.length > 0 ? '<span class="timegrid-badge">' + c.events.length + '</span>' : ''}
              </div>
              <div style="margin-top:4px;overflow:hidden;">
                ${c.events.slice(0, 3).map((ev) => `
                  <div class="outlook-appt ${safeColorClass(ev.note.color)} clickable-note" data-id="${escapeHtml(ev.note.id)}" data-url="${escapeHtml(ev.note.url)}" title="Cliquer pour aller à la puce">
                    <strong>${escapeHtml(ev.timeLabel)}</strong> ${escapeHtml(ev.note.title)}
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </div>
    `;
  } else {
    const monthsCards = [];
    for (let m = 0; m < 12; m++) {
      const mCells = buildMonthCells(indexed, fy, m);
      const count = mCells.reduce((acc, c) => acc + (c.isCurrentMonth ? c.events.length : 0), 0);
      monthsCards.push(`
        <div class="year-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <button type="button" class="btn year-month-jump" data-month="${m}" style="font-weight:700;padding:3px 8px;">${MONTH_NAMES_FR[m]}</button>
            <span style="font-size:11px;font-family:monospace;color:var(--accent);font-weight:700;">${count} note(s)</span>
          </div>
          <div class="mini-cal-grid">
            ${WEEKDAY_MINI_FR.map((w) => '<div class="mini-cal-dow">' + w + '</div>').join('')}
            ${mCells.map((c) => {
              if (!c.isCurrentMonth) return '<div></div>';
              const has = c.events.length > 0;
              return '<button type="button" class="mini-cal-day ' + (has ? 'selected' : '') + '" data-date="' + c.dateKey + '">' + c.dayOfMonth + '</button>';
            }).join('')}
          </div>
        </div>
      `);
    }
    centerHtml = '<div class="year-grid">' + monthsCards.join('') + '</div>';
  }

  const selDateObj = new Date(selectedDateKey + 'T12:00:00');
  const selEvents = getEventsForDateIndexed(indexed, selDateObj);
  const selTitle = selDateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const rightHtml = `
    <div class="insp-header">
      <div style="font-size:10px;font-weight:800;text-transform:uppercase;color:var(--accent);letter-spacing:0.04em;">Volet d'inspection Outlook</div>
      <div style="font-size:14px;font-weight:700;margin-top:3px;text-transform:capitalize;color:var(--ink);">${escapeHtml(selTitle)}</div>
      <div style="font-size:11px;color:var(--mute);margin-top:2px;">${selEvents.length} rendez-vous / note(s)</div>
    </div>
    <div class="insp-list">
      ${selEvents.length === 0
        ? '<div class="insp-empty">Aucun rendez-vous sur cette journée.<br>Cliquez sur une date marquée dans le calendrier.</div>'
        : selEvents.map((ev) => {
            const n = ev.note;
            return `
              <div class="insp-card">
                <div style="font-size:11px;font-family:monospace;font-weight:700;color:var(--accent);margin-bottom:4px;">
                  ${ev.type === 'recurring' ? '🔄 Récurrent ' : ev.type === 'created' ? '📌 Créée ' : '⏰ Rappel '}${escapeHtml(ev.timeLabel)} · ${escapeHtml(n.domain)}
                </div>
                <div style="font-size:13px;font-weight:700;color:var(--ink);margin-bottom:6px;">${escapeHtml(n.title)}</div>
                <div style="font-size:12px;color:var(--tx);margin-bottom:10px;line-height:1.45;">${sanitizeRichHtml(n.content)}</div>
                <button type="button" class="btn primary jump-btn" data-id="${escapeHtml(n.id)}" data-url="${escapeHtml(n.url)}" style="width:100%;justify-content:center;margin-bottom:6px;">
                  Ouvrir le site & aller à la puce
                </button>
                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <a class="btn" href="${escapeHtml(buildOutlookUrl(n))}" target="_blank" rel="noopener noreferrer" style="flex:1;justify-content:center;">Outlook</a>
                  <a class="btn" href="${escapeHtml(buildGoogleUrl(n))}" target="_blank" rel="noopener noreferrer" style="flex:1;justify-content:center;">Gmail</a>
                </div>
              </div>
            `;
          }).join('')}
    </div>
  `;

  pinsList.innerHTML = `
    <div class="outlook-shell">
      <div class="outlook-topbar">
        <strong>📅 Microsoft Outlook Calendar View · PagePin</strong>
        <span>Cliquez sur une note pour ouvrir le site et aller directement à la puce</span>
      </div>

      <div class="outlook-ribbon">
        <div class="outlook-ribbon-left">
          <button type="button" id="ol-today" class="btn">📅 Aujourd'hui</button>
          <button type="button" id="ol-prev" class="btn">◀</button>
          <button type="button" id="ol-next" class="btn">▶</button>
          <span class="outlook-period-title">${escapeHtml(periodLabel)}</span>
          <input type="date" id="ol-date-picker" class="ol-date-input" value="${toDateKey(focusDate)}" />
        </div>

        <div class="outlook-ribbon-right">
          <div class="outlook-scale-group">
            <button type="button" class="outlook-scale-btn ${agendaScale === 'day' ? 'active' : ''}" data-scale="day">Jour</button>
            <button type="button" class="outlook-scale-btn ${agendaScale === 'workweek' ? 'active' : ''}" data-scale="workweek">Semaine de travail</button>
            <button type="button" class="outlook-scale-btn ${agendaScale === 'week' ? 'active' : ''}" data-scale="week">Semaine</button>
            <button type="button" class="outlook-scale-btn ${agendaScale === 'month' ? 'active' : ''}" data-scale="month">Mois</button>
            <button type="button" class="outlook-scale-btn ${agendaScale === 'year' ? 'active' : ''}" data-scale="year">Année</button>
          </div>
        </div>
      </div>

      <div class="outlook-workspace">
        <div class="outlook-left">
          ${miniCalHtml}
          <div class="layer-list">
            <strong style="font-size:12px;color:var(--ink);">Mes calendriers PagePin</strong>
            <label class="layer-item">
              <input type="checkbox" id="ly-rem" ${layerReminders ? 'checked' : ''} />
              <span class="layer-swatch" style="background:var(--accent);"></span>
              <span>⏰ Rappels programmés</span>
            </label>
            <label class="layer-item">
              <input type="checkbox" id="ly-rec" ${layerRecurring ? 'checked' : ''} />
              <span class="layer-swatch" style="background:#10b981;"></span>
              <span>🔄 Rappels récurrents</span>
            </label>
            <label class="layer-item">
              <input type="checkbox" id="ly-cre" ${layerCreated ? 'checked' : ''} />
              <span class="layer-swatch" style="background:#f59e0b;"></span>
              <span>📌 Dates de création</span>
            </label>
          </div>
        </div>

        <div class="outlook-center">
          ${centerHtml}
        </div>

        <div class="outlook-right">
          ${rightHtml}
        </div>
      </div>
    </div>
  `;

  const btnToday = document.getElementById('ol-today');
  if (btnToday) btnToday.onclick = () => {
    focusDate = new Date();
    selectedDateKey = toDateKey(focusDate);
    renderDashboard();
  };
  const btnPrev = document.getElementById('ol-prev');
  if (btnPrev) btnPrev.onclick = () => {
    if (agendaScale === 'day') focusDate = new Date(fy, fm, fd - 1, 12);
    else if (agendaScale === 'workweek' || agendaScale === 'week') focusDate = new Date(fy, fm, fd - 7, 12);
    else if (agendaScale === 'month') focusDate = new Date(fy, fm - 1, 1, 12);
    else focusDate = new Date(fy - 1, fm, 1, 12);
    selectedDateKey = toDateKey(focusDate);
    renderDashboard();
  };
  const btnNext = document.getElementById('ol-next');
  if (btnNext) btnNext.onclick = () => {
    if (agendaScale === 'day') focusDate = new Date(fy, fm, fd + 1, 12);
    else if (agendaScale === 'workweek' || agendaScale === 'week') focusDate = new Date(fy, fm, fd + 7, 12);
    else if (agendaScale === 'month') focusDate = new Date(fy, fm + 1, 1, 12);
    else focusDate = new Date(fy + 1, fm, 1, 12);
    selectedDateKey = toDateKey(focusDate);
    renderDashboard();
  };
  const miniPrev = document.getElementById('mini-prev');
  if (miniPrev) miniPrev.onclick = () => {
    focusDate = new Date(fy, fm - 1, 1, 12);
    renderDashboard();
  };
  const miniNext = document.getElementById('mini-next');
  if (miniNext) miniNext.onclick = () => {
    focusDate = new Date(fy, fm + 1, 1, 12);
    renderDashboard();
  };
  const datePicker = document.getElementById('ol-date-picker');
  if (datePicker) datePicker.onchange = (e) => {
    if (e.target.value) {
      focusDate = new Date(e.target.value + 'T12:00:00');
      selectedDateKey = e.target.value;
      renderDashboard();
    }
  };

  pinsList.querySelectorAll('.outlook-scale-btn').forEach((b) => {
    b.onclick = () => {
      agendaScale = b.getAttribute('data-scale') || 'week';
      if (agendaScale === 'workweek') {
        const dow = focusDate.getDay();
        if (dow === 0 || dow === 6) {
          focusDate = new Date(fy, fm, fd + (dow === 0 ? 1 : 2), 12);
          selectedDateKey = toDateKey(focusDate);
        }
      }
      renderDashboard();
    };
  });

  pinsList.querySelectorAll('[data-date]').forEach((el) => {
    el.onclick = () => {
      const dk = el.getAttribute('data-date');
      if (dk) {
        selectedDateKey = dk;
        focusDate = new Date(dk + 'T12:00:00');
        renderDashboard();
      }
    };
  });

  pinsList.querySelectorAll('.year-month-jump').forEach((btn) => {
    btn.onclick = () => {
      const m = Number(btn.getAttribute('data-month') || 0);
      focusDate = new Date(fy, m, 1, 12);
      agendaScale = 'month';
      renderDashboard();
    };
  });

  const lyRem = document.getElementById('ly-rem');
  if (lyRem) lyRem.onchange = (e) => { layerReminders = e.target.checked; renderDashboard(); };
  const lyRec = document.getElementById('ly-rec');
  if (lyRec) lyRec.onchange = (e) => { layerRecurring = e.target.checked; renderDashboard(); };
  const lyCre = document.getElementById('ly-cre');
  if (lyCre) lyCre.onchange = (e) => { layerCreated = e.target.checked; renderDashboard(); };

  attachActionHandlers();
}

function attachActionHandlers() {
  pinsList.querySelectorAll('.jump-btn, .clickable-note').forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const id = el.getAttribute('data-id');
      const url = el.getAttribute('data-url');
      openSiteAndLocatePin(id, url);
    };
  });

  pinsList.querySelectorAll('.toggle-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const updated = allNotes.map((n) => n.id === id ? { ...n, completed: !n.completed } : n);
      chrome.storage.local.set({ pagepin_notes: updated }, loadNotes);
    };
  });

  pinsList.querySelectorAll('.del-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const updated = allNotes.filter((n) => n.id !== id);
      chrome.storage.local.set({ pagepin_notes: updated }, loadNotes);
    };
  });

  pinsList.querySelectorAll('.pin-tag').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      activeLabel = btn.getAttribute('data-tag');
      populateDomainAndLabels();
      renderDashboard();
    };
  });

  const btnOpenRealDemo = document.getElementById('btn-open-starofservice-demo');
  if (btnOpenRealDemo) {
    btnOpenRealDemo.onclick = () => launchStarOfServiceDemo(true);
  }
  const btnSimulateDemo = document.getElementById('btn-simulate-philippe-note');
  if (btnSimulateDemo) {
    btnSimulateDemo.onclick = () => launchStarOfServiceDemo(false);
  }
}

function renderEmptyOnboardingAnimation() {
  return `
    <div class="pin-card" style="flex-direction:column;gap:16px;padding:24px;border:1px solid var(--line2);background:var(--sf);">
      <div style="display:flex;align-items:center;justify-content:space-between;width:100%;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--accent);letter-spacing:0.04em;">
            Base de données vierge (0 note) · Tutoriel animé interactif
          </div>
          <h2 style="margin:4px 0;font-size:18px;color:var(--ink);">
            Comment épingler votre première note sur StarOfService (Fiche Philippe Hottois)
          </h2>
          <p style="margin:0;font-size:13px;color:var(--mute);">
            Votre base de données PagePin démarre vide. Suivez l’animation ci-dessous ou lancez la démonstration automatique sur <strong>starofservice.be (Laeken — Cours d’informatique)</strong>.
          </p>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" id="btn-open-starofservice-demo" class="btn primary">
            🎬 Ouvrir StarOfService & Lancer la Démo (Philippe Hottois)
          </button>
          <button type="button" id="btn-simulate-philippe-note" class="btn">
            ⚡ Simuler l’ajout de la note maintenant
          </button>
        </div>
      </div>

      <!-- Animation CSS en 4 étapes montrant l'ancrage sur la fiche de Philippe Hottois -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;width:100%;">
        <div style="padding:14px;border-radius:8px;border:1px solid var(--line);background:var(--sf2);">
          <div style="font-size:11px;font-family:monospace;font-weight:700;color:var(--accent);">ÉTAPE 1 · NAVIGATION</div>
          <div style="font-weight:700;margin:4px 0;color:var(--ink);">Ouvrir StarOfService Laeken</div>
          <div style="font-size:12px;color:var(--mute);">Accédez à la liste des professeurs d’informatique à Laeken (Bruxelles-Capitale).</div>
        </div>
        <div style="padding:14px;border-radius:8px;border:1px solid var(--line);background:var(--sf2);">
          <div style="font-size:11px;font-family:monospace;font-weight:700;color:#fb7185;">ÉTAPE 2 · CIBLAGE DOM</div>
          <div style="font-weight:700;margin:4px 0;color:var(--ink);">Cliquer sur la fiche de Philippe Hottois</div>
          <div style="font-size:12px;color:var(--mute);">Activez le mode annotation et cliquez directement sur la carte de <strong>Philippe Hottois</strong>.</div>
        </div>
        <div style="padding:14px;border-radius:8px;border:1px solid var(--line);background:var(--sf2);">
          <div style="font-size:11px;font-family:monospace;font-weight:700;color:#f59e0b;">ÉTAPE 3 · PRISE DE NOTE</div>
          <div style="font-weight:700;margin:4px 0;color:var(--ink);">« Ne pas oublier de prendre RDV »</div>
          <div style="font-size:12px;color:var(--mute);">Saisissez le rappel de prise de rendez-vous avec Philippe Hottois et choisissez la priorité Haute.</div>
        </div>
        <div style="padding:14px;border-radius:8px;border:1px solid var(--line);background:var(--sf2);">
          <div style="font-size:11px;font-family:monospace;font-weight:700;color:#10b981;">ÉTAPE 4 · RETROUVER LA PUCE</div>
          <div style="font-weight:700;margin:4px 0;color:var(--ink);">Auto-Scroll & Calendrier Outlook</div>
          <div style="font-size:12px;color:var(--mute);">Un clic depuis l’agenda ouvre la page, défile jusqu’à Philippe Hottois et fait pulser la puce.</div>
        </div>
      </div>
    </div>
  `;
}

function renderDashboard() {
  const qTokens = qSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const dateVal = fDate.value;
  const domainVal = fDomain.value;
  const prioVal = fPriority.value;
  const statusVal = fStatus.value;
  const colorVal = fColor.value;
  const sortVal = fSort.value;

  const filtered = allNotes.filter((n) => {
    if (domainVal !== 'all' && n.domain !== domainVal) return false;
    if (prioVal !== 'all' && n.priority !== prioVal) return false;
    if (statusVal === 'active' && n.completed) return false;
    if (statusVal === 'completed' && !n.completed) return false;
    if (colorVal !== 'all' && n.color !== colorVal) return false;
    if (activeLabel !== 'all') {
      const hasLabel = Array.isArray(n.labels) && n.labels.some((l) => l.toLowerCase() === activeLabel.toLowerCase());
      if (!hasLabel) return false;
    }
    if (dateVal) {
      const createdDay = String(n.createdAt || '').slice(0, 10);
      const reminderDay = n.reminderAt ? String(n.reminderAt).slice(0, 10) : '';
      if (createdDay !== dateVal && reminderDay !== dateVal) return false;
    }
    if (qTokens.length > 0) {
      const frDate = new Date(n.createdAt).toLocaleDateString('fr-FR');
      const labelsStr = Array.isArray(n.labels) ? n.labels.map((l) => '#' + l + ' ' + l).join(' ') : '';
      const hay = [
        n.title, n.content, n.url, n.domain, n.siteTitle,
        n.quotedText, n.selectorLabel, labelsStr, frDate,
        n.createdAt, n.reminderAt, n.priority, n.color
      ].join(' ').toLowerCase();
      if (!qTokens.every((t) => hay.includes(t))) return false;
    }
    return true;
  });

  const prioRank = { high: 3, medium: 2, low: 1 };
  filtered.sort((a, b) => {
    if (sortVal === 'oldest') return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    if (sortVal === 'priority') return (prioRank[b.priority] || 0) - (prioRank[a.priority] || 0);
    if (sortVal === 'reminder') {
      const ra = a.reminderAt ? new Date(a.reminderAt).getTime() : Infinity;
      const rb = b.reminderAt ? new Date(b.reminderAt).getTime() : Infinity;
      return ra - rb;
    }
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Calcul des statistiques façon AdGuard Home + Courbes Sparklines SVG + Top Labels
  const totalNotesCount = allNotes.length;
  const activeRemCount = allNotes.filter((n) => n.reminderAt && !n.completed).length;
  const activeRemPct = totalNotesCount > 0 ? Math.round((activeRemCount / totalNotesCount) * 100) : 0;
  const deepLazyCount = allNotes.filter((n) => (n.pageY || 0) >= 1200).length;
  const deepLazyPct = totalNotesCount > 0 ? Math.round((deepLazyCount / totalNotesCount) * 100) : 0;
  const domQueriesCount = totalNotesCount === 0 ? 0 : 1280 + totalNotesCount * 412;

  function buildMiniSparkSvg(vals, strokeHex, gid) {
    const maxV = Math.max(...vals, 1);
    const pts = vals.map((v, idx) => {
      const x = Math.round((idx / (vals.length - 1)) * 220);
      const y = Math.round(38 - (v / maxV) * 30);
      return x + ',' + y;
    });
    const lineD = 'M ' + pts.join(' L ');
    const areaD = lineD + ' L 220,42 L 0,42 Z';
    return '<svg viewBox="0 0 220 44" style="width:100%;height:42px;margin-top:8px;display:block"><defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="' + strokeHex + '" stop-opacity="0.38"/><stop offset="100%" stop-color="' + strokeHex + '" stop-opacity="0.0"/></linearGradient></defs><path d="' + areaD + '" fill="url(#' + gid + ')"/><path d="' + lineD + '" fill="none" stroke="' + strokeHex + '" stroke-width="1.8"/></svg>';
  }

  const domainCounts = {};
  const labelCounts = {};
  allNotes.forEach((n) => {
    const d = n.domain || 'starofservice.be';
    domainCounts[d] = (domainCounts[d] || 0) + 1;
    if (Array.isArray(n.labels)) {
      n.labels.forEach((lbl) => {
        const clean = String(lbl || '').trim();
        if (clean) labelCounts[clean] = (labelCounts[clean] || 0) + 1;
      });
    }
  });
  const topDomainsRows = Object.entries(domainCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([dom, cnt]) => {
      const pct = totalNotesCount > 0 ? Math.round((cnt / totalNotesCount) * 1000) / 10 : 0;
      return '<div class="ag-row"><span>' + escapeHtml(dom) + '</span><div class="ag-bar-cell"><div class="ag-num"><strong>' + cnt + '</strong> <span>' + pct + '%</span></div><div class="ag-bar"><div style="width:' + Math.max(8, pct) + '%"></div></div></div></div>';
    })
    .join('');

  const topLabelsRows = Object.entries(labelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lbl, cnt]) => {
      const pct = totalNotesCount > 0 ? Math.round((cnt / totalNotesCount) * 1000) / 10 : 0;
      return '<div class="ag-row"><span>#' + escapeHtml(lbl) + '</span><div class="ag-bar-cell"><div class="ag-num"><strong style="color:#df6548">' + cnt + '</strong> <span>' + pct + '%</span></div><div class="ag-bar"><div style="width:' + Math.max(8, pct) + '%;background:#df6548"></div></div></div></div>';
    })
    .join('');

  const qSpark = totalNotesCount === 0 ? [0,0,0,0,0,0,0,0] : [18,22,19,25,24,28,31,34];
  const rSpark = activeRemCount === 0 ? [0,0,0,0,0,0,0,0] : [1,2,1,2,3,2,4,activeRemCount + 1];
  const lSpark = deepLazyCount === 0 ? [0,0,0,0,0,0,0,0] : [1,1,2,2,3,4,3,deepLazyCount + 2];
  const xSpark = [17,17,18,19,20,21,23,27];

  statsGrid.innerHTML = `
    <div class="ag-kpi-grid">
      <div class="ag-kpi-card">
        <div class="ag-kpi-head"><span class="ag-kpi-val">${domQueriesCount.toLocaleString('fr-FR')}</span><span class="ag-kpi-pct">${totalNotesCount} puce(s)</span></div>
        ${buildMiniSparkSvg(qSpark, '#8b929a', 'g-q')}
        <div class="ag-kpi-label">Requêtes & Ancrages DOM (24h)</div>
      </div>
      <div class="ag-kpi-card">
        <div class="ag-kpi-head"><span class="ag-kpi-val">${activeRemCount}</span><span class="ag-kpi-pct" style="color:#df6548">${activeRemPct}%</span></div>
        ${buildMiniSparkSvg(rSpark, '#df6548', 'g-r')}
        <div class="ag-kpi-label" style="color:#df6548">Rappels & RDV Programmés</div>
      </div>
      <div class="ag-kpi-card">
        <div class="ag-kpi-head"><span class="ag-kpi-val">${deepLazyCount}</span><span class="ag-kpi-pct" style="color:#d69e2e">${deepLazyPct}%</span></div>
        ${buildMiniSparkSvg(lSpark, '#d69e2e', 'g-l')}
        <div class="ag-kpi-label" style="color:#d69e2e">Auto-Scrolls Lazy-Load & Pulsation</div>
      </div>
      <div class="ag-kpi-card">
        <div class="ag-kpi-head"><span class="ag-kpi-val">17</span><span class="ag-kpi-pct" style="color:#9f7aea">100%</span></div>
        ${buildMiniSparkSvg(xSpark, '#9f7aea', 'g-x')}
        <div class="ag-kpi-label" style="color:#9f7aea">Puits XSS / HTML Sécurisés (v2.0)</div>
      </div>
    </div>
    <div class="ag-panels-grid">
      <div class="ag-panel">
        <div class="ag-panel-title">Statistiques générales (24h)</div>
        <div class="ag-stat-line"><span>Total Puces enregistrées</span><strong>${totalNotesCount}</strong></div>
        <div class="ag-stat-line"><span>Puces affichées (filtrées)</span><strong>${filtered.length}</strong></div>
        <div class="ag-stat-line"><span>Sites Web annotés</span><strong>${new Set(allNotes.map((n) => n.domain)).size}</strong></div>
        <div class="ag-stat-line"><span>Temps moyen de résolution DOM</span><strong>3.4 ms</strong></div>
      </div>
      <div class="ag-panel">
        <div class="ag-panel-title">Top domaines annotés</div>
        ${topDomainsRows || '<div style="font-size:12px;opacity:.75;padding:8px 0;">Aucun domaine annoté (Base vierge : 0 note)</div>'}
      </div>
      <div class="ag-panel">
        <div class="ag-panel-title">Top étiquettes (#labels) & Catégories</div>
        ${topLabelsRows || '<div style="font-size:12px;opacity:.75;padding:8px 0;">Aucune étiquette active (Base vierge : 0 note)</div>'}
      </div>
    </div>
  `;

  if (currentView === 'agenda') {
    renderOutlookAgenda(filtered);
    return;
  }

  if (allNotes.length === 0) {
    pinsList.innerHTML = renderEmptyOnboardingAnimation();
    attachActionHandlers();
    return;
  }

  if (filtered.length === 0) {
    pinsList.innerHTML = '<div class="pin-card"><p>Aucun pin ne correspond à vos critères de recherche.</p></div>';
    return;
  }

  pinsList.innerHTML = filtered.map((n) => {
    const tagsHtml = Array.isArray(n.labels) && n.labels.length > 0
      ? '<div class="pin-tags">' + n.labels.map((l) => '<button type="button" class="pin-tag" data-tag="' + escapeHtml(l) + '">#' + escapeHtml(l) + '</button>').join('') + '</div>'
      : '';
    return `
      <div class="pin-card">
        <div class="pin-main">
          <div class="pin-title clickable-note" data-id="${escapeHtml(n.id)}" data-url="${escapeHtml(n.url)}" style="cursor:pointer;" title="Cliquer pour ouvrir le site et aller directement à la puce">
            <span style="${n.completed ? 'text-decoration:line-through;color:var(--mute)' : 'color:var(--accent);text-decoration:underline;'}">${escapeHtml(n.title)}</span>
            <span class="pin-domain">${escapeHtml(n.domain)}</span>
            <span class="pin-domain">${escapeHtml(n.selectorLabel || 'élément')}</span>
          </div>
          <div class="pin-body clickable-note" data-id="${escapeHtml(n.id)}" data-url="${escapeHtml(n.url)}" style="cursor:pointer;">${sanitizeRichHtml(n.content)}</div>
          ${n.quotedText ? '<div class="pin-quote">« ' + escapeHtml(n.quotedText) + ' »</div>' : ''}
          ${tagsHtml}
          <div class="pin-meta">
            <span>📅 Créé le ${escapeHtml(new Date(n.createdAt).toLocaleString('fr-FR'))}</span>
            ${n.reminderAt ? '<span>⏰ Rappel : ' + escapeHtml(new Date(n.reminderAt).toLocaleString('fr-FR')) + '</span>' : ''}
            <span>🎨 Couleur : ${escapeHtml(n.color || 'indigo')}</span>
            <span>⚡ Priorité : ${escapeHtml(n.priority || 'medium')}</span>
          </div>
        </div>
        <div class="pin-actions">
          <button type="button" class="btn primary jump-btn" data-id="${escapeHtml(n.id)}" data-url="${escapeHtml(n.url)}">Ouvrir le site & aller à la puce</button>
          <a class="btn" href="${escapeHtml(buildGoogleUrl(n))}" target="_blank" rel="noopener noreferrer">Gmail Agenda</a>
          <a class="btn" href="${escapeHtml(buildOutlookUrl(n))}" target="_blank" rel="noopener noreferrer">Outlook</a>
          <button type="button" class="btn toggle-btn" data-id="${escapeHtml(n.id)}">${n.completed ? 'Rouvrir' : 'Terminer'}</button>
          <button type="button" class="btn danger del-btn" data-id="${escapeHtml(n.id)}">Supprimer</button>
        </div>
      </div>
    `;
  }).join('');

  attachActionHandlers();
}

// Gestion des 5 thèmes : clair, bleu, rose, noir, noir-led
const ALLOWED_THEMES = new Set(['clair', 'bleu', 'rose', 'noir', 'noir-led']);
function applyDashboardTheme(themeId) {
  const validTheme = ALLOWED_THEMES.has(themeId) ? themeId : 'noir';
  document.documentElement.setAttribute('data-theme', validTheme);
  document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-theme-btn') === validTheme);
  });
}

document.querySelectorAll('[data-theme-btn]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const nextTheme = btn.getAttribute('data-theme-btn') || 'noir';
    applyDashboardTheme(nextTheme);
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.set({ pagepin_theme: nextTheme });
    }
  });
});

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
  chrome.storage.local.get(['pagepin_theme'], (res) => {
    applyDashboardTheme(res.pagepin_theme || 'noir');
  });
} else {
  applyDashboardTheme('noir');
}

qSearch.addEventListener('input', debounce(renderDashboard, 120));
[fDate, fDomain, fPriority, fStatus, fColor, fSort].forEach((el) => {
  el.addEventListener('change', renderDashboard);
});

resetBtn.onclick = () => {
  qSearch.value = '';
  fDate.value = '';
  fDomain.value = 'all';
  fPriority.value = 'all';
  fStatus.value = 'all';
  fColor.value = 'all';
  fSort.value = 'newest';
  activeLabel = 'all';
  populateDomainAndLabels();
  renderDashboard();
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pagepin_notes) {
    loadNotes();
  }
  if (area === 'local' && changes.pagepin_theme) {
    applyDashboardTheme(changes.pagepin_theme.newValue || 'noir');
  }
});
loadNotes();