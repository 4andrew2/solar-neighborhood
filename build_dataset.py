"""Build data/stars.json from three sources:
  • curated 102 nearest stars (re-parsed from stars.js, SIMBAD-derived)
  • GAIA DR3 — all sources with parallax > 65 mas (~within 50 ly)
  • NASA Exoplanet Archive — confirmed exoplanets (pscomppars)

The output is the single source-of-truth consumed by the frontend.
Run:  python build_dataset.py
"""
from __future__ import annotations
import json
import re
from pathlib import Path

import numpy as np
import astropy.units as u
from astropy.coordinates import SkyCoord
from astroquery.gaia import Gaia
from astroquery.ipac.nexsci.nasa_exoplanet_archive import NasaExoplanetArchive
from astroquery.vizier import Vizier

ROOT     = Path(__file__).parent
OUT_DIR  = ROOT / "data"
OUT_DIR.mkdir(exist_ok=True)
LY_PER_PC = 3.261563777


# ── 1. parse curated stars.js (already SIMBAD-resolved) ──────────────────
def load_curated() -> list[dict]:
    text = (ROOT / "stars.js").read_text()
    pat = re.compile(
        r'\{\s*name:\s*"([^"]+)"\s*,\s*'
        r'ra:\s*(-?\d+\.\d+)\s*,\s*'
        r'dec:\s*(-?\d+\.\d+)\s*,\s*'
        r'distLy:\s*(\d+\.\d+)\s*,\s*'
        r'vmag:\s*(-?\d+\.\d+)\s*,\s*'
        r'sp:\s*"([^"]*)"\s*\}'
    )
    rows = []
    for m in pat.finditer(text):
        name, ra, dec, distLy, vmag, sp = m.groups()
        rows.append({
            "name":   name,
            "ra":     float(ra),
            "dec":    float(dec),
            "distLy": float(distLy),
            "vmag":   float(vmag),
            "sp":     sp,
        })
    return rows


# ── 2. GAIA DR3 query — stars within ~50 ly ──────────────────────────────
# Primary: ESA's GAIA TAP. Fallback: VizieR mirror of GAIA DR3 (I/355/gaiadr3),
# in case ESA is down (503) or drops the connection.
def fetch_gaia(parallax_mas_min: float = 65.0) -> list[dict]:
    rows = _fetch_gaia_esa(parallax_mas_min)
    if rows is None:
        rows = _fetch_gaia_vizier(parallax_mas_min)
    return rows or []


def _fetch_gaia_esa(parallax_mas_min: float):
    query = f"""
    SELECT source_id, ra, dec, parallax, parallax_error,
           phot_g_mean_mag, bp_rp
    FROM gaiadr3.gaia_source
    WHERE parallax > {parallax_mas_min}
      AND parallax_error/parallax < 0.2
      AND phot_g_mean_mag IS NOT NULL
    """
    print(f"querying GAIA DR3 via ESA (parallax > {parallax_mas_min} mas → distance < {round(1000/parallax_mas_min*LY_PER_PC, 1)} ly)…")
    # Async TAP — sync jobs are hard-capped at 2000 rows; async returns up to 3M.
    for attempt in range(2):
        try:
            job = Gaia.launch_job_async(query)
            tbl = job.get_results()
            print(f"  → {len(tbl)} rows from ESA")
            return [_gaia_row(r, "source_id", "ra", "dec", "parallax", "phot_g_mean_mag", "bp_rp") for r in tbl]
        except Exception as exc:
            print(f"  ESA attempt {attempt+1} failed: {str(exc).splitlines()[0]}")
    print("  ESA unavailable → falling back to VizieR")
    return None


