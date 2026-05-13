const API_BASE = 'https://resultados.mininterior.gob.ar/api/resultados/getResultados';

const BASE_PARAMS = {
  anioEleccion: 2023,
  tipoRecuento: 1,
  tipoEleccion: 2,
  categoriaId: 7,   // 7 = Intendente (confirmado del CSV oficial DINE)
  distritoId: 2,
  seccionId: 113,
};

// Circuitos reales de Tigre según el CSV oficial DINE 2023 Generales.
// IDs descubiertos del archivo ResultadoElectorales_2023_Generales.csv
// Coordenadas aproximadas — para precisión usar shapefiles del IGN.
const CIRCUITOS = {
  '':      { nombre: 'Tigre (sección completa)', lat: -34.426, lng: -58.579, zoom: 12 },
  '00530': { nombre: 'Tigre Centro',             lat: -34.427, lng: -58.577, zoom: 14 },
  '0534A': { nombre: 'Benavídez',                lat: -34.394, lng: -58.681, zoom: 13 },
  '00535': { nombre: 'Don Torcuato',             lat: -34.474, lng: -58.614, zoom: 13 },
  '00534': { nombre: 'El Talar',                 lat: -34.453, lng: -58.640, zoom: 13 },
  '00536': { nombre: 'General Pacheco',          lat: -34.460, lng: -58.659, zoom: 13 },
  '0535A': { nombre: 'Ricardo Rojas',            lat: -34.443, lng: -58.592, zoom: 13 },
  '0536A': { nombre: 'Rincón de Milberg',        lat: -34.400, lng: -58.598, zoom: 13 },
  '00533': { nombre: 'Dique Luján',              lat: -34.384, lng: -58.625, zoom: 13 },
};

const PALETTE = [
  '#58a6ff', '#f78166', '#3fb950', '#d2a8ff',
  '#ffa657', '#79c0ff', '#56d364', '#ff7b72', '#8b949e',
];

// Colores estables por partido para el mapa coroplético
const PARTY_COLORS = {
  'UNION POR LA PATRIA':                          '#58a6ff',
  'JUNTOS POR EL CAMBIO':                         '#f7c948',
  'LA LIBERTAD AVANZA':                           '#d2a8ff',
  'FRENTE DE IZQUIERDA Y DE TRABAJADORES - UNIDAD': '#f78166',
};
function partyColor(nombre) {
  return PARTY_COLORS[nombre] ?? '#8b949e';
}

let map, choroplethLayer = null, geojsonData = null, currentData = null;

function initMap() {
  map = L.map('map', {
    center: [-34.426, -58.579],
    zoom: 12,
    zoomControl: false,
    attributionControl: true,
  });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(map);
}

async function loadGeoJSON() {
  const res = await fetch('tigre_circuitos.geojson');
  geojsonData = await res.json();
}

