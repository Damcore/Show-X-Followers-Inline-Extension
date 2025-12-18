const DEFAULTS = {
  enabled: true,
  showFollowers: true,
  showFollowing: true,
  showJoined: true,
  showLocation: false,
  themeMode: 'auto', // auto | dark | light
  maxRequestsPerMinute: 20,
  cacheTTLdays: 30,

  // Advanced (safe defaults)
  rateLimitPauseMinutes: 5,
  scrollPauseMs: 500,
  prefetchBatchSize: 200,
  maxConcurrentTabs: 3,
  scrapeTabLoadTimeoutMs: 15000,
  scrapeProfileHeaderWaitMs: 10000,
  unavailableTTLhours: 24,
  followerColors: (window.XPMI_SHARED && window.XPMI_SHARED.DEFAULT_FOLLOWER_COLORS)
    ? { ...window.XPMI_SHARED.DEFAULT_FOLLOWER_COLORS }
    : {
      gt1m: '#f4212e',
      k250to1m: '#ff9f0a',
      k25to250k: '#ffd60a',
      k5to25k: '#00ba7c',
      k1to5k: '#40dca0',
      lt1k: '#D02ED9'
    }
};

function $(id){ return document.getElementById(id); }
function sendMessage(msg){ return new Promise((resolve) => chrome.runtime.sendMessage(msg, resp => resolve(resp))); }
function clampInt(v, min, max, fallback){
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
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

function renderStatus(st){
  const box = $('status');
  if (!box) return;

  if (!st){
    box.textContent = 'Status: unavailable';
    return;
  }

  const cache = st.cacheSize ?? '-';
  const queue = st.queueLength ?? '-';
  const active = st.activeScrapes ?? '-';
  box.textContent = `Cached: ${cache} | Queue: ${queue} | Scraping: ${active}`;
}

function applyTheme(mode){
  const html = document.documentElement;
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');

  const resolve = () => {
    const m = (mode || '').toLowerCase();
    if (m === 'dark' || m === 'light') return m;
    if (prefersDark?.matches) return 'dark';
    if (prefersLight?.matches) return 'light';
    return 'dark';
  };

  const next = resolve();
  html.setAttribute('data-theme', next);

  if (prefersDark?.addEventListener){
    prefersDark.addEventListener('change', () => {
      if ((mode || '').toLowerCase() === 'auto'){
        html.setAttribute('data-theme', resolve());
      }
    });
  }
  if (prefersLight?.addEventListener){
    prefersLight.addEventListener('change', () => {
      if ((mode || '').toLowerCase() === 'auto'){
        html.setAttribute('data-theme', resolve());
      }
    });
  }
}

function getSettingsFromUI(){
  return {
    enabled: $('enabled').checked,
    showFollowers: $('showFollowers').checked,
    showFollowing: $('showFollowing').checked,
    showJoined: $('showJoined').checked,
    showLocation: $('showLocation').checked,
    themeMode: $('themeMode').value || DEFAULTS.themeMode,
    maxRequestsPerMinute: clampInt($('maxRequestsPerMinute').value, 1, 120, DEFAULTS.maxRequestsPerMinute),
    cacheTTLdays: clampInt($('cacheTTLdays').value, 1, 365, DEFAULTS.cacheTTLdays),

    // Advanced
    rateLimitPauseMinutes: clampInt($('rateLimitPauseMinutes').value, 1, 60, DEFAULTS.rateLimitPauseMinutes),
    scrollPauseMs: clampInt($('scrollPauseMs').value, 100, 5000, DEFAULTS.scrollPauseMs),
    prefetchBatchSize: clampInt($('prefetchBatchSize').value, 20, 1000, DEFAULTS.prefetchBatchSize),
    maxConcurrentTabs: clampInt($('maxConcurrentTabs').value, 1, 10, DEFAULTS.maxConcurrentTabs),
    scrapeTabLoadTimeoutMs: clampInt($('scrapeTabLoadTimeoutMs').value, 3000, 60000, DEFAULTS.scrapeTabLoadTimeoutMs),
    scrapeProfileHeaderWaitMs: clampInt($('scrapeProfileHeaderWaitMs').value, 1000, 60000, DEFAULTS.scrapeProfileHeaderWaitMs),
    unavailableTTLhours: clampInt($('unavailableTTLhours').value, 1, 168, DEFAULTS.unavailableTTLhours),
    followerColors: {
      gt1m: $('colorGt1m').value,
      k250to1m: $('colorK250to1m').value,
      k25to250k: $('colorK25to250k').value,
      k5to25k: $('colorK5to25k').value,
      k1to5k: $('colorK1to5k').value,
      lt1k: $('colorLt1k').value
    }
  };
}

function applySettingsToUI(settings){
  $('enabled').checked = !!settings.enabled;
  $('showFollowers').checked = settings.showFollowers !== false;
  $('showFollowing').checked = !!settings.showFollowing;
  $('showJoined').checked = !!settings.showJoined;
  $('showLocation').checked = !!settings.showLocation;
  $('themeMode').value = settings.themeMode || DEFAULTS.themeMode;

  $('maxRequestsPerMinute').value = Number(settings.maxRequestsPerMinute || DEFAULTS.maxRequestsPerMinute);
  $('cacheTTLdays').value = Number(settings.cacheTTLdays || DEFAULTS.cacheTTLdays);

  // Advanced
  $('rateLimitPauseMinutes').value = Number(settings.rateLimitPauseMinutes || DEFAULTS.rateLimitPauseMinutes);
  $('scrollPauseMs').value = Number(settings.scrollPauseMs || DEFAULTS.scrollPauseMs);
  $('prefetchBatchSize').value = Number(settings.prefetchBatchSize || DEFAULTS.prefetchBatchSize);
  $('maxConcurrentTabs').value = Number(settings.maxConcurrentTabs || DEFAULTS.maxConcurrentTabs);
  $('scrapeTabLoadTimeoutMs').value = Number(settings.scrapeTabLoadTimeoutMs || DEFAULTS.scrapeTabLoadTimeoutMs);
  $('scrapeProfileHeaderWaitMs').value = Number(settings.scrapeProfileHeaderWaitMs || DEFAULTS.scrapeProfileHeaderWaitMs);
  $('unavailableTTLhours').value = Number(settings.unavailableTTLhours || DEFAULTS.unavailableTTLhours);

  const c = settings.followerColors || {};
  $('colorGt1m').value = c.gt1m || DEFAULTS.followerColors.gt1m;
  $('colorK250to1m').value = c.k250to1m || DEFAULTS.followerColors.k250to1m;
  $('colorK25to250k').value = c.k25to250k || DEFAULTS.followerColors.k25to250k;
  $('colorK5to25k').value = c.k5to25k || DEFAULTS.followerColors.k5to25k;
  $('colorK1to5k').value = c.k1to5k || DEFAULTS.followerColors.k1to5k;
  $('colorLt1k').value = c.lt1k || DEFAULTS.followerColors.lt1k;
}

function renderColorChips(settings){
  const followerColors = { ...DEFAULTS.followerColors, ...(settings.followerColors || {}) };
  document.querySelectorAll('.colorChip').forEach(chip => {
    const key = chip.dataset.key;
    chip.style.setProperty('--chipColor', followerColors[key] || '#ffffff');
    chip.style.borderColor = followerColors[key] || '#ffffff';
  });
}

let statusInterval = null;
async function refreshStatus(){
  try{
    const r = await sendMessage({ type:'xmeta:getStatus' });
    renderStatus(r?.status);
  } catch {
    // ignore
  }
}

function startStatusAutoRefresh(){
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => {
    if (document.hidden) return;
    refreshStatus();
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshStatus();
  });
}

