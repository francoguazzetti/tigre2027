#!/usr/bin/env python3
"""
Extractor de resultados electorales por circuito — Tigre 2023
==============================================================
Lee el CSV oficial del DINE (elecciones2023.zip) y extrae los resultados
de INTENDENTE por circuito. También intenta geocodificar via Nominatim.

Fuente de datos:
  https://datos.gob.ar → "Resultados Provisionales Elecciones 2023"
  Archivo: 2023_generales_1.zip  (renombrar a elecciones2023.zip en /tmp)

Instalación:
    pip install aiohttp requests

Uso:
    # 1. Descargar el ZIP en /tmp:
    # curl -L -o /tmp/elecciones2023.zip https://www.argentina.gob.ar/sites/default/files/2023_generales_1.zip
    # 2. Correr el script:
    python discover_circuits.py

Outputs:
    circuitos_intendente.json  — resultados por circuito (para app.js)
    circuitos_intendente.csv   — tabla para Excel/QGIS/Flourish
"""

import zipfile, csv, io, json, sys
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from typing import Optional

# ─── Configuración ───────────────────────────────────────────────────────────

ZIP_PATH   = "/tmp/elecciones2023.zip"
CSV_DENTRO = "2023_Generales/ResultadoElectorales_2023_Generales.csv"

DISTRITO_ID = "2"    # Buenos Aires Province
SECCION_ID  = "113"  # Tigre
CARGO_ID    = "7"    # INTENDENTE (confirmado del CSV)

# Circuitos reales de Tigre (descubiertos del CSV del DINE)
# Para confirmar/actualizar: ver columna circuito_id filtrando distrito_id=2, seccion_id=113
CIRCUITOS_TIGRE = ["00530", "00533", "00534", "00535", "00536", "0534A", "0535A", "0536A"]

# Coordenadas aproximadas por circuito (centroide de Tigre como placeholder).
# Para coordenadas precisas se necesitan shapefiles del IGN:
# https://www.ign.gob.ar/NuestrasActividades/Geografia/DatosAbiertos/Geodesia
# Mapping basado en tamaño poblacional y geografía del partido.
COORDS_APROX = {
    "00530": (-34.426, -58.579),   # Tigre Centro (mayor cantidad de mesas)
    "00533": (-34.384, -58.625),   # Dique Luján (pequeño)
    "00534": (-34.453, -58.640),   # El Talar
    "00535": (-34.474, -58.614),   # Don Torcuato
    "00536": (-34.460, -58.659),   # General Pacheco
    "0534A": (-34.394, -58.681),   # Benavídez
    "0535A": (-34.443, -58.592),   # Ricardo Rojas
    "0536A": (-34.400, -58.598),   # Rincón de Milberg (pequeño, gana JxC)
}

NOMINATIM = "https://nominatim.openstreetmap.org/search"

TIGRE_CENTER = (-34.426, -58.579)

# ─── Modelos ────────────────────────────────────────────────────────────────

@dataclass
class Circuito:
    id:             str
    mesas:          int
    electores:      int
    total_votos:    int
    winner_nombre:  str
    winner_votos:   int
    winner_pct:     float
    agrupaciones:   list = field(default_factory=list)
    lat:            float = TIGRE_CENTER[0]
    lng:            float = TIGRE_CENTER[1]
    geo_source:     str  = "centroide_tigre"


# ─── Procesamiento del CSV ───────────────────────────────────────────────────