def _fetch_gaia_vizier(parallax_mas_min: float):
    print("querying GAIA DR3 via VizieR (I/355/gaiadr3)…")
    v = Vizier(
        columns=["Source", "RA_ICRS", "DE_ICRS", "Plx", "e_Plx", "Gmag", "BP-RP"],
        column_filters={"Plx": f">{parallax_mas_min}"},
        row_limit=-1,
    )
    try:
        tables = v.query_constraints(catalog="I/355/gaiadr3")
    except Exception as exc:
        print(f"  VizieR query failed: {exc}")
        return None
    if not tables:
        print("  VizieR returned no tables")
        return None
    tbl = tables[0]
    print(f"  → {len(tbl)} rows from VizieR")
    out = []
    for r in tbl:
        plx = float(r["Plx"])
        if plx <= 0:
            continue
        e_plx = float(r["e_Plx"]) if not np.ma.is_masked(r["e_Plx"]) else 0
        if e_plx > 0 and (e_plx / plx) >= 0.2:
            continue
        gmag = r["Gmag"]
        if np.ma.is_masked(gmag):
            continue
        bp_rp = r["BP-RP"]
        out.append({
            "source_id": int(r["Source"]),
            "ra":        float(r["RA_ICRS"]),
            "dec":       float(r["DE_ICRS"]),
            "distLy":    round(LY_PER_PC * 1000.0 / plx, 3),
            "vmag":      round(float(gmag), 2),
            "bp_rp":     (round(float(bp_rp), 3) if not np.ma.is_masked(bp_rp) else None),
        })
    return out


def _gaia_row(r, src_col, ra_col, dec_col, plx_col, g_col, bp_rp_col):
    plx = float(r[plx_col])
    bp_rp = r[bp_rp_col]
    return {
        "source_id": int(r[src_col]),
        "ra":        float(r[ra_col]),
        "dec":       float(r[dec_col]),
        "distLy":    round(LY_PER_PC * 1000.0 / plx, 3),
        "vmag":      round(float(r[g_col]), 2),
        "bp_rp":     (round(float(bp_rp), 3) if not np.ma.is_masked(bp_rp) else None),
    }


# ── 3. NASA Exoplanet Archive ────────────────────────────────────────────
def fetch_exoplanets() -> list[dict]:
    print("querying NASA Exoplanet Archive (pscomppars)…")
    tbl = NasaExoplanetArchive.query_criteria(
        table="pscomppars",
        select="pl_name,hostname,ra,dec,pl_orbper,pl_rade,pl_bmasse,pl_orbsmax,pl_eqt,disc_year,sy_dist",
    )
    print(f"  → {len(tbl)} confirmed planets")

    def num(v):
        if np.ma.is_masked(v):
            return None
        try:
            f = float(v.value)           # astropy Quantity
        except AttributeError:
            f = float(v)
        return None if (f != f) else f   # NaN → None (NaN is the only x where x != x)

    out = []
    for r in tbl:
        out.append({
            "pl_name":  str(r["pl_name"]),
            "hostname": str(r["hostname"]),
            "ra":       num(r["ra"]),
            "dec":      num(r["dec"]),
            "period_d": num(r["pl_orbper"]),
            "radius_e": num(r["pl_rade"]),
            "mass_e":   num(r["pl_bmasse"]),
            "sma_au":   num(r["pl_orbsmax"]),
            "eqt_k":    num(r["pl_eqt"]),
            "year":     (int(r["disc_year"]) if not np.ma.is_masked(r["disc_year"]) else None),
        })
    return out


# ── 4. cross-match curated ↔ GAIA  ───────────────────────────────────────
# Curated coords are SIMBAD J2000; GAIA is J2016. Use 60" tolerance to absorb
# proper motion for nearby high-PM stars.
def merge_curated_and_gaia(curated, gaia, match_arcsec: float = 60.0) -> list[dict]:
    if not gaia:
        return [{**c, "isCurated": True, "planets": []} for c in curated]

    g_ra  = np.array([g["ra"]  for g in gaia])
    g_dec = np.array([g["dec"] for g in gaia])
    gaia_coords = SkyCoord(g_ra * u.deg, g_dec * u.deg)

    c_ra  = np.array([c["ra"]  for c in curated])
    c_dec = np.array([c["dec"] for c in curated])
    curated_coords = SkyCoord(c_ra * u.deg, c_dec * u.deg)

    idx, sep, _ = curated_coords.match_to_catalog_sky(gaia_coords)
    matched_gaia: set[int] = set()

    stars: list[dict] = []
    for i, c in enumerate(curated):
        star = dict(c)
        star["isCurated"] = True
        star["planets"]   = []
        if sep[i].arcsecond < match_arcsec:
            j = int(idx[i])
            matched_gaia.add(j)
            g = gaia[j]
            star["bp_rp"]   = g["bp_rp"]
            star["gaia_id"] = g["source_id"]
        stars.append(star)

    n_curated_matched = len(matched_gaia)
    print(f"  → {n_curated_matched}/{len(curated)} curated stars matched to GAIA within {match_arcsec}″")

    for j, g in enumerate(gaia):
        if j in matched_gaia:
            continue
        stars.append({
            "name":      f"Gaia DR3 {g['source_id']}",
            "ra":         g["ra"],
            "dec":        g["dec"],
            "distLy":     g["distLy"],
            "vmag":       g["vmag"],
            "sp":         "",
            "bp_rp":      g["bp_rp"],
            "gaia_id":    g["source_id"],
            "isCurated":  False,
            "planets":    [],
        })
    return stars