async function load(){
  const r = await sendMessage({ type:'xmeta:getStatus' });
  const settings = { ...DEFAULTS, ...(r?.settings || {}) };
  // Merge nested followerColors
  settings.followerColors = normalizeFollowerColors({ ...DEFAULTS.followerColors, ...((r?.settings || {}).followerColors || {}) });

  applySettingsToUI(settings);
  applyTheme(settings.themeMode || DEFAULTS.themeMode);
  renderColorChips(settings);
  renderStatus(r?.status);
  startStatusAutoRefresh();
}

async function save(){
  const settings = getSettingsFromUI();
  settings.followerColors = normalizeFollowerColors(settings.followerColors);
  await sendMessage({ type:'xmeta:saveSettings', settings });
  applyTheme(settings.themeMode || DEFAULTS.themeMode);
  const r = await sendMessage({ type:'xmeta:getStatus' });
  renderStatus(r?.status);
  renderColorChips(settings);
}

async function clearCache(){
  const ok = window.confirm('DELETE ALL ENTRIES? This removes all cached profile data.');
  if (!ok) return;
  await sendMessage({ type:'xmeta:clearCache' });
  const r = await sendMessage({ type:'xmeta:getStatus' });
  renderStatus(r?.status);
}

async function exportCache(){
  const r = await chrome.storage.local.get('xmeta');
  const users = r?.xmeta?.users || {};
  const jsonStr = JSON.stringify(users, null, 2);

  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  a.href = url;
  a.download = `xmeta-cache-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function importCache(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    try{
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object'){
        alert('Import failed: invalid JSON format.');
        return;
      }
      const resp = await sendMessage({ type:'xmeta:importCache', users: parsed });
      if (resp?.ok){
        alert(`Import complete: ${resp.imported || 0} entries.`);
        const r = await sendMessage({ type:'xmeta:getStatus' });
        renderStatus(r?.status);
      } else {
        alert(`Import failed: ${resp?.error || 'unknown error'}`);
      }
    } catch (e){
      alert(`Import failed: ${e?.message || e}`);
    }
  };
  input.click();
}

[
  'enabled','showFollowers','showFollowing','showJoined','showLocation',
  'themeMode','maxRequestsPerMinute','cacheTTLdays',
  'rateLimitPauseMinutes','scrollPauseMs','prefetchBatchSize','maxConcurrentTabs','scrapeTabLoadTimeoutMs','scrapeProfileHeaderWaitMs','unavailableTTLhours',
  'colorGt1m','colorK250to1m','colorK25to250k','colorK5to25k','colorK1to5k','colorLt1k'
].forEach(id => $(id).addEventListener('change', save));

$('clearCache').addEventListener('click', clearCache);
$('exportCache').addEventListener('click', exportCache);
$('importCache').addEventListener('click', importCache);

load().catch(()=>{});
