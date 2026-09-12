import { MarketplaceMcpError } from "./errors.mjs";

export async function readBoundedResponse(response, limit, label) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > limit) {
    throw new MarketplaceMcpError("response-too-large", `${label} exceeds the ${limit}-byte limit.`);
  }
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new MarketplaceMcpError("response-too-large", `${label} exceeds the ${limit}-byte limit.`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new MarketplaceMcpError("response-too-large", `${label} exceeds the ${limit}-byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function encodeBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
