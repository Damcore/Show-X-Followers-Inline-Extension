import { XMetaUtils } from './utils.js';

const DEBUG = false;
const dlog = (...a) => { if (DEBUG) console.log('[xmeta]', ...a); };

// New schema (no backwards-compat required per request).
// Users are stored as: { fetchedAt, followers, following, joinedYear, location, unavailable }
const SCHEMA_VERSION = 4;

const DEFAULT_SETTINGS = {
  enabled: true,
  showFollowers: true,
  showFollowing: true,
  showJoined: true,
  showLocation: false,
  themeMode: 'auto',
  maxRequestsPerMinute: 20,
  cacheTTLdays: 30,
  maxConcurrentTabs: 3,
  rateLimitPauseMinutes: 5,
  scrollPauseMs: 500,
  prefetchBatchSize: 200,
  scrapeTabLoadTimeoutMs: 15000,
  scrapeProfileHeaderWaitMs: 10000,
  unavailableTTLhours: 24,
  followerColors: {
    gt1m: '#f4212e',
    k250to1m: '#ff9f0a',
    k25to250k: '#ffd60a',
    k5to25k: '#00ba7c',
    k1to5k: '#40dca0',
    lt1k: '#D02ED9'
  }
};

const MAX_CONCURRENT_TABS = 3;
const PROCESS_ALARM = 'xmeta_process';
const RATE_LIMIT_ALARM = 'xmeta_rate_limit_clear';

let state = {
  schemaVersion: SCHEMA_VERSION,
  users: Object.create(null),
  settings: { ...DEFAULT_SETTINGS }
};

let queue = [];              // tasks: {handleKey, handle, enqueuedAt}
let queued = new Set();      // handleKey
let inflight = new Set();    // handleKey
let requestTimes = [];       // timestamps for rpm limiting
let activeScrapes = 0;
let rateLimitUntil = 0;

const now = () => Date.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function clampNumber(v, min, max, fallback){
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function createEmptyUsers(){
  return Object.create(null);
}

function toSafeUsers(obj){
  const out = createEmptyUsers();
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) out[k] = v;
  return out;
}

function normalizeFollowerColors(followerColors){
  const src = followerColors || {};
  const out = {
    gt1m: src.gt1m ?? src.red,
    k250to1m: src.k250to1m ?? src.orange,
    k25to250k: src.k25to250k ?? src.yellow,
    k5to25k: src.k5to25k ?? src.green,
    k1to5k: src.k1to5k ?? src.lightGreen,
    lt1k: src.lt1k ?? src.white
  };
  if (typeof out.lt1k === 'string' && out.lt1k.trim().toLowerCase() === '#ffffff'){
    out.lt1k = '#D02ED9';
  }
  return out;
}

function unavailableTtlMs(settings){
  const hours = Math.max(1, Number(settings?.unavailableTTLhours || DEFAULT_SETTINGS.unavailableTTLhours || 24));
  return hours * 3600_000;
}

function isPausedForRateLimit(){
  return rateLimitUntil && now() < rateLimitUntil;
}

function broadcastRateLimit(untilTs){
  rateLimitUntil = untilTs;
  const remainingMs = Math.max(0, untilTs - now());
  broadcast({ type:'xmeta:rateLimit', until: untilTs, remainingMs }).catch(()=>{});
}

function clearRateLimit(){
  if (!rateLimitUntil) return;
  rateLimitUntil = 0;
  try { chrome.alarms?.clear(RATE_LIMIT_ALARM); } catch {}
  broadcast({ type:'xmeta:rateLimitCleared' }).catch(()=>{});
}

function scheduleRateLimitClear(untilTs){
  if (!untilTs) return;
  if (chrome.alarms?.create){
    try { chrome.alarms.create(RATE_LIMIT_ALARM, { when: untilTs + 50 }); } catch {}
    return;
  }
  setTimeout(() => {
    clearRateLimit();
    scheduleProcess(now());
  }, Math.max(0, untilTs - now()) + 50);
}

