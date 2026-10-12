import sharp from 'sharp';
function xml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}
export async function watermarkProof(
  bytes,
  { type = "text", placement = "corner", text = "Photography", logo } = {},
) {
  const input = sharp(bytes, { limitInputPixels: 30000000 })
    .rotate()
    .resize({
      width: 1500,
      height: 1500,
      fit: "inside",
      withoutEnlargement: true,
    });
  const normalized = await input.toBuffer();
  const meta = await sharp(normalized).metadata(),
    w = meta.width,
    h = meta.height;
  const diagonal = placement === "diagonal";
  let mark, markWidth, markHeight;
  if (type === "logo" && logo) {
    markWidth = Math.round(diagonal ? Math.hypot(w, h) * 0.85 : w * 0.2);
    mark = await sharp(logo, { limitInputPixels: 64000000 })
      .resize({
        width: markWidth,
        height: Math.round(h * (diagonal ? 0.65 : 0.16)),
        fit: "inside",
        withoutEnlargement: false,
      })
      .png()
      .toBuffer();
    const m = await sharp(mark).metadata();
    markWidth = m.width;
    markHeight = m.height;
    const alpha = await sharp(mark)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let i = 3; i < alpha.data.length; i += 4)
      alpha.data[i] = Math.round(alpha.data[i] * (diagonal ? 0.25 : 0.45));
    mark = await sharp(alpha.data, { raw: alpha.info }).png().toBuffer();
  } else {
    const raw = String(text || "Photography")
      .trim()
      .slice(0, 100);
    const value = raw.startsWith("©") ? raw : "© " + raw;
    const size = Math.max(
      12,
      Math.round(Math.min(w, h) * (diagonal ? 0.12 : 0.035)),
    );
    markWidth = Math.min(
      Math.round(diagonal ? Math.hypot(w, h) * 0.92 : w * 0.65),
      Math.max(80, Math.round(value.length * size * 0.66)),
    );
    markHeight = Math.round(size * 1.6);
    const fitted = Math.max(
      10,
      Math.min(size, Math.floor(markWidth / (value.length * 0.66))),
    );
    mark = await sharp(
      Buffer.from(
        `<svg width="${markWidth}" height="${markHeight}" xmlns="http://www.w3.org/2000/svg"><text x="50%" y="65%" text-anchor="middle" font-family="sans-serif" font-size="${fitted}" fill="white" fill-opacity="${diagonal ? 0.3 : 0.55}" stroke="black" stroke-opacity="${diagonal ? 0.16 : 0.3}" stroke-width="${Math.max(1, fitted * 0.018)}" paint-order="stroke">${xml(value)}</text></svg>`,
      ),
    )
      .png()
      .toBuffer();
  }
  if (diagonal) {
    mark = await sharp(mark)
      .rotate((-Math.atan2(h, w) * 180) / Math.PI, {
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer();
    const m = await sharp(mark).metadata();
    if (m.width > w || m.height > h)
      mark = await sharp(mark)
        .resize({
          width: Math.floor(w * 0.95),
          height: Math.floor(h * 0.95),
          fit: "inside",
        })
        .toBuffer();
    return sharp(normalized)
      .composite([{ input: mark, gravity: "centre" }])
      .jpeg({ quality: 86 })
      .toBuffer();
  }
  const gap = Math.round(Math.min(w, h) * 0.035);
  return sharp(normalized)
    .composite([
      {
        input: mark,
        left: Math.max(0, w - markWidth - gap),
        top: Math.max(0, h - markHeight - gap),
      },
    ])
    .jpeg({ quality: 86 })
    .toBuffer();
}
