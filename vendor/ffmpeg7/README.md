# Vendored FFmpeg 7 runtime libraries (for NDI|HX decode)

NDI's HX (H.264/H.265) decoder `dlopen()`s FFmpeg 7's `libavcodec.so.61` /
`libavutil.so.59`. Ubuntu 24.04 ships only FFmpeg 6 (`libavcodec.so.60`), so
without these NDI shows a "Video decoder not found" placeholder instead of the
camera video. See the NDI section of the top-level `README.md`.

## Layout

```
vendor/ffmpeg7/
  x86_64/     ← FFmpeg 7 .so.* for Intel N97 (committed)
  aarch64/    ← FFmpeg 7 .so.* for Rockchip RK3588 (add when NDI|HX is needed there)
```

Each arch folder holds **only the fully-versioned real `.so` files** (e.g.
`libavcodec.so.61.19.101`, `libavutil.so.59.39.100`, …) — **not** the SONAME
symlinks (`libavcodec.so.61`) or the unversioned dev symlink (`libavcodec.so`),
and no headers.

> **Why real files only:** `migrations/0002` copies these into `/usr/local/lib`
> and runs `ldconfig`, which reads each file's SONAME and creates the
> `libavcodec.so.61 → …61.19.101` symlinks itself. If we also shipped our own
> non-symlink copy at the SONAME path, `ldconfig` warns "is not a symbolic link"
> and registers the libs non-deterministically — a fresh box then fails `0002`
> on the first attempt (it only self-heals on the retry). Ship real files; let
> `ldconfig` make the links.

## How these were produced

`../../build-ffmpeg7-libs.sh`, run on a machine of the target architecture. It
builds FFmpeg `release/7.1` (`--enable-shared --disable-static`) and stages the
versioned `.so` files here.

## How they get installed

`migrations/0002-ndi-hx-ffmpeg7.sh` copies `vendor/ffmpeg7/$(uname -m)/*.so.*`
into `/usr/local/lib` and runs `ldconfig` — alongside the system FFmpeg 6, which
GStreamer still uses (different SONAME, no conflict).

## Adding a new architecture later

1. Run `build-ffmpeg7-libs.sh` on a box of that arch.
2. Commit the new `vendor/ffmpeg7/<arch>/` files.
3. Add a **new** migration (e.g. `0003-…`) to install them — do not edit `0002`,
   which is already recorded as applied on existing devices.