# ── 5. attach planets by host position ───────────────────────────────────
def attach_planets(stars, planets, match_arcsec: float = 30.0) -> int:
    valid = [p for p in planets if p["ra"] is not None and p["dec"] is not None]
    if not valid:
        return 0

    s_ra  = np.array([s["ra"]  for s in stars])
    s_dec = np.array([s["dec"] for s in stars])
    star_coords = SkyCoord(s_ra * u.deg, s_dec * u.deg)

    p_ra  = np.array([p["ra"]  for p in valid])
    p_dec = np.array([p["dec"] for p in valid])
    p_coords = SkyCoord(p_ra * u.deg, p_dec * u.deg)

    idx, sep, _ = p_coords.match_to_catalog_sky(star_coords)
    attached = 0
    for i, p in enumerate(valid):
        if sep[i].arcsecond > match_arcsec:
            continue
        host_star = stars[int(idx[i])]
        host_star["planets"].append({
            "name":     p["pl_name"],
            "host":     p["hostname"],
            "period_d": p["period_d"],
            "radius_e": p["radius_e"],
            "mass_e":   p["mass_e"],
            "sma_au":   p["sma_au"],
            "eqt_k":    p["eqt_k"],
            "year":     p["year"],
        })
        attached += 1
    n_hosts = sum(1 for s in stars if s["planets"])
    print(f"  → attached {attached} planets to {n_hosts} stars (≤ {match_arcsec}″)")
    return attached


def main() -> None:
    curated = load_curated()
    print(f"loaded {len(curated)} curated stars from stars.js")

    gaia    = fetch_gaia(parallax_mas_min=13.0)
    planets = fetch_exoplanets()

    stars   = merge_curated_and_gaia(curated, gaia)
    print(f"combined: {len(stars)} stars "
          f"({sum(1 for s in stars if s['isCurated'])} curated + "
          f"{sum(1 for s in stars if not s['isCurated'])} GAIA-only)")

    attach_planets(stars, planets)

    # Slider caps at 100k visible — keep ~10% headroom so the user can reach
    # the max without the dataset being the bottleneck. Trimming here halves
    # the JSON wire size and cuts ~120k sprites the frontend would otherwise
    # build but never show.
    MAX_KEEP = 110_000
    if len(stars) > MAX_KEEP:
        before = len(stars)
        # Keep all curated (they're special-cased in the UI) + nearest GAIA.
        curated_rows = [s for s in stars if s["isCurated"]]
        gaia_rows    = [s for s in stars if not s["isCurated"]]
        gaia_rows.sort(key=lambda s: s["distLy"])
        keep_gaia    = gaia_rows[: MAX_KEEP - len(curated_rows)]
        stars = curated_rows + keep_gaia
        print(f"  trimmed {before} → {len(stars)} (curated kept, GAIA truncated by distance)")

    out = OUT_DIR / "stars.json"
    out.write_text(json.dumps(stars, separators=(",", ":"), allow_nan=False))
    n_with_planets = sum(1 for s in stars if s["planets"])
    print(f"\nwrote {out}  ({len(stars)} stars, {n_with_planets} planet hosts)")


if __name__ == "__main__":
    main()
