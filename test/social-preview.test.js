import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const imageUrl = "https://plugins.omarchy.org/assets/img/omarchy-plugin-marketplace-card.png";

test("shared social card is 1200 by 630 and linked from both shells", async () => {
  const root = new URL("../", import.meta.url);
  const index = await readFile(new URL("site/index.html", root), "utf8");
  const plugin = await readFile(new URL("site/plugin.html", root), "utf8");
  for (const html of [index, plugin]) {
    assert.ok(html.includes(`<meta property="og:image" content="${imageUrl}">`));
    assert.ok(html.includes('<meta property="og:image:alt" content="discover omarchy plugins">'));
    assert.ok(html.includes('<meta property="og:image:width" content="1200">'));
    assert.ok(html.includes('<meta property="og:image:height" content="630">'));
    assert.ok(html.includes(`<meta name="twitter:image" content="${imageUrl}">`));
    assert.ok(html.includes('<meta name="twitter:image:alt" content="discover omarchy plugins">'));
    assert.equal(html.includes("omarchy-plugin-marketplace-preview.png"), false);
  }
  const imagePath = fileURLToPath(new URL("site/assets/img/omarchy-plugin-marketplace-card.png", root));
  const meta = await sharp(imagePath).metadata();
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
});
