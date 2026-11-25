/* Small reader for OpenStreetMap opening_hours values.
   Handles the common forms ("Mo-Fr 10:00-20:00; Sa,Su 12:00-18:00", "24/7",
   "Tu off", times past midnight). Anything it can't read safely (months,
   week numbers, sunrise, holidays-only rules) returns null so the app shows
   the raw text instead of guessing. */
(function (global) {
  const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const DAY_RE = "(?:Mo|Tu|We|Th|Fr|Sa|Su)";
  const DAYSEL_RE = new RegExp("^(" + DAY_RE + "(?:-" + DAY_RE + ")?(?:\\s*,\\s*" + DAY_RE + "(?:-" + DAY_RE + ")?)*)\\s*:?\\s*(.*)$");

  function toMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    const h = +m[1], mi = +m[2];
    if (h > 48 || mi > 59) return null;
    return h * 60 + mi;
  }

  function parseDays(sel) {
    const out = new Set();
    for (const part of sel.split(",")) {
      const p = part.trim();
      const [a, b] = p.split("-");
      const i = DAYS.indexOf(a), j = b ? DAYS.indexOf(b) : i;
      if (i < 0 || j < 0) return null;
      for (let k = i; ; k = (k + 1) % 7) { out.add(k); if (k === j) break; }
    }
    return out;
  }

  function parseTimes(s) {
    s = s.trim();
    if (!s || /^(open)$/i.test(s)) return [[0, 1440]];
    if (/^(off|closed)$/i.test(s)) return [];
    const res = [];
    for (const span of s.split(",")) {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/.exec(span.trim());
      if (!m) return null;
      const a = toMin(m[1]), b = toMin(m[2]);
      if (a == null || b == null) return null;
      res.push([a, b]);
    }
    return res;
  }

  // Returns week[7] -> array of [startMin, endMin] within that day, or null.
  function parse(raw) {
    if (!raw || typeof raw !== "string") return null;
    let s = raw.replace(/"[^"]*"/g, "").replace(/\s+/g, " ").trim();
    if (/^24\/7( open)?$/i.test(s)) return DAYS.map(() => [[0, 1440]]);
    // split rules on ';' and on ', ' that is followed by a weekday rule
    const rules = s.split(/\s*;\s*|\s*\|\|\s*|,\s+(?=(?:Mo|Tu|We|Th|Fr|Sa|Su|PH)\b)/).filter(Boolean);
    const week = DAYS.map(() => null); // null = not set yet
    let any = false;
    for (let rule of rules) {
      rule = rule.trim();
      if (/^(PH|SH)\b/.test(rule)) continue;            // holiday-only rule: ignore
      rule = rule.replace(/,?\s*PH\b(\s+off)?/g, "").trim();
      if (/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|week|sunrise|sunset|dawn|dusk|\[|easter)/i.test(rule)) return null;
      let days, times;
      if (/^24\/7/.test(rule)) { days = new Set([0,1,2,3,4,5,6]); times = [[0,1440]]; }
      else {
        const m = DAYSEL_RE.exec(rule);
        if (m) { days = parseDays(m[1]); times = parseTimes(m[2]); }
        else { days = new Set([0,1,2,3,4,5,6]); times = parseTimes(rule); }
      }
      if (!days || !times) return null;
      for (const d of days) week[d] = [];
      for (const d of days) {
        for (const [a, b] of times) {
          if (b > a) {
            week[d].push([a, Math.min(b, 1440)]);
            if (b > 1440) spill(week, (d + 1) % 7, [0, b - 1440]);
          } else if (b < a || (a === 0 && b === 0)) {
            week[d].push([a, 1440]);
            if (b > 0) spill(week, (d + 1) % 7, [0, b]);
          }
        }
      }
      any = true;
    }
    if (!any) return null;
    return week.map(w => (w || []).sort((x, y) => x[0] - y[0]));
  }
  function spill(week, d, iv) { (week[d] = week[d] || []).push(iv); }

  const fmt = m => {
    m = m % 1440;
    return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
  };

  function status(raw, now = new Date()) {
    const week = parse(raw);
    if (!week) return { state: "unknown", text: raw ? "Hours listed" : "Hours not listed", today: null };
    const d = (now.getDay() + 6) % 7, m = now.getHours() * 60 + now.getMinutes();
    const today = week[d].length ? week[d].map(([a, b]) => fmt(a) + "–" + (b === 1440 ? "24:00" : fmt(b))).join(", ") : "Closed today";
    for (const [a, b] of week[d]) {
      if (m >= a && m < b) {
        let end = b;
        if (b === 1440) {
          const nx = week[(d + 1) % 7].find(iv => iv[0] === 0);
          if (nx) { if (nx[1] === 1440) return { state: "open", text: "Open 24 hours", today }; end = nx[1]; }
        }
        const soon = end - m <= 60 && b - m <= 60;
        return { state: soon ? "closing" : "open", text: (soon ? "Closes soon · " : "Open until ") + fmt(end), today };
      }
    }
    for (let k = 0; k < 8; k++) {
      const dd = (d + k) % 7;
      const nxt = week[dd].find(([a]) => k > 0 || a > m);
      if (nxt) {
        const when = k === 0 ? "" : k === 1 ? "tomorrow " : DAY_NAMES[dd] + " ";
        return { state: "closed", text: "Closed · opens " + when + fmt(nxt[0]), today };
      }
    }
    return { state: "closed", text: "Closed", today };
  }

  global.SaunaHours = { parse, status };
})(typeof window !== "undefined" ? window : globalThis);
