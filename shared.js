// Shared helpers used by both options UI and content script.
// Exposed as window.XPMI_SHARED to avoid duplication.
(() => {
  const DEFAULT_FOLLOWER_COLORS = {
    gt1m: '#f4212e',
    k250to1m: '#ff9f0a',
    k25to250k: '#ffd60a',
    k5to25k: '#00ba7c',
    k1to5k: '#40dca0',
    lt1k: '#D02ED9'
  };

  function clamp01(t){
    return Math.max(0, Math.min(1, t));
  }

  function hexToRgb(hex){
    if (!hex) return null;
    let h = String(hex).trim();
    if (h.startsWith('#')) h = h.slice(1);
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function lerp(a, b, t){
    return a + (b - a) * t;
  }

  function mixRGB(c1, c2, t){
    const tt = clamp01(t);
    const r = Math.round(lerp(c1[0], c2[0], tt));
    const g = Math.round(lerp(c1[1], c2[1], tt));
    const b = Math.round(lerp(c1[2], c2[2], tt));
    return `rgb(${r},${g},${b})`;
  }

  function getFollowerColor(followers, followerColors){
    // Color scale:
    //   > 1M: gt1m
    //   1M..250K: k250to1m -> k25to250k
    //   250K..25K: k25to250k -> k5to25k
    //   25K..5K: k5to25k
    //   5K..1K: k1to5k
    //   < 1K: lt1k
    if (followers == null || Number.isNaN(followers)) return 'rgb(113,118,123)';
    const v = Number(followers);
    if (!Number.isFinite(v)) return 'rgb(113,118,123)';

    const c = { ...DEFAULT_FOLLOWER_COLORS, ...(followerColors || {}) };
    const GT1M = hexToRgb(c.gt1m) || hexToRgb(DEFAULT_FOLLOWER_COLORS.gt1m);
    const K250_TO_1M = hexToRgb(c.k250to1m) || hexToRgb(DEFAULT_FOLLOWER_COLORS.k250to1m);
    const K25_TO_250K = hexToRgb(c.k25to250k) || hexToRgb(DEFAULT_FOLLOWER_COLORS.k25to250k);
    const K5_TO_25K = hexToRgb(c.k5to25k) || hexToRgb(DEFAULT_FOLLOWER_COLORS.k5to25k);
    const K1_TO_5K = hexToRgb(c.k1to5k) || hexToRgb(DEFAULT_FOLLOWER_COLORS.k1to5k);
    const LT1K = hexToRgb(c.lt1k) || hexToRgb(DEFAULT_FOLLOWER_COLORS.lt1k);

    if (v > 1_000_000) return mixRGB(GT1M, GT1M, 0);

    if (v >= 250_000){
      // 250K -> 1M : yellow -> orange
      const t = (v - 250_000) / (1_000_000 - 250_000);
      return mixRGB(K25_TO_250K, K250_TO_1M, t);
    }

    if (v >= 25_000){
      // 25K -> 250K : green -> yellow
      const t = (v - 25_000) / (250_000 - 25_000);
      return mixRGB(K5_TO_25K, K25_TO_250K, t);
    }

    if (v >= 5_000){
      return mixRGB(K5_TO_25K, K5_TO_25K, 0);
    }

    if (v >= 1_000){
      return mixRGB(K1_TO_5K, K1_TO_5K, 0);
    }

    return mixRGB(LT1K, LT1K, 0);
  }

  function formatCount(n){
    if (n == null || Number.isNaN(n)) return '-';
    const v = Number(n);
    if (!Number.isFinite(v)) return '-';
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';

    if (abs < 1000) return sign + String(Math.round(abs));

    const format3 = (x, suf) => {
      const ax = Math.abs(x);
      let decimals = 0;
      if (ax < 10) decimals = 2;
      else if (ax < 100) decimals = 1;
      else decimals = 0;
      const s = ax.toFixed(decimals);
      return sign + s + suf;
    };

    if (abs < 1_000_000){
      const x = abs / 1_000;
      let decimals = 0;
      if (x < 10) decimals = 2;
      else if (x < 100) decimals = 1;
      else decimals = 0;

      const rounded = Number(x.toFixed(decimals));
      if (rounded >= 1000){
        return format3(abs / 1_000_000, 'M');
      }
      return sign + x.toFixed(decimals) + 'k';
    }

    return format3(abs / 1_000_000, 'M');
  }

  window.XPMI_SHARED = {
    DEFAULT_FOLLOWER_COLORS,
    hexToRgb,
    getFollowerColor,
    formatCount
  };
})();
