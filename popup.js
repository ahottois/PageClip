// PagePin v2.0.0 — Popup Script Sécurisé (Base vide au démarrage + Bouton Démo Guidée StarOfService Philippe Hottois)
const DEMO_STAROFSERVICE_URL = 'https://www.starofservice.be/annubis/bruxelles-capitale/region-bruxelles-capitale/laeken/cours-d-informatique';

const toggleBtn = document.getElementById('toggle-btn');
const dashboardBtn = document.getElementById('dashboard-btn');
const searchInput = document.getElementById('search-input');
const listEl = document.getElementById('notes-list');
let cachedNotes = [];

const ENTITY_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(raw) {
  return String(raw == null ? '' : raw).replace(/[&<>"']/g, (ch) => ENTITY_MAP[ch] || ch);
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

function renderList(query = '') {
  if (cachedNotes.length === 0) {
    listEl.innerHTML = `
      <div style="padding:14px 16px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;">
        <div style="font-weight:700;color:#0f172a;margin-bottom:4px;">✨ Base de données vide (0 note)</div>
        <p style="margin:0 0 10px;color:#475569;line-height:1.45;">
          Découvrez comment épingler une note sur la fiche de <strong>Philippe Hottois</strong> (StarOfService — Cours d’informatique à Laeken) pour ne pas oublier de prendre rendez-vous.
        </p>
        <button type="button" id="popup-demo-btn" style="width:100%;padding:8px 10px;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;font-size:12px;cursor:pointer;">
          🎬 Lancer la démo (Fiche Philippe Hottois)
        </button>
      </div>
    `;
    const demoBtn = document.getElementById('popup-demo-btn');
    if (demoBtn) {
      demoBtn.onclick = () => {
        chrome.storage.local.set({ pagepin_demo_pending: true, pagepin_active: true }, () => {
          chrome.tabs.create({ url: DEMO_STAROFSERVICE_URL });
          window.close();
        });
      };
    }
    return;
  }

  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = cachedNotes.filter((n) => {
    if (tokens.length === 0) return true;
    const dateStr = new Date(n.createdAt).toLocaleDateString('fr-FR');
    const labelsStr = Array.isArray(n.labels) ? n.labels.map((l) => '#' + l + ' ' + l).join(' ') : '';
    const hay = [n.title, n.content, n.url, n.domain, n.quotedText, n.selectorLabel, labelsStr, dateStr, n.priority, n.color].join(' ').toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });

  listEl.innerHTML = filtered.slice(0, 20).map((n) => {
    const tagsHtml = Array.isArray(n.labels) && n.labels.length > 0
      ? '<div class="tags">' + n.labels.map((l) => '<span class="tag">#' + escapeHtml(l) + '</span>').join('') + '</div>'
      : '';
    return `
      <div class="item" data-id="${escapeHtml(n.id)}" data-url="${escapeHtml(n.url)}">
        <strong>${escapeHtml(n.title)}</strong>
        <div class="meta">${escapeHtml(n.domain)} · ${escapeHtml(new Date(n.createdAt).toLocaleDateString('fr-FR'))}</div>
        ${tagsHtml}
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.item').forEach((el) => {
    el.onclick = () => {
      const noteId = el.getAttribute('data-id');
      const url = el.getAttribute('data-url');
      if (!isSafeHttpUrl(url)) return;
      chrome.storage.local.set({ pagepin_locate_note_id: noteId, pagepin_locate_ts: Date.now() }, () => {
        chrome.tabs.query({}, (tabs) => {
          const cleanTarget = String(url || '').replace(/\/+$/, '').toLowerCase();
          const existingTab = (tabs || []).find((t) => t.url && String(t.url).replace(/\/+$/, '').toLowerCase() === cleanTarget);
          if (existingTab && existingTab.id) {
            chrome.tabs.update(existingTab.id, { active: true }, () => {
              if (existingTab.windowId) chrome.windows.update(existingTab.windowId, { focused: true });
              chrome.tabs.sendMessage(existingTab.id, { type: 'LOCATE_NOTE', noteId }, () => {
                void chrome.runtime.lastError;
                window.close();
              });
            });
          } else {
            chrome.tabs.create({ url });
          }
        });
      });
    };
  });
}

function load() {
  chrome.storage.local.get(['pagepin_active', 'pagepin_notes', 'pagepin_theme'], (res) => {
    const validThemes = new Set(['clair', 'bleu', 'rose', 'noir', 'noir-led']);
    const theme = validThemes.has(res.pagepin_theme) ? res.pagepin_theme : 'noir';
    document.documentElement.setAttribute('data-theme', theme);
    const active = Boolean(res.pagepin_active);
    toggleBtn.textContent = active ? 'Mode annotation ACTIF (Désactiver)' : 'Activer le mode annotation sur ce site';
    toggleBtn.style.background = active ? '#e11d48' : '#3b82f6';
    cachedNotes = res.pagepin_notes || [];
    renderList(searchInput.value);
  });
}

searchInput.addEventListener('input', () => renderList(searchInput.value));

dashboardBtn.onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
};

toggleBtn.onclick = () => {
  chrome.storage.local.get(['pagepin_active'], (res) => {
    const nextActive = !Boolean(res.pagepin_active);
    chrome.storage.local.set({ pagepin_active: nextActive }, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs && tabs[0];
        if (activeTab && activeTab.id && activeTab.url && /^https?:\/\//i.test(activeTab.url)) {
          chrome.tabs.sendMessage(activeTab.id, { type: 'SET_ANNOTATION_MODE', active: nextActive }, () => {
            if (chrome.runtime.lastError) {
              chrome.scripting.insertCSS({ target: { tabId: activeTab.id }, files: ['content.css'] }, () => {
                void chrome.runtime.lastError;
                chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['content.js'] }, () => {
                  void chrome.runtime.lastError;
                  setTimeout(() => {
                    chrome.tabs.sendMessage(activeTab.id, { type: 'SET_ANNOTATION_MODE', active: nextActive }, () => {
                      void chrome.runtime.lastError;
                      window.close();
                    });
                  }, 60);
                });
              });
            } else {
              window.close();
            }
          });
        } else {
          load();
          window.close();
        }
      });
    });
  });
};

load();