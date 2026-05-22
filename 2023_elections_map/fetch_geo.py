#!/usr/bin/env python3
"""
Genera tigre_circuitos.geojson descargando polígonos de Nominatim/OSM.

Uso:
    python fetch_geo.py

Output:
    tigre_circuitos.geojson
"""

import urllib.request, urllib.parse, json, time, sys
from shapely.geometry import shape, mapping, Polygon
from shapely.ops import unary_union

NOMINATIM = "https://nominatim.openstreetmap.org/search"
HEADERS   = {"User-Agent": "TigreElectoralMap/1.0 (research)"}

# Mapeo: circuito_id → lista de queries a Nominatim (se usan todos los polígonos encontrados)
# Basado en la geografía del Partido de Tigre y los IDs descubiertos del DINE.
# Tigre Centro no tiene polígono propio en OSM.
# Lo definimos manualmente con las coordenadas del área urbana (peninsula entre ríos).
TIGRE_CENTRO_MANUAL = Polygon([
    # (lng, lat)
    (-58.597, -34.418),
    (-58.581, -34.410),
    (-58.562, -34.415),
    (-58.554, -34.424),
    (-58.558, -34.437),
    (-58.571, -34.442),
    (-58.590, -34.440),
    (-58.601, -34.432),
    (-58.597, -34.418),
])

CIRCUIT_LOCALITIES = {
    "00530": [],  # se define con TIGRE_CENTRO_MANUAL, no via Nominatim
    "0534A": [
        "Benavídez, Partido de Tigre, Buenos Aires, Argentina",
        "Nordelta, Tigre, Buenos Aires, Argentina",
    ],
    "00535": [
        "Don Torcuato, Partido de Tigre, Buenos Aires, Argentina",
        "Troncos del Talar, Partido de Tigre, Buenos Aires, Argentina",
    ],
    "00534": [
        "El Talar, Buenos Aires Province, Argentina",
    ],
    "00536": [
        "General Pacheco, Partido de Tigre, Buenos Aires, Argentina",
    ],
    "0535A": [
        "Ricardo Rojas, Partido de Tigre, Buenos Aires, Argentina",
    ],
    "0536A": [
        "Rincón de Milberg, Partido de Tigre, Buenos Aires, Argentina",
    ],
    "00533": [
        "Dique Luján, Partido de Tigre, Buenos Aires, Argentina",
    ],
}

CIRCUIT_NAMES = {
    "00530": "Tigre Centro",
    "0534A": "Benavídez",
    "00535": "Don Torcuato",
    "00534": "El Talar",
    "00536": "General Pacheco",
    "0535A": "Ricardo Rojas",
    "0536A": "Rincón de Milberg",
    "00533": "Dique Luján",
}


def fetch_polygon(query: str) -> list[dict] | None:
    """Descarga el primer polígono disponible para la query dada."""
    url = (f"{NOMINATIM}?q={urllib.parse.quote(query)}"
           f"&format=geojson&polygon_geojson=1&limit=3")
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
    except Exception as e:
        print(f"    ERROR fetching '{query}': {e}")
        return None

    features = data.get("features", [])
    polygons = [
        f for f in features
        if f["geometry"]["type"] in ("Polygon", "MultiPolygon")
    ]
    return polygons or None


def build_geojson(all_features: list[dict]) -> dict:
    return {
        "type": "FeatureCollection",
        "features": all_features,
    }


def main():
    print("Descargando polígonos de Nominatim/OSM...")
    print("(1 segundo entre requests — límite de rate de Nominatim)\n")

    all_features = []
    seen_osm_ids = set()

    for cid, queries in CIRCUIT_LOCALITIES.items():
        print(f"  Circuito {cid} — {CIRCUIT_NAMES[cid]}")
        circuit_features = []

        for query in queries:
            polygons = fetch_polygon(query)
            time.sleep(1.1)

            if not polygons:
                print(f"    ✗ Sin polígono: {query!r}")
                continue

            for poly in polygons:
                osm_id = poly["properties"].get("osm_id")
                if osm_id in seen_osm_ids:
                    continue
                seen_osm_ids.add(osm_id)

                name = poly["properties"].get("display_name", "").split(",")[0].strip()
                print(f"    ✓ {poly['geometry']['type']:15s} {name} (osm_id={osm_id})")

                circuit_features.append({
                    "type": "Feature",
                    "properties": {
                        "circuito_id": cid,
                        "nombre":      CIRCUIT_NAMES[cid],
                        "localidad":   name,
                        "osm_id":      osm_id,
                    },
                    "geometry": poly["geometry"],
                })

        if not circuit_features:
            print(f"    ⚠ Sin datos para circuito {cid} — se omite")
        else:
            all_features.extend(circuit_features)
        print()

    # Tigre Centro (00530): agregar el polígono manual (la ciudad, sin el delta)
    print("─── Agregando Tigre Centro (polígono manual del área urbana) ───")
    all_features.append({
        "type": "Feature",
        "properties": {
            "circuito_id": "00530",
            "nombre":      "Tigre Centro",
            "localidad":   "Tigre Centro (manual)",
            "osm_id":      None,
        },
        "geometry": mapping(TIGRE_CENTRO_MANUAL),
    })
    print(f"  ✓ Tigre Centro — centroide ({TIGRE_CENTRO_MANUAL.centroid.y:.3f}, {TIGRE_CENTRO_MANUAL.centroid.x:.3f})")

    geojson = build_geojson(all_features)

    with open("tigre_circuitos.geojson", "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False, separators=(",", ":"))

    print(f"\n→ tigre_circuitos.geojson  ({len(all_features)} features, "
          f"{len(set(f['properties']['circuito_id'] for f in all_features))} circuitos)")


if __name__ == "__main__":
    main()
