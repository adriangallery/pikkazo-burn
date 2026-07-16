// Share landing for a built Cubist Soul.
//   /api/share?combo=<hex16>
// Crawlers (X, Discord, Telegram) read the OG/Twitter tags — og:image is the
// server-rendered composite. Humans get bounced straight to the builder with
// the combo preloaded (meta refresh + JS redirect).
export const config = { maxDuration: 10 };

function validCombo(hex) {
  return typeof hex === "string" && /^[0-9a-f]{16}$/i.test(hex.trim());
}

export default function handler(req, res) {
  const raw = req.query.combo;
  const combo = validCombo(raw) ? String(raw).trim().toLowerCase() : null;

  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const host = req.headers.host || "cubistsouls.vercel.app";
  const origin = `${proto}://${host}`;

  const builderUrl = combo ? `/builder.html?combo=${combo}` : "/builder.html";
  const ogImage = combo
    ? `${origin}/api/render?combo=${combo}`
    : `${origin}/api/img?id=136`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>I built a Cubist Soul</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="I built a Cubist Soul" />
<meta property="og:description" content="Composed from the recovered Cubist Souls trait library. Build your own." />
<meta property="og:image" content="${ogImage}" />
<meta property="og:url" content="${origin}${builderUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="I built a Cubist Soul" />
<meta name="twitter:description" content="Composed from the recovered Cubist Souls trait library. Build your own." />
<meta name="twitter:image" content="${ogImage}" />
<meta http-equiv="refresh" content="0; url=${builderUrl}" />
<link rel="canonical" href="${origin}${builderUrl}" />
</head>
<body>
<p>Redirecting to the <a href="${builderUrl}">Soul Builder</a>…</p>
<script>location.replace(${JSON.stringify(builderUrl)});</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return res.status(200).send(html);
}
