(function () {
  "use strict";

  const OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const CACHE_KEY = "saunaan:last";
  const PREF_KEY = "saunaan:prefs";

  const $ = s => document.querySelector(s);
  const statusEl = $("#status"), listEl = $("#list"), tpl = $("#itemTpl");
  const openOnlyEl = $("#openOnly"), unverEl = $("#showUnverified"), areaBtn = $("#areaBtn");

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const prefs = Object.assign({ radius: 15000, openOnly: false, unverified: false }, store.get(PREF_KEY) || {});
  openOnlyEl.checked = prefs.openOnly; unverEl.checked = prefs.unverified;
  const savePrefs = () => store.set(PREF_KEY, prefs);

  // ---------- map ----------
  const map = L.map("map", { zoomControl: false, attributionControl: true, zoomSnap: 0.25 }).setView([60.1699, 24.9384], 12);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const pinLayer = L.layerGroup().addTo(map);
  let meMarker = null, radiusCircle = null;

  let state = { center: null, origin: null, label: "", places: [], selected: null };

  // Offer "Search this area" only after the person drags the map.
  map.on("dragend", () => {
    if (!state.center) return;
    const c = map.getCenter();
    areaBtn.hidden = haversine(c.lat, c.lng, state.center[0], state.center[1]) < prefs.radius * 0.35;
  });
  areaBtn.addEventListener("click", () => {
    const c = map.getCenter();
    areaBtn.hidden = true;
    search([c.lat, c.lng], "this area", null);
  });

  // ---------- radius chips ----------
  const chips = [...document.querySelectorAll(".chip")];
  function paintChips() { chips.forEach(c => c.setAttribute("aria-checked", String(+c.dataset.r === prefs.radius))); }
  chips.forEach(c => c.addEventListener("click", () => {
    prefs.radius = +c.dataset.r; savePrefs(); paintChips();
    if (state.center) search(state.center, state.label, null);
  }));
  paintChips();

  openOnlyEl.addEventListener("change", () => { prefs.openOnly = openOnlyEl.checked; savePrefs(); render(); });
  unverEl.addEventListener("change", () => { prefs.unverified = unverEl.checked; savePrefs(); render(); });

  // ---------- locate ----------
  $("#locateBtn").addEventListener("click", locate);
  function locate() {
    if (!("geolocation" in navigator)) { setStatus("This browser can't share your location. Search a place instead.", true); return; }
    setStatus("Finding your location…");
    navigator.geolocation.getCurrentPosition(
      pos => {
        const here = [pos.coords.latitude, pos.coords.longitude];
        showMe(here);
        search(here, "you", true);
      },
      err => {
        const msg = err.code === 1
          ? "Location is blocked for this site. Allow it in your browser settings, or search a place."
          : "Couldn't get your location. Try again outdoors, or search a place.";
        setStatus(msg, true);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 }
    );
  }
  function showMe(ll) {
    if (meMarker) meMarker.setLatLng(ll);
    else meMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="me"></div>', iconSize: [16, 16] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  }

  // ---------- place search ----------
  $("#searchForm").addEventListener("submit", async e => {
    e.preventDefault();
    const q = $("#q").value.trim();
    if (!q) return;
    $("#q").blur();
    setStatus("Looking up “" + q + "”…");
    try {
      const url = NOMINATIM + "?format=jsonv2&limit=1&q=" + encodeURIComponent(q);
      const r = await fetch(url, { headers: { "Accept-Language": navigator.language || "en" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const js = await r.json();
      if (!js.length) { setStatus("No place found for “" + q + "”. Try a city name.", true); return; }
      const label = js[0].name || js[0].display_name.split(",")[0];
      search([+js[0].lat, +js[0].lon], label, false);
    } catch (err) {
      setStatus("Place search isn't reachable right now. Check your connection and try again.", true);
    }
  });

  // ---------- data ----------
  function buildQuery(lat, lon, r) {
    const a = `(around:${r},${lat.toFixed(5)},${lon.toFixed(5)})`;
    return `[out:json][timeout:25];(
      nwr["leisure"="sauna"]${a};
      nwr["amenity"="sauna"]${a};
      nwr["sauna"~"^(yes|public|customers|designated)$"]${a};
      nwr["amenity"="public_bath"]${a};
      nwr["bath:type"~"sauna|hammam|onsen|thermal|banya"]${a};
      nwr["leisure"="water_park"]["sauna"]${a};
      nwr["leisure"="spa"]${a};
      nwr["amenity"="spa"]${a};
    );out center tags;`;
  }

  // Ask the mirrors in a staggered race: the first good answer wins, the rest are cancelled.
  // The main server is often at capacity, so waiting for it alone can take a minute.
  function overpass(q) {
    const ctls = [];
    const tries = OVERPASS.map((url, i) => new Promise((resolve, reject) => {
      setTimeout(async () => {
        if (ctls.done) return reject(new Error("done"));
        const ctl = new AbortController(); ctls.push(ctl);
        const t = setTimeout(() => ctl.abort(), 40000);
        try {
          const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const js = await r.json();
          if (!js || !Array.isArray(js.elements)) throw new Error("bad reply");
          resolve(js);
        } catch (e) { reject(e); } finally { clearTimeout(t); }
      }, i * 800);
    }));
    return Promise.any(tries).finally(() => { ctls.done = true; ctls.forEach(c => c.abort()); });
  }

  const RADII = [2000, 5000, 15000, 40000, 100000];
  let searchSeq = 0;
  async function search(center, label, fromMe, widened) {
    const seq = ++searchSeq;
    // fromMe: true = measure from this point, false = measure from the searched place, null = keep
    state.center = center; state.label = label;
    if (fromMe === true) state.origin = center;
    else if (fromMe === false) state.origin = null;
    drawRadius();

    map.invalidateSize(); map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10] });
    setStatus("Searching " + fmtDist(prefs.radius) + " around " + (label === "you" ? "you" : label) + "…");
    const slow = setTimeout(() => { if (seq === searchSeq) setStatus("Still searching. The free map servers are slow right now…"); }, 8000);
    try {
      const js = await overpass(buildQuery(center[0], center[1], prefs.radius));
      clearTimeout(slow);
      if (seq !== searchSeq) return;
      state.places = normalize(js.elements || []);
      state.fetchedAt = Date.now(); state.offline = false; state.widened = widened || null;
      // Saunas are sparse outside the Nordics: widen automatically when nothing turns up.
      const next = RADII.find(r => r > prefs.radius);
      if (!state.places.some(p => p.verified) && next) {
        prefs.radius = next; paintChips(); savePrefs();
        return search(center, label, null, widened || true);
      }
      store.set(CACHE_KEY, { center, label, origin: state.origin, places: state.places, fetchedAt: state.fetchedAt, radius: prefs.radius });
      render();
    } catch (e) {
      clearTimeout(slow);
      if (seq !== searchSeq) return;
      setStatus("The sauna map servers are busy or you're offline. Try again in a minute.", true);
    }
  }

  function drawRadius() {
    if (radiusCircle) radiusCircle.remove();
    radiusCircle = L.circle(state.center, { radius: prefs.radius, color: getCss("--ember"), weight: 1.5, fillOpacity: 0.04, interactive: false }).addTo(map);
  }

  const REJECT_ACCESS = /^(private|no|residents|members)$/;
  function normalize(els) {
    const seen = new Set(), out = [];
    for (const el of els) {
      const t = el.tags || {};
      const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
      if (lat == null) continue;
      const id = el.type + "/" + el.id;
      if (seen.has(id)) continue; seen.add(id);
      if (REJECT_ACCESS.test(t.access || "") || REJECT_ACCESS.test(t["sauna:access"] || "")) continue;
      if (t.sauna === "no") continue;
      const name = t.name || t["name:en"] || t.brand || t.operator || "";
      const publicSignal = /^(yes|public|customers|permissive|designated)$/.test(t.access || "") || !!(t.opening_hours || t.fee || t.charge || t.website || t["contact:website"] || t.phone || t["contact:phone"]);
      const verified = !!name || publicSignal;
      out.push({
        id, lat, lon, tags: t, verified,
        name: name || "Unnamed sauna",
        kind: kindOf(t),
      });
    }
    // drop exact duplicates mapped twice (same name within 60 m)
    return out.filter((p, i) => !out.some((q, j) => j < i && q.name === p.name && p.name !== "Unnamed sauna" && haversine(p.lat, p.lon, q.lat, q.lon) < 60));
  }

  function kindOf(t) {
    const bt = t["bath:type"] || "";
    if (/hammam/.test(bt)) return "Hammam";
    if (/onsen/.test(bt)) return "Onsen";
    if (/banya/.test(bt) || /banya/i.test(t.sauna || "")) return "Banya";
    if (t.amenity === "public_bath") return /thermal/.test(bt) ? "Thermal bath" : "Public bath";
    if (t.leisure === "water_park") return "Water park with sauna";
    if (t.leisure === "spa" || t.amenity === "spa") return /^(yes|public|customers|designated)$/.test(t.sauna || "") ? "Spa with sauna" : "Spa · call to confirm sauna";
    if (t.leisure === "sports_centre" || t.sport === "swimming" || t.leisure === "swimming_pool") return "Swimming hall with sauna";
    if (t.leisure === "fitness_centre") return "Gym with sauna";
    if (t.tourism === "hotel" || t.tourism === "hostel") return "Hotel sauna";
    if (t.leisure === "sauna" || t.amenity === "sauna") {
      if (/smoke/i.test(t["sauna:type"] || "")) return "Smoke sauna";
      return "Sauna";
    }
    return "Sauna";
  }

  // ---------- render ----------
  function render() {
    const ref = state.origin || state.center;
    const items = state.places.map(p => {
      const st = SaunaHours.status(p.tags.opening_hours);
      return Object.assign(p, { st, dist: ref ? haversine(ref[0], ref[1], p.lat, p.lon) : 0 });
    });
    const unverCount = items.filter(p => !p.verified).length;
    let shown = items.filter(p => prefs.unverified || p.verified);
    if (prefs.openOnly) shown = shown.filter(p => p.st.state === "open" || p.st.state === "closing");
    shown.sort((a, b) => a.dist - b.dist);

    pinLayer.clearLayers();
    listEl.textContent = "";
    for (const p of shown) {
      const node = tpl.content.firstElementChild.cloneNode(true);
      node.dataset.state = p.st.state; node.dataset.id = p.id;
      node.querySelector(".name").textContent = p.name;
      node.querySelector(".meta").textContent = [p.kind, priceText(p.tags), genderText(p.tags)].filter(Boolean).join(" · ");
      node.querySelector(".hours").textContent = p.st.text;
      node.querySelector(".dist").textContent = fmtDist(p.dist);
      fillDetails(node, p);
      if (Rv.enabled) setupReviews(node, p);
      node.querySelector(".itemmain").addEventListener("click", () => select(p.id, true));
      listEl.appendChild(node);

      const m = L.marker([p.lat, p.lon], { icon: pinIcon(p.st.state, false), title: p.name, keyboard: false });
      m.on("click", () => select(p.id, false));
      m._sid = p.id; m._state = p.st.state;
      pinLayer.addLayer(m);
    }

    const where = state.label === "you" ? "you" : state.label;
    let msg;
    if (!state.places.length) msg = `No saunas mapped within ${fmtDist(prefs.radius)} of ${where}. Try a wider radius.`;
    else if (!shown.length) msg = prefs.openOnly ? `None open right now within ${fmtDist(prefs.radius)}. Untick “Open now” to see all.` : `Only unverified saunas here. Tick “Include unverified” to see them.`;
    else msg = `<b>${shown.length}</b> ${shown.length === 1 ? "sauna" : "saunas"} within ${fmtDist(prefs.radius)} of ${escapeHtml(where)}`;
    if (state.widened && shown.length) msg += ` · nothing closer, so the search was widened`;
    if (!prefs.unverified && unverCount) msg += ` · ${unverCount} unverified hidden`;
    if (state.offline) msg += ` · saved ${timeAgo(state.fetchedAt)}`;
    statusEl.innerHTML = msg; statusEl.classList.remove("err");
    if (state.selected) select(state.selected, false, true);
    if (Rv.enabled) loadReviews(shown);
  }

  // ---------- reviews ----------
  const Rv = window.SaunaReviews || { enabled: false };
  const reviewCache = {};            // placeKey -> [reviews]
  const STAR = "★", NOSTAR = "☆";
  const stars = n => STAR.repeat(n) + NOSTAR.repeat(5 - n);

  async function loadReviews(places) {
    const need = places.filter(p => !(Rv.placeKey(p.id) in reviewCache));
    if (!need.length) return;
    try {
      const got = await Rv.fetchFor(need.map(p => p.id));
      for (const p of need) reviewCache[Rv.placeKey(p.id)] = got[Rv.placeKey(p.id)] || [];
    } catch (e) {
      for (const p of need) { const li = itemFor(p.id); li && (li.querySelector(".revsummary").textContent = "Reviews couldn't load. Check your connection."); }
      return;
    }
    for (const p of need) paintReviews(p);
  }
  const itemFor = id => listEl.querySelector(`.item[data-id="${CSS.escape(id)}"]`);

  function summarize(list) {
    const avg = list.reduce((a, r) => a + r.rating, 0) / list.length;
    const counts = {};
    list.forEach(r => r.tags.forEach(t => counts[t] = (counts[t] || 0) + 1));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => Rv.TAGS[t] + (n > 1 ? " (" + n + ")" : ""));
    return { avg, top };
  }

  function paintReviews(p) {
    const li = itemFor(p.id); if (!li) return;
    const list = reviewCache[Rv.placeKey(p.id)];
    const badge = li.querySelector(".rating"), sum = li.querySelector(".revsummary"), ol = li.querySelector(".revlist");
    if (!list) { sum.textContent = "Loading reviews…"; return; }
    ol.textContent = "";
    if (!list.length) {
      badge.hidden = true;
      sum.textContent = "No reviews yet. Been here? Tell others what it's like.";
      return;
    }
    const { avg, top } = summarize(list);
    badge.hidden = false;
    badge.textContent = STAR + " " + avg.toFixed(1) + " · " + list.length + (list.length === 1 ? " review" : " reviews");
    sum.textContent = stars(Math.round(avg)) + "  " + avg.toFixed(1) + " from " + list.length + (list.length === 1 ? " visitor" : " visitors") + (top.length ? ". Most mentioned: " + top.join(", ") : "");
    for (const r of list.slice(0, 20)) {
      const item = document.createElement("li"); item.className = "rev";
      const head = document.createElement("div"); head.className = "revtop";
      const st = document.createElement("span"); st.className = "revstars"; st.textContent = stars(r.rating); st.setAttribute("aria-label", r.rating + " out of 5");
      const who = document.createElement("span"); who.className = "revwho"; who.textContent = (r.name || "A visitor") + (r.created ? " · " + r.created.toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "");
      head.append(st, who); item.append(head);
      if (r.tags.length) { const tg = document.createElement("div"); tg.className = "revtags"; r.tags.forEach(t => { const c = document.createElement("span"); c.className = "tag"; c.textContent = Rv.TAGS[t]; tg.append(c); }); item.append(tg); }
      if (r.text) { const tx = document.createElement("p"); tx.className = "revtext"; tx.textContent = r.text; item.append(tx); }
      ol.append(item);
    }
  }

  function setupReviews(node, p) {
    const sec = node.querySelector(".reviews"); sec.hidden = false;
    const form = sec.querySelector(".revform"), writeBtn = sec.querySelector(".write"), msg = sec.querySelector(".formmsg");
    const key = Rv.placeKey(p.id);
    let rating = 0;
    const row = sec.querySelector(".starrow");
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "starbtn"; b.textContent = NOSTAR; b.setAttribute("aria-label", i + (i === 1 ? " star" : " stars")); b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => { rating = i; paintStars(); msg.textContent = ""; });
      row.append(b);
    }
    const paintStars = () => [...row.children].forEach((b, j) => { b.textContent = j < rating ? STAR : NOSTAR; b.setAttribute("aria-pressed", String(j < rating)); });
    const tagRow = sec.querySelector(".tagrow");
    for (const [k, label] of Object.entries(Rv.TAGS)) {
      const l = document.createElement("label"); l.className = "tagopt";
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.value = k;
      l.append(cb, document.createTextNode(label)); tagRow.append(l);
    }
    const done = store.get("saunaan:reviewed") || {};
    if (done[key]) writeBtn.textContent = "Write another review";
    writeBtn.addEventListener("click", () => { form.hidden = false; writeBtn.hidden = true; form.querySelector(".starbtn").focus(); });
    sec.querySelector(".cancel").addEventListener("click", () => { form.hidden = true; writeBtn.hidden = false; msg.textContent = ""; });
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (!rating) { msg.textContent = "Pick a star rating first."; return; }
      const text = form.text.value.trim(), name = form.name.value.trim();
      const tags = [...tagRow.querySelectorAll("input:checked")].map(c => c.value);
      const btn = form.querySelector("[type=submit]"); btn.disabled = true; msg.textContent = "Posting…";
      try {
        const rv = await Rv.submit({ id: p.id, placeName: p.name, rating, text, name, tags });
        (reviewCache[key] = reviewCache[key] || []).unshift(rv);
        const d = store.get("saunaan:reviewed") || {}; d[key] = Date.now(); store.set("saunaan:reviewed", d);
        try { localStorage.setItem("saunaan:name", name); } catch {}
        form.reset(); rating = 0; paintStars();
        form.hidden = true; writeBtn.hidden = false; writeBtn.textContent = "Write another review";
        msg.textContent = "";
        paintReviews(p);
        sec.querySelector(".revsummary").textContent = "Thanks! Your review is up. " + sec.querySelector(".revsummary").textContent;
      } catch (err) {
        msg.textContent = "Couldn't post your review. Check your connection and try again.";
      } finally { btn.disabled = false; }
    });
    try { const nm = localStorage.getItem("saunaan:name"); if (nm) form.name.value = nm; } catch {}
    paintReviews(p);
  }

  function fillDetails(node, p) {
    const t = p.tags, dl = node.querySelector(".facts");
    const add = (k, v) => { if (!v) return; const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); };
    if (p.st.today && p.st.state !== "unknown") add("Today", p.st.today);
    add("Hours", t.opening_hours);
    add("Price", t.charge || (t.fee === "yes" ? "Paid entry" : t.fee === "no" ? "Free" : ""));
    add("Who", genderText(t, true));
    add("Swim wear", t.nudism === "obligatory" || t.clothes === "no" ? "No swimsuits (nude)" : t.nudism === "no" || t.clothes === "yes" ? "Swimsuits required" : "");
    add("Wheelchair", t.wheelchair === "yes" ? "Accessible" : t.wheelchair === "limited" ? "Partly accessible" : t.wheelchair === "no" ? "Not accessible" : "");
    add("Address", address(t));
    add("Notes", t.description);
    if (!p.verified) add("Note", "No name or opening details mapped. This may be a private sauna in a building.");

    const ll = p.lat + "," + p.lon;
    node.querySelector(".go").href = "https://www.google.com/maps/dir/?api=1&destination=" + ll;
    node.querySelector(".apple").href = "https://maps.apple.com/?daddr=" + ll + "&q=" + encodeURIComponent(p.name);
    node.querySelector(".osm").href = "https://www.openstreetmap.org/" + p.id;
    const web = t.website || t["contact:website"] || t.url;
    if (web && /^https?:\/\//i.test(web)) { const a = node.querySelector(".web"); a.href = web; a.hidden = false; }
    const tel = (t.phone || t["contact:phone"] || "").split(";")[0].trim();
    if (tel) { const a = node.querySelector(".tel"); a.href = "tel:" + tel.replace(/[^\d+]/g, ""); a.textContent = "Call " + tel; a.hidden = false; }
  }

  function select(id, fromList, quiet) {
    state.selected = id;
    listEl.querySelectorAll(".item").forEach(li => {
      const on = li.dataset.id === id;
      li.classList.toggle("sel", on);
      li.querySelector(".details").hidden = !on;
    });
    pinLayer.eachLayer(m => m.setIcon(pinIcon(m._state, m._sid === id)));
    if (quiet) return;
    const p = state.places.find(x => x.id === id);
    if (!p) return;
    if (fromList) { map.panTo([p.lat, p.lon]); }
    else {
      const li = listEl.querySelector(`[data-id="${CSS.escape(id)}"]`);
      li && li.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function pinIcon(st, sel) {
    return L.divIcon({ className: "", html: `<div class="pin ${st}${sel ? " sel" : ""}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  // ---------- helpers ----------
  function priceText(t) {
    if (t.charge) return t.charge.length > 18 ? "Paid" : t.charge;
    if (t.fee === "no") return "Free";
    if (t.fee === "yes") return "Paid";
    return "";
  }
  function genderText(t, long) {
    const g = t["sauna:gender"] || (t.unisex === "yes" ? "unisex" : t.female === "yes" && t.male !== "yes" ? "female" : t.male === "yes" && t.female !== "yes" ? "male" : "");
    const map = { unisex: long ? "Mixed (everyone together)" : "Mixed", mixed: "Mixed", female: "Women only", male: "Men only", separate: "Separate sections" };
    return map[g] || "";
  }
  function address(t) {
    const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
    return [street, t["addr:city"]].filter(Boolean).join(", ");
  }
  function haversine(a, b, c, d) {
    const R = 6371000, r = Math.PI / 180;
    const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + " m" : (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)) + " km"; }
  function timeAgo(ts) { const m = Math.round((Date.now() - ts) / 60000); return m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#d4651c"; }
  function setStatus(text, err) { statusEl.textContent = text; statusEl.classList.toggle("err", !!err); }

  // refresh open/closed labels every minute
  setInterval(() => {
    for (const p of state.places) {
      const li = itemFor(p.id); if (!li) continue;
      p.st = SaunaHours.status(p.tags.opening_hours);
      li.dataset.state = p.st.state; li.querySelector(".hours").textContent = p.st.text;
    }
    pinLayer.eachLayer(m => { const p = state.places.find(x => x.id === m._sid); if (p && m._state !== p.st.state) { m._state = p.st.state; m.setIcon(pinIcon(p.st.state, m._sid === state.selected)); } });
  }, 60000);

  // ---------- start ----------
  const last = store.get(CACHE_KEY);
  if (last && last.places && last.places.length) {
    state = { center: last.center, origin: last.origin, label: last.label, places: last.places, fetchedAt: last.fetchedAt, offline: true, selected: null };
    if (last.radius) { prefs.radius = last.radius; paintChips(); }
    if (state.origin) showMe(state.origin);
    drawRadius(); map.invalidateSize(); map.fitBounds(radiusCircle.getBounds(), { padding: [10, 10] });
    render();
  }
  // If location was already allowed, find saunas right away.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then(p => { if (p.state === "granted") locate(); }).catch(() => {});
  }

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.__saunaan = { search, state: () => state, normalize };
})();
