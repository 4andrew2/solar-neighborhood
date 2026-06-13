"""Fetch precise coordinates/parallax/spectral types from SIMBAD for the
hand-curated star list, then emit `stars.js` with the cleaned-up data.

Run:  python fetch_stars.py
"""
from __future__ import annotations
import json
import re
import sys
import time
from pathlib import Path

from astropy import units as u
from astropy.coordinates import SkyCoord
from astroquery.simbad import Simbad

# ── input: name → (alias for SIMBAD lookup, fallback display name) ──────
# The "lookup" name is what we send to SIMBAD; the "display" name is what we
# render in the UI (preserves friendly names like "Alpha Centauri A").
STARS: list[tuple[str, str]] = [
    ("Proxima Centauri",      "Proxima Centauri"),
    ("Alpha Centauri A",      "Alf Cen A"),
    ("Alpha Centauri B",      "Alf Cen B"),
    ("Barnard's Star",        "Barnard star"),
    ("Wolf 359",              "Wolf 359"),
    ("Lalande 21185",         "Lalande 21185"),
    ("Sirius A",              "Sirius A"),
    ("Sirius B",              "Sirius B"),
    ("Luyten 726-8 A (BL Cet)",  "BL Cet"),
    ("Luyten 726-8 B (UV Cet)",  "UV Cet"),
    ("Ross 154",              "Ross 154"),
    ("Ross 248",              "Ross 248"),
    ("Epsilon Eridani",       "* eps Eri"),
    ("Lacaille 9352",         "Lacaille 9352"),
    ("Ross 128",              "Ross 128"),
    ("EZ Aquarii A",          "GJ 866 A"),
    ("EZ Aquarii B",          "GJ 866 B"),
    ("EZ Aquarii C",          "GJ 866 C"),
    ("Procyon A",             "Procyon A"),
    ("Procyon B",             "Procyon B"),  # vmag/sp via MANUAL
    ("61 Cygni A",            "* 61 Cyg A"),
    ("61 Cygni B",            "* 61 Cyg B"),
    ("Struve 2398 A (GJ 725 A)", "GJ 725 A"),
    ("Struve 2398 B (GJ 725 B)", "GJ 725 B"),
    ("Groombridge 34 A",      "GX And"),
    ("Groombridge 34 B",      "GQ And"),
    ("Epsilon Indi",          "* eps Ind"),
    ("DX Cancri",             "DX Cnc"),
    ("Tau Ceti",              "* tau Cet"),
    ("GJ 1061",               "GJ 1061"),
    ("YZ Ceti",               "YZ Cet"),
    ("Luyten's Star",         "GJ 273"),
    ("Teegarden's Star",      "GAT 1370"),
    ("Kapteyn's Star",        "Kapteyn Star"),
    ("Lacaille 8760",         "Lacaille 8760"),
    ("Kruger 60 A",           "GJ 860 A"),
    ("Kruger 60 B",           "GJ 860 B"),
    ("DEN 1048-3956",         "DENIS J1048.0-3956"),
    ("Ross 614 A",            "GJ 234 A"),
    ("Ross 614 B",            "GJ 234 B"),
    ("Wolf 1061",             "Wolf 1061"),
    ("van Maanen's Star",     "GJ 35"),
    ("Gliese 1",              "GJ 1"),
    ("Wolf 424 A",            "GJ 473 A"),
    ("Wolf 424 B",            "GJ 473 B"),
    ("TZ Arietis",            "TZ Ari"),
    ("Gliese 687",            "GJ 687"),
    ("LHS 292",               "LHS 292"),
    ("Gliese 674",            "GJ 674"),
    ("GJ 1245 A",             "GJ 1245 A"),
    ("GJ 1245 B",             "GJ 1245 B"),
    ("Gliese 440 (LP 145-141)", "GJ 440"),
    ("Gliese 876",            "GJ 876"),
    ("LHS 288",               "LHS 288"),
    ("Gliese 412 A",          "GJ 412 A"),
    ("Gliese 412 B (WX UMa)", "WX UMa"),
    ("Groombridge 1618",      "GJ 380"),
    ("AD Leonis",             "AD Leo"),
    ("Gliese 832",            "GJ 832"),
    ("Gliese 682",            "GJ 682"),
    ("40 Eridani A (Keid)",   "HD 26965"),
    ("40 Eridani B",          "HD 26976"),
    ("40 Eridani C",          "GJ 166 C"),
    ("EV Lacertae",           "EV Lac"),
    ("70 Ophiuchi A",         "* 70 Oph A"),
    ("70 Ophiuchi B",         "* 70 Oph B"),
    ("Altair",                "* alf Aql"),

    # v2 additions
    ("Luhman 16 A (WISE 1049-5319 A)", "WISE J104915.57-531906.1A"),
    ("Luhman 16 B (WISE 1049-5319 B)", "WISE J104915.57-531906.1B"),
    ("WISE 0855-0714",        "WISE J085510.83-071442.5"),
    ("SCR 1845-6357 A",       "SCR J1845-6357"),
    ("SCR 1845-6357 B",       "SCR J1845-6357 B"),
    ("UGPS J0722-05",         "UGPS J072227.51-054031.2"),
    ("Gliese 1002",           "GJ 1002"),
    ("DENIS 0255-4700",       "DENIS-P J025503.3-470049"),
    ("Gliese 251",            "GJ 251"),
    ("Stein 2051 A",          "GJ 169.1 A"),
    ("Stein 2051 B",          "GJ 169.1 B"),
    ("2MASS J1835+3259",      "2MASS J18353790+3259545"),
    ("HD 36395 (Gliese 205)", "HD 36395"),
    ("LHS 1723",              "LHS 1723"),
    ("Sigma Draconis (Alsafi)", "* sig Dra"),
    ("Gliese 588",            "GJ 588"),
    ("Gliese 570 A",          "GJ 570 A"),
    ("Gliese 570 B",          "GJ 570 B"),
    ("Gliese 570 C",          "GJ 570 C"),
    ("Eta Cassiopeiae A (Achird)", "* eta Cas A"),
    ("Eta Cassiopeiae B",     "* eta Cas B"),
    ("36 Ophiuchi A",         "* 36 Oph A"),
    ("36 Ophiuchi B",         "* 36 Oph B"),
    ("YZ Canis Minoris (Gliese 285)", "YZ CMi"),
    ("82 G. Eridani (HD 20794)", "HD 20794"),
    ("Gliese 783 A (HR 7703)", "HD 191408"),
    ("Gliese 783 B",          "GJ 783 B"),
    ("Delta Pavonis",         "* del Pav"),
    ("EQ Pegasi A",           "GJ 896 A"),
    ("EQ Pegasi B",           "GJ 896 B"),
    ("Wolf 630 (Gliese 644) A", "GJ 644 A"),
    ("Wolf 630 (Gliese 644) B", "GJ 644 B"),
    ("Gliese 581",            "GJ 581"),
    ("Xi Bootis A",           "* xi Boo A"),
    ("Xi Bootis B",           "* xi Boo B"),
]