async function fetchResultados(circuitoId = '') {
  const params = { ...BASE_PARAMS };
  if (circuitoId) params.circuitoId = circuitoId;  // formato: '00530', '0534A', etc.
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)])
  ).toString();
  const url = `${API_BASE}?${qs}`;
  console.log('[API] GET', url);
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${res.statusText}`);
    return res.json();
  } finally {
    clearTimeout(tid);
  }
}

function parseResultados(json) {
  // La API usa: estadoRecuento + valoresTotalizadosPositivos
  const estado = json?.estadoRecuento ?? {};
  const meta = {
    electores:       safeInt(estado.cantidadElectores),
    votantes:        safeInt(estado.cantidadVotantes),
    mesasEscrutadas: safeInt(estado.mesasTotalizadas),
    mesasTotales:    safeInt(estado.mesasTotalizadas),
    participacion:   estado.participacionPorcentaje
                       ? parseFloat(estado.participacionPorcentaje).toFixed(2)
                       : null,
  };

  const raw = json?.valoresTotalizadosPositivos ?? [];
  if (!raw.length) console.warn('[parseResultados] sin agrupaciones en respuesta', json);

  const agrupaciones = [];
  for (const ag of raw) {
    const votos = safeInt(ag?.votos);
    if (votos === null) continue;
    agrupaciones.push({
      id:         String(ag?.idAgrupacion ?? '?'),
      nombre:     ag?.nombreAgrupacion ?? 'Sin nombre',
      votos,
      porcentaje: parseFloat(ag?.votosPorcentaje ?? 0),
    });
  }

  agrupaciones.sort((a, b) => b.votos - a.votos);
  const totalVotos = agrupaciones.reduce((s, a) => s + a.votos, 0);
  for (const ag of agrupaciones)
    if (!ag.porcentaje && totalVotos > 0)
      ag.porcentaje = parseFloat(((ag.votos / totalVotos) * 100).toFixed(2));

  return { meta, agrupaciones, totalVotos };
}

function safeInt(v) { const n = parseInt(v, 10); return isNaN(n) ? null : n; }
function getColor(i) { return PALETTE[Math.min(i, PALETTE.length - 1)]; }

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('es-AR');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildPopupHTML(key, parsed) {
  const ci = CIRCUITOS[key] ?? CIRCUITOS[''];
  const { meta, agrupaciones, totalVotos } = parsed;

  let partHTML = '';
  if (meta.participacion) {
    partHTML = `<div class="popup-total">
      Electores: <b>${fmt(meta.electores)}</b> ·
      Votantes: <b>${fmt(meta.votantes)}</b> ·
      Participación: <b>${meta.participacion}%</b>
    </div>`;
  } else if (totalVotos) {
    partHTML = `<div class="popup-total">Total votos procesados: <b>${fmt(totalVotos)}</b></div>`;
  }

  let rows = '';
  agrupaciones.forEach(ag => {
    const color = partyColor(ag.nombre);
    const pct   = ag.porcentaje.toFixed(1);
    rows += `
      <div class="party-row">
        <span class="party-dot" style="background:${color}"></span>
        <span class="party-name">${escHtml(ag.nombre)}</span>
        <span class="party-votes">${fmt(ag.votos)}</span>
        <span class="party-pct" style="color:${color}">${pct}%</span>
      </div>
      <div class="bar-wrap">
        <div class="bar-fill" style="width:${Math.min(pct,100)}%;background:${color}"></div>
      </div>`;
  });

  const mesas = (meta.mesasEscrutadas && meta.mesasTotales)
    ? `<div style="font-size:.7rem;color:#6e7681;margin-top:8px">Mesas: ${meta.mesasEscrutadas}/${meta.mesasTotales}</div>`
    : '';

  return `
    <div class="popup-title">${escHtml(ci.nombre)}</div>
    <div class="popup-subtitle">Elecciones Generales 2023 · Categoría Intendente</div>
    ${partHTML}
    ${rows || '<p style="color:#6e7681;font-size:.8rem">Sin datos de agrupaciones</p>'}
    ${mesas}`;
}

function updateLegend(agrupaciones) {
  document.getElementById('legend-items').innerHTML =
    agrupaciones.slice(0, 8).map(ag => `
      <div class="legend-item">
        <div class="legend-dot" style="background:${partyColor(ag.nombre)}"></div>
        <span class="legend-label">${escHtml(ag.nombre.length > 28 ? ag.nombre.slice(0,26)+'…' : ag.nombre)}</span>
        <span class="legend-pct">${ag.porcentaje.toFixed(1)}%</span>
      </div>`).join('');
  document.getElementById('legend').style.display = 'block';
}

function updateLegendFromAll(circuitosData) {
  const totals = {};
  for (const { parsed } of Object.values(circuitosData))
    for (const ag of parsed.agrupaciones)
      totals[ag.nombre] = (totals[ag.nombre] ?? 0) + ag.votos;
  const total = Object.values(totals).reduce((s, v) => s + v, 0);
  const ags = Object.entries(totals)
    .map(([nombre, votos]) => ({ nombre, votos, porcentaje: (votos / total) * 100 }))
    .sort((a, b) => b.votos - a.votos);
  updateLegend(ags);
}

function updateStats(meta) {
  if (!meta.participacion) return;
  document.getElementById('stat-participation').textContent = meta.participacion + '%';
  document.getElementById('stat-valid').textContent = fmt(meta.votantes);
  document.getElementById('stat-mesas').textContent = (meta.mesasEscrutadas && meta.mesasTotales)
    ? `${meta.mesasEscrutadas}/${meta.mesasTotales}` : '—';
  document.getElementById('stats-bar').style.display = 'flex';
}

function updateStatsFromAll(circuitosData) {
  let electores = 0, votantes = 0, mesas = 0;
  for (const { parsed } of Object.values(circuitosData)) {
    electores += parsed.meta.electores ?? 0;
    votantes  += parsed.meta.votantes  ?? 0;
    mesas     += parsed.meta.mesasEscrutadas ?? 0;
  }
  if (!electores) return;
  document.getElementById('stat-participation').textContent =
    ((votantes / electores) * 100).toFixed(2) + '%';
  document.getElementById('stat-valid').textContent = fmt(votantes);
  document.getElementById('stat-mesas').textContent = fmt(mesas);
  document.getElementById('stats-bar').style.display = 'flex';
}

function circuitStyle(cid, highlight = false) {
  const d = currentData?.[cid];
  if (!d || !d.parsed.agrupaciones.length)
    return { fillColor: '#333', weight: 1, color: '#555', fillOpacity: 0.25 };
  const winner  = d.parsed.agrupaciones[0];
  const color   = partyColor(winner.nombre);
  const opacity = 0.45 + Math.min((winner.porcentaje - 35) / 100, 0.35);
  return {
    fillColor:   color,
    weight:      highlight ? 3 : 1.5,
    color:       highlight ? '#fff' : 'rgba(255,255,255,0.4)',
    fillOpacity: highlight ? Math.min(opacity + 0.15, 0.92) : opacity,
  };
}

function renderChoropleth(circuitosData) {
  if (!geojsonData) return;
  if (choroplethLayer) map.removeLayer(choroplethLayer);

  // El Partido de Tigre (00530) va al fondo; las localidades encima
  const sorted = [...geojsonData.features].sort((a, b) => {
    if (a.properties.circuito_id === '00530') return -1;
    if (b.properties.circuito_id === '00530') return  1;
    return 0;
  });

  choroplethLayer = L.geoJSON({ ...geojsonData, features: sorted }, {
    style: feature => circuitStyle(feature.properties.circuito_id),

    onEachFeature: (feature, layer) => {
      const cid = feature.properties.circuito_id;
      const d   = circuitosData[cid];

      if (d) {
        layer.bindPopup(
          L.popup({ maxWidth: 340 }).setContent(buildPopupHTML(cid, d.parsed)),
          { autoPan: true }
        );
      }

      layer.on('mouseover', function () {
        this.setStyle(circuitStyle(cid, true));
        this.bringToFront();
        const ci = CIRCUITOS[cid];
        const winner = d?.parsed.agrupaciones[0];
        this.bindTooltip(
          `<b>${ci?.nombre ?? cid}</b>${winner ? `<br>${escHtml(winner.nombre)}: ${winner.porcentaje.toFixed(1)}%` : ''}`,
          { sticky: true, direction: 'top' }
        ).openTooltip();
      });
      layer.on('mouseout', function () {
        choroplethLayer.resetStyle(this);
        this.closeTooltip();
      });
    },
  }).addTo(map);
}

async function loadData() {
  const btn = document.getElementById('load-btn');
  btn.disabled = true;
  showOverlay('Cargando todos los circuitos…');

  try {
    const circuitKeys = Object.keys(CIRCUITOS).filter(k => k !== '');
    let loaded = 0;

    const entries = await Promise.all(
      circuitKeys.map(async key => {
        const json   = await fetchResultados(key);
        const parsed = parseResultados(json);
        loaded++;
        showOverlay(`Cargando circuitos… ${loaded}/${circuitKeys.length}`);
        return [key, { parsed, circuitoInfo: CIRCUITOS[key] }];
      })
    );

    currentData = Object.fromEntries(entries.filter(([, v]) => v.parsed.agrupaciones.length));

    if (!Object.keys(currentData).length) {
      showError('Sin datos', 'La API no devolvió datos para ningún circuito.');
      loadDemoData();
      return;
    }

    renderChoropleth(currentData);
    updateLegendFromAll(currentData);
    updateStatsFromAll(currentData);
    map.flyTo([CIRCUITOS[''].lat, CIRCUITOS[''].lng], CIRCUITOS[''].zoom, { duration: 1 });
    hideOverlay();

  } catch (err) {
    console.error('[loadData]', err);
    let msg = err.message ?? 'Error desconocido';
    if (err.name === 'AbortError' || msg.includes('timeout'))
      msg = 'Timeout 15s — reintente en unos momentos.';
    else if (msg.includes('Failed to fetch') || msg.includes('NetworkError'))
      msg = 'Sin conexión a la API. Verifique su red.';
    else if (msg.includes('CORS'))
      msg = 'Bloqueado por CORS — pruebe desde un servidor local.';
    showError('Error al cargar resultados', msg);
    loadDemoData();
  } finally {
    btn.disabled = false;
  }
}

function focusCircuit() {
  const key = document.getElementById('circuit-select').value;
  if (!currentData) return;
  const ci = CIRCUITOS[key] ?? CIRCUITOS[''];
  map.flyTo([ci.lat, ci.lng], ci.zoom, { duration: 0.8 });
  if (key && currentData[key]) {
    updateLegend(currentData[key].parsed.agrupaciones);
    updateStats(currentData[key].parsed.meta);
  } else {
    updateLegendFromAll(currentData);
    updateStatsFromAll(currentData);
  }
}

function loadDemoData() {
  const DEMO = [
    { id: 135, nombre: 'UNION POR LA PATRIA',                              votos: 52300, porcentaje: 42.5 },
    { id: 136, nombre: 'JUNTOS POR EL CAMBIO',                             votos: 35800, porcentaje: 29.1 },
    { id: 137, nombre: 'LA LIBERTAD AVANZA',                               votos: 22100, porcentaje: 17.9 },
    { id: 138, nombre: 'FRENTE DE IZQUIERDA Y DE TRABAJADORES - UNIDAD',   votos: 5400,  porcentaje: 4.4  },
    { id: 139, nombre: 'Otros',                                             votos: 2620,  porcentaje: 2.1  },
  ];
  const DEMO_META = {
    electores: 280000, votantes: 123180,
    participacion: '43.99', mesasEscrutadas: 420, mesasTotales: 480,
  };
  const circuitosData = {};
  for (const [key, ci] of Object.entries(CIRCUITOS)) {
    if (key === '') continue;
    const factor = 0.8 + Math.random() * 0.4;
    const ags = DEMO.map(ag => ({ ...ag, votos: Math.round(ag.votos * factor * 0.12) }));
    ags.sort((a, b) => b.votos - a.votos);
    const total = ags.reduce((s, a) => s + a.votos, 0);
    ags.forEach(ag => { ag.porcentaje = parseFloat(((ag.votos / total) * 100).toFixed(2)); });
    circuitosData[key] = { parsed: { meta: DEMO_META, agrupaciones: ags, totalVotos: total }, circuitoInfo: ci };
  }
  renderChoropleth(circuitosData);
  updateLegend(DEMO);
  document.getElementById('stat-participation').textContent = DEMO_META.participacion + '%';
  document.getElementById('stat-valid').textContent         = fmt(DEMO_META.votantes);
  document.getElementById('stat-mesas').textContent         = `${DEMO_META.mesasEscrutadas}/${DEMO_META.mesasTotales}`;
  document.getElementById('stats-bar').style.display = 'flex';
  document.getElementById('legend').style.display    = 'block';

  const notice = document.createElement('div');
  notice.style.cssText = `position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
    z-index:2000;background:#5a3825;border:1px solid #ffa657;border-radius:8px;
    padding:8px 18px;font-size:.78rem;color:#ffa657;pointer-events:none;backdrop-filter:blur(4px);`;
  notice.textContent = '⚠ Modo demostración — datos de ejemplo (API no disponible)';
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 8000);
}

function showOverlay(msg) {
  const el = document.getElementById('overlay');
  el.innerHTML = `<div class="spinner"></div><p>${escHtml(msg)}</p>`;
  el.classList.remove('hidden');
}
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }
function showError(title, detail) {
  const el = document.getElementById('overlay');
  el.innerHTML = `<div class="error-box">
    <h2>${escHtml(title)}</h2>
    <p>${escHtml(detail)}</p>
    <button class="btn" onclick="hideOverlay()">Cerrar y ver demo</button>
  </div>`;
  el.classList.remove('hidden');
}

window.addEventListener('DOMContentLoaded', async () => {
  initMap();
  await loadGeoJSON();
  setTimeout(loadData, 400);
});
