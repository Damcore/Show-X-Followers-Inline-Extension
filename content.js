(() => {
  // Do not run inside background scrape tabs.
  try{
    const u = new URL(location.href);
    if (u.searchParams.get('xmeta_scrape') === '1') return;
  } catch {}

  const STYLE_ID = 'xmeta-style';
  const LINE_CLASS = 'xmeta-line';
  const PARENT_CLASS = 'xmeta-parent-wrap';

  const handleElements = new Map(); // handleKey -> Set<HTMLElement>
  const handleState = new Map();    // handleKey -> {status,user}
  let settings = null;
  let rateLimitUntil = 0;

  const DEBUG = false;
  const dlog = (...a) => { if (DEBUG) console.log('[xmeta]', ...a); };

  function sendMessage(msg){
    return new Promise((resolve) => {
      try{
        chrome.runtime.sendMessage(msg, resp => resolve(resp));
      } catch (e){
        resolve({ ok:false, error:String(e?.message || e) });
      }
    });
  }

  function isPaused(){
    return rateLimitUntil && Date.now() < rateLimitUntil;
  }

  function rateLimitMessage(){
    if (!rateLimitUntil) return 'Rate limit detected - pausing';
    const remainingMs = Math.max(0, rateLimitUntil - Date.now());
    const mins = Math.max(1, Math.ceil(remainingMs / 60000));
    return `Rate limit detected - pausing (resumes in ${mins} min)`;
  }

  function clampNumber(v, min, max, fallback){
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  }

  function getScrollPauseMs(){
    return clampNumber(settings?.scrollPauseMs, 100, 5000, 500);
  }

  function getPrefetchBatchSize(){
    return clampNumber(settings?.prefetchBatchSize, 20, 1000, 200);
  }

  function ensureStyle(){
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${LINE_CLASS}{
        font-size: 12px;
        line-height: 16px;
        min-height: 16px;
        margin-top: 2px;
        color: rgb(113,118,123);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: auto;
        user-select: text;
        -webkit-user-select: text;
        cursor: text;
        display: block;
        width: 100%;
      }
      .${PARENT_CLASS}{
        flex-wrap: wrap !important;
        align-items: flex-start !important;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function formatCount(n){
    const f = window.XPMI_SHARED && window.XPMI_SHARED.formatCount;
    return f ? f(n) : (n == null ? '-' : String(n));
  }


  function getFollowerColor(f){
    const fn = window.XPMI_SHARED && window.XPMI_SHARED.getFollowerColor;
    const colors = (settings && settings.followerColors) ? settings.followerColors : null;
    return fn ? fn(f, colors) : 'rgb(113,118,123)';
  }

  function getJoinedYear(user){
    const y = user && user.joinedYear;
    if (y == null) return null;
    const m = String(y).match(/\b(19\d{2}|20\d{2})\b/);
    return m ? m[1] : null;
  }


  function getHeaderContainer(article){
    return article.querySelector('[data-testid="User-Name"]') || article.querySelector('header');
  }

  function findHandleInHeader(headerEl){
    // Prefer a profile link
    const links = headerEl.querySelectorAll('a[href^="/"]');
    for (const a of links){
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
      if (m) return m[1];
    }
    // Fallback: find "@handle" text
    const t = headerEl.textContent || '';
    const m2 = t.match(/@([A-Za-z0-9_]{1,15})/);
    return m2 ? m2[1] : null;
  }

  function findProfileLink(headerEl, handleLower){
    for (const a of headerEl.querySelectorAll('a[href^="/"]')){
      const href = a.getAttribute('href') || '';
      const m = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
      if (m && m[1].toLowerCase() === handleLower) return a;
    }
    return null;
  }

  function findHandleSpan(headerEl, handleLower){
    const want = '@' + handleLower;
    for (const s of headerEl.querySelectorAll('span')){
      const t = (s.textContent || '').trim().toLowerCase();
      if (t === want) return s;
    }
    return null;
  }

  function findInjectionParent(headerEl, handleLower){
    // We want a real second line. Most tweet headers use a flex row (name, @handle, dot, time).
    // If that flex row is nowrap, appending a block element will still stay on the same line.
    // Solution: append into the flex row container and force flex-wrap: wrap for THAT container only.
    const handleSpan = findHandleSpan(headerEl, handleLower);
    const profileLink = findProfileLink(headerEl, handleLower);

    if (!handleSpan) return headerEl;

    // Find the smallest ancestor that is a flex container and contains the profile link (if found).
    let node = handleSpan;
    while (node && node !== headerEl){
      node = node.parentElement;
      if (!node) break;
      if (profileLink && !node.contains(profileLink)) continue;

      const cs = window.getComputedStyle(node);
      if (cs && cs.display === 'flex'){
        return node;
      }
    }
    return headerEl;
  }

  function getOrCreateLine(article, headerEl, handleKey){
    let line = article.querySelector(`.${LINE_CLASS}[data-xmeta-handlekey="${handleKey}"]`);
    if (line) return line;

    line = document.createElement('div');
    line.className = LINE_CLASS;
    line.setAttribute('data-xmeta-handlekey', handleKey);
    line.textContent = 'Followers: … (waiting)';

    const parent = findInjectionParent(headerEl, handleKey);
    try{ parent.classList.add(PARENT_CLASS); } catch {}
    parent.appendChild(line);

    return line;
  }

  function track(handleKey, el){
    let set = handleElements.get(handleKey);
    if (!set){ set = new Set(); handleElements.set(handleKey, set); }
    set.add(el);
  }

  function pruneHandleElements(){
    for (const [hk, set] of handleElements.entries()){
      for (const el of Array.from(set)){
        if (!el || !el.isConnected) set.delete(el);
      }
      if (set.size === 0) handleElements.delete(hk);
    }
  }

  function pruneHandleState(){
    for (const hk of handleState.keys()){
      const set = handleElements.get(hk);
      if (!set || set.size === 0) handleState.delete(hk);
    }
  }

  // Batch prefetch: request visible handles only after scrolling pauses.
  // This reduces wasted scrapes on authors that immediately scroll out of view.
  const pendingHandles = new Set();
  // On initial page render (no scrolling yet), still kick off quickly so the
  // extension feels responsive.
  const INITIAL_PREFETCH_DEBOUNCE_MS = 50;
  let lastScrollAt = 0;
  let prefetchTimer = null;

  function schedulePrefetchFlush(){
    if (prefetchTimer) clearTimeout(prefetchTimer);

    const sinceScroll = Date.now() - lastScrollAt;
    const pauseMs = getScrollPauseMs();
    // If the user hasn't scrolled recently, flush soon (but still debounce a bit
    // to coalesce DOM mutations). Otherwise wait until the scroll pause window.
    const delay = (sinceScroll >= pauseMs)
      ? INITIAL_PREFETCH_DEBOUNCE_MS
      : Math.max(0, pauseMs - sinceScroll);

    prefetchTimer = setTimeout(() => {
      prefetchTimer = null;
      flushPending().catch(err => dlog('flushPending err', err));
    }, delay);
  }

  async function flushPending(){
    if (!settings?.enabled) return;
    if (document.hidden) return;
    if (Date.now() - lastScrollAt < getScrollPauseMs()){
      schedulePrefetchFlush();
      return;
    }

    const batchSize = getPrefetchBatchSize();
    const batch = Array.from(pendingHandles).slice(0, batchSize);
    batch.forEach(h => pendingHandles.delete(h));
    await requestHandles(batch);

    if (pendingHandles.size) schedulePrefetchFlush();
  }

  function markPending(handle){
    if (!handle) return;
    pendingHandles.add(handle);
    schedulePrefetchFlush();
  }

  window.addEventListener('scroll', () => {
    lastScrollAt = Date.now();
    schedulePrefetchFlush();
  }, { passive: true });

  function renderLine(lineEl, state){
    const s = settings || {};
    const showFollowers = s.showFollowers !== false;
    const showFollowing = !!s.showFollowing;
    const showJoined = !!s.showJoined;
    const showLocation = !!s.showLocation;

    const user = state?.user || null;

    if (isPaused() && !user){
      lineEl.textContent = rateLimitMessage();
      return;
    }

    if (!user){
      lineEl.textContent = showFollowers ? 'Followers: … (waiting)' : '';
      return;
    }

    if (user.unavailable){
      const parts = [];
      if (showFollowers) parts.push('Followers: -');
      if (showFollowing) parts.push('Following: -');
      if (showJoined) parts.push('Joined: -');
      if (showLocation) parts.push('Location: -');
      lineEl.textContent = parts.join(' | ');
      return;
    }

    const parts = [];
    if (showFollowers){
      const v = user.followers == null ? '-' : formatCount(user.followers);
      const span = document.createElement('span');
      // Label stays grey (inherits from .xmeta-line), number is colored.
      span.appendChild(document.createTextNode('Followers: '));

      const num = document.createElement('span');
      num.textContent = v;
      num.style.color = getFollowerColor(user.followers);
      num.style.fontWeight = '500';
      span.appendChild(num);

      parts.push(span);
    }
    const pushText = (t) => {
      const sp = document.createElement('span');
      sp.textContent = t;
      parts.push(sp);
    };

    if (showFollowing) pushText(`Following: ${user.following == null ? '-' : formatCount(user.following)}`);
    if (showJoined) pushText(`Joined: ${getJoinedYear(user) || '-'}`);
    if (showLocation) pushText(`Location: ${user.location || '-'}`);

    lineEl.replaceChildren();
    parts.forEach((p, i) => {
      if (i) lineEl.appendChild(document.createTextNode(' | '));
      lineEl.appendChild(p);
    });
  }

  function getTweetId(article){
    // X uses virtualized DOM and may recycle <article> nodes as you scroll.
    // If we only scan "new" articles once, our injected line can disappear
    // when X re-renders / replaces the header (common for reposts/media-only).
    // A stable tweet id lets us detect reuse and re-inject safely.
    const a = article.querySelector('a[href*="/status/"]');
    const href = a?.getAttribute('href') || '';
    const m = href.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  async function requestHandles(handles){
    if (!handles.length) return;
    const resp = await sendMessage({ type:'xmeta:requestUsers', handles });

    if (resp?.ok && resp.results){
      for (const [hk, r] of Object.entries(resp.results)){
        if (!handleState.has(hk)) handleState.set(hk, { status: r.status, user: r.user || null });
        else handleState.set(hk, { status: r.status, user: r.user || null });
        const set = handleElements.get(hk);
        if (set){
          for (const el of Array.from(set)){
            if (!el.isConnected){ set.delete(el); continue; }
            renderLine(el, handleState.get(hk));
          }
        }
      }
    }
  }

  function scanNew(){
    if (!settings?.enabled) return;

    ensureStyle();

    // Scan all tweet articles. We keep this idempotent so we can re-inject
    // if X re-renders a tweet header (especially common for reposts with only media).
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    const toRequest = [];
    const seen = new Set();
    let firstEligible = null;

    for (const article of articles){
      // Detect virtualized/recycled articles.
      const tid = getTweetId(article);
      const prevTid = article.getAttribute('data-xmeta-tweetid');
      if (tid && prevTid && prevTid !== tid){
        // Article was reused for a different tweet: remove any stale injected lines.
        for (const el of Array.from(article.querySelectorAll(`.${LINE_CLASS}`))){
          try{ el.remove(); } catch {}
        }
      }
      if (tid) article.setAttribute('data-xmeta-tweetid', tid);

      // Ignore promoted
      if (article.querySelector('[data-testid="placementTracking"]')) continue;

      const header = getHeaderContainer(article);
      if (!header) continue;

      const handle = findHandleInHeader(header);
      if (!handle) continue;

      const hk = handle.toLowerCase();

      if (!firstEligible) firstEligible = article;

      // If the article changed author/handle but kept our old line, clean it up.
      for (const el of Array.from(article.querySelectorAll(`.${LINE_CLASS}`))){
        const k = el.getAttribute('data-xmeta-handlekey');
        if (k && k !== hk){
          try{ el.remove(); } catch {}
        }
      }

      const line = getOrCreateLine(article, header, hk);
      track(hk, line);
      if (!handleState.has(hk)) handleState.set(hk, { status:'queued', user:null });
      renderLine(line, handleState.get(hk));

      if (!seen.has(hk)){
        seen.add(hk);
        toRequest.push(handle);
      }
    }

    pruneHandleElements();
    pruneHandleState();
    for (const h of toRequest.slice(0, 400)) markPending(h);
  }

  // Debounce scanning to avoid CPU spikes from MutationObserver storms.
  let scanTimer = null;
  function scheduleScan(){
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanNew();
    }, 250);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'xmeta:userUpdate'){
      handleState.set(msg.handleKey, { status:'fresh', user: msg.user });
      const set = handleElements.get(msg.handleKey);
      if (set){
        for (const el of Array.from(set)){
          if (!el.isConnected){ set.delete(el); continue; }
          renderLine(el, handleState.get(msg.handleKey));
        }
      }
    }
    if (msg?.type === 'xmeta:settings'){
      settings = msg.settings || settings;
      scheduleScan();
      schedulePrefetchFlush();
    }
    if (msg?.type === 'xmeta:rateLimit'){
      rateLimitUntil = msg.until || 0;
      for (const [hk, st] of handleState.entries()){
        const set = handleElements.get(hk);
        if (set){
          for (const el of Array.from(set)){
            if (!el.isConnected){ set.delete(el); continue; }
            renderLine(el, st);
          }
        }
      }
    }
    if (msg?.type === 'xmeta:rateLimitCleared'){
      rateLimitUntil = 0;
      scheduleScan();
    }
  });

  const mo = new MutationObserver((mutList) => {
    let shouldScan = false;
    for (const m of mutList){
      for (const n of m.addedNodes || []){
        if (n.nodeType === 1 && n.classList && n.classList.contains(LINE_CLASS)) continue;
        shouldScan = true;
      }
      for (const n of m.removedNodes || []){
        shouldScan = true;
      }
    }
    if (shouldScan) scheduleScan();
  });

  mo.observe(document.documentElement, { childList: true, subtree: true });

  async function init(){
    const st = await sendMessage({ type:'xmeta:getStatus' });
    settings = st?.settings || settings || { enabled:true };
    rateLimitUntil = st?.status?.rateLimitUntil || 0;
    // Kick off immediately so the first paint feels responsive.
    // Subsequent scans are driven by the MutationObserver debounce.
    await scanNew();
    setTimeout(() => { scanNew(); }, 600);
    setTimeout(() => { scanNew(); }, 1600);
  }

  init().catch(()=>{});
})();
