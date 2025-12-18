export const XMetaUtils = (() => {
  function normalizeHandle(handle){
    if (!handle) return null;
    let h = String(handle).trim();
    if (h.startsWith('@')) h = h.slice(1);
    const m = h.match(/^[A-Za-z0-9_]{1,15}$/);
    if (!m) return null;
    return { handleKey: h.toLowerCase(), displayHandle: h };
  }

  function parseJoinedYear(joinedText){
    if (!joinedText) return null;
    const raw = String(joinedText).trim();
    const m = raw.match(/\b(19\d{2}|20\d{2})\b/);
    return m ? m[1] : null;
  }

  function parseCountText(text){
    if (!text) return null;
    const raw = String(text).replace(/\u00A0/g,' ').trim();
    if (!raw) return null;

    // X can return strings like:
    //  - "1,366 Followers"
    //  - "1.2M"
    //  - Multiple numbers due to layout quirks (e.g., "Joined May 2024 931 Following 1,366 Followers")
    // Strategy:
    //   1) Find number tokens WITHOUT merging separate numbers
    //   2) If we see a "Followers" / "Following" label, pick the number right before it.

    const lower = raw.toLowerCase();
    let anchor = -1;
    for (const k of ['followers', 'follower']){
      const i = lower.indexOf(k);
      if (i >= 0){ anchor = i; break; }
    }
    if (anchor < 0){
      const i = lower.indexOf('following');
      if (i >= 0) anchor = i;
    }

    // Tokenizer: grouped number or decimal + suffix. Keeps tokens separate.
    const re = /(\d{1,3}(?:[\.,\s]\d{3})+(?:[\.,]\d+)?|\d+(?:[\.,]\d+)?)(?:\s*([kKmM]))?/g;

    const matches = [];
    for (const m of raw.matchAll(re)){
      const idx = m.index ?? 0;
      // Avoid matching inside another digit sequence.
      if (idx > 0 && /\d/.test(raw[idx - 1])) continue;
      matches.push({ token: m[1], suf: (m[2] || '').toLowerCase(), idx, end: idx + m[0].length });
    }
    if (!matches.length) return null;

    let picked = matches[0];
    if (anchor >= 0){
      const before = matches.filter(x => x.end <= anchor);
      if (before.length){
        picked = before.reduce((a,b) => (b.end > a.end ? b : a));
      }
    }

    let numPart = String(picked.token || '').replace(/\s+/g, '');
    const suf = picked.suf;

    if (suf === 'k' || suf === 'm'){
      // Normalize separators: "," => "." and keep only the LAST dot as decimal separator.
      numPart = numPart.replace(/,/g, '.').replace(/[^0-9.]/g, '');
      const parts = numPart.split('.');
      if (parts.length > 2){
        const last = parts.pop();
        numPart = parts.join('') + '.' + last;
      }

      const v = Number(numPart);
      if (!Number.isFinite(v)) return null;
      return Math.round(v * (suf === 'k' ? 1_000 : 1_000_000));
    }

    // No suffix: treat separators as thousands separators.
    const digits = numPart.replace(/\D/g, '');
    if (!digits) return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
  }

  return { normalizeHandle, parseJoinedYear, parseCountText };
})();
