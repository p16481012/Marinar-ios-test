/** Build a downloadable V2 card from an avatar without requiring server image processing. */
export async function buildCharacterCardPng(avatarUrl: string, charData: Record<string, unknown>): Promise<Blob> {
  // Step 1: Fetch avatar and draw to canvas to get raw PNG bytes
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load avatar image"));
    img.src = avatarUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const pngBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Canvas toBlob failed"))), "image/png");
  });
  const pngBuf = new Uint8Array(await pngBlob.arrayBuffer());

  return embedCharacterCardPng(pngBuf, charData);
}

/** Embed the complete card in the PNG that both browser downloads and importers consume. */
export function embedCharacterCardPng(pngBuf: Uint8Array, charData: Record<string, unknown>): Blob {
  // Step 2: Build the V2 character card JSON
  const v2Card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: charData.name || "",
      description: charData.description || "",
      personality: charData.personality || "",
      scenario: charData.scenario || "",
      first_mes: charData.first_mes || "",
      mes_example: charData.mes_example || "",
      creator_notes: charData.creator_notes || "",
      system_prompt: charData.system_prompt || "",
      post_history_instructions: charData.post_history_instructions || "",
      tags: charData.tags || [],
      creator: charData.creator || "",
      character_version: charData.character_version || "",
      alternate_greetings: charData.alternate_greetings || [],
      extensions: charData.extensions || {},
      ...(charData.character_book !== undefined ? { character_book: charData.character_book } : {}),
    },
  };

  // Step 3: Encode JSON as base64
  const jsonStr = JSON.stringify(v2Card);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  // Manual base64 encode that handles UTF-8 properly
  let binary = "";
  for (let i = 0; i < jsonBytes.length; i++) binary += String.fromCharCode(jsonBytes[i]);
  const b64 = btoa(binary);

  // Step 4: Build tEXt chunk: keyword("chara") + null byte + base64 text
  const keyword = new TextEncoder().encode("chara");
  const textData = new TextEncoder().encode(b64);
  const chunkPayload = new Uint8Array(keyword.length + 1 + textData.length);
  chunkPayload.set(keyword, 0);
  chunkPayload[keyword.length] = 0; // null separator
  chunkPayload.set(textData, keyword.length + 1);

  // Step 5: Calculate CRC32 for the chunk (type + data)
  const typeBytes = new TextEncoder().encode("tEXt");
  const crcInput = new Uint8Array(typeBytes.length + chunkPayload.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(chunkPayload, typeBytes.length);
  const crc = crc32(crcInput);

  // Step 6: Build the full chunk (length + type + data + crc)
  const chunkLength = chunkPayload.length;
  const fullChunk = new Uint8Array(4 + 4 + chunkLength + 4);
  // Length (big-endian)
  fullChunk[0] = (chunkLength >> 24) & 0xff;
  fullChunk[1] = (chunkLength >> 16) & 0xff;
  fullChunk[2] = (chunkLength >> 8) & 0xff;
  fullChunk[3] = chunkLength & 0xff;
  // Type
  fullChunk.set(typeBytes, 4);
  // Data
  fullChunk.set(chunkPayload, 8);
  // CRC (big-endian)
  fullChunk[8 + chunkLength] = (crc >> 24) & 0xff;
  fullChunk[9 + chunkLength] = (crc >> 16) & 0xff;
  fullChunk[10 + chunkLength] = (crc >> 8) & 0xff;
  fullChunk[11 + chunkLength] = crc & 0xff;

  // Step 7: Insert chunk before IEND in the PNG
  // Find IEND chunk (last 12 bytes typically: length(4) + "IEND"(4) + crc(4))
  let iendOffset = -1;
  for (let i = pngBuf.length - 12; i >= 8; i--) {
    if (pngBuf[i + 4] === 0x49 && pngBuf[i + 5] === 0x45 && pngBuf[i + 6] === 0x4e && pngBuf[i + 7] === 0x44) {
      iendOffset = i;
      break;
    }
  }
  if (iendOffset === -1) throw new Error("Could not find IEND chunk in PNG");

  // Build final PNG: everything before IEND + our tEXt chunk + IEND
  const beforeIend = pngBuf.slice(0, iendOffset);
  const iendChunk = pngBuf.slice(iendOffset);
  const finalPng = new Uint8Array(beforeIend.length + fullChunk.length + iendChunk.length);
  finalPng.set(beforeIend, 0);
  finalPng.set(fullChunk, beforeIend.length);
  finalPng.set(iendChunk, beforeIend.length + fullChunk.length);

  return new Blob([finalPng], { type: "image/png" });
}

/** CRC32 implementation for PNG chunk checksums */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  // Build table on first call
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crc32.table[n] = c;
    }
  }
  for (let i = 0; i < data.length; i++) {
    crc = crc32.table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
crc32.table = null as Uint32Array | null;
