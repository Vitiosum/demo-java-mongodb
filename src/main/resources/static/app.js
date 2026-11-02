'use strict';
// The Observatory: draws the MongoDB "sky" collection as a planisphere for Paris,
// and shows every query, aggregation and insert the page asks MongoDB to run.
(() => {
  const DEG = Math.PI / 180;
  const PARIS = { lat: 48.8566, lon: 2.3522 };
  const C = 500;            // chart centre (viewBox 1000 × 1000)
  const R = 410;            // radius of the sky disc
  const DEC_MIN = -45;      // declination at the rim
  const SCALE = R / (90 - DEC_MIN);
  const OBLIQUITY = 23.43928 * DEG;
  const GALACTIC_POLE = { ra: 192.85948 * DEG, dec: 27.12825 * DEG, l: 122.93192 * DEG };

  const SPECTRAL = { O: '#9db4ff', B: '#aabfff', A: '#cad8ff', F: '#f6f4ff', G: '#fff1dc', K: '#ffd2a1', M: '#ffb56c' };
  const TEMPERATURE = { O: 'above 30,000 K', B: '10,000 to 30,000 K', A: '7,500 to 10,000 K', F: '6,000 to 7,500 K', G: '5,200 to 6,000 K', K: '3,700 to 5,200 K', M: 'below 3,700 K' };
  const PLANET_COLOR = { Mercury: '#b9b1a5', Venus: '#f3e6c0', Earth: '#7fb2e5', Mars: '#e07a52', Jupiter: '#e8c9a0', Saturn: '#e9d59a', Uranus: '#9fd8d8', Neptune: '#7d98ec' };
  const NEBULA_COLOR = { emission: '#ef8fae', reflection: '#8fb4ff', planetary: '#7fd6c8', dark: '#8a8fb0', 'supernova remnant': '#f2a46b' };
  const KIND = { star: 'Star', planet: 'Planet', comet: 'Comet', nebula: 'Nebula', galaxy: 'Galaxy', cluster: 'Star cluster', constellation: 'Constellation' };

  const state = { objects: [], byId: new Map(), offsetHours: 0, lifted: false, hits: null, picking: false, pick: null, fresh: null };

  // ---------- small helpers ----------
  const $ = (selector) => document.querySelector(selector);
  const mod = (a, n) => ((a % n) + n) % n;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const idOf = (doc) => doc && doc._id && doc._id.$oid;
  const f1 = (n) => Number(n).toFixed(1);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function dateOf(value) { // relaxed Extended JSON: {"$date": "ISO"} or {"$date": {"$numberLong": "ms"}}
    if (!value || value.$date === undefined) return null;
    const d = value.$date;
    return new Date(typeof d === 'object' ? Number(d.$numberLong) : d);
  }
  function fmtRA(hours) {
    let h = Math.floor(hours), m = Math.round((hours - h) * 60);
    if (m === 60) { h = (h + 1) % 24; m = 0; }
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }
  function fmtDec(deg) {
    const sign = deg < 0 ? '−' : '+';
    let d = Math.floor(Math.abs(deg)), m = Math.round((Math.abs(deg) - d) * 60);
    if (m === 60) { d += 1; m = 0; }
    return `${sign}${d}° ${String(m).padStart(2, '0')}′`;
  }
  function fmtLy(ly) {
    if (ly >= 1e6) return `${(ly / 1e6).toLocaleString('en', { maximumFractionDigits: 1 })} million light years`;
    return `${Number(ly).toLocaleString('en')} light years`;
  }
  const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

  async function getJson(url, options) {
    const res = await fetch(url, options);
    let body = null;
    try { body = await res.json(); } catch (e) { body = { error: `The server answered ${res.status}.` }; }
    return { ok: res.ok, status: res.status, body };
  }

  // ---------- astronomy ----------
  const julian = (date) => date.getTime() / 86400000 + 2440587.5;
  const sidereal = (date) => mod(280.46061837 + 360.98564736629 * (julian(date) - 2451545) + PARIS.lon, 360) / 15;
  const viewDate = () => new Date(Date.now() + state.offsetHours * 3600000);

  /** Heliocentric ecliptic position from the JPL elements stored in a planet's "orbit" sub-document. */
  function heliocentric(orbit, T) {
    const a = orbit.semiMajorAxisAu, e = orbit.eccentricity, I = orbit.inclinationDeg * DEG;
    const L = orbit.meanLongitudeDeg + orbit.meanMotionDegPerCentury * T;
    const M = (mod(L - orbit.perihelionLongitudeDeg + 180, 360) - 180) * DEG;
    const w = (orbit.perihelionLongitudeDeg - orbit.nodeLongitudeDeg) * DEG, O = orbit.nodeLongitudeDeg * DEG;
    let E = M + e * Math.sin(M);
    for (let i = 0; i < 8; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), cI = Math.cos(I), sI = Math.sin(I);
    return [
      (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      sw * sI * xp + cw * sI * yp,
    ];
  }
  function equatorial([x, y, z]) {
    const ye = y * Math.cos(OBLIQUITY) - z * Math.sin(OBLIQUITY);
    const ze = y * Math.sin(OBLIQUITY) + z * Math.cos(OBLIQUITY);
    return { ra: mod(Math.atan2(ye, x) / DEG, 360) / 15, dec: Math.atan2(ze, Math.hypot(x, ye)) / DEG };
  }

  /** Where a document sits in the sky. Each type stores its position its own way. */
  function position(doc, date) {
    if (typeof doc.ra === 'number' && typeof doc.dec === 'number') return { ra: doc.ra, dec: doc.dec };
    const c = doc.coordinates;
    if (c && c.ra && c.dec) {
      const south = c.dec.d < 0 || Object.is(c.dec.d, -0) || c.dec.south === true;
      return { ra: c.ra.h + c.ra.m / 60, dec: (south ? -1 : 1) * (Math.abs(c.dec.d) + c.dec.m / 60) };
    }
    const earth = state.objects.find((o) => o.type === 'planet' && o.name === 'Earth' && o.orbit);
    if (doc.orbit && doc.name !== 'Earth' && earth) {
      const T = (julian(date) - 2451545) / 36525;
      const p = heliocentric(doc.orbit, T), e = heliocentric(earth.orbit, T);
      return equatorial([p[0] - e[0], p[1] - e[1], p[2] - e[2]]);
    }
    return null;
  }

  // Equidistant polar projection, seen from below: north pole in the centre, east to the left,
  // the meridian (right ascension = local sidereal time) pointing down to the south.
  function project(ra, dec, lst) {
    const r = (90 - dec) * SCALE, b = (ra - lst) * 15 * DEG;
    return [C - r * Math.sin(b), C + r * Math.cos(b)];
  }
  function unproject(x, y, lst) {
    const dx = C - x, dy = y - C;
    return { ra: mod(lst + Math.atan2(dx, dy) / DEG / 15, 24), dec: 90 - Math.hypot(dx, dy) / SCALE };
  }
  function horizonPoint(azimuthDeg, lst) {
    const A = azimuthDeg * DEG, phi = PARIS.lat * DEG;
    const dec = Math.asin(Math.cos(phi) * Math.cos(A)) / DEG;
    const hourAngle = Math.atan2(-Math.sin(A), -Math.sin(phi) * Math.cos(A)) / DEG / 15;
    return project(lst - hourAngle, dec, lst);
  }
  function galactic(lDeg) {
    const l = lDeg * DEG, g = GALACTIC_POLE;
    const dec = Math.asin(Math.cos(g.dec) * Math.cos(g.l - l));
    const ra = g.ra + Math.atan2(Math.sin(g.l - l), -Math.sin(g.dec) * Math.cos(g.l - l));
    return { ra: mod(ra / DEG, 360) / 15, dec: dec / DEG };
  }

  // ---------- the chart ----------
  const P = (pt) => `${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`;

  function defs() {
    const halos = Object.entries(SPECTRAL).map(([k, c]) =>
      `<radialGradient id="halo-${k}"><stop offset="0" stop-color="${c}" stop-opacity="0.75"/><stop offset="0.35" stop-color="${c}" stop-opacity="0.18"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('');
    const nebulae = Object.entries(NEBULA_COLOR).map(([k, c]) =>
      `<radialGradient id="neb-${k.replace(' ', '-')}"><stop offset="0" stop-color="${c}" stop-opacity="0.65"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('');
    return `<defs>
      <radialGradient id="skydisc" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#16246a"/><stop offset="0.62" stop-color="#0c1640"/><stop offset="1" stop-color="#060b26"/></radialGradient>
      <linearGradient id="brass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f1dba0"/><stop offset="0.28" stop-color="#c9a35a"/><stop offset="0.52" stop-color="#7a5b2b"/><stop offset="0.74" stop-color="#d8b56d"/><stop offset="1" stop-color="#8a6a33"/></linearGradient>
      <linearGradient id="brass-edge" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#4a3618"/><stop offset="0.5" stop-color="#e9cf8e"/><stop offset="1" stop-color="#4a3618"/></linearGradient>
      <filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
      <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.55"/></filter>
      <clipPath id="disc"><circle cx="${C}" cy="${C}" r="${R}"/></clipPath>
      ${halos}${nebulae}</defs>`;
  }

  function milkyWay(lst) {
    let wide = '', core = '';
    for (let l = 0; l < 360; l += 4) {
      const a = galactic(l), b = galactic(l + 4);
      if (a.dec < DEC_MIN - 6 || b.dec < DEC_MIN - 6) continue;
      const glow = 0.35 + 0.65 * (1 + Math.cos(l * DEG)) / 2; // brighter towards the galactic centre
      const seg = `M${P(project(a.ra, a.dec, lst))}L${P(project(b.ra, b.dec, lst))}`;
      wide += `<path d="${seg}" stroke="#c7d2ff" stroke-opacity="${(0.1 * glow).toFixed(3)}" stroke-width="86"/>`;
      core += `<path d="${seg}" stroke="#dfe5ff" stroke-opacity="${(0.15 * glow).toFixed(3)}" stroke-width="30"/>`;
    }
    return `<g class="mw" fill="none" clip-path="url(#disc)">${wide}${core}</g>`;
  }

  function grid(lst) {
    let out = '';
    [60, 30].forEach((dec) => { out += `<circle cx="${C}" cy="${C}" r="${(90 - dec) * SCALE}"/>`; });
    out += `<circle class="equator" cx="${C}" cy="${C}" r="${90 * SCALE}"/>`;
    for (let h = 0; h < 24; h += 2) out += `<path d="M${P(project(h, 80, lst))}L${P(project(h, DEC_MIN, lst))}"/>`;
    let ecliptic = '';
    for (let lam = 0; lam <= 360; lam += 3) {
      const l = lam * DEG;
      const ra = mod(Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l)) / DEG, 360) / 15;
      const dec = Math.asin(Math.sin(l) * Math.sin(OBLIQUITY)) / DEG;
      ecliptic += `${lam ? 'L' : 'M'}${P(project(ra, dec, lst))}`;
    }
    const label = project(mod(Math.atan2(Math.sin(150 * DEG) * Math.cos(OBLIQUITY), Math.cos(150 * DEG)) / DEG, 360) / 15,
      Math.asin(Math.sin(150 * DEG) * Math.sin(OBLIQUITY)) / DEG + 2.5, lst);
    return `<g class="grid">${out}</g><path class="ecliptic" d="${ecliptic}Z"/><text class="ecliptic-label" x="${label[0]}" y="${label[1]}">ecliptic</text>`;
  }

  function rim(lst) {
    let ticks = '', nums = '';
    for (let i = 0; i < 144; i++) {
      const h = i / 6, hour = i % 6 === 0;
      const b = (h - lst) * 15 * DEG, s = Math.sin(b), c = Math.cos(b);
      const r1 = R + 3, r2 = R + (hour ? 14 : 8);
      ticks += `<line class="rim-tick${hour ? ' rim-tick--hour' : ''}" x1="${(C - r1 * s).toFixed(1)}" y1="${(C + r1 * c).toFixed(1)}" x2="${(C - r2 * s).toFixed(1)}" y2="${(C + r2 * c).toFixed(1)}"/>`;
      if (hour) nums += `<text class="rim-num" x="${(C - (R + 29) * s).toFixed(1)}" y="${(C + (R + 29) * c).toFixed(1)}">${h}h</text>`;
    }
    return `<g pointer-events="none">
      <circle cx="${C}" cy="${C}" r="${R + 23}" fill="none" stroke="url(#brass)" stroke-width="46"/>
      <circle cx="${C}" cy="${C}" r="${R + 46}" fill="none" stroke="url(#brass-edge)" stroke-width="2"/>
      <circle cx="${C}" cy="${C}" r="${R + 1}" fill="none" stroke="#2a1d0b" stroke-width="2"/>
      ${ticks}${nums}
      <path d="M${C - 9} ${C + R + 62} L${C} ${C + R + 49} L${C + 9} ${C + R + 62} Z" fill="url(#brass)" stroke="#3a2a11"/>
    </g>`;
  }

  function cover(lst) {
    let horizon = '';
    const pts = [];
    for (let az = 0; az <= 360; az += 3) {
      const p = horizonPoint(az, lst);
      pts.push(p);
      horizon += `${az ? 'L' : 'M'}${P(p)}`;
    }
    horizon += 'Z';
    const disc = `M${C - R} ${C}a${R} ${R} 0 1 0 ${2 * R} 0a${R} ${R} 0 1 0 ${-2 * R} 0Z`;
    const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const cardinals = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([label, az]) => {
      const [x, y] = horizonPoint(az, lst);
      const d = Math.hypot(x - cx, y - cy) || 1;
      return `<text class="cardinal" x="${(x - (x - cx) / d * 20).toFixed(1)}" y="${(y - (y - cy) / d * 20).toFixed(1)}">${label}</text>`;
    }).join('');
    return `<path class="cover" d="${disc}${horizon}"/><path class="cover-edge" d="${horizon}"/>${cardinals}
      <text class="engraving" x="${C}" y="${C - R + 70}" text-anchor="middle">Horizon of Paris, 48° 51′ north</text>`;
  }

  function starRadius(mag) { return Math.max(1.1, Math.min(7, 4.9 - 0.95 * mag)); }

  function objectSvg(doc, pt) {
    const id = idOf(doc), visitor = doc.discovery ? ' visitor' : '';
    const hit = state.hits && state.hits.has(id) ? ' is-hit' : '';
    const at = `transform="translate(${pt[0].toFixed(1)} ${pt[1].toFixed(1)})"`;
    const title = `<title>${esc(doc.name)}</title>`;
    if (doc.type === 'star') {
      const r = starRadius(doc.magnitude ?? 4), k = (doc.spectralClass || 'A')[0];
      const color = SPECTRAL[k] || SPECTRAL.A;
      const twinkle = doc.magnitude < 2.6 && !reducedMotion
        ? ` twinkle" style="--tw:${(2.6 + (id.charCodeAt(22) % 9) * 0.45).toFixed(2)}s;--td:-${(id.charCodeAt(23) % 7) * 0.6}s` : '';
      const halo = doc.magnitude < 1.6 ? `<circle class="halo" r="${(r * 4.2).toFixed(1)}" fill="url(#halo-${SPECTRAL[k] ? k : 'A'})"/>` : '';
      const core = visitor
        ? `<path class="core" d="M0 -${r + 3}L${r * 0.4} -${r * 0.4}L${r + 3} 0L${r * 0.4} ${r * 0.4}L0 ${r + 3}L-${r * 0.4} ${r * 0.4}L-${r + 3} 0L-${r * 0.4} -${r * 0.4}Z"/>`
        : `<circle class="core" r="${r.toFixed(2)}" fill="${color}"/>`;
      return `<g class="obj star${visitor}${hit}${twinkle}" data-id="${id}" ${at}>${halo}${core}<circle class="hit" r="${Math.max(9, r + 4)}"/>${title}</g>`;
    }
    if (doc.type === 'planet') {
      const color = visitor ? 'var(--patina)' : PLANET_COLOR[doc.name] || '#e8d9b0';
      const ring = doc.rings ? `<ellipse rx="11" ry="3.4" fill="none" stroke="${color}" stroke-width="1.3" transform="rotate(-22)"/>` : '';
      return `<g class="obj planet${visitor}${hit}" data-id="${id}" ${at}><circle r="9" fill="${color}" opacity="0.14"/><circle class="core" r="5.2" fill="${color}" stroke="rgba(0,0,0,.45)"/>${ring}<circle class="hit" r="12"/>${title}</g>`;
    }
    if (doc.type === 'galaxy') {
      return `<g class="obj dso${hit}" data-id="${id}" ${at}><ellipse class="core" rx="10" ry="4.2" transform="rotate(-28)" fill="rgba(238,160,160,.16)" stroke="#eea0a0" stroke-width="1.3"/><circle class="hit" r="11"/>${title}</g>`;
    }
    if (doc.type === 'cluster') {
      const globular = doc.clusterType === 'globular';
      const shape = globular
        ? `<circle class="core" r="6.5" fill="rgba(232,213,154,.18)" stroke="#e8d59a" stroke-width="1.2"/><path d="M-6.5 0H6.5M0 -6.5V6.5" stroke="#e8d59a" stroke-width="0.9"/>`
        : `<circle class="core" r="9" fill="none" stroke="#e8d59a" stroke-width="1.3" stroke-dasharray="2.2 3"/><circle r="1.3" cx="-2" cy="-1" fill="#f6ecc8"/><circle r="1" cx="2.5" cy="2" fill="#f6ecc8"/><circle r="0.9" cx="1" cy="-3.5" fill="#f6ecc8"/>`;
      return `<g class="obj dso${hit}" data-id="${id}" ${at}>${shape}<circle class="hit" r="11"/>${title}</g>`;
    }
    if (doc.type === 'nebula') {
      const kind = doc.nebulaType || 'emission', color = visitor ? '#74c2b0' : NEBULA_COLOR[kind] || NEBULA_COLOR.emission;
      const shape = kind === 'planetary'
        ? `<circle class="core" r="4.6" fill="none" stroke="${color}" stroke-width="1.5"/><circle r="1.4" fill="${color}"/>`
        : `<circle r="15" fill="url(#neb-${visitor ? 'planetary' : kind.replace(' ', '-')})"/><circle class="core" r="2" fill="${color}"/>`;
      return `<g class="obj dso nebula${visitor}${hit}" data-id="${id}" ${at}>${shape}<circle class="hit" r="11"/>${title}</g>`;
    }
    return '';
  }

  function labelSvg(doc, pt, taken) {
    const hit = state.hits && state.hits.has(idOf(doc)) ? ' label-hit' : '';
    const x = (pt[0] + 9).toFixed(1), y = (pt[1] + 4).toFixed(1);
    if (doc.type === 'planet') {
      // planets bunch up along the ecliptic: drop a label below when another one sits there
      let ly = pt[1] - 8;
      if (taken.some(([tx, ty]) => Math.abs(tx - pt[0]) < 60 && Math.abs(ty - ly) < 16)) ly = pt[1] + 20;
      taken.push([pt[0], ly]);
      return `<text class="planet-name${hit}" x="${(pt[0] + 13).toFixed(1)}" y="${ly.toFixed(1)}">${esc(doc.name)}</text>`;
    }
    if (doc.type === 'star' && (doc.magnitude < 1.6 || doc.discovery)) return `<text class="star-name${hit}" x="${x}" y="${y}">${esc(doc.name)}</text>`;
    if (doc.messier) return `<text class="dso-name${hit}" x="${(pt[0] + 11).toFixed(1)}" y="${(pt[1] + 13).toFixed(1)}">${esc(doc.messier)}</text>`;
    if (doc.discovery) return `<text class="star-name${hit}" x="${x}" y="${y}">${esc(doc.name)}</text>`;
    return '';
  }

  function render() {
    const svg = $('#chart');
    const date = viewDate(), lst = sidereal(date);
    const placed = new Map();
    for (const doc of state.objects) {
      const pos = position(doc, date);
      if (pos && pos.dec >= DEC_MIN) placed.set(idOf(doc), { doc, pt: project(pos.ra, pos.dec, lst) });
    }

    let figures = '', names = '';
    for (const doc of state.objects.filter((o) => o.type === 'constellation')) {
      const stars = (doc.stars || []).map((ref) => placed.get(ref && ref.$oid));
      for (const [a, b] of doc.figure || []) {
        if (stars[a] && stars[b]) figures += `<line x1="${stars[a].pt[0].toFixed(1)}" y1="${stars[a].pt[1].toFixed(1)}" x2="${stars[b].pt[0].toFixed(1)}" y2="${stars[b].pt[1].toFixed(1)}"/>`;
      }
      const known = stars.filter(Boolean);
      if (known.length) {
        const x = known.reduce((s, p) => s + p.pt[0], 0) / known.length;
        const y = Math.max(...known.map((p) => p.pt[1])) + 26;
        const hit = state.hits && state.hits.has(idOf(doc)) ? ' style="fill:var(--patina)"' : '';
        names += `<text class="const-name obj-label" data-id="${idOf(doc)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}"${hit}>${esc(doc.name)}</text>`;
      }
    }

    const order = { nebula: 0, galaxy: 0, cluster: 0, star: 1, planet: 2 };
    const items = [...placed.values()].sort((a, b) => (order[a.doc.type] ?? 3) - (order[b.doc.type] ?? 3) || (b.doc.magnitude ?? 0) - (a.doc.magnitude ?? 0));
    const bodies = items.map(({ doc, pt }) => objectSvg(doc, pt)).join('');
    const taken = [];
    const labels = items.map(({ doc, pt }) => labelSvg(doc, pt, taken)).join('');

    const earth = state.objects.find((o) => o.type === 'planet' && o.name === 'Earth');
    const z = project(lst, PARIS.lat, lst);
    const zenith = earth ? `<g class="obj zenith-mark" data-id="${idOf(earth)}" transform="translate(${z[0].toFixed(1)} ${z[1].toFixed(1)})"><circle class="zenith" r="6"/><path class="zenith" d="M-13 0H-8M8 0H13M0 -13V-8M0 8V13"/><circle class="hit" r="14"/><title>Zenith of Paris: you are standing on Earth</title></g>` : '';

    let rings = '';
    if (state.hits) for (const id of state.hits) { const p = placed.get(id); if (p) rings += `<circle class="ring" cx="${p.pt[0].toFixed(1)}" cy="${p.pt[1].toFixed(1)}" r="13"/>`; }
    if (state.fresh && placed.get(state.fresh)) { const p = placed.get(state.fresh).pt; rings += `<circle class="ring ring--pulse" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="12"/>`; }
    if (state.pick) { const p = project(state.pick.ra, state.pick.dec, lst); rings += `<path class="pick-mark" d="M${p[0] - 12} ${p[1]}H${p[0] + 12}M${p[0]} ${p[1] - 12}V${p[1] + 12}"/><circle class="pick-mark" cx="${p[0]}" cy="${p[1]}" r="7"/>`; }

    svg.innerHTML = `<title id="chart-title">Planisphere of the sky over Paris</title>${defs()}
      <g filter="url(#shadow)"><circle cx="${C}" cy="${C}" r="${R + 46}" fill="#0a0f2a"/></g>
      <circle cx="${C}" cy="${C}" r="${R}" fill="url(#skydisc)"/>
      <g id="layer-deep">${milkyWay(lst)}</g>
      <g id="layer-mid">${grid(lst)}</g>
      <g class="sky-objects"><g class="fig">${figures}</g>${names}${bodies}${labels}${zenith}</g>
      ${cover(lst)}${rim(lst)}${rings}`;
    svg.classList.toggle('is-filtered', !!state.hits);
    svg.classList.toggle('is-lifted', state.lifted);
    svg.classList.toggle('is-picking', state.picking);
    renderClock(date, lst);
  }

  function renderClock(date, lst) {
    const time = date.toLocaleString('en-GB', { timeZone: 'Europe/Paris', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    $('#clock').textContent = `${time} in Paris, sidereal time ${fmtRA(lst)}`;
    $('#now').hidden = state.offsetHours === 0;
  }

  // gentle parallax: the Milky Way and the grid sit "deeper" than the objects
  function parallax(event) {
    if (reducedMotion) return;
    const box = $('#chart-wrap').getBoundingClientRect();
    const dx = (event.clientX - box.left) / box.width - 0.5, dy = (event.clientY - box.top) / box.height - 0.5;
    const deep = $('#layer-deep'), mid = $('#layer-mid');
    if (deep) deep.setAttribute('transform', `translate(${(-dx * 14).toFixed(1)} ${(-dy * 14).toFixed(1)})`);
    if (mid) mid.setAttribute('transform', `translate(${(-dx * 5).toFixed(1)} ${(-dy * 5).toFixed(1)})`);
  }

  // ---------- mongosh-style rendering of documents ----------
  function shell(value, indent = 0, inline = false) {
    const pad = '  '.repeat(indent + 1), end = '  '.repeat(indent);
    if (value === null || value === undefined) return '<span class="j-null">null</span>';
    if (typeof value === 'number') return `<span class="j-num">${Object.is(value, -0) ? '-0' : value}</span>`;
    if (typeof value === 'boolean') return `<span class="j-bool">${value}</span>`;
    if (typeof value === 'string') return `<span class="j-str">'${esc(value)}'</span>`;
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      const scalar = value.every((v) => typeof v !== 'object' || v === null);
      if (inline || (scalar && value.length <= 8) || value.every((v) => Array.isArray(v) && v.length <= 2)) {
        return `[ ${value.map((v) => shell(v, indent, true)).join(', ')} ]`;
      }
      return `[\n${value.map((v) => pad + shell(v, indent + 1)).join(',\n')}\n${end}]`;
    }
    if (value.$oid) return `<span class="j-fn">ObjectId</span>(<span class="j-str">'${esc(value.$oid)}'</span>)`;
    if (value.$date !== undefined) return `<span class="j-fn">ISODate</span>(<span class="j-str">'${esc(dateOf(value).toISOString())}'</span>)`;
    if (value.$numberLong) return `<span class="j-fn">Long</span>(<span class="j-str">'${esc(value.$numberLong)}'</span>)`;
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const key = (k) => k.startsWith('$') ? `<span class="j-op">${esc(k)}</span>`
      : /^[A-Za-z_][\w]*$/.test(k) ? `<span class="j-key">${esc(k)}</span>` : `<span class="j-key">'${esc(k)}'</span>`;
    const small = keys.length <= 3 && keys.every((k) => typeof value[k] !== 'object' || value[k] === null || value[k].$oid || value[k].$date);
    if (inline || small) return `{ ${keys.map((k) => `${key(k)}: ${shell(value[k], indent, true)}`).join(', ')} }`;
    return `{\n${keys.map((k) => `${pad}${key(k)}: ${shell(value[k], indent + 1)}`).join(',\n')}\n${end}}`;
  }
  const fn = (name) => `<span class="j-fn">${name}</span>`;

  // ---------- little glyphs for lists ----------
  function glyph(doc) {
    const s = (body) => `<svg class="glyph" viewBox="-9 -9 18 18" aria-hidden="true">${body}</svg>`;
    switch (doc.type) {
      case 'star': return s(`<circle r="${Math.max(2, Math.min(5.5, 5 - 0.8 * (doc.magnitude ?? 3)))}" fill="${doc.discovery ? '#74c2b0' : SPECTRAL[(doc.spectralClass || 'A')[0]] || '#fff'}"/>`);
      case 'planet': return s(`<circle r="4" fill="${PLANET_COLOR[doc.name] || '#74c2b0'}"/>${doc.rings ? '<ellipse rx="8" ry="2.4" fill="none" stroke="#e9d59a" transform="rotate(-22)"/>' : ''}`);
      case 'comet': return s('<path d="M3 -3 L-8 7" stroke="#f1dba0" stroke-width="2.4" stroke-linecap="round" opacity=".55"/><circle cx="3.5" cy="-3.5" r="3" fill="#f6ecc8"/>');
      case 'galaxy': return s('<ellipse rx="7.5" ry="3.2" transform="rotate(-28)" fill="rgba(238,160,160,.2)" stroke="#eea0a0"/>');
      case 'cluster': return s('<circle r="6" fill="none" stroke="#e8d59a" stroke-dasharray="2 2.4"/>');
      case 'nebula': return s(`<circle r="7" fill="${NEBULA_COLOR[doc.nebulaType] || '#ef8fae'}" opacity=".45"/><circle r="2" fill="${NEBULA_COLOR[doc.nebulaType] || '#ef8fae'}"/>`);
      default: return s('<path d="M-6 4 L-1 -5 L6 1" fill="none" stroke="#c9a35a" stroke-width="1.2"/><circle cx="-6" cy="4" r="1.8" fill="#efe5cb"/><circle cx="-1" cy="-5" r="1.8" fill="#efe5cb"/><circle cx="6" cy="1" r="1.8" fill="#efe5cb"/>');
    }
  }
  function keyValue(doc) {
    if (typeof doc.magnitude === 'number') return `mag ${doc.magnitude}`;
    if (doc.type === 'planet') return `${(doc.moons || []).length} moons`;
    if (doc.type === 'comet') return `${doc.orbitalPeriodYears} yr`;
    if (doc.type === 'constellation') return `${(doc.stars || []).length} stars`;
    return '';
  }

  // ---------- query bar ----------
  async function runQuery(q) {
    $('#q').value = q;
    document.querySelectorAll('#chips button').forEach((b) => b.classList.toggle('is-active', b.dataset.q === q));
    const { ok, body } = await getJson(`/api/query?q=${encodeURIComponent(q)}`);
    if (!ok) {
      $('#stats').innerHTML = `<span class="obs-error">${esc(body.error || 'The query failed.')}</span>`;
      return;
    }
    $('#filter').innerHTML = `${fn('db')}.sky.${fn('find')}(${shell(body.filter, 0, true)})`;
    const plan = body.plan || {};
    const how = plan.stage === 'IXSCAN'
      ? `<span class="is-ix">Index scan on ${esc(plan.index)}</span>, ${plan.keysExamined} keys and ${plan.docsExamined} documents examined.`
      : `Collection scan, ${plan.docsExamined} documents examined.`;
    $('#stats').innerHTML = `<strong>${body.count} ${body.count === 1 ? 'document' : 'documents'}</strong> in ${body.millis} ms, round trip from Java to MongoDB. ${how}`;
    $('#results').innerHTML = body.results.map((doc) =>
      `<li><button type="button" data-id="${idOf(doc)}">${glyph(doc)}<span><span class="r-name">${esc(doc.name)}</span><span class="r-type">${esc(KIND[doc.type] || doc.type)}</span></span><span class="r-val">${esc(keyValue(doc))}</span></button></li>`).join('');
    state.hits = q.trim() ? new Set(body.results.map(idOf)) : null;
    history.replaceState(null, '', q.trim() ? `?q=${encodeURIComponent(q.trim())}` : location.pathname); // shareable link
    $('#clear').hidden = !state.hits;
    render();
    renderComets();
  }

  // ---------- comets ----------
  function renderComets() {
    const comets = state.objects.filter((o) => o.type === 'comet');
    const Y0 = 1975, Y1 = 2135, x = (year) => `${((year - Y0) / (Y1 - Y0) * 100).toFixed(2)}%`;
    const yearOf = (d) => d.getUTCFullYear() + d.getUTCMonth() / 12;
    const now = yearOf(new Date());
    const rows = comets.map((doc) => {
      const last = dateOf(doc.lastPerihelion);
      if (!last) return '';
      const lastY = yearOf(last), nextY = lastY + doc.orbitalPeriodYears;
      const hit = state.hits && state.hits.has(idOf(doc)) ? ' is-hit' : '';
      const within = nextY <= Y1;
      return `<div class="comet-row${hit}">
        <button type="button" data-id="${idOf(doc)}"><span class="c-name">${esc(doc.name)}</span><span class="c-meta">${esc(doc.designation || (doc.discovery ? 'logged by ' + doc.discovery.by : ''))}</span></button>
        <div class="track">
          <span class="track__line" style="left:${x(Math.max(Y0, lastY))};right:${within ? `calc(100% - ${x(nextY)})` : '0'}"></span>
          <span class="comet-now" style="left:${x(now)}"></span>
          ${lastY >= Y0 ? `<span class="track__dot" style="left:${x(lastY)}"></span><span class="track__label" style="left:${x(lastY)}">${Math.floor(lastY)}</span>` : ''}
          ${within ? `<span class="track__dot track__dot--next" style="left:${x(nextY)}"></span><span class="track__label track__label--next" style="left:${x(nextY)}">${Math.floor(nextY)}</span>`
            : `<span class="track__more">back in ${Math.floor(nextY)}</span>`}
        </div></div>`;
    }).join('');
    const ticks = [1980, 2000, 2020, 2040, 2060, 2080, 2100, 2120].map((y) => `<span style="left:${x(y)}">${y}</span>`).join('');
    $('#comets').innerHTML = `${rows}<div class="comet-axis">${ticks}<span class="comet-axis__now" style="left:${x(now)}">today</span></div>`;
  }

  // ---------- observation sheet ----------
  function art(doc) {
    const w = 380, h = 150;
    if (doc.type === 'star') {
      const k = (doc.spectralClass || 'A')[0], color = doc.discovery ? '#74c2b0' : SPECTRAL[k] || '#fff';
      const mag = doc.magnitude ?? 3, x = 160 + (Math.max(-1.5, Math.min(6, mag)) + 1.5) / 7.5 * 200;
      return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Brightness on the magnitude scale">
        <defs><radialGradient id="art-star"><stop offset="0" stop-color="#fff"/><stop offset="0.12" stop-color="${color}"/><stop offset="0.4" stop-color="${color}" stop-opacity="0.25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>
        <circle cx="70" cy="72" r="${Math.max(26, 64 - mag * 7)}" fill="url(#art-star)"/>
        <line x1="160" y1="72" x2="360" y2="72" stroke="#c9a35a" stroke-opacity=".5"/>
        ${[-1, 0, 1, 2, 3, 4, 5, 6].map((m) => { const tx = 160 + (m + 1.5) / 7.5 * 200; return `<line x1="${tx}" y1="66" x2="${tx}" y2="78" stroke="#c9a35a" stroke-opacity=".6"/><text x="${tx}" y="98" fill="#b9b29d" font-size="12" text-anchor="middle" font-family="JetBrains Mono">${m}</text>`; }).join('')}
        <path d="M${x} 60 l-6 -10 h12z" fill="#f1dba0"/>
        <text x="160" y="40" fill="#b9b29d" font-size="13" font-family="IM Fell English" font-style="italic">brighter</text>
        <text x="360" y="40" fill="#b9b29d" font-size="13" font-family="IM Fell English" font-style="italic" text-anchor="end">fainter</text>
      </svg>`;
    }
    if (doc.type === 'planet') {
      const color = PLANET_COLOR[doc.name] || '#74c2b0', moons = doc.moons || [];
      const r = Math.max(10, Math.min(34, Math.sqrt(doc.radiusKm || 6000) / 7.5));
      const orbits = moons.slice(0, 8).map((m, i) => {
        const rx = r + 22 + i * 15, ry = rx * 0.32, a = (i * 137) * DEG;
        return `<ellipse cx="190" cy="75" rx="${rx}" ry="${ry}" fill="none" stroke="#c9a35a" stroke-opacity=".28"/><circle cx="${(190 + rx * Math.cos(a)).toFixed(1)}" cy="${(75 + ry * Math.sin(a)).toFixed(1)}" r="2.6" fill="#efe5cb"><title>${esc(m.name)}</title></circle>`;
      }).join('');
      const rings = doc.rings ? `<ellipse cx="190" cy="75" rx="${r * 1.9}" ry="${r * 0.5}" fill="none" stroke="${color}" stroke-width="3" opacity=".7"/>` : '';
      return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(doc.name)} and its moons">${orbits}<circle cx="190" cy="75" r="${r}" fill="${color}"/>${rings}</svg>`;
    }
    if (doc.type === 'comet') {
      const e = Math.min(0.97, doc.eccentricity ?? 0.8), a = 150, b = a * Math.sqrt(1 - e * e), cx = 200, focus = cx - a * e;
      return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Orbit with eccentricity ${e}">
        <ellipse cx="${cx}" cy="75" rx="${a}" ry="${Math.max(b, 6)}" fill="none" stroke="#c9a35a" stroke-opacity=".5" stroke-dasharray="4 5"/>
        <circle cx="${focus}" cy="75" r="9" fill="#ffd27a"/><text x="${focus}" y="104" fill="#b9b29d" font-size="12" text-anchor="middle" font-family="IM Fell English" font-style="italic">Sun</text>
        <path d="M${cx - a + 2} 75 l26 -9 l0 18z" fill="#f6ecc8" opacity=".35"/><circle cx="${cx - a + 2}" cy="75" r="4.5" fill="#f6ecc8"/>
        <text x="${cx - a + 2}" y="58" fill="#b9b29d" font-size="12" text-anchor="middle" font-family="IM Fell English" font-style="italic">perihelion</text></svg>`;
    }
    if (doc.type === 'constellation') {
      const stars = (doc.stars || []).map((ref) => state.byId.get(ref && ref.$oid));
      const known = stars.filter((s) => s && typeof s.ra === 'number');
      if (!known.length) return '';
      // local flat projection, north up and east to the left, as the sky is seen
      const ra0 = known[0].ra, dec0 = known.reduce((t, s) => t + s.dec, 0) / known.length;
      const flat = stars.map((s) => s && typeof s.ra === 'number'
        ? [-(mod(s.ra - ra0 + 12, 24) - 12) * 15 * Math.cos(dec0 * DEG), -s.dec] : null);
      const xs = flat.filter(Boolean).map((p) => p[0]), ys = flat.filter(Boolean).map((p) => p[1]);
      const minX = Math.min(...xs), minY = Math.min(...ys);
      const k = 120 / Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 1);
      const offX = 190 - (Math.max(...xs) - minX) * k / 2, offY = 75 - (Math.max(...ys) - minY) * k / 2;
      const map = (p) => [((p[0] - minX) * k + offX).toFixed(1), ((p[1] - minY) * k + offY).toFixed(1)];
      const lines = (doc.figure || []).map(([i, j]) => flat[i] && flat[j]
        ? `<line x1="${map(flat[i])[0]}" y1="${map(flat[i])[1]}" x2="${map(flat[j])[0]}" y2="${map(flat[j])[1]}" stroke="#efe5cb" stroke-opacity=".5"/>` : '').join('');
      const dots = flat.map((p, i) => p ? `<circle cx="${map(p)[0]}" cy="${map(p)[1]}" r="${(starRadius(stars[i].magnitude) * 0.9).toFixed(1)}" fill="#fff4e0"/>` : '').join('');
      return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Figure of ${esc(doc.name)}, north up">${lines}${dots}</svg>`;
    }
    const color = doc.type === 'galaxy' ? '#eea0a0' : doc.type === 'cluster' ? '#e8d59a' : NEBULA_COLOR[doc.nebulaType] || '#74c2b0';
    const shape = doc.type === 'galaxy'
      ? `<ellipse cx="190" cy="75" rx="120" ry="38" transform="rotate(-18 190 75)" fill="url(#art-glow)"/><ellipse cx="190" cy="75" rx="26" ry="10" transform="rotate(-18 190 75)" fill="#fff4e0" opacity=".7"/>`
      : doc.type === 'cluster'
        ? Array.from({ length: doc.clusterType === 'globular' ? 90 : 24 }, (_, i) => { const a = i * 2.39996, rr = (doc.clusterType === 'globular' ? 4.2 : 9) * Math.sqrt(i); return `<circle cx="${(190 + rr * Math.cos(a)).toFixed(1)}" cy="${(75 + rr * 0.8 * Math.sin(a)).toFixed(1)}" r="${i % 7 ? 1.4 : 2.4}" fill="#f6ecc8" opacity="${(1 - i / 120).toFixed(2)}"/>`; }).join('')
        : `<circle cx="190" cy="75" r="70" fill="url(#art-glow)"/>${doc.nebulaType === 'planetary' ? '<circle cx="190" cy="75" r="22" fill="none" stroke="' + color + '" stroke-width="5" opacity=".8"/>' : ''}`;
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(KIND[doc.type] || doc.type)}"><defs><radialGradient id="art-glow"><stop offset="0" stop-color="${color}" stop-opacity=".8"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs>${shape}</svg>`;
  }

  function sheetHuman(doc, lookup) {
    const facts = [], extra = [];
    let sub = '';
    const fact = (label, value) => { if (value !== undefined && value !== null && value !== '') facts.push(`<dt>${label}</dt><dd>${value}</dd>`); };
    const pos = position(doc, viewDate());
    switch (doc.type) {
      case 'star': {
        const k = (doc.spectralClass || '?')[0];
        sub = [doc.bayer, doc.constellation && `in ${doc.constellation}`].filter(Boolean).map(esc).join(' ');
        const v = doc.variability;
        fact('Magnitude', `${doc.magnitude}${v ? `<br><small>varies from ${v.range[0]} to ${v.range[1]}${v.periodDays ? ` over ${v.periodDays} days` : ''} (${esc(v.type)})</small>` : ''}`);
        fact('Spectral class', `<span class="swatch" style="background:${SPECTRAL[k] || '#fff'}"></span>${esc(doc.spectralClass)}${TEMPERATURE[k] ? `<br><small>surface ${TEMPERATURE[k]}</small>` : ''}`);
        if (doc.distanceLy) fact('Distance', `${fmtLy(doc.distanceLy)}${doc.distanceLy < 5000 ? `<br><small>the light you see left it around ${Math.round(new Date().getFullYear() - doc.distanceLy)}</small>` : ''}`);
        break;
      }
      case 'planet':
        sub = doc.order ? `Planet number ${doc.order} from the Sun` : 'A planet logged by a visitor';
        if (doc.radiusKm) fact('Radius', `${Number(doc.radiusKm).toLocaleString('en')} km <small>(${(doc.radiusKm / 6371).toFixed(2)} × Earth)</small>`);
        fact('Orbital period', doc.orbitalPeriodYears && `${doc.orbitalPeriodYears} years`);
        fact('Brightest magnitude', doc.brightestMagnitude);
        fact('Moons in this document', String((doc.moons || []).length));
        fact('Rings', doc.rings ? 'yes' : undefined);
        if (doc.discovered) fact('Discovered', `${doc.discovered.year} by ${esc(doc.discovered.by)}`);
        if (doc.name === 'Earth') fact('Position', 'you are standing on it, at the zenith of the chart');
        if (doc.moons && doc.moons.length) extra.push(`<h3>Moons</h3><ul class="moon-list">${doc.moons.map((m) => `<li>${esc(m.name)}${m.discovered ? ` <small class="j-dim">${m.discovered}</small>` : ''}</li>`).join('')}</ul>`);
        if (doc.orbit && doc.name !== 'Earth') extra.push('<p class="obs-note">Tonight\'s position is computed in your browser from the <code>orbit</code> sub-document and from Earth\'s own document.</p>');
        break;
      case 'comet': {
        sub = esc(doc.designation || 'A comet logged by a visitor');
        const last = dateOf(doc.lastPerihelion);
        fact('Orbital period', `${doc.orbitalPeriodYears} years`);
        if (last) {
          fact('Last perihelion', fmtDate(last));
          const next = new Date(last.getTime() + doc.orbitalPeriodYears * 365.25 * 86400000);
          fact('Next return', `around ${next.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`);
        }
        fact('Closest to the Sun', doc.perihelionAu && `${doc.perihelionAu} AU`);
        fact('Eccentricity', doc.eccentricity);
        fact('Meteor showers', doc.meteorShowers && doc.meteorShowers.map(esc).join(', '));
        fact('Visited by', doc.visitedBy && doc.visitedBy.map(esc).join(', '));
        break;
      }
      case 'constellation':
        sub = `${esc(doc.abbr)}, genitive ${esc(doc.genitive)}`;
        fact('Area', `${doc.areaSqDeg} square degrees`);
        fact('Star references', String((doc.stars || []).length));
        if (lookup) extra.push(`<h3>Its stars, resolved with $lookup</h3><ul class="star-list">${lookup.stars.map((s) => `<li><button type="button" data-id="${idOf(s)}">${esc(s.name)}</button></li>`).join('')}</ul>`);
        break;
      default: {
        const where = doc.coordinates && doc.coordinates.constellation;
        sub = [doc.messier, where && `in ${where}`].filter(Boolean).map(esc).join(' ');
        fact('Kind', esc(doc.nebulaType || doc.morphology || doc.clusterType || ''));
        fact('Magnitude', doc.magnitude);
        if (doc.distanceLy) fact('Distance', fmtLy(doc.distanceLy));
        fact('Also known as', doc.alsoKnownAs && doc.alsoKnownAs.map(esc).join(', '));
        fact('Group', doc.group && esc(doc.group));
        if (doc.supernovaYear) fact('Supernova', `seen from Earth in ${doc.supernovaYear}`);
        if (doc.blackHole) fact('Black hole', `${(doc.blackHole.solarMasses / 1e9).toFixed(1)} billion solar masses, first imaged in ${doc.blackHole.firstImaged}`);
        if (doc.starsEstimated) fact('Stars', `about ${Number(doc.starsEstimated).toLocaleString('en')}`);
      }
    }
    if (pos && doc.name !== 'Earth') fact(doc.type === 'planet' ? 'Position tonight' : 'Position', `RA ${fmtRA(pos.ra)}, Dec ${fmtDec(pos.dec)}`);
    if (doc.discovery) fact('Logged', `by ${esc(doc.discovery.by)}, ${fmtDate(dateOf(doc.discovery.at))}`);
    return `<p class="sheet__kind">${esc(KIND[doc.type] || doc.type)}</p>
      <h2 class="sheet__name" id="sheet-name">${esc(doc.name)}</h2>
      ${sub ? `<p class="sheet__sub">${sub}</p>` : ''}
      <div class="sheet__art">${art(doc)}</div>
      <dl class="facts">${facts.join('')}</dl>
      <div class="sheet__extra">${extra.join('')}</div>`;
  }

  async function openSheet(id) {
    if (!id) return;
    const { ok, body } = await getJson(`/api/objects/${encodeURIComponent(id)}`);
    if (!ok) return;
    const doc = body.document;
    $('#sheet-human').innerHTML = sheetHuman(doc, body.lookup);
    $('#sheet-doc').innerHTML = shell(doc);
    $('#sheet-lookup').innerHTML = body.lookup
      ? `<p class="lookup-title">The aggregation that resolved its star references, ${body.lookup.millis} ms</p><pre class="obs-code">${fn('db')}.sky.${fn('aggregate')}(${shell(body.lookup.pipeline)})</pre>` : '';
    const dialog = $('#sheet');
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('.sheet__human').scrollTop = 0;
  }

  // ---------- discoveries ----------
  function syncKind() {
    const type = new FormData($('#discover')).get('type');
    document.querySelectorAll('#discover [data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(type); });
  }

  async function submitDiscovery(event) {
    event.preventDefault();
    const form = event.target, data = new FormData(form), type = data.get('type');
    const num = (name) => { const v = data.get(name); return v === null || v === '' ? null : Number(v); };
    const text = (name) => { const v = data.get(name); return v === null || v === '' ? null : String(v).trim(); };
    const body = { type, name: text('name'), observer: text('observer') };
    if (type === 'star') Object.assign(body, { magnitude: num('magnitude'), spectralClass: text('spectralClass'), distanceLy: num('distanceLy') });
    if (type === 'planet') Object.assign(body, { moons: (text('moons') || '').split(',').map((s) => s.trim()).filter(Boolean), rings: data.get('rings') === 'on' });
    if (type === 'comet') Object.assign(body, { orbitalPeriodYears: num('orbitalPeriodYears'), lastPerihelion: text('lastPerihelion') });
    if (type === 'nebula') body.nebulaType = text('nebulaType');
    if (type !== 'comet') Object.assign(body, { ra: num('ra'), dec: num('dec') });

    form.querySelectorAll('[data-error]').forEach((el) => { el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
    $('#discover-error').hidden = true;
    $('#inserted').hidden = true;

    const { ok, body: answer } = await getJson('/api/discoveries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!ok) {
      const fields = answer.fields || {};
      Object.entries(fields).forEach(([field, message]) => {
        const slot = form.querySelector(`[data-error="${field}"]`);
        if (slot) slot.textContent = `${field === 'ra' ? 'RA' : field === 'dec' ? 'Dec' : ''} ${message}`.trim();
        const input = form.querySelector(`[name="${field}"]`);
        if (input) input.setAttribute('aria-invalid', 'true');
      });
      $('#discover-error').textContent = answer.error || 'The document was not inserted.';
      $('#discover-error').hidden = false;
      return;
    }
    const doc = answer.document;
    $('#inserted').hidden = false;
    $('#inserted-stats').innerHTML = `<strong>Inserted.</strong> <code>insertOne()</code> took ${answer.millis} ms. This is the document read back from the collection:`;
    $('#inserted-doc').innerHTML = shell(doc);
    state.fresh = idOf(doc);
    state.pick = null;
    form.reset();
    syncKind();
    await Promise.all([loadSky(), loadCensus()]);
    if (doc.type === 'comet') $('#comets').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  }

  function startPicking() {
    state.picking = true;
    $('#pick-hint').hidden = false;
    render();
    $('#chart-wrap').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  }

  function pickAt(event) {
    const svg = $('#chart');
    const pt = svg.createSVGPoint();
    pt.x = event.clientX; pt.y = event.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const sky = unproject(p.x, p.y, sidereal(viewDate()));
    if (sky.dec < DEC_MIN) return;
    state.pick = sky;
    state.picking = false;
    $('#pick-hint').hidden = true;
    $('#discover [name="ra"]').value = sky.ra.toFixed(2);
    $('#discover [name="dec"]').value = sky.dec.toFixed(1);
    render();
    setTimeout(() => $('#discover').scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' }), 350);
  }

  // ---------- census + platform ----------
  async function loadCensus() {
    const { ok, body } = await getJson('/api/census');
    if (!ok) return;
    $('#census-pipeline').innerHTML = `${fn('db')}.sky.${fn('aggregate')}(${shell(body.pipeline)})`;
    const max = Math.max(...body.groups.map((g) => g.count), 1);
    $('#census').innerHTML = body.groups.map((g) =>
      `<li><span class="t-name">${esc(KIND[g._id] || g._id)}</span><span class="t-bar" style="width:${(g.count / max * 100).toFixed(1)}%"></span><span class="t-count">${g.count}</span></li>`).join('');
    const total = body.groups.reduce((s, g) => s + g.count, 0);
    $('#census-stats').innerHTML = `<strong>${total} documents</strong>, grouped by MongoDB in ${body.millis} ms.`;
  }

  async function loadPlatform() {
    const { ok, body } = await getJson('/api/platform');
    if (!ok) return;
    const v = body.versions;
    $('#versions').textContent = `Java ${v.java} · Spring Boot ${v.springBoot} · MongoDB ${v.mongodb || '?'}`;
    const vars = body.variables, onClever = !!vars.APP_ID;
    $('#live-label').textContent = onClever ? 'Live on Clever Cloud' : 'Running locally';
    $('#live').classList.toggle('cc-pill--live', onClever);
    $('#platform-pill').innerHTML = onClever ? '<span class="cc-dot"></span>Production' : '<span class="cc-dot cc-dot--muted"></span>Local run';
    const labels = [['CC_APP_NAME', 'Application'], ['APP_ID', 'App ID'], ['INSTANCE_NUMBER', 'Instance'], ['CC_PRETTY_INSTANCE_NAME', 'Instance name'],
      ['INSTANCE_TYPE', 'Instance type'], ['CC_COMMIT_ID', 'Commit'], ['CC_DEPLOYMENT_ID', 'Deployment']];
    $('#platform').innerHTML = labels.map(([name, label]) =>
      `<div><dt>${label}</dt><dd class="${vars[name] ? '' : 'is-empty'}" title="${name}">${esc(vars[name] || 'set on Clever Cloud')}</dd></div>`).join('');
  }

  async function loadSky() {
    const { ok, body } = await getJson('/api/sky');
    if (!ok) {
      $('#stats').innerHTML = '<span class="obs-error">The catalogue cannot be read right now. /health/deep tells whether MongoDB answers.</span>';
      return;
    }
    state.objects = body.objects;
    state.byId = new Map();
    const date = viewDate();
    for (const doc of state.objects) {
      const pos = position(doc, date);
      state.byId.set(idOf(doc), Object.assign({ magnitude: doc.magnitude }, pos || {}));
    }
    render();
    renderComets();
  }

  // ---------- wiring ----------
  document.addEventListener('DOMContentLoaded', () => {
    $('#ask').addEventListener('submit', (e) => { e.preventDefault(); runQuery($('#q').value); });
    $('#chips').addEventListener('click', (e) => { const b = e.target.closest('button[data-q]'); if (b) runQuery(b.dataset.q); });
    $('#clear').addEventListener('click', () => runQuery(''));
    document.addEventListener('click', (e) => {
      const target = e.target.closest('#results [data-id], #comets [data-id], .star-list [data-id]');
      if (target) openSheet(target.dataset.id);
    });
    $('#chart').addEventListener('click', (e) => {
      if (state.picking) { pickAt(e); return; }
      const obj = e.target.closest('[data-id]');
      if (obj) openSheet(obj.dataset.id);
    });
    $('#chart-wrap').addEventListener('pointermove', parallax);
    $('#hours').addEventListener('input', (e) => { state.offsetHours = Number(e.target.value); render(); });
    $('#now').addEventListener('click', () => { state.offsetHours = 0; $('#hours').value = 0; render(); });
    $('#whole').addEventListener('change', (e) => { state.lifted = e.target.checked; render(); });
    $('#sheet-close').addEventListener('click', () => $('#sheet').close());
    $('#sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
    $('#discover').addEventListener('change', (e) => { if (e.target.name === 'type') syncKind(); });
    $('#discover').addEventListener('submit', submitDiscovery);
    $('#pick').addEventListener('click', startPicking);
    syncKind();
    loadSky().then(() => runQuery(new URLSearchParams(location.search).get('q') || ''));
    loadCensus();
    loadPlatform();
    setInterval(() => { if (!state.picking) render(); }, 60000); // the sky turns: 1° every 4 minutes
  });
})();
