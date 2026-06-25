"""Edge flood-fill background remover.

Removes the near-white background of MAGIDB art while preserving white
pixels enclosed inside a *large* shape (e.g. the seal's white body). Small
enclosed near-white blobs -- letter counters (the holes in O/C/a/e/g/D ...)
and stray star speckles -- are removed too, so no white dots survive on a
dark background. The anti-aliased ring is feathered and colour-decontaminated
so the edge takes the foreground colour instead of a white halo, then the
result is auto-cropped to content.
"""
import sys
import numpy as np
from PIL import Image
from scipy import ndimage


def remove_bg(src, dst, *, white_hard=32, keep_big_frac=0.03,
              feather_lo=24, feather_hi=115, dilate=4, decontam=True,
              max_dim=None, pad=0):
    im = Image.open(src).convert("RGBA")
    arr = np.array(im).astype(np.float32)
    rgb = arr[..., :3]
    alpha = arr[..., 3].copy()
    H, W = rgb.shape[:2]

    # Distance from pure white: 0 = white, large = saturated colour.
    dist = np.sqrt(((255.0 - rgb) ** 2).sum(axis=2))

    # 1) Background = border-connected near-white (the outer background) PLUS
    #    every *small* enclosed near-white blob (letter counters, star
    #    speckles). A large enclosed white region is preserved -- so a white
    #    belly stays solid while the hole inside an "O" becomes transparent.
    near_white = dist < white_hard
    labels, n = ndimage.label(near_white)
    if n:
        sizes = np.bincount(labels.ravel(), minlength=n + 1)
        border = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
        border_ids = np.unique(border)
        keep_big = keep_big_frac * H * W
        is_bg = sizes <= keep_big          # small blobs anywhere -> background
        is_bg[border_ids] = True           # outer background, any size
        is_bg[0] = False                   # label 0 = non-white pixels (keep last)
        bg = is_bg[labels]
    else:
        bg = np.zeros((H, W), bool)

    # 2) Feather the anti-aliased ring just inside the cut so no white halo
    #    survives. In a few-px band around bg, alpha scales with "colourfulness".
    zone = ndimage.binary_dilation(bg, iterations=dilate)
    soft = np.clip((dist - feather_lo) / (feather_hi - feather_lo), 0.0, 1.0)

    out_alpha = alpha.copy()
    out_alpha[zone] = np.minimum(out_alpha[zone], soft[zone] * 255.0)
    out_alpha[bg] = 0.0

    # 3) Colour-decontaminate the partial-alpha ring: un-premultiply the white
    #    background (C = a*F + (1-a)*255) so the fringe takes the foreground
    #    colour F instead of a white tint.
    out_rgb = rgb.copy()
    if decontam:
        m = zone & (out_alpha > 6) & (out_alpha < 250)
        af = (out_alpha[m] / 255.0)[..., None]
        F = (rgb[m] - (1.0 - af) * 255.0) / np.clip(af, 0.05, None)
        out_rgb[m] = np.clip(F, 0.0, 255.0)

    out = np.dstack([out_rgb, out_alpha]).astype(np.uint8)
    out_img = Image.fromarray(out, "RGBA")

    # 4) Auto-crop to the opaque bounding box (+ optional padding).
    bbox = out_img.getbbox()
    if bbox:
        l, t, r, b = bbox
        l = max(0, l - pad); t = max(0, t - pad)
        r = min(out_img.width, r + pad); b = min(out_img.height, b + pad)
        out_img = out_img.crop((l, t, r, b))

    # 5) Optional downscale (high-quality) to cap bundle size.
    if max_dim and max(out_img.size) > max_dim:
        s = max_dim / max(out_img.size)
        out_img = out_img.resize(
            (round(out_img.width * s), round(out_img.height * s)), Image.LANCZOS)

    out_img.save(dst)
    pct = 100.0 * (out_alpha < 4).sum() / out_alpha.size
    print(f"{src} -> {dst}  size={out_img.size}  transparent={pct:.1f}%")


if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))   # brand/
    assets = os.path.join(os.path.dirname(here), "src", "assets")
    remove_bg(os.path.join(here, "logo.png"),
              os.path.join(assets, "logo-mark.png"),    max_dim=1000, pad=6)