# Last-resort manual data for objects SIMBAD can't resolve under those
# names (fallback used only if every SIMBAD attempt fails for that row).
MANUAL: dict[str, dict] = {
    "WISE 0855-0714":      dict(ra=133.78624, dec=-7.24407, distLy=7.27,  vmag=25.0,  sp="Y4"),
    "Luhman 16 A (WISE 1049-5319 A)": dict(ra=162.3284, dec=-53.3187, distLy=6.516, vmag=23.25, sp="L7.5"),
    "Luhman 16 B (WISE 1049-5319 B)": dict(ra=162.3284, dec=-53.3187, distLy=6.516, vmag=24.07, sp="T0.5"),
    "UGPS J0722-05":       dict(ra=110.5304, dec=-5.4053, distLy=13.43, vmag=24.5,  sp="T9"),
    "DENIS 0255-4700":     dict(ra=43.7754,  dec=-47.0086, distLy=16.20, vmag=22.92, sp="L9"),
    "2MASS J1835+3259":    dict(ra=278.7562, dec=32.9913, distLy=18.55, vmag=18.27, sp="M8.5V"),
    "SCR 1845-6357 B":     dict(ra=281.4628, dec=-63.9569, distLy=12.571, vmag=19.5,  sp="T6"),
    "Procyon B":           dict(ra=114.82743, dec=5.22483, distLy=11.4022, vmag=10.70, sp="DQZ"),
    "Ross 614 B":          dict(ra=99.5417,  dec=-2.8054,  distLy=13.349,  vmag=14.23, sp="M5.5V"),
    "Gliese 783 B":        dict(ra=303.0937, dec=-36.8521, distLy=19.91,   vmag=14.0,  sp="M4V"),
}

LY_PER_PC = 3.261563777