async function hasUserTabs(){
  try{
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*'] });
    // Ignore our hidden scrape tabs identified by the query param.
    return tabs.some(t => {
      const u = t.pendingUrl || t.url || '';
      return u && !u.includes('xmeta_scrape=1');
    });
  } catch {
    // If tab query fails, err on the side of allowing scrapes.
    return true;
  }
}

async function waitForProfileDOM(tabId, timeoutMs = 15000){
  // X is an SPA; the tab can reach "complete" before the profile header/metrics appear.
  // This wait is best-effort and intentionally short: we still scrape even if it times out.
  const start = now();
  while (now() - start < timeoutMs){
    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const nameBlock = document.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
          const hasFollowersLink = !!document.querySelector('a[href$="/followers"], a[href*="/verified_followers"]');
          const hasFollowingLink = !!document.querySelector('a[href$="/following"]');
          const hasJoin = !!document.querySelector('[data-testid="UserJoinDate"]');
          const hasLoc = !!document.querySelector('[data-testid="UserLocation"]');
          return !!nameBlock && (hasFollowersLink || hasFollowingLink || hasJoin || hasLoc);
        }
      });
      if (res && res[0] && res[0].result) return true;
    } catch (e) {
      // Ignore transient executeScript errors while the tab navigates.
    }
    await sleep(250);
  }
  return false;
}

async function detectRateLimit(tabId){
  try{
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const nav = performance.getEntriesByType('navigation');
        const status = (nav && nav[0] && typeof nav[0].responseStatus === 'number') ? nav[0].responseStatus : null;

        // Scan resource timing for API 429 responses (e.g., account/settings.json).
        const resEntries = performance.getEntriesByType('resource') || [];
        const res429 = resEntries.some(e => typeof e.responseStatus === 'number' && e.responseStatus === 429);

        const text = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
        const hint = /rate limit/i.test(text) || /HTTP-?429/i.test(text);

        return { status, res429, hint };
      }
    });
    return res?.result || {};
  } catch (e){
    return {};
  }
}

async function loadState(){
  const r = await chrome.storage.local.get('xmeta');
  const x = r?.xmeta;

  if (!x || typeof x !== 'object'){
    state = { schemaVersion: SCHEMA_VERSION, users: createEmptyUsers(), settings: { ...DEFAULT_SETTINGS } };
    await chrome.storage.local.set({ xmeta: state });
    return state;
  }

  let needsSave = false;

  // Merge settings (including nested followerColors)
  const incoming = x.settings || {};
  const normalizedColors = normalizeFollowerColors({ ...DEFAULT_SETTINGS.followerColors, ...(incoming.followerColors || {}) });
  if (JSON.stringify(normalizedColors) !== JSON.stringify(incoming.followerColors)) needsSave = true;
  x.settings = { ...DEFAULT_SETTINGS, ...incoming, followerColors: normalizedColors };

  if (x.schemaVersion !== SCHEMA_VERSION){
    // No backwards-compat requested: wipe users to avoid mismatched shapes.
    x.schemaVersion = SCHEMA_VERSION;
    x.users = createEmptyUsers();
    state = x;
    await chrome.storage.local.set({ xmeta: x });
    return x;
  }

  x.users = toSafeUsers(x.users);
  state = x;
  if (needsSave) await chrome.storage.local.set({ xmeta: state });
  return state;
}

async function saveState(){
  await chrome.storage.local.set({ xmeta: state });
}

function isFresh(entry, settings){
  if (!entry?.fetchedAt) return false;
  const age = now() - entry.fetchedAt;

  // Retry "unavailable" entries sooner (24h) so temporary issues can recover.
  const ttlMs = entry.unavailable ? unavailableTtlMs(settings)
    : (Math.max(1, Number(settings.cacheTTLdays || 30)) * 86400_000);

  return age < ttlMs;
}

function shouldRetryMissing(entry){
  if (!entry || entry.unavailable) return false;
  const missingFollowers = entry.followers == null;
  const missingFollowing = entry.following == null;
  if (!missingFollowers && !missingFollowing) return false;
  const fetched = entry.fetchedAt || 0;
  return (now() - fetched) > 30_000;
}

function pruneRequestTimes(rpm){
  const cutoff = now() - 60_000;
  requestTimes = requestTimes.filter(t => t >= cutoff);
  return requestTimes.length < rpm;
}

