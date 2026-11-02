// PagePin v2.0.0 — Content Script Sécurisé + Chargement Progressif Lazy-Load jusqu'à la Puce + Pulsation Radar
(function () {
  if (typeof window.__pagepinCleanup === 'function') {
    try { window.__pagepinCleanup(); } catch (e) {}
  }

  let annotationMode = false;
  let pageNotes = [];
  let pinElementsMap = new Map();
  let rafPending = false;
  let cachedMainScrollContainer = null;
  let cachedMainScrollTs = 0;
  let activeSpotlightInterval = null;
  let activeSpotlightTimer = null;
  let activePulsingNoteId = null;
  let activePulseUntil = 0;
  let initialAutoLocateDone = false;
  let demoInProgress = false;

  const ENTITY_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function escapeHtml(raw) {
    return String(raw == null ? '' : raw).replace(/[&<>"']/g, (ch) => ENTITY_MAP[ch] || ch);
  }

  // Assainisseur HTML strict par liste blanche pour les notes riches (supprime tout attribut et script)
  function sanitizeRichHtml(dirtyHtml) {
    const input = String(dirtyHtml == null ? '' : dirtyHtml);
    if (!input.trim()) return '';
    const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'P', 'BR']);
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(input, 'text/html');
      function cleanNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return document.createTextNode(node.textContent || '');
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return document.createDocumentFragment();
        }
        const tag = node.tagName.toUpperCase();
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'].includes(tag)) {
          return document.createDocumentFragment();
        }
        const frag = document.createDocumentFragment();
        Array.from(node.childNodes).forEach((child) => {
          frag.appendChild(cleanNode(child));
        });
        if (!ALLOWED.has(tag)) {
          return frag;
        }
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

  function isContextValid() {
    try {
      return Boolean(typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function normalizeUrl(raw) {
    try {
      const u = new URL(raw);
      const cleanPath = u.pathname.replace(/\/+$/, '') || '';
      return u.protocol + '//' + u.host.toLowerCase() + cleanPath + u.search;
    } catch {
      return raw;
    }
  }

  function syncCaptureListeners(active) {
    if (active) {
      window.addEventListener('pointerdown', handlePointerDownCapture, true);
      window.addEventListener('mousedown', handlePointerDownCapture, true);
      window.addEventListener('click', handleClickCapture, true);
    } else {
      window.removeEventListener('pointerdown', handlePointerDownCapture, true);
      window.removeEventListener('mousedown', handlePointerDownCapture, true);
      window.removeEventListener('click', handleClickCapture, true);
    }
  }

  function setAnnotationModeState(active) {
    annotationMode = Boolean(active);
    syncCaptureListeners(annotationMode);
    if (document.documentElement) {
      document.documentElement.classList.toggle('pagepin-annotation-cursor', annotationMode);
    }
    if (document.body) {
      document.body.classList.toggle('pagepin-annotation-cursor', annotationMode);
    }
    renderPageBadgeAndPins();
  }

  function normalizeClickedElement(rawTarget) {
    let el = rawTarget;
    if (!el || el.nodeType !== 1) {
      el = el && el.parentElement ? el.parentElement : document.body;
    }
    while (
      el &&
      el.namespaceURI === 'http://www.w3.org/2000/svg' &&
      String(el.tagName || '').toLowerCase() !== 'svg' &&
      el.parentElement
    ) {
      el = el.parentElement;
    }
    return el || document.body;
  }

  function getSafeElementId(el) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    return el.getAttribute('id') || '';
  }

  function getUniqueCssSelector(el) {
    try {
      if (!el || el.nodeType !== 1) return 'body';
      const elId = getSafeElementId(el);
      if (elId && /^[a-zA-Z][\w-]*$/.test(elId) && typeof CSS !== 'undefined' && CSS.escape) {
        return '#' + CSS.escape(elId);
      }
      const parts = [];
      let cur = el;
      let depth = 0;
      while (cur && cur.nodeType === 1 && cur !== document.body && cur !== document.documentElement && depth < 10) {
        depth++;
        let tag = String(cur.tagName || 'div').toLowerCase();
        const curId = getSafeElementId(cur);
        if (curId && /^[a-zA-Z][\w-]*$/.test(curId) && typeof CSS !== 'undefined' && CSS.escape) {
          parts.unshift('#' + CSS.escape(curId));
          break;
        }
        const parent = cur.parentElement;
        if (parent && parent.children) {
          const siblings = Array.from(parent.children).filter(
            (c) => String(c.tagName || '').toLowerCase() === tag
          );
          if (siblings.length > 1) {
            const idx = siblings.indexOf(cur) + 1;
            if (idx > 0) tag += ':nth-of-type(' + idx + ')';
          }
        }
        parts.unshift(tag);
        cur = parent;
      }
      return parts.join(' > ') || 'body';
    } catch (e) {
      return 'body';
    }
  }

  function getScrollParent(el) {
    try {
      let cur = el ? el.parentElement : null;
      while (cur && cur !== document.body && cur !== document.documentElement) {
        const style = window.getComputedStyle(cur);
        const overflowY = style ? style.overflowY : '';
        if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
          return cur;
        }
        cur = cur.parentElement;
      }
    } catch (e) {}
    return document.scrollingElement || document.documentElement;
  }

  // Empêche qu'un sélecteur générique nth-of-type ne matche par erreur un élément en haut de page
  // alors que la vraie cible se trouve dans une partie basse non encore chargée (lazy-load).
  function verifyCandidateElementMatchesNote(el, note) {
    if (!el || el === document.body || el === document.documentElement) return false;
    const cleanQuoted = String(note.quotedText || '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (cleanQuoted.length >= 3) {
      const cleanCand = String(el.textContent || '').trim().replace(/\s+/g, ' ').toLowerCase();
      if (!cleanCand) return false;
      const shortSnippet = cleanQuoted.slice(0, 36);
      if (cleanCand.includes(shortSnippet)) return true;
      const words = cleanQuoted.split(/[^a-z0-9àâäéèêëîïôöùûüç-]+/i).filter((w) => w.length >= 4).slice(0, 4);
      if (words.length > 0) {
        const matched = words.filter((w) => cleanCand.includes(w)).length;
        if (matched >= Math.min(2, words.length)) return true;
      }
      return false;
    }
    const hasExplicitId = Boolean(note.selectorPath && note.selectorPath.includes('#'));
    const notePageY = typeof note.pageY === 'number' ? note.pageY : 0;
    if (!hasExplicitId && notePageY > 900) {
      const curScrollHeight = (document.scrollingElement || document.documentElement).scrollHeight || 0;
      if (curScrollHeight < notePageY - 250) return false;
      const r = el.getBoundingClientRect();
      const candDocY = r.top + (window.scrollY || 0);
      if (Math.abs(candDocY - notePageY) > 650) return false;
    }
    return true;
  }

  // PERF-01 FIX + Anti-faux-positif lazy-load : vérifie quotedText / pageY avant de valider selectorPath
  function resolveTargetElement(note) {
    if (note.selectorPath && note.selectorPath !== 'body') {
      try {
        const allMatches = document.querySelectorAll(note.selectorPath);
        for (let i = 0; i < allMatches.length; i++) {
          const cand = allMatches[i];
          if (verifyCandidateElementMatchesNote(cand, note)) {
            return cand;
          }
        }
      } catch (e) {}
    }
    if (note.quotedText && note.quotedText.length >= 2) {
      try {
        const snippet = note.quotedText.trim().replace(/\s+/g, ' ').slice(0, 50).toLowerCase();
        const candidates = document.querySelectorAll('p, span, button, a, h1, h2, h3, h4, td, li, section, article, div, svg');
        let bestMatch = null;
        let bestArea = Infinity;
        for (let i = 0; i < candidates.length; i++) {
          const el = candidates[i];
          const rawTxt = el.textContent;
          if (!rawTxt || rawTxt.length < snippet.length || rawTxt.length > 4500) continue;
          const normTxt = rawTxt.replace(/\s+/g, ' ').toLowerCase();
          if (normTxt.includes(snippet)) {
            if (el.closest && el.closest('.pagepin-injected-ui')) continue;
            const r = el.getBoundingClientRect();
            const area = r.width * r.height;
            if (area > 0 && area < bestArea) {
              bestArea = area;
              bestMatch = el;
            }
          }
        }
        if (bestMatch) return bestMatch;
      } catch (e) {}
    }
    return null;
  }

  function updateAllPinPositions() {
    rafPending = false;
    if (pinElementsMap.size === 0) return;

    const now = Date.now();
    const currentScrollHeight = (document.scrollingElement || document.documentElement).scrollHeight || 0;

    pinElementsMap.forEach((entry) => {
      const { pinEl, note } = entry;
      if (!entry.targetEl || !document.body.contains(entry.targetEl)) {
        entry.targetEl = resolveTargetElement(note);
      }
      const targetEl = entry.targetEl;
      const isPulsing = activePulsingNoteId === note.id && now < activePulseUntil;

      if (isPulsing && !pinEl.classList.contains('pagepin-pin-pulse')) {
        pinEl.classList.add('pagepin-pin-pulse');
      }

      if (targetEl && targetEl !== document.body) {
        const rect = targetEl.getBoundingClientRect();
        const relX = typeof note.elementRelX === 'number' ? note.elementRelX : 0.5;
        const relY = typeof note.elementRelY === 'number' ? note.elementRelY : 0.5;

        const x = rect.left + rect.width * relX;
        const y = rect.top + rect.height * relY;

        const outOfViewport =
          !isPulsing &&
          (rect.width === 0 ||
            rect.height === 0 ||
            y < -20 ||
            y > window.innerHeight + 20 ||
            x < -20 ||
            x > window.innerWidth + 20);

        pinEl.style.display = outOfViewport ? 'none' : 'flex';
        pinEl.style.left = Math.round(Math.max(18, Math.min(window.innerWidth - 18, x))) + 'px';
        pinEl.style.top = Math.round(Math.max(18, Math.min(window.innerHeight - 18, y))) + 'px';
      } else {
        // Si la cible n'est pas encore chargée dans le DOM et que la hauteur de page n'a pas atteint pageY,
        // on garde la puce masquée jusqu'à ce que l'auto-scroll progressif ait chargé cette partie de la page.
        const mainScrollEl = document.scrollingElement || document.documentElement;
        const scrollX = window.scrollX || mainScrollEl.scrollLeft || 0;
        const scrollY = window.scrollY || mainScrollEl.scrollTop || 0;

        const docX = typeof note.pageX === 'number'
          ? note.pageX
          : (note.offsetXPercent / 100) * window.innerWidth;
        const docY = typeof note.pageY === 'number'
          ? note.pageY
          : (note.offsetYPercent / 100) * window.innerHeight;

        const sectionLoadedEnough = currentScrollHeight >= docY - 120;
        const x = docX - scrollX;
        const y = docY - scrollY;

        const shouldShowFallback =
          isPulsing ||
          (sectionLoadedEnough && !note.quotedText && y >= -20 && y <= window.innerHeight + 20);

        pinEl.style.display = shouldShowFallback ? 'flex' : 'none';
        pinEl.style.left = Math.round(Math.max(18, Math.min(window.innerWidth - 18, x))) + 'px';
        pinEl.style.top = Math.round(Math.max(18, Math.min(window.innerHeight - 18, y))) + 'px';
      }
    });
  }

  function schedulePositionUpdate() {
    if (rafPending || pinElementsMap.size === 0) return;
    rafPending = true;
    requestAnimationFrame(updateAllPinPositions);
  }

  function findMainScrollableContainer() {
    const now = Date.now();
    if (cachedMainScrollContainer && document.body.contains(cachedMainScrollContainer) && now - cachedMainScrollTs < 2000) {
      return cachedMainScrollContainer;
    }
    try {
      const candidates = document.querySelectorAll('main, [role="main"], div, section');
      let bestEl = null;
      let bestScrollableHeight = 0;
      for (let i = 0; i < candidates.length; i++) {
        const el = candidates[i];
        const sh = el.scrollHeight - el.clientHeight;
        if (sh > 60 && el.clientHeight > 180) {
          if (el.closest && el.closest('.pagepin-injected-ui')) continue;
          const style = window.getComputedStyle(el);
          const oy = style ? style.overflowY : '';
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
            if (sh > bestScrollableHeight) {
              bestScrollableHeight = sh;
              bestEl = el;
            }
          }
        }
      }
      cachedMainScrollContainer = bestEl;
      cachedMainScrollTs = now;
      return bestEl;
    } catch (e) {
      return null;
    }
  }

  // Fait pulser intensément la puce avec double anneau radar + encadré sur l'élément cible + bulle spotlight
  function showPinSpotlightCallout(pinEl, note, targetEl) {
    if (activeSpotlightInterval) {
      clearInterval(activeSpotlightInterval);
      activeSpotlightInterval = null;
    }
    if (activeSpotlightTimer) {
      clearTimeout(activeSpotlightTimer);
      activeSpotlightTimer = null;
    }
    document.querySelectorAll('.pagepin-spotlight-callout').forEach((el) => el.remove());
    document.querySelectorAll('.pagepin-target-found-highlight').forEach((el) => {
      el.classList.remove('pagepin-target-found-highlight');
    });
    if (!pinEl || !document.body) return;

    activePulsingNoteId = note.id;
    activePulseUntil = Date.now() + 5500;

    pinEl.style.display = 'flex';
    pinEl.classList.add('pagepin-pin-pulse');
    if (targetEl && targetEl !== document.body && targetEl.classList) {
      targetEl.classList.add('pagepin-target-found-highlight');
    }

    const callout = document.createElement('div');
    callout.className = 'pagepin-injected-ui pagepin-spotlight-callout';
    callout.innerHTML = '📍 <strong>' + escapeHtml(note.title || 'Note épinglée') + '</strong>';
    document.body.appendChild(callout);

    const syncCalloutPos = () => {
      updateAllPinPositions();
      const entry = pinElementsMap.get(note.id);
      const currentPinEl = (entry && entry.pinEl) ? entry.pinEl : pinEl;
      if (!document.body.contains(callout) || !document.body.contains(currentPinEl)) return;
      currentPinEl.style.display = 'flex';
      currentPinEl.classList.add('pagepin-pin-pulse');
      const r = currentPinEl.getBoundingClientRect();
      callout.style.left = Math.round(r.left + r.width / 2) + 'px';
      callout.style.top = Math.max(20, Math.round(r.top - 14)) + 'px';
    };
    syncCalloutPos();
    activeSpotlightInterval = setInterval(syncCalloutPos, 90);

    activeSpotlightTimer = setTimeout(() => {
      if (activeSpotlightInterval) {
        clearInterval(activeSpotlightInterval);
        activeSpotlightInterval = null;
      }
      activePulsingNoteId = null;
      activePulseUntil = 0;
      document.querySelectorAll('.pagepin-pin-pulse').forEach((el) => el.classList.remove('pagepin-pin-pulse'));
      document.querySelectorAll('.pagepin-target-found-highlight').forEach((el) => {
        el.classList.remove('pagepin-target-found-highlight');
      });
      callout.remove();
      updateAllPinPositions();
    }, 5500);
  }

  // Tente uniquement de centrer et faire pulser la puce SI son élément cible est déjà réellement chargé dans le DOM
  function tryScrollToLoadedTarget(note) {
    if (!note) return false;
    let entry = pinElementsMap.get(note.id);
    const freshTarget = resolveTargetElement(note);
    if (entry && freshTarget) {
      entry.targetEl = freshTarget;
    }

    const targetEl = freshTarget || (entry && entry.targetEl ? entry.targetEl : null);
    if (!targetEl || targetEl === document.body || targetEl === document.documentElement) {
      return false;
    }

    try {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } catch (e) {
      targetEl.scrollIntoView();
    }

    const sp = getScrollParent(targetEl);
    if (sp && sp !== document.documentElement && sp !== document.body) {
      setTimeout(() => {
        const r = targetEl.getBoundingClientRect();
        const spRect = sp.getBoundingClientRect();
        const relY = typeof note.elementRelY === 'number' ? note.elementRelY : 0.5;
        const pinViewportY = r.top + r.height * relY;
        const desiredCenterY = spRect.top + spRect.height / 2;
        const deltaY = pinViewportY - desiredCenterY;
        if (Math.abs(deltaY) > 40) {
          sp.scrollBy({ top: deltaY, behavior: 'smooth' });
        }
      }, 120);
    }

    setTimeout(() => {
      updateAllPinPositions();
      entry = pinElementsMap.get(note.id);
      if (entry && entry.pinEl) {
        showPinSpotlightCallout(entry.pinEl, note, targetEl);
      }
    }, 340);

    return true;
  }

  // Fallback utilisé uniquement après que la page a été chargée jusqu'aux coordonnées cibles (pageY / scrollParentTop)
  function fallbackScrollToCoordinatesAndPulse(note) {
    if (!note) return;
    let scrolledContainer = false;
    if (note.scrollParentSelector) {
      try {
        const spEl = document.querySelector(note.scrollParentSelector);
        if (spEl && typeof note.scrollParentTop === 'number') {
          spEl.scrollTo({ top: Math.max(0, note.scrollParentTop), behavior: 'smooth' });
          scrolledContainer = true;
        }
      } catch (e) {}
    }

    if (!scrolledContainer) {
      const mainSp = findMainScrollableContainer();
      if (mainSp) {
        const targetTop = typeof note.scrollParentTop === 'number' && note.scrollParentTop > 0
          ? note.scrollParentTop
          : Math.max(0, (note.pageY || 0) - Math.round(window.innerHeight * 0.4));
        mainSp.scrollTo({ top: targetTop, behavior: 'smooth' });
      }
    }

    if (typeof note.pageY === 'number' || typeof note.windowScrollY === 'number') {
      const winTargetY = typeof note.windowScrollY === 'number' && note.windowScrollY > 0
        ? note.windowScrollY
        : Math.max(0, (note.pageY || 0) - Math.round(window.innerHeight * 0.4));
      window.scrollTo({ top: winTargetY, behavior: 'smooth' });
    }

    setTimeout(() => {
      updateAllPinPositions();
      const entry = pinElementsMap.get(note.id);
      if (entry && entry.pinEl) {
        showPinSpotlightCallout(entry.pinEl, note, entry.targetEl || null);
      }
    }, 360);
  }

  let activeProgressiveTimer = null;
  let activeMutationObserver = null;

  function stopProgressiveAutoScroll() {
    if (activeProgressiveTimer) {
      clearInterval(activeProgressiveTimer);
      activeProgressiveTimer = null;
    }
    if (activeMutationObserver) {
      try { activeMutationObserver.disconnect(); } catch (e) {}
      activeMutationObserver = null;
    }
    document.querySelectorAll('.pagepin-progressive-hud').forEach((el) => el.remove());
  }

  function updateProgressiveHud(note, step, maxSteps, currentLoadedHeight, isDone, statusDetail) {
    let hud = document.querySelector('.pagepin-progressive-hud');
    if (!hud && document.body) {
      hud = document.createElement('div');
      hud.className = 'pagepin-injected-ui pagepin-progressive-hud';
      document.body.appendChild(hud);
    }
    if (!hud) return;

    const pct = isDone ? 100 : Math.min(95, Math.max(8, Math.round((step / Math.max(1, maxSteps)) * 100)));
    const detailLine = statusDetail
      ? statusDetail
      : '« ' + String(note.title || 'Note épinglée') + ' » · Palier ' + step + '/' + maxSteps + ' (' + Math.round(currentLoadedHeight) + 'px chargés)';

    hud.innerHTML = `
      <div class="pp-hud-row">
        <span class="pp-hud-title">${isDone ? '✅ Puce localisée — Pulsation active !' : '⏳ Chargement de la page jusqu’à la puce...'}</span>
        <button type="button" id="pp-hud-stop" class="pp-hud-stop">${isDone ? 'Fermer' : 'Arrêter'}</button>
      </div>
      <div class="pp-hud-sub">${escapeHtml(detailLine)}</div>
      <div class="pp-hud-bar"><div class="pp-hud-fill" style="width:${pct}%"></div></div>
    `;
    const stopBtn = hud.querySelector('#pp-hud-stop');
    if (stopBtn) {
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        stopProgressiveAutoScroll();
      };
    }
    if (isDone) {
      setTimeout(() => {
        if (hud && hud.parentNode) hud.remove();
      }, 3200);
    }
  }

  function isSafeLazyLoadButtonText(rawText) {
    const txt = String(rawText == null ? '' : rawText).trim().replace(/\s+/g, ' ');
    if (!txt || txt.length > 64) return false;
    const dangerousPattern = /\b(supprimer|delete|remove|payer|pay|acheter|buy|checkout|commander|order|déconnecter|logout|sign out|désabonner|unsubscribe|autoriser|allow|confirmer|confirm)\b/i;
    if (dangerousPattern.test(txt)) return false;
    const safeLazyPattern = /^(?:[+▼↓›»•\s]*)(voir\s+plus|afficher\s+plus|charger\s+plus|charger\s+la\s+suite|plus\s+de\s+r[ée]sultats|plus\s+de\s+profils|plus\s+d['’]annonces|load\s+more|show\s+more|more\s+results|see\s+more)(?:\b|\s|$)/i;
    return safeLazyPattern.test(txt);
  }

  function tryTriggerLazyLoadMoreButton() {
    try {
      const buttons = document.querySelectorAll('button:not([type="submit"]), a[role="button"]:not([href^="http"]), [data-testid*="load-more"], [class*="load-more"]');
      for (let i = 0; i < buttons.length; i++) {
        const btn = buttons[i];
        if (btn.closest && (btn.closest('.pagepin-injected-ui') || btn.closest('form'))) continue;
        const txt = String(btn.textContent || '').trim();
        if (isSafeLazyLoadButtonText(txt)) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top > -100 && r.top < window.innerHeight + 350) {
            btn.click();
            return true;
          }
        }
      }
    } catch (e) {}
    return false;
  }

  // Charge progressivement la page palier par palier jusqu'à ce que la partie contenant la puce soit chargée,
  // puis centre la vue sur la puce et la fait pulser intensément pour indiquer sa position.
  function startProgressiveAutoScrollToPin(note) {
    if (!note) return;
    stopProgressiveAutoScroll();

    renderPageBadgeAndPins();
    if (tryScrollToLoadedTarget(note)) {
      return;
    }

    const maxSteps = 55;
    const maxStagnantBottomTicks = 16;
    let step = 0;
    let lastScrollHeight = (document.scrollingElement || document.documentElement).scrollHeight || 0;
    let stagnantTicks = 0;
    let mutationThrottlePending = false;

    updateProgressiveHud(note, 1, maxSteps, lastScrollHeight, false);

    if (document.body && typeof MutationObserver !== 'undefined') {
      activeMutationObserver = new MutationObserver(() => {
        if (mutationThrottlePending) return;
        mutationThrottlePending = true;
        setTimeout(() => {
          mutationThrottlePending = false;
          if (!activeMutationObserver) return;
          const foundEl = resolveTargetElement(note);
          if (foundEl && foundEl !== document.body) {
            renderPageBadgeAndPins();
            if (tryScrollToLoadedTarget(note)) {
              const h = (document.scrollingElement || document.documentElement).scrollHeight || 0;
              updateProgressiveHud(note, step + 1, maxSteps, h, true);
              if (activeProgressiveTimer) {
                clearInterval(activeProgressiveTimer);
                activeProgressiveTimer = null;
              }
              if (activeMutationObserver) {
                activeMutationObserver.disconnect();
                activeMutationObserver = null;
              }
            }
          }
        }, 160);
      });
      activeMutationObserver.observe(document.body, { childList: true, subtree: true });
    }

    activeProgressiveTimer = setInterval(() => {
      step += 1;
      const foundEl = resolveTargetElement(note);
      if (foundEl && foundEl !== document.body) {
        renderPageBadgeAndPins();
        if (tryScrollToLoadedTarget(note)) {
          const h = (document.scrollingElement || document.documentElement).scrollHeight || 0;
          updateProgressiveHud(note, step, maxSteps, h, true);
          if (activeProgressiveTimer) {
            clearInterval(activeProgressiveTimer);
            activeProgressiveTimer = null;
          }
          if (activeMutationObserver) {
            activeMutationObserver.disconnect();
            activeMutationObserver = null;
          }
          return;
        }
      }

      let scrollContainer = null;
      if (note.scrollParentSelector) {
        try { scrollContainer = document.querySelector(note.scrollParentSelector); } catch (e) {}
      }
      if (!scrollContainer) {
        scrollContainer = findMainScrollableContainer();
      }

      const mainDocEl = document.scrollingElement || document.documentElement;
      const activeEl = scrollContainer || mainDocEl;
      const currentScrollTop = scrollContainer ? scrollContainer.scrollTop : (window.scrollY || mainDocEl.scrollTop || 0);
      const currentScrollHeight = activeEl ? activeEl.scrollHeight : document.documentElement.scrollHeight;
      const clientHeight = Math.max(320, scrollContainer ? scrollContainer.clientHeight : window.innerHeight);
      const maxScrollableTop = Math.max(0, currentScrollHeight - clientHeight);
      const atBottom = currentScrollTop >= maxScrollableTop - 80;
      const heightGrew = currentScrollHeight > lastScrollHeight + 15;

      if (heightGrew) {
        lastScrollHeight = currentScrollHeight;
        stagnantTicks = 0;
      }

      const targetY = scrollContainer
        ? (typeof note.scrollParentTop === 'number' && note.scrollParentTop > 0 ? note.scrollParentTop : note.pageY)
        : (typeof note.pageY === 'number' && note.pageY > 0 ? note.pageY : note.windowScrollY);

      // Si la hauteur de la page a chargé au-delà de targetY et que le scroll a atteint targetY
      if (
        typeof targetY === 'number' &&
        targetY > 0 &&
        currentScrollHeight >= targetY + 60 &&
        currentScrollTop + clientHeight >= targetY &&
        stagnantTicks >= 2
      ) {
        updateProgressiveHud(note, step, maxSteps, currentScrollHeight, true);
        stopProgressiveAutoScroll();
        fallbackScrollToCoordinatesAndPulse(note);
        return;
      }

      // Tant que nous ne sommes pas tout en bas de la partie déjà chargée, on continue de descendre sans incrémenter stagnantTicks !
      if (!atBottom) {
        stagnantTicks = 0;
        const stride = Math.max(520, Math.round(clientHeight * 0.8));
        const nextTop = Math.min(maxScrollableTop, currentScrollTop + stride);
        updateProgressiveHud(
          note,
          step,
          maxSteps,
          currentScrollHeight,
          false,
          'Défilement vers le bas (' + Math.round(nextTop) + 'px / ' + Math.round(currentScrollHeight) + 'px chargés)...'
        );

        if (scrollContainer) {
          scrollContainer.scrollTop = nextTop;
          try { scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
        } else {
          window.scrollTo({ top: nextTop, behavior: 'auto' });
        }
        try {
          window.dispatchEvent(new Event('scroll'));
          document.dispatchEvent(new Event('scroll', { bubbles: true }));
        } catch (e) {}
        return;
      }

      // Nous sommes en bas de la partie chargée : on déclenche le lazy-loading (IntersectionObserver / bouton Voir plus)
      stagnantTicks += 1;
      const clickedMore = tryTriggerLazyLoadMoreButton();

      updateProgressiveHud(
        note,
        step,
        maxSteps,
        currentScrollHeight,
        false,
        clickedMore
          ? 'Clic automatique sur « Voir plus » — chargement de la suite (' + Math.round(currentScrollHeight) + 'px)...'
          : 'Attente du chargement de la section suivante en bas de page (' + Math.round(currentScrollHeight) + 'px)...'
      );

      // Petit rebond (bounce) en bas de page pour ré-exciter les IntersectionObserver paresseux
      if (stagnantTicks % 2 === 1) {
        const bounceUp = Math.max(0, maxScrollableTop - 110);
        if (scrollContainer) {
          scrollContainer.scrollTop = bounceUp;
          setTimeout(() => {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
            try { scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (e) {}
          }, 90);
        } else {
          window.scrollTo({ top: bounceUp, behavior: 'auto' });
          setTimeout(() => {
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
            try { window.dispatchEvent(new Event('scroll')); } catch (e) {}
          }, 90);
        }
      }

      if (step >= maxSteps || stagnantTicks >= maxStagnantBottomTicks) {
        stopProgressiveAutoScroll();
        renderPageBadgeAndPins();
        if (!tryScrollToLoadedTarget(note)) {
          fallbackScrollToCoordinatesAndPulse(note);
        }
      }
    }, 300);
  }

  function locateNoteWithRetries(note) {
    if (!note) return;
    startProgressiveAutoScrollToPin(note);
  }

  // Recherche la fiche de Philippe Hottois dans le DOM de StarOfService
  function findPhilippeHottoisCardElement() {
    const candidates = document.querySelectorAll('article, section, li, div, h2, h3, h4, a, span');
    let bestCard = null;
    let bestArea = Infinity;
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.closest && el.closest('.pagepin-injected-ui')) continue;
      const txt = String(el.textContent || '').toLowerCase();
      if (txt.includes('philippe') && txt.includes('hottois')) {
        const card = el.closest('article, li, [class*="card"], [class*="pro"], div') || el;
        const r = card.getBoundingClientRect();
        const area = r.width * r.height;
        if (area > 1200 && area < bestArea) {
          bestArea = area;
          bestCard = card;
        }
      }
    }
    return bestCard;
  }

  // Démo animée pas-à-pas sur StarOfService : charge la page jusqu'à la fiche de Philippe Hottois, épingle la note et fait pulser la puce
  function runGuidedPhilippeHottoisDemo() {
    if (demoInProgress || !document.body) return;
    demoInProgress = true;

    let hud = document.querySelector('.pagepin-progressive-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.className = 'pagepin-injected-ui pagepin-progressive-hud';
      document.body.appendChild(hud);
    }

    const setDemoStepHud = (stepTitle, subText, pct) => {
      if (!hud) return;
      hud.innerHTML = `
        <div class="pp-hud-row">
          <span class="pp-hud-title">🎬 ${escapeHtml(stepTitle)}</span>
          <button type="button" id="pp-hud-stop" class="pp-hud-stop">Quitter démo</button>
        </div>
        <div class="pp-hud-sub">${escapeHtml(subText)}</div>
        <div class="pp-hud-bar"><div class="pp-hud-fill" style="width:${pct}%"></div></div>
      `;
      const stopBtn = hud.querySelector('#pp-hud-stop');
      if (stopBtn) {
        stopBtn.onclick = () => {
          demoInProgress = false;
          hud.remove();
        };
      }
    };

    setDemoStepHud(
      'Étape 1/4 · Activation & Chargement progressif',
      'Défilement progressif sur StarOfService (Laeken) jusqu’à la fiche de Philippe Hottois...',
      25
    );
    setAnnotationModeState(true);

    let searchAttempts = 0;
    const locateInterval = setInterval(() => {
      if (!demoInProgress) {
        clearInterval(locateInterval);
        return;
      }
      searchAttempts += 1;
      let targetCard = findPhilippeHottoisCardElement();

      if (!targetCard && searchAttempts < 28) {
        tryTriggerLazyLoadMoreButton();
        const stride = Math.max(480, Math.round(window.innerHeight * 0.78));
        window.scrollBy({ top: stride, behavior: 'auto' });
        try { window.dispatchEvent(new Event('scroll')); } catch (e) {}
        return;
      }

      clearInterval(locateInterval);

      if (!targetCard) {
        targetCard = document.querySelector('main, h1, body') || document.body;
      }

      try {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (e) {}

      targetCard.classList.add('pagepin-demo-target-highlight');
      setDemoStepHud(
        'Étape 2/4 · Fiche de Philippe Hottois localisée !',
        'Ancrage du pointeur sur la fiche « Philippe Hottois — Cours d’informatique »...',
        55
      );

      setTimeout(() => {
        if (!demoInProgress) return;
        const rect = targetCard.getBoundingClientRect();
        const anchorData = {
          selectorPath: getUniqueCssSelector(targetCard),
          elementRelX: 0.78,
          elementRelY: 0.35,
          pageX: Math.round(rect.left + window.scrollX + rect.width * 0.78),
          pageY: Math.round(rect.top + window.scrollY + rect.height * 0.35),
          scrollParentSelector: '',
          scrollParentTop: 0,
          windowScrollY: Math.round(window.scrollY || 0),
          offsetXPercent: 72,
          offsetYPercent: 45,
          quotedText: 'Philippe Hottois — Cours d’informatique à Laeken (StarOfService)',
          selectorLabel: String(targetCard.tagName || 'div').toLowerCase() + '#fiche-philippe-hottois'
        };

        setDemoStepHud(
          'Étape 3/4 · Saisie automatique de la note',
          '« Ne pas oublier de prendre un rendez-vous avec Philippe Hottois »',
          82
        );

        openAddNoteModal(anchorData);

        setTimeout(() => {
          const titleInput = document.querySelector('#pp-title');
          const labelsInput = document.querySelector('#pp-labels');
          const editorEl = document.querySelector('#pp-editor');
          const prioSelect = document.querySelector('#pp-priority');
          const colorSelect = document.querySelector('#pp-color');
          const remInput = document.querySelector('#pp-reminder');

          if (titleInput) {
            titleInput.value = 'Ne pas oublier de prendre un rendez-vous avec Philippe Hottois';
          }
          if (labelsInput) {
            labelsInput.value = 'Rendez-vous, PhilippeHottois, CoursInformatique, Laeken';
          }
          if (editorEl) {
            editorEl.innerHTML =
              '<p><b>Action requise :</b> Contacter <b>Philippe Hottois</b> sur sa fiche StarOfService (Laeken) pour planifier un rendez-vous de cours d’informatique.</p><ul><li>Vérifier ses disponibilités cette semaine</li><li>Confirmer le créneau</li></ul>';
          }
          if (prioSelect) prioSelect.value = 'high';
          if (colorSelect) colorSelect.value = 'rose';
          if (remInput) {
            const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
            const pad = (n) => String(n).padStart(2, '0');
            remInput.value =
              tomorrow.getFullYear() +
              '-' +
              pad(tomorrow.getMonth() + 1) +
              '-' +
              pad(tomorrow.getDate()) +
              'T10:00';
          }

          setTimeout(() => {
            targetCard.classList.remove('pagepin-demo-target-highlight');
            const saveBtn = document.querySelector('#pp-save');
            if (saveBtn) saveBtn.click();
            setDemoStepHud(
              'Étape 4/4 · Note épinglée & Puce #1 en pulsation !',
              'La puce #1 pulse sur la fiche de Philippe Hottois pour indiquer son emplacement exact.',
              100
            );
            demoInProgress = false;
            setTimeout(() => {
              if (hud && hud.parentNode) hud.remove();
            }, 3800);
          }, 1400);
        }, 450);
      }, 1100);
    }, 320);
  }

  function loadAndRender() {
    if (!isContextValid()) return;
    chrome.storage.local.get(
      ['pagepin_notes', 'pagepin_active', 'pagepin_locate_note_id', 'pagepin_demo_pending'],
      (res) => {
        if (chrome.runtime.lastError || !res) return;
        const allNotes = res.pagepin_notes || [];
        annotationMode = Boolean(res.pagepin_active);
        const currentUrl = normalizeUrl(window.location.href);
        pageNotes = allNotes.filter((n) => normalizeUrl(n.url) === currentUrl);
        setAnnotationModeState(annotationMode);

        if (res.pagepin_demo_pending && window.location.hostname.includes('starofservice.be')) {
          chrome.storage.local.remove(['pagepin_demo_pending']);
          runGuidedPhilippeHottoisDemo();
          return;
        }

        if (res.pagepin_locate_note_id) {
          const targetNote = pageNotes.find((n) => n.id === res.pagepin_locate_note_id);
          if (targetNote) {
            initialAutoLocateDone = true;
            chrome.storage.local.remove(['pagepin_locate_note_id', 'pagepin_locate_ts']);
            locateNoteWithRetries(targetNote);
            return;
          }
        }

        // NOUVEAU : Si la page contient une puce située en bas de page dans une partie non encore chargée
        // (ou hors de l'écran initial), lance automatiquement le chargement progressif jusqu'à la puce puis la fait pulser !
        if (!initialAutoLocateDone && !annotationMode && pageNotes.length > 0) {
          const unloadedOrBelowNote = pageNotes.find((n) => {
            const el = resolveTargetElement(n);
            if (!el) return true; // Dans une partie non chargée de la page !
            const r = el.getBoundingClientRect();
            return r.top > window.innerHeight - 40 || r.bottom < 0;
          });
          if (unloadedOrBelowNote) {
            initialAutoLocateDone = true;
            setTimeout(() => {
              startProgressiveAutoScrollToPin(unloadedOrBelowNote);
            }, 300);
          } else {
            initialAutoLocateDone = true;
            const firstEntry = pinElementsMap.get(pageNotes[0].id);
            if (firstEntry && firstEntry.pinEl) {
              showPinSpotlightCallout(firstEntry.pinEl, pageNotes[0], firstEntry.targetEl);
            }
          }
        }
      }
    );
  }

  function renderPageBadgeAndPins() {
    if (!document.body) return;
    document.querySelectorAll('.pagepin-pin-bubble, .pagepin-page-banner').forEach((el) => el.remove());
    pinElementsMap.clear();

    const unloadedCount = pageNotes.filter((n) => !resolveTargetElement(n)).length;

    if (pageNotes.length > 0 || annotationMode) {
      const banner = document.createElement('div');
      banner.className = 'pagepin-injected-ui pagepin-page-banner' + (annotationMode ? ' pagepin-banner-active' : '');
      const locateLabel = unloadedCount > 0
        ? '📌 <strong>' + Number(pageNotes.length) + ' puce(s) (' + unloadedCount + ' en bas non chargée)</strong> — Charger jusqu’à la puce & faire pulser'
        : '📌 <strong>' + Number(pageNotes.length) + ' puce(s) sur cette page</strong> — Aller à la puce & faire pulser';

      banner.innerHTML = annotationMode
        ? '<span class="pp-banner-main">🎯 <strong>Mode annotation ACTIF :</strong> cliquez n\'importe où sur la page</span><button type="button" id="pp-cancel-annot-btn" class="pp-banner-sub pp-banner-danger">Annuler</button>'
        : '<button type="button" id="pp-locate-btn" class="pp-banner-main">' + locateLabel + '</button><button type="button" id="pp-start-annot-btn" class="pp-banner-sub">+ Annoter</button><button type="button" id="pp-dash-btn" class="pp-banner-sub" title="Ouvrir le Tableau de Bord des Pins">Tableau de bord</button>';

      document.body.appendChild(banner);

      const locateBtn = banner.querySelector('#pp-locate-btn');
      if (locateBtn) {
        let cycleIdx = 0;
        locateBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (pageNotes.length > 0) {
            const target = pageNotes[cycleIdx % pageNotes.length];
            cycleIdx += 1;
            startProgressiveAutoScrollToPin(target);
          }
        });
      }
      const startAnnotBtn = banner.querySelector('#pp-start-annot-btn');
      if (startAnnotBtn) {
        startAnnotBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setAnnotationModeState(true);
          if (isContextValid()) chrome.storage.local.set({ pagepin_active: true });
        });
      }
      const cancelAnnotBtn = banner.querySelector('#pp-cancel-annot-btn');
      if (cancelAnnotBtn) {
        cancelAnnotBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setAnnotationModeState(false);
          if (isContextValid()) chrome.storage.local.set({ pagepin_active: false });
        });
      }
      const dashBtn = banner.querySelector('#pp-dash-btn');
      if (dashBtn) {
        dashBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isContextValid()) chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
        });
      }
    }

    const now = Date.now();
    pageNotes.forEach((note, idx) => {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'pagepin-injected-ui pagepin-pin-bubble';
      if (activePulsingNoteId === note.id && now < activePulseUntil) {
        pin.classList.add('pagepin-pin-pulse');
      }
      pin.textContent = String(idx + 1);
      const labelsStr = Array.isArray(note.labels) && note.labels.length > 0 ? ' [' + note.labels.map((l) => '#' + l).join(' ') + ']' : '';
      pin.title = String(note.title || '') + labelsStr + ' (Cliquer pour ouvrir)';
      pin.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showNotePopover(note);
      });
      document.body.appendChild(pin);

      const targetEl = resolveTargetElement(note);
      pinElementsMap.set(note.id, { pinEl: pin, targetEl, note });
    });

    updateAllPinPositions();
  }

  function parseSafeReminderIso(rawVal) {
    if (typeof rawVal !== 'string' || !rawVal.trim()) return null;
    const d = new Date(rawVal.trim());
    if (Number.isNaN(d.getTime())) return null;
    const yr = d.getUTCFullYear();
    if (yr < 2000 || yr > 2100) return null;
    return d.toISOString();
  }

  function showNotePopover(note) {
    document.querySelectorAll('.pagepin-modal-overlay').forEach((el) => el.remove());
    const labelsHtml = Array.isArray(note.labels) && note.labels.length > 0
      ? '<div class="pagepin-labels-row">' + note.labels.map((l) => '<span class="pagepin-label-chip">#' + escapeHtml(l) + '</span>').join('') + '</div>'
      : '';
    const overlay = document.createElement('div');
    overlay.className = 'pagepin-injected-ui pagepin-modal-overlay';
    overlay.innerHTML = `
      <div class="pagepin-modal-card">
        <div class="pagepin-modal-header">
          <h3>${escapeHtml(note.title)}</h3>
          <span class="pagepin-badge">${escapeHtml(note.selectorLabel || 'Élément')}</span>
        </div>
        ${labelsHtml}
        <div class="pagepin-rich-body">${sanitizeRichHtml(note.content)}</div>
        ${note.quotedText ? '<p class="pagepin-quote">« ' + escapeHtml(note.quotedText) + ' »</p>' : ''}
        ${note.reminderAt ? '<p class="pagepin-meta">⏰ Rappel : ' + escapeHtml(new Date(note.reminderAt).toLocaleString('fr-FR')) + '</p>' : ''}
        <div class="pagepin-actions">
          <button id="pagepin-open-dash" type="button">Tableau de bord</button>
          <button id="pagepin-delete-btn" type="button" class="danger">Supprimer</button>
          <button id="pagepin-close-btn" type="button" class="primary">Fermer</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const closePopover = () => {
      document.removeEventListener('keydown', onEscPopover, true);
      overlay.remove();
    };
    const onEscPopover = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closePopover();
      }
    };
    document.addEventListener('keydown', onEscPopover, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closePopover();
    });
    overlay.querySelector('#pagepin-close-btn').onclick = closePopover;
    overlay.querySelector('#pagepin-open-dash').onclick = () => {
      if (isContextValid()) chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    };
    overlay.querySelector('#pagepin-delete-btn').onclick = () => {
      if (!isContextValid()) return;
      chrome.storage.local.get(['pagepin_notes'], (res) => {
        const list = (res.pagepin_notes || []).filter((n) => n.id !== note.id);
        chrome.storage.local.set({ pagepin_notes: list }, () => {
          closePopover();
          loadAndRender();
        });
      });
    };
  }

  function handlePointerDownCapture(e) {
    if (!annotationMode) return;
    if (!isContextValid()) {
      cleanupListeners();
      return;
    }
    const raw = e.target && e.target.nodeType === 1 ? e.target : (e.target ? e.target.parentElement : null);
    if (raw && raw.closest && raw.closest('.pagepin-injected-ui')) return;
    e.stopPropagation();
  }

  function handleClickCapture(e) {
    if (!annotationMode) return;
    if (!isContextValid()) {
      cleanupListeners();
      return;
    }
    const raw = e.target && e.target.nodeType === 1 ? e.target : (e.target ? e.target.parentElement : null);
    if (raw && raw.closest && raw.closest('.pagepin-injected-ui')) return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }

    const targetEl = normalizeClickedElement(e.target);
    const rect = targetEl.getBoundingClientRect ? targetEl.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const elementRelX = rect.width > 0 ? Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width)) : 0.5;
    const elementRelY = rect.height > 0 ? Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height)) : 0.5;
    const selectorPath = getUniqueCssSelector(targetEl);

    const scrollParent = getScrollParent(targetEl);
    const isInnerScroll = Boolean(
      scrollParent &&
      scrollParent !== document.documentElement &&
      scrollParent !== document.body
    );
    const scrollParentSelector = isInnerScroll ? getUniqueCssSelector(scrollParent) : '';
    const scrollParentTop = isInnerScroll ? Math.round(scrollParent.scrollTop || 0) : 0;
    const windowScrollY = Math.round(window.scrollY || 0);

    const scrollX = window.scrollX || (scrollParent ? scrollParent.scrollLeft : 0) || 0;
    const scrollY = window.scrollY || (scrollParent ? scrollParent.scrollTop : 0) || 0;

    const pageX = Math.round(e.clientX + scrollX);
    const pageY = Math.round(e.clientY + scrollY);

    const offsetXPercent = Math.round((e.clientX / Math.max(window.innerWidth, 1)) * 100);
    const offsetYPercent = Math.round((e.clientY / Math.max(window.innerHeight, 1)) * 100);
    const quotedText = String(targetEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const elId = getSafeElementId(targetEl);
    const selectorLabel = String(targetEl.tagName || 'div').toLowerCase() + (elId ? '#' + elId : '');

    openAddNoteModal({
      selectorPath,
      elementRelX,
      elementRelY,
      pageX,
      pageY,
      scrollParentSelector,
      scrollParentTop,
      windowScrollY,
      offsetXPercent,
      offsetYPercent,
      quotedText,
      selectorLabel
    });
  }

  function openAddNoteModal(anchorData) {
    document.querySelectorAll('.pagepin-modal-overlay').forEach((el) => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'pagepin-injected-ui pagepin-modal-overlay';
    overlay.innerHTML = `
      <div class="pagepin-modal-card">
        <h3>Nouvelle note ancrée sur cet élément</h3>
        <p class="pagepin-quote">Cible : ${escapeHtml(anchorData.selectorLabel)} ${anchorData.quotedText ? '— « ' + escapeHtml(anchorData.quotedText.slice(0, 60)) + ' »' : ''}</p>
        <label>Titre de la note *</label>
        <input id="pp-title" type="text" placeholder="Ex: Ne pas oublier de prendre un rendez-vous avec Philippe Hottois..." />
        <label>Labels / Étiquettes (séparés par une virgule)</label>
        <input id="pp-labels" type="text" placeholder="Ex: Rendez-vous, PhilippeHottois, CoursInformatique" />
        <label>Contenu détaillé (Éditeur riche)</label>
        <div class="pagepin-toolbar">
          <button type="button" data-cmd="bold" title="Gras"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Italique"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Souligné"><u>U</u></button>
          <button type="button" data-cmd="insertUnorderedList" title="Liste à puces">• Liste</button>
          <button type="button" data-cmd="insertOrderedList" title="Liste numérotée">1. Liste</button>
        </div>
        <div id="pp-editor" class="pagepin-rich-editor" contenteditable="true"></div>
        <div class="pagepin-row">
          <div>
            <label>Priorité</label>
            <select id="pp-priority">
              <option value="medium">Moyenne</option>
              <option value="high">Haute</option>
              <option value="low">Basse</option>
            </select>
          </div>
          <div>
            <label>Couleur</label>
            <select id="pp-color">
              <option value="indigo">Indigo</option>
              <option value="amber">Ambre</option>
              <option value="emerald">Émeraude</option>
              <option value="rose">Rose</option>
            </select>
          </div>
        </div>
        <div class="pagepin-row">
          <div>
            <label>Date de rappel</label>
            <input id="pp-reminder" type="datetime-local" />
          </div>
          <div>
            <label>Répétition</label>
            <select id="pp-recurrence">
              <option value="none">Une seule fois</option>
              <option value="daily">Tous les jours</option>
              <option value="weekly">Chaque semaine (Lundi)</option>
              <option value="monthly">Chaque mois (le 15)</option>
            </select>
          </div>
        </div>
        <div class="pagepin-actions">
          <button type="button" id="pp-cancel">Annuler</button>
          <button type="button" id="pp-save" class="primary">Épingler la note</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    setTimeout(() => {
      const titleInput = overlay.querySelector('#pp-title');
      if (titleInput) titleInput.focus();
    }, 30);

    overlay.querySelectorAll('.pagepin-toolbar button').forEach((btn) => {
      btn.addEventListener('mousedown', (ev) => ev.preventDefault());
      btn.addEventListener('click', () => {
        const cmd = btn.getAttribute('data-cmd');
        const editor = overlay.querySelector('#pp-editor');
        editor.focus();
        document.execCommand(cmd, false);
      });
    });

    const closeModal = () => {
      document.removeEventListener('keydown', onEscModal, true);
      overlay.remove();
    };
    const onEscModal = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        closeModal();
      }
    };
    document.addEventListener('keydown', onEscModal, true);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });

    overlay.querySelector('#pp-cancel').onclick = closeModal;
    const saveBtn = overlay.querySelector('#pp-save');
    saveBtn.onclick = () => {
      if (saveBtn.disabled) return;
      saveBtn.disabled = true;

      const title = overlay.querySelector('#pp-title').value.trim() || 'Note épinglée';
      const rawLabels = overlay.querySelector('#pp-labels').value;
      const labels = rawLabels
        ? rawLabels.split(',').map((s) => s.trim().replace(/^#+/, '')).filter(Boolean)
        : [];
      const rawEditorHtml = overlay.querySelector('#pp-editor').innerHTML.trim();
      const content = sanitizeRichHtml(rawEditorHtml) || '<p>Note enregistrée sur cet élément.</p>';
      const priority = overlay.querySelector('#pp-priority').value || 'medium';
      const color = overlay.querySelector('#pp-color').value || 'indigo';
      const reminderVal = overlay.querySelector('#pp-reminder').value;
      const recFreq = overlay.querySelector('#pp-recurrence').value;

      if (!isContextValid()) {
        closeModal();
        return;
      }

      chrome.storage.local.get(['pagepin_notes'], (res) => {
        const list = (res && res.pagepin_notes) || [];
        const newNote = {
          id: 'note-' + Date.now(),
          url: normalizeUrl(window.location.href),
          siteTitle: document.title || window.location.hostname,
          domain: window.location.hostname.replace(/^www\./, ''),
          blockId: 'dom-element',
          selectorLabel: anchorData.selectorLabel,
          selectorPath: anchorData.selectorPath,
          elementRelX: anchorData.elementRelX,
          elementRelY: anchorData.elementRelY,
          pageX: anchorData.pageX,
          pageY: anchorData.pageY,
          scrollParentSelector: anchorData.scrollParentSelector || '',
          scrollParentTop: anchorData.scrollParentTop || 0,
          windowScrollY: anchorData.windowScrollY || 0,
          quotedText: anchorData.quotedText,
          offsetXPercent: anchorData.offsetXPercent,
          offsetYPercent: anchorData.offsetYPercent,
          title,
          content,
          color,
          priority,
          labels,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          reminderAt: parseSafeReminderIso(reminderVal),
          recurrence: {
            frequency: recFreq,
            dayOfWeek: 1,
            dayOfMonth: 15
          },
          reminderNotified: false,
          completed: false
        };
        const nowMs = Date.now();
        const isDuplicate = list.some((ex) => {
          const exTime = new Date(ex.createdAt || 0).getTime();
          return (
            !Number.isNaN(exTime) &&
            Math.abs(nowMs - exTime) <= 2500 &&
            normalizeUrl(ex.url) === newNote.url &&
            String(ex.selectorPath || '') === String(newNote.selectorPath || '') &&
            String(ex.title || '').trim().toLowerCase() === newNote.title.toLowerCase()
          );
        });
        const nextList = isDuplicate ? list : [newNote, ...list];
        chrome.storage.local.set(
          { pagepin_notes: nextList, pagepin_active: false, pagepin_locate_note_id: newNote.id },
          () => {
            closeModal();
            setAnnotationModeState(false);
            loadAndRender();
          }
        );
      });
    };
  }

  function cleanupListeners() {
    stopProgressiveAutoScroll();
    syncCaptureListeners(false);
    window.removeEventListener('scroll', schedulePositionUpdate, true);
    window.removeEventListener('resize', schedulePositionUpdate);
  }

  window.__pagepinCleanup = cleanupListeners;

  window.addEventListener('scroll', schedulePositionUpdate, { capture: true, passive: true });
  window.addEventListener('resize', schedulePositionUpdate, { passive: true });

  if (isContextValid()) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
      if (msg && msg.type === 'SET_ANNOTATION_MODE') {
        setAnnotationModeState(Boolean(msg.active));
        sendResponse({ ok: true, active: annotationMode });
        return true;
      }
      if (msg && msg.type === 'START_GUIDED_DEMO') {
        runGuidedPhilippeHottoisDemo();
        sendResponse({ ok: true });
        return true;
      }
      if (msg && msg.type === 'LOCATE_NOTE' && msg.noteId) {
        const target = pageNotes.find((n) => n.id === msg.noteId);
        if (target) {
          locateNoteWithRetries(target);
        } else {
          loadAndRender();
        }
        sendResponse({ ok: true });
        return true;
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !isContextValid()) return;
      if (
        changes.pagepin_notes ||
        changes.pagepin_active ||
        changes.pagepin_locate_note_id ||
        changes.pagepin_demo_pending
      ) {
        loadAndRender();
      }
    });
    loadAndRender();
  }
})();