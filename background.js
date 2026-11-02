// PagePin v2.0.0 — Service Worker (Manifest V3)
// Démarre avec une base de données vierge (INITIAL_NOTES = []), gère la démo guidée StarOfService (Philippe Hottois)
// et synchronise différentiellement les alarmes.

const DEMO_STAROFSERVICE_URL = 'https://www.starofservice.be/annubis/bruxelles-capitale/region-bruxelles-capitale/laeken/cours-d-informatique';
const INITIAL_NOTES = [];

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
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

function computeNextOccurrenceIso(currentIso, recurrence, nowMs) {
  const base = currentIso ? new Date(currentIso) : new Date(nowMs);
  const validBase = Number.isNaN(base.getTime()) ? new Date(nowMs) : base;
  const hours = validBase.getHours();
  const minutes = validBase.getMinutes();
  const startFrom = new Date(Math.max(validBase.getTime(), nowMs));

  if (!recurrence || recurrence.frequency === 'none') return null;

  if (recurrence.frequency === 'daily') {
    const next = new Date(startFrom);
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= nowMs) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (recurrence.frequency === 'weekly') {
    const targetDay = typeof recurrence.dayOfWeek === 'number' ? recurrence.dayOfWeek : 1;
    const next = new Date(startFrom);
    next.setHours(hours, minutes, 0, 0);
    let add = (targetDay - next.getDay() + 7) % 7;
    if (add === 0 && next.getTime() <= nowMs) add = 7;
    next.setDate(next.getDate() + add);
    return next.toISOString();
  }

  if (recurrence.frequency === 'monthly') {
    const targetDom = typeof recurrence.dayOfMonth === 'number' ? recurrence.dayOfMonth : 15;
    let y = startFrom.getFullYear();
    let m = startFrom.getMonth();
    const build = (yr, mo) => {
      const maxD = new Date(yr, mo + 1, 0).getDate();
      return new Date(yr, mo, Math.min(targetDom, maxD), hours, minutes, 0, 0);
    };
    let cand = build(y, m);
    if (cand.getTime() <= nowMs) {
      m += 1;
      if (m > 11) { m = 0; y += 1; }
      cand = build(y, m);
    }
    return cand.toISOString();
  }
  return null;
}

function reinjectOpenTabs() {
  chrome.tabs.query({}, (tabs) => {
    (tabs || []).forEach((tab) => {
      if (tab.id && tab.url && /^https?:\/\//i.test(tab.url)) {
        chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] }, () => {
          void chrome.runtime.lastError;
        });
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }, () => {
          void chrome.runtime.lastError;
        });
      }
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['pagepin_notes'], (res) => {
    if (!Array.isArray(res.pagepin_notes)) {
      // Base de données initialement vide ([]), prête pour l'animation de démonstration
      chrome.storage.local.set({
        pagepin_notes: INITIAL_NOTES,
        pagepin_active: false,
        pagepin_demo_pending: false
      });
      syncAlarmsDifferential(INITIAL_NOTES);
    } else {
      syncAlarmsDifferential(res.pagepin_notes);
    }
    reinjectOpenTabs();
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (msg && msg.type === 'OPEN_DASHBOARD') {
    chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === 'LAUNCH_STAROFSERVICE_DEMO') {
    chrome.storage.local.set({ pagepin_demo_pending: true, pagepin_active: true }, () => {
      chrome.tabs.create({ url: DEMO_STAROFSERVICE_URL });
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pagepin_notes) {
    syncAlarmsDifferential(changes.pagepin_notes.newValue || []);
  }
});

function syncAlarmsDifferential(notesList) {
  chrome.alarms.getAll((existingAlarms) => {
    const now = Date.now();
    const desiredMap = new Map();

    (notesList || []).forEach((note) => {
      if (!note.completed && note.reminderAt) {
        const when = new Date(note.reminderAt).getTime();
        if (!Number.isNaN(when) && when > now) {
          desiredMap.set('reminder_' + note.id, when);
        }
      }
    });

    const existingMap = new Map();
    (existingAlarms || []).forEach((alarm) => {
      if (!alarm.name.startsWith('reminder_')) return;
      existingMap.set(alarm.name, alarm.scheduledTime);
      const desiredWhen = desiredMap.get(alarm.name);
      if (desiredWhen === undefined || Math.abs(desiredWhen - alarm.scheduledTime) > 500) {
        chrome.alarms.clear(alarm.name);
      }
    });

    desiredMap.forEach((when, name) => {
      const existingWhen = existingMap.get(name);
      if (existingWhen === undefined || Math.abs(existingWhen - when) > 500) {
        chrome.alarms.create(name, { when });
      }
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('reminder_')) return;
  const noteId = alarm.name.replace('reminder_', '');
  chrome.storage.local.get(['pagepin_notes'], (res) => {
    const notesList = res.pagepin_notes || [];
    const idx = notesList.findIndex((n) => n.id === noteId);
    if (idx === -1) return;
    const note = notesList[idx];
    if (note.completed) return;

    chrome.notifications.create('notif_' + note.id, {
      type: 'basic',
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      title: 'Rappel PagePin : ' + String(note.title || ''),
      message: stripHtml(note.content) + ' (' + String(note.domain || '') + ')',
      priority: 2
    });

    if (note.recurrence && note.recurrence.frequency && note.recurrence.frequency !== 'none') {
      const nextIso = computeNextOccurrenceIso(note.reminderAt, note.recurrence, Date.now());
      if (nextIso) {
        notesList[idx] = { ...note, reminderAt: nextIso, updatedAt: new Date().toISOString() };
        chrome.storage.local.set({ pagepin_notes: notesList });
      }
    }
  });
});

chrome.notifications.onClicked.addListener((notifId) => {
  if (!notifId.startsWith('notif_')) return;
  const noteId = notifId.replace('notif_', '');
  chrome.storage.local.get(['pagepin_notes'], (res) => {
    const notesList = res.pagepin_notes || [];
    const note = notesList.find((n) => n.id === noteId);
    if (note && isSafeHttpUrl(note.url)) {
      chrome.storage.local.set({ pagepin_locate_note_id: note.id, pagepin_locate_ts: Date.now() }, () => {
        chrome.tabs.query({}, (tabs) => {
          const cleanTarget = String(note.url || '').replace(/\/+$/, '').toLowerCase();
          const existingTab = (tabs || []).find((t) => t.url && String(t.url).replace(/\/+$/, '').toLowerCase() === cleanTarget);
          if (existingTab && existingTab.id) {
            chrome.tabs.update(existingTab.id, { active: true }, () => {
              if (existingTab.windowId) chrome.windows.update(existingTab.windowId, { focused: true });
              chrome.tabs.sendMessage(existingTab.id, { type: 'LOCATE_NOTE', noteId: note.id }, () => {
                void chrome.runtime.lastError;
              });
            });
          } else {
            chrome.tabs.create({ url: note.url });
          }
        });
      });
    }
  });
});