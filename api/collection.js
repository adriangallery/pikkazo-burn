// Collection-level metadata (OpenSea contractURI). The diamond's renderer
// points contractURI() here.
const LORE =
  "Ten thousand cubist portraits were abandoned by their maker. Inside every canvas, a soul stayed trapped. " +
  "Each Cubist Soul exists because its holder burned the original canvas on Ethereum, an irreversible act of liberation. " +
  "The soul kept its number, and the face it wore in the canvas that held it.";

export default async function handler(req, res) {
  const body = {
    name: "Cubist Souls",
    description: LORE,
    image: "https://cubistsouls.vercel.app/soul.jpg",
    external_link: "https://cubistsouls.vercel.app",
  };
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=86400");
  return res.status(200).json(body);
}