function nextAllowedTime(){
  const cutoff = now() - 60_000;
  requestTimes = requestTimes.filter(t => t >= cutoff);
  if (requestTimes.length === 0) return now();
  const oldest = Math.min(...requestTimes);
  return oldest + 60_000;
}

function enqueue(handleKey, handle){
  if (queued.has(handleKey) || inflight.has(handleKey)) return;
  queued.add(handleKey);
  queue.push({ handleKey, handle, enqueuedAt: now() });
}

function scheduleProcess(whenMs){
  const target = Number.isFinite(whenMs) ? whenMs : now();
  const when = Math.max(now(), target);
  const delay = when - now();
  if (delay === 0){
    try { chrome.alarms?.clear(PROCESS_ALARM); } catch {}
    processQueue().catch(err => dlog('processQueue error', err));
    return;
  }
  if (chrome.alarms?.create){
    try { chrome.alarms.create(PROCESS_ALARM, { when }); } catch {}
    return;
  }
  setTimeout(() => {
    processQueue().catch(err => dlog('processQueue error', err));
  }, delay);
}

async function broadcast(msg){
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*'] });
  await Promise.allSettled(tabs.map(t => chrome.tabs.sendMessage(t.id, msg).catch(()=>{})));
}

function makeUnavailable(){
  return { fetchedAt: now(), unavailable: true };
}

function waitForTabComplete(tabId, timeoutMs){
  return new Promise(async (resolve, reject) => {
    const started = now();
    let done = false;

    async function check(){
      try{
        const t = await chrome.tabs.get(tabId);
        if (t?.status === 'complete'){
          cleanup();
          done = true;
          return resolve(t);
        }
      } catch {}
      if (now() - started > timeoutMs){
        cleanup();
        reject(new Error('tab_load_timeout'));
      }
    }

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete'){
        cleanup();
        done = true;
        resolve();
      }
    };

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearInterval(interval);
      clearTimeout(timeout);
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    const interval = setInterval(check, 300);
    const timeout = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new Error('tab_load_timeout'));
    }, timeoutMs);

    await check();
    if (done) return;
  });
}

async function scrapeProfileViaTab(handle, handleKey, settings){
  // Mark scrape tabs so the content script can self-disable.
  const url = `https://x.com/${encodeURIComponent(handle)}?xmeta_scrape=1`;
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  let rateLimited = false;
  const tabLoadTimeoutMs = clampNumber(settings?.scrapeTabLoadTimeoutMs, 3000, 60000, 15000);
  const profileWaitMs = clampNumber(settings?.scrapeProfileHeaderWaitMs, 1000, 60000, 10000);

  const closeTab = async () => {
    try { await chrome.tabs.remove(tabId); } catch {}
  };

  try{
    await waitForTabComplete(tabId, tabLoadTimeoutMs);

    // X is an SPA and can report "complete" before profile metrics exist.
    // Keep this short; we still attempt the scrape even if the hint check times out.
    await waitForProfileDOM(tabId, profileWaitMs);

    const rateInfo = await detectRateLimit(tabId);
    rateLimited = (rateInfo?.status === 429) || !!rateInfo?.hint || !!rateInfo?.res429;

    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [handleKey],
      func: (targetHandleKey) => {
        const out = {
          targetHandleKey,
          actualHandle: null,
          followersText: null,
          followingText: null,
          location: null,
          joinedText: null
        };

        // Verify handle from profile header if possible
        const nameBlock = document.querySelector('[data-testid="UserName"], [data-testid="User-Name"]');
        if (nameBlock){
          const spans = Array.from(nameBlock.querySelectorAll('span'));
          const handleSpan = spans.find(s => {
            const t = (s.textContent || '').trim();
            return /^@[A-Za-z0-9_]{1,15}$/.test(t);
          });
          out.actualHandle = handleSpan ? handleSpan.textContent.trim().replace(/^@/,'') : null;
        }

        const locEl = document.querySelector('[data-testid="UserLocation"] span span, [data-testid="UserLocation"] span');
        if (locEl) out.location = (locEl.textContent || '').trim() || null;

        const joinEl = document.querySelector('[data-testid="UserJoinDate"] span');
        if (joinEl) out.joinedText = (joinEl.textContent || '').trim() || null;

        const hk = String(targetHandleKey || '').toLowerCase();
        const followingA =
          document.querySelector(`a[href="/${hk}/following"]`) ||
          document.querySelector('a[href$="/following"]');

        const followersA =
          document.querySelector(`a[href="/${hk}/followers"]`) ||
          document.querySelector(`a[href="/${hk}/verified_followers"]`) ||
          document.querySelector('a[href$="/followers"], a[href*="/verified_followers"]');

        function readCountText(a){
          if (!a) return null;
          const numSpan = a.querySelector('span span') || a.querySelector('span');
          const t = (numSpan?.textContent || '').trim();
          return t || null;
        }

        out.followingText = readCountText(followingA);
        out.followersText = readCountText(followersA);

        return out;
      }
    });

    const raw = res?.result;
    if (!raw) return { user: makeUnavailable(), rateLimited };

    if (raw.actualHandle && String(raw.actualHandle).toLowerCase() !== String(handleKey).toLowerCase()){
      return { user: makeUnavailable(), rateLimited };
    }

    const followers = XMetaUtils.parseCountText(raw.followersText);
    const following = XMetaUtils.parseCountText(raw.followingText);
    const joinedYear = XMetaUtils.parseJoinedYear(raw.joinedText);

    const user = {
      followers: followers ?? null,
      following: following ?? null,
      location: raw.location || null,
      joinedYear: joinedYear || null,
      fetchedAt: now()
    };

    // If everything is missing, treat as unavailable (login wall / protected / blocked / layout change)
    if (user.followers == null && user.following == null && !user.location && !user.joinedYear){
      return { user: makeUnavailable(), rateLimited };
    }

    return { user, rateLimited };
  } catch (err){
    return { user: makeUnavailable(), rateLimited };
  } finally {
    await closeTab();
  }
}