def setup_simbad() -> Simbad:
    s = Simbad()
    s.TIMEOUT = 60
    s.add_votable_fields("parallax", "sptype", "flux(V)")
    return s


def parse_row(row) -> dict | None:
    """Modern SIMBAD: ra/dec already decimal-degrees, lowercase column names."""
    try:
        cols = row.colnames
        ra_v  = row["ra"]  if "ra"  in cols else row["RA"]
        dec_v = row["dec"] if "dec" in cols else row["DEC"]
        ra_deg  = float(ra_v)
        dec_deg = float(dec_v)
        plx_key = "plx_value" if "plx_value" in cols else "PLX_VALUE"
        plx_mas = float(row[plx_key]) if not _is_masked(row[plx_key]) else None
        sp_key  = "sp_type" if "sp_type" in cols else "SP_TYPE"
        sp      = str(row[sp_key]).strip() or "?"
        v_key   = "V" if "V" in cols else ("FLUX_V" if "FLUX_V" in cols else None)
        vmag    = float(row[v_key]) if v_key and not _is_masked(row[v_key]) else None
        return dict(ra=ra_deg, dec=dec_deg, plx_mas=plx_mas, sp=sp, vmag=vmag)
    except Exception as exc:
        print(f"  parse error: {exc}", file=sys.stderr)
        return None


def _is_masked(value) -> bool:
    import numpy as np
    try:
        return bool(np.ma.is_masked(value))
    except Exception:
        return value is None


def query_one(simbad: Simbad, query_name: str, retries: int = 2) -> dict | None:
    for attempt in range(retries + 1):
        try:
            tbl = simbad.query_object(query_name)
            if tbl is None or len(tbl) == 0:
                return None
            return parse_row(tbl[0])
        except Exception as exc:
            print(f"  attempt {attempt+1} failed for {query_name!r}: {exc}", file=sys.stderr)
            time.sleep(1.0 + attempt)
    return None


def main() -> None:
    simbad = setup_simbad()
    rows: list[dict] = []
    failures: list[str] = []

    for display_name, lookup in STARS:
        print(f"→ {display_name:42s}  ({lookup})")
        data = query_one(simbad, lookup)
        if data is None:
            print("   ✗ SIMBAD miss; trying manual fallback")
            if display_name in MANUAL:
                m = MANUAL[display_name]
                rows.append(dict(name=display_name, **m, source="manual"))
                continue
            failures.append(display_name)
            continue

        # convert parallax → distance(ly)
        plx = data["plx_mas"]
        distLy = LY_PER_PC * 1000.0 / plx if plx and plx > 0 else None
        if distLy is None:
            # fallback distance from manual list if SIMBAD has no parallax
            if display_name in MANUAL:
                distLy = MANUAL[display_name]["distLy"]
            else:
                print("   ✗ no parallax + no manual fallback")
                failures.append(display_name)
                continue

        vmag = data["vmag"] if data["vmag"] is not None else (
            MANUAL.get(display_name, {}).get("vmag", 99.0)
        )
        sp = data["sp"] if data["sp"] and data["sp"] != "?" else (
            MANUAL.get(display_name, {}).get("sp", "?")
        )
        rows.append(dict(
            name=display_name,
            ra=round(data["ra"], 5),
            dec=round(data["dec"], 5),
            distLy=round(distLy, 3),
            vmag=round(vmag, 2),
            sp=sp,
            source="simbad",
        ))
        time.sleep(0.15)

    print()
    print(f"resolved: {len(rows)} / {len(STARS)}")
    if failures:
        print("unresolved:")
        for f in failures:
            print(f"  - {f}")

    # emit stars.js
    out = Path(__file__).parent / "stars.js"
    lines = [
        "// Auto-generated by fetch_stars.py — values from SIMBAD (J2000).",
        "// Fields: name, RA/Dec (decimal degrees), distLy, vmag (apparent V), sp (spectral type)",
        "export const STARS = [",
    ]
    for r in rows:
        lines.append(
            f'  {{ name: {json.dumps(r["name"])}, '
            f'ra: {r["ra"]:>9.5f}, dec: {r["dec"]:>9.5f}, '
            f'distLy: {r["distLy"]:>7.3f}, vmag: {r["vmag"]:>6.2f}, '
            f'sp: {json.dumps(r["sp"])} }},'
        )
    lines.append("];")
    out.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {out}  ({len(rows)} stars)")


if __name__ == "__main__":
    main()
