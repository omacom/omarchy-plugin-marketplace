import assert from "node:assert/strict";
import test from "node:test";
import { isWidePreview } from "../site/assets/js/shared.js";

test("banner previews preserve the whole image, normal screenshots keep their framing", () => {
  assert.equal(isWidePreview({ previewThumbnailWidth: 720, previewThumbnailHeight: 241 }), true);
  assert.equal(isWidePreview({ previewWidth: 2170, previewHeight: 725 }), true);
  assert.equal(isWidePreview({ previewWidth: 720, previewHeight: 360 }), true);
  assert.equal(isWidePreview({ previewWidth: 720, previewHeight: 405 }), false);
  assert.equal(isWidePreview({ previewWidth: 400, previewHeight: 400 }), false);
});
test("classification uses the card dimensions and fails safely for invalid metadata", () => {
  assert.equal(isWidePreview({ previewThumbnailWidth: 720, previewThumbnailHeight: 405, previewWidth: 2170, previewHeight: 725 }), false);
  for (const value of [{}, {previewWidth: 1,previewHeight: 0}, {previewWidth: Infinity,previewHeight: 1}, {previewWidth: 'invalid',previewHeight: 1}, {previewWidth: -3,previewHeight: 1}]) assert.equal(isWidePreview(value), false);
});
