"""Download Vergely+ 2022 dust cube, downsample, ship as uint8 binary.

Source: J/A+A/664/A174 (CDS) — Galactic interstellar dust Gaia-2MASS 3D maps.
  X → galactic center, Y → rotation, Z → NGP. Units: parsecs.
  Values: extinction density at 550 nm in nanomagnitude per parsec.

Writes:
  data/dust_cube.bin    — uint8 raw, shape (nz, ny, nx), C-order, x fastest
  data/dust_cube.json   — shape, voxel size (pc), world extent (pc),
                          log-clip range used for [0,1] normalize.
"""
from __future__ import annotations
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from astropy.io import fits
from scipy.ndimage import zoom

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / "data" / "raw"
OUT_BIN = ROOT / "data" / "dust_cube.bin"
OUT_META = ROOT / "data" / "dust_cube.json"

# 010pc cube: 601 x 601 x 161 voxels over 3 x 3 x 0.8 kpc, ~5 pc pitch.
SOURCE_URL = (
    "https://cdsarc.cds.unistra.fr/ftp/J/A+A/664/A174/"
    "fits/explore_cube_density_values_010pc_v2.fits"
)
RAW_FILE = RAW_DIR / "vergely2022_010pc.fits"

# Target dims for the shipped cube. X/Y get heavy downsampling, Z less.
TARGET_NX = 128
TARGET_NY = 128
TARGET_NZ = 32

# Density spans ~1e-5 to 6e-2 nmag/pc, so log10 with a small epsilon floor.
# Lo = median (mostly diffuse background → black); hi = 99.5-pct (cloud cores
# saturate to full brightness). Anything below lo clips to zero.
DENSITY_EPS = 1e-5
LOG_CLIP_LO_PCT = 50.0
LOG_CLIP_HI_PCT = 99.5


def download_if_missing() -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    if RAW_FILE.exists():
        print(f"[skip download] {RAW_FILE} ({RAW_FILE.stat().st_size/1e6:.0f} MB)")
        return RAW_FILE
    print(f"[download] {SOURCE_URL}\n  -> {RAW_FILE}")
    with urllib.request.urlopen(SOURCE_URL) as r, open(RAW_FILE, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        read = 0
        while chunk := r.read(1 << 20):
            f.write(chunk)
            read += len(chunk)
            if total:
                sys.stdout.write(f"\r  {read/1e6:7.1f} / {total/1e6:.0f} MB")
                sys.stdout.flush()
        sys.stdout.write("\n")
    return RAW_FILE


def load_cube(path: Path):
    with fits.open(path, memmap=True) as hdul:
        hdu = hdul[0]
        data = np.asarray(hdu.data, dtype=np.float32)  # shape (NZ, NY, NX)
        hdr = hdu.header
        nx, ny, nz = hdr["NAXIS1"], hdr["NAXIS2"], hdr["NAXIS3"]
        # Vergely header is non-WCS: STEP = voxels-per-pc, SUN_POSn = 1-indexed
        # pixel position of the Sun. World coord of 0-indexed voxel i along
        # axis n: (i - (SUN_POSn - 1)) * STEP.
        step = float(hdr["STEP"])
        sx, sy, sz = float(hdr["SUN_POSX"]) - 1, float(hdr["SUN_POSY"]) - 1, float(hdr["SUN_POSZ"]) - 1
        wx = lambda i: (i - sx) * step
        wy = lambda i: (i - sy) * step
        wz = lambda i: (i - sz) * step
        extent_pc = {
            "x": [wx(-0.5), wx(nx - 0.5)],
            "y": [wy(-0.5), wy(ny - 0.5)],
            "z": [wz(-0.5), wz(nz - 0.5)],
        }
        voxel_pc = [step, step, step]
    print(f"[load] shape={data.shape} extent_pc={extent_pc} voxel_pc={voxel_pc}")
    return data, extent_pc, voxel_pc


def build():
    raw = download_if_missing()
    data, extent_pc, voxel_pc = load_cube(raw)

    # Vergely density can be very faintly negative due to inversion noise.
    data = np.clip(data, 0.0, None)
    log_d = np.log10(data + DENSITY_EPS)

    lo = float(np.percentile(log_d, LOG_CLIP_LO_PCT))
    hi = float(np.percentile(log_d, LOG_CLIP_HI_PCT))
    norm = np.clip((log_d - lo) / (hi - lo), 0.0, 1.0)
    print(f"[norm] log10-clip [{lo:.3f} .. {hi:.3f}]  zero-fraction={(norm==0).mean():.3f}")

    nz, ny, nx = norm.shape
    zoom_factors = (TARGET_NZ / nz, TARGET_NY / ny, TARGET_NX / nx)
    print(f"[downsample] {norm.shape} -> {(TARGET_NZ, TARGET_NY, TARGET_NX)}")
    small = zoom(norm, zoom_factors, order=1, mode="nearest")
    small = np.clip(small, 0.0, 1.0)

    quant = (small * 255.0 + 0.5).astype(np.uint8)
    OUT_BIN.write_bytes(quant.tobytes(order="C"))
    print(f"[write] {OUT_BIN} ({OUT_BIN.stat().st_size/1024:.1f} KB)")

    meta = {
        "shape": [TARGET_NX, TARGET_NY, TARGET_NZ],  # x, y, z (axis order in bin)
        "dtype": "uint8",
        "extent_pc": extent_pc,  # half-open voxel-edge bounds, NOT centers
        "source_voxel_pc": voxel_pc,
        "log_norm": {"fn": "log10", "eps": DENSITY_EPS, "clip_lo": lo, "clip_hi": hi},
        "source": "Vergely+ 2022 (J/A+A/664/A174) explore_cube_density_values_010pc_v2",
        "frame": "vergely_xyz",
        "frame_note": "+X galactic center, +Y rotation, +Z NGP. App's +Y is anti-rotation, so flip Y in shader.",
    }
    OUT_META.write_text(json.dumps(meta, indent=2))
    print(f"[write] {OUT_META}")


if __name__ == "__main__":
    build()