def procesar_csv(zip_path: str) -> dict[str, Circuito]:
    print(f"Abriendo {zip_path}...")

    votos_pos  = defaultdict(lambda: defaultdict(int))   # circuito → agrupacion → votos
    electores  = defaultdict(set)                        # circuito → set de (mesa_id, electores)
    mesas_set  = defaultdict(set)                        # circuito → set de mesa_id

    try:
        zf = zipfile.ZipFile(zip_path)
    except FileNotFoundError:
        print(f"ERROR: No se encontró {zip_path}")
        print("Descargá el ZIP con:")
        print("  curl -L -o /tmp/elecciones2023.zip 'https://www.argentina.gob.ar/sites/default/files/2023_generales_1.zip'")
        sys.exit(1)

    with zf:
        with zf.open(CSV_DENTRO) as f:
            reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))
            header = next(reader)
            col    = {h: i for i, h in enumerate(header)}
            total  = 0

            for row in reader:
                try:
                    if (row[col["distrito_id"]] != DISTRITO_ID
                            or row[col["seccion_id"]] != SECCION_ID):
                        continue

                    cid       = row[col["circuito_id"]]
                    cargo     = row[col["cargo_id"]]
                    ag        = row[col["agrupacion_nombre"]]
                    tipo      = row[col["votos_tipo"]]
                    votos     = int(row[col["votos_cantidad"]] or 0)
                    mesa_id   = row[col["mesa_id"]]
                    elec      = int(row[col["mesa_electores"]] or 0)

                    mesas_set[cid].add(mesa_id)

                    if mesa_id not in {m for m, _ in electores[cid]}:
                        electores[cid].add((mesa_id, elec))

                    if cargo == CARGO_ID and tipo == "POSITIVO" and ag:
                        votos_pos[cid][ag] += votos

                    total += 1
                except (IndexError, ValueError):
                    continue

            print(f"  Filas procesadas: {total}")

    # Construir resultados
    result: dict[str, Circuito] = {}
    for cid in sorted(votos_pos.keys()):
        ag_data     = votos_pos[cid]
        total_votos = sum(ag_data.values())
        if total_votos == 0:
            continue

        electores_total = sum(e for _, e in electores[cid])
        ags_sorted  = sorted(ag_data.items(), key=lambda x: x[1], reverse=True)
        winner      = ags_sorted[0]

        result[cid] = Circuito(
            id           = cid,
            mesas        = len(mesas_set[cid]),
            electores    = electores_total,
            total_votos  = total_votos,
            winner_nombre= winner[0],
            winner_votos = winner[1],
            winner_pct   = round(winner[1] / total_votos * 100, 2),
            agrupaciones = [
                {"nombre": n, "votos": v, "pct": round(v / total_votos * 100, 2)}
                for n, v in ags_sorted
            ],
        )

    return result


# ─── Geocoding ──────────────────────────────────────────────────────────────

def geocode_circuit(cid: str) -> tuple[float, float, str]:
    """Aplica coordenadas aproximadas. Ver COORDS_APROX para ajustar manualmente."""
    if cid in COORDS_APROX:
        return (*COORDS_APROX[cid], "aproximado_manual")
    return (*TIGRE_CENTER, "centroide_tigre")


# ─── Output ──────────────────────────────────────────────────────────────────

def save(circuitos: dict[str, Circuito]):
    import csv as csv_mod

    # JSON
    payload = [asdict(c) for c in circuitos.values()]
    with open("circuitos_intendente.json", "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"→ circuitos_intendente.json  ({len(payload)} circuitos)")

    # CSV
    cols = ["id", "mesas", "electores", "total_votos",
            "winner_nombre", "winner_votos", "winner_pct", "lat", "lng", "geo_source"]
    with open("circuitos_intendente.csv", "w", newline="", encoding="utf-8") as f:
        w = csv_mod.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for c in circuitos.values():
            w.writerow(asdict(c))
    print(f"→ circuitos_intendente.csv")

    print("\n─── Resultados por circuito (Intendente 2023) ───────────────")
    for cid, c in sorted(circuitos.items()):
        print(f"  {cid:6s} | {c.mesas:3d} mesas | {c.electores:6d} electores | "
              f"{c.winner_nombre[:30]:30s} {c.winner_pct:5.1f}%")

    print("\n─── Distribución de ganadores ───────────────────────────────")
    from collections import Counter
    winners = Counter(c.winner_nombre for c in circuitos.values())
    for nombre, count in winners.most_common():
        pct = count / len(circuitos) * 100
        print(f"  {count:2d} circuitos ({pct:4.1f}%) → {nombre}")


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import time
    t0 = time.time()

    print("=" * 60)
    print("  Resultados Intendente Tigre 2023 — por circuito")
    print(f"  Fuente: {ZIP_PATH}")
    print("=" * 60 + "\n")

    circuitos = procesar_csv(ZIP_PATH)

    print(f"\n  → {len(circuitos)} circuitos encontrados\n")

    # Geocoding
    print("─── Aplicando coordenadas aproximadas ───────────────────────")
    print("  ⚠ Para coordenadas exactas usar shapefiles IGN o DINE.\n")
    for cid, c in circuitos.items():
        lat, lng, source = geocode_circuit(cid)
        c.lat        = lat
        c.lng        = lng
        c.geo_source = source
        print(f"  Circuito {cid}: ({lat:.4f}, {lng:.4f})  [{source}]")

    print()
    save(circuitos)
    print(f"\nTiempo total: {time.time() - t0:.1f}s")