async function processQueue(){
  await loadState();
  const settings = state.settings || DEFAULT_SETTINGS;

  if (!settings.enabled) return;

  if (isPausedForRateLimit()){
    scheduleProcess(rateLimitUntil);
    return;
  }

  const hasTabs = await hasUserTabs();
  if (!hasTabs){
    scheduleProcess(now() + 5000);
    return;
  }

  const rpm = Math.min(120, Math.max(1, Number(settings.maxRequestsPerMinute || 20)));
  const maxTabs = Math.min(10, Math.max(1, Number(settings.maxConcurrentTabs || MAX_CONCURRENT_TABS)));

  while (queue.length){
    if (isPausedForRateLimit()){
      scheduleProcess(rateLimitUntil);
      break;
    }
    if (activeScrapes >= maxTabs) break;
    if (!pruneRequestTimes(rpm)) break;

    const task = queue.shift();
    if (!task) break;
    queued.delete(task.handleKey);
    inflight.add(task.handleKey);
    activeScrapes++;
    requestTimes.push(now());

    dlog('scrape start', task.handleKey);

    (async () => {
      try{
        const result = await scrapeProfileViaTab(task.handle, task.handleKey, settings);
        const user = result?.user || makeUnavailable();

        if (result?.rateLimited){
          const pauseMs = Math.max(1, Number(settings.rateLimitPauseMinutes || DEFAULT_SETTINGS.rateLimitPauseMinutes || 5)) * 60_000;
          const until = now() + pauseMs;
          if (until > rateLimitUntil){
            broadcastRateLimit(until);
            scheduleRateLimitClear(until);
          }
        }

        state.users[task.handleKey] = user;
        await saveState();
        await broadcast({ type:'xmeta:userUpdate', handleKey: task.handleKey, user });
      } catch (err){
        dlog('scrape error', err);
        state.users[task.handleKey] = makeUnavailable();
      } finally {
        inflight.delete(task.handleKey);
        activeScrapes = Math.max(0, activeScrapes - 1);
        scheduleProcess(now() + 150);
      }
    })();
  }

  if (queue.length){
    scheduleProcess(nextAllowedTime() + 200);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await loadState();
    const settings = state.settings || DEFAULT_SETTINGS;

    if (msg?.type === 'xmeta:getStatus'){
      const users = state.users || {};
      const lastFetch = Object.values(users).reduce((mx, u) => Math.max(mx, u?.fetchedAt || 0), 0);
      sendResponse({
        ok: true,
        settings,
        status: {
          cacheSize: Object.keys(users).length,
          lastFetch,
          queueLength: queue.length,
          activeScrapes,
          rateLimitUntil
        }
      });
      return;
    }

    if (msg?.type === 'xmeta:requestUsers'){
      if (!settings.enabled){
        sendResponse({ ok:true, results:{} });
        return;
      }

      const handles = Array.isArray(msg.handles) ? msg.handles : [];
      const results = {};
      const paused = isPausedForRateLimit();

      for (const h of handles.slice(0, 400)){
        const norm = XMetaUtils.normalizeHandle(h);
        if (!norm) continue;

        const hk = norm.handleKey;
        const cached = state.users[hk];

        if (cached?.unavailable){
          enqueue(hk, norm.displayHandle);
          results[hk] = { status:'queued', user: cached };
        } else if (cached && isFresh(cached, settings)){
          if (!paused && shouldRetryMissing(cached)){
            enqueue(hk, norm.displayHandle);
            results[hk] = { status:'queued', user: cached };
          } else {
            results[hk] = { status:'fresh', user: cached };
          }
        } else {
          enqueue(hk, norm.displayHandle);
          results[hk] = { status:'queued', user: cached || null };
        }
      }

      scheduleProcess(now());
      sendResponse({ ok:true, results });
      return;
    }

    if (msg?.type === 'xmeta:saveSettings'){
      const incoming = msg.settings || {};
      const mergedColors = normalizeFollowerColors({ ...DEFAULT_SETTINGS.followerColors, ...(incoming.followerColors || {}) });
      state.settings = { ...DEFAULT_SETTINGS, ...incoming, followerColors: mergedColors };
      await saveState();
      await broadcast({ type:'xmeta:settings', settings: state.settings });
      sendResponse({ ok:true });
      return;
    }

    if (msg?.type === 'xmeta:clearCache'){
      state.users = createEmptyUsers();
      await saveState();
      sendResponse({ ok:true });
      return;
    }

    if (msg?.type === 'xmeta:importCache'){
      const incoming = msg.users;
      if (!incoming || typeof incoming !== 'object'){
        sendResponse({ ok:false, error:'invalid_payload' });
        return;
      }
      let imported = 0;
      const maxEntries = 10000;
      for (const [hk, entry] of Object.entries(incoming).slice(0, maxEntries)){
        if (!entry || typeof entry !== 'object') continue;
        const norm = XMetaUtils.normalizeHandle(hk);
        if (!norm) continue;
        const clean = {
          fetchedAt: Number(entry.fetchedAt) || 0,
          followers: (entry.followers == null) ? null : Number(entry.followers),
          following: (entry.following == null) ? null : Number(entry.following),
          joinedYear: entry.joinedYear == null ? null : entry.joinedYear,
          location: entry.location || null,
          unavailable: !!entry.unavailable
        };
        if (!clean.fetchedAt && clean.followers == null && clean.following == null && !clean.location && !clean.joinedYear){
          continue;
        }
        state.users[norm.handleKey] = clean;
        imported++;
      }
      await saveState();
      sendResponse({ ok:true, imported });
      return;
    }

    sendResponse({ ok:false, error:'unknown_message' });
  })().catch(err => {
    try { sendResponse({ ok:false, error: String(err?.message || err) }); } catch {}
  });

  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm?.name) return;
  if (alarm.name === PROCESS_ALARM){
    processQueue().catch(err => dlog('processQueue error', err));
    return;
  }
  if (alarm.name === RATE_LIMIT_ALARM){
    if (rateLimitUntil && now() >= rateLimitUntil){
      clearRateLimit();
      scheduleProcess(now());
    } else if (rateLimitUntil){
      scheduleRateLimitClear(rateLimitUntil);
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  loadState().then(() => scheduleProcess(now())).catch(()=>{});
});

loadState().then(() => scheduleProcess(now())).catch(()=>{});
