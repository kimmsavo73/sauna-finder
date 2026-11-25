/* Shared sauna reviews, stored in Google Cloud Firestore through its REST API
   (no SDK needed). Settings live in config.js. If config.js is empty, the app
   still works and simply leaves reviews out. */
(function (global) {
  const cfg = global.SAUNAAN_CONFIG || {};
  const enabled = !!(cfg.firebaseProjectId && cfg.firebaseApiKey);
  const BASE = enabled ? `https://firestore.googleapis.com/v1/projects/${cfg.firebaseProjectId}/databases/(default)/documents` : "";
  const KEY = enabled ? "?key=" + encodeURIComponent(cfg.firebaseApiKey) : "";

  // Quick labels a reviewer can tick. Keep in sync with firestore.rules.
  const TAGS = {
    hot: "Hot löyly",
    soft: "Gentle heat",
    dip: "Cold plunge or swim",
    quiet: "Quiet and calm",
    busy: "Often crowded",
    clean: "Clean",
    value: "Good value",
    beginner: "Good for first-timers",
    social: "Friendly locals",
  };

  const placeKey = id => id.replace("/", "_");          // "node/123" -> "node_123"

  const str = v => ({ stringValue: v });
  function fromDoc(d) {
    const f = d.fields || {};
    return {
      id: d.name.split("/").pop(),
      place: f.place?.stringValue,
      rating: +(f.rating?.integerValue || 0),
      text: f.text?.stringValue || "",
      name: f.name?.stringValue || "",
      tags: (f.tags?.arrayValue?.values || []).map(v => v.stringValue).filter(t => TAGS[t]),
      created: f.created?.timestampValue ? new Date(f.created.timestampValue) : null,
    };
  }

  // Fetch reviews for many places at once (Firestore "in" takes 30 values per query).
  async function fetchFor(ids) {
    const out = {};
    if (!enabled || !ids.length) return out;
    const keys = [...new Set(ids.map(placeKey))];
    const chunks = [];
    for (let i = 0; i < keys.length; i += 30) chunks.push(keys.slice(i, i + 30));
    await Promise.all(chunks.map(async chunk => {
      const body = {
        structuredQuery: {
          from: [{ collectionId: "reviews" }],
          where: { fieldFilter: { field: { fieldPath: "place" }, op: "IN", value: { arrayValue: { values: chunk.map(str) } } } },
          limit: 1000,
        },
      };
      const r = await fetch(BASE + ":runQuery" + KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error("reviews HTTP " + r.status);
      const rows = await r.json();
      for (const row of rows) {
        if (!row.document) continue;
        const rv = fromDoc(row.document);
        (out[rv.place] = out[rv.place] || []).push(rv);
      }
    }));
    for (const k in out) out[k].sort((a, b) => (b.created || 0) - (a.created || 0));
    return out;
  }

  function newId() {
    const a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const b = crypto.getRandomValues(new Uint8Array(20));
    return Array.from(b, x => a[x % a.length]).join("");
  }

  async function submit({ id, placeName, rating, text, name, tags }) {
    if (!enabled) throw new Error("Reviews are not set up");
    const docName = `projects/${cfg.firebaseProjectId}/databases/(default)/documents/reviews/${newId()}`;
    const write = {
      update: {
        name: docName,
        fields: {
          place: str(placeKey(id)),
          placeName: str(String(placeName).slice(0, 120)),
          rating: { integerValue: String(rating) },
          text: str(text),
          name: str(name),
          tags: { arrayValue: { values: tags.map(str) } },
        },
      },
      updateTransforms: [{ fieldPath: "created", setToServerValue: "REQUEST_TIME" }],
      currentDocument: { exists: false },
    };
    const r = await fetch(BASE + ":commit" + KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ writes: [write] }) });
    if (!r.ok) throw new Error("submit HTTP " + r.status);
    return { id: docName.split("/").pop(), place: placeKey(id), rating, text, name, tags, created: new Date() };
  }

  global.SaunaReviews = { enabled, TAGS, placeKey, fetchFor, submit };
})(window);
