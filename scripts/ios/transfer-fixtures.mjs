// Small synthetic artifacts, independently encoded without importing application code.
export const CHARACTER_NAME = "iOS 자료 이전 동료";
export const CHARACTER_DESCRIPTION = "A careful archivist who remembers the blue lantern. 한글 설명 보존.";
export const LORE_CONTENT = "The blue lantern belongs to the quiet library. 푸른 등불의 기록.";
export const CHARACTER_CARD = {
  spec: "chara_card_v2", spec_version: "2.0", data: {
    name: CHARACTER_NAME, description: CHARACTER_DESCRIPTION, first_mes: "Welcome to the archive.",
    tags: ["iOS fixture", "한글"], extensions: {},
    character_book: { name: "Embedded archive", entries: [{ id: 0, keys: ["blue lantern"], content: LORE_CONTENT, enabled: true, insertion_order: 10, position: "before_char", extensions: {} }] },
  },
};
export const LOREBOOK = { name: "iOS 독립 설정집", entries: {
  "0": { uid: 0, key: ["library", "도서관"], keysecondary: [], comment: "Library", content: LORE_CONTENT, order: 10, position: 0, disable: false, constant: true },
} };
export const PRESET = { __filename: "iOS-preset.json", prompts: [
  { identifier: "main", name: "Rules", role: "system", content: "Preserve the blue lantern. Keep replies concise. 한글 지침.", enabled: true },
  { identifier: "chatHistory", name: "History", role: "system", marker: true },
], prompt_order: [{ character_id: 100001, order: [{ identifier: "main", enabled: true }, { identifier: "chatHistory", enabled: true }] }] };
export const CHAT_LINES = [
  { user_name: "Tester", character_name: CHARACTER_NAME, create_date: "2026-10-21T00:00:00.000Z" },
  { name: "Tester", is_user: true, is_system: false, send_date: "2026-10-21T00:00:01.000Z", mes: "Where is the blue lantern? 한글 질문." },
  { name: CHARACTER_NAME, is_user: false, is_system: false, send_date: "2026-10-21T00:00:02.000Z", mes: "It is in the quiet library. 한글 답변." },
];
export const MINIMAL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxY4WQAAAABJRU5ErkJggg==", "base64");

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function makeCharacterPng(card = CHARACTER_CARD) {
  const data = Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString("base64")}`);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0); chunk.write("tEXt", 4); data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([MINIMAL_PNG.subarray(0, -12), chunk, MINIMAL_PNG.subarray(-12)]);
}
export function readCharacterPng(bytes) {
  if (!bytes.subarray(0, 8).equals(MINIMAL_PNG.subarray(0, 8))) throw new Error("Exported card is not PNG");
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    if (offset + size + 12 > bytes.length) throw new Error("Truncated exported PNG chunk");
    if (type === "tEXt") {
      const content = bytes.subarray(offset + 8, offset + size + 8);
      if (content.subarray(0, 6).toString() === "chara\0") {
        if (bytes.readUInt32BE(offset + size + 8) !== crc32(bytes.subarray(offset + 4, offset + size + 8))) throw new Error("Exported card metadata CRC mismatch");
        return JSON.parse(Buffer.from(content.subarray(6).toString(), "base64").toString());
      }
    }
    offset += size + 12;
  }
  throw new Error("Exported PNG has no character metadata");
}

// Raw names are intentional: ZIP libraries often sanitize the adversarial traversal fixture.
export function makeStoredZip(entries) {
  const local = [], directory = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(value);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc32(bytes), 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, filename, bytes); directory.push(central, filename); offset += header.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

// Inspect only the fixture format we receive. This deliberately does not share
// production ZIP parsing or hash validation code with the system under test.
export function readStoredZipEntries(bytes) {
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) throw new Error("Fixture backup must have an ordinary ZIP32 end record");
  let cursor = bytes.readUInt32LE(end + 16);
  const entries = [];
  for (let count = 0; count < bytes.readUInt16LE(end + 10); count++) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50 || bytes.readUInt16LE(cursor + 10) !== 0) throw new Error("Fixture backup must use stored entries");
    const size = bytes.readUInt32LE(cursor + 24), nameSize = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes.toString("utf8", cursor + 46, cursor + 46 + nameSize);
    const local = bytes.readUInt32LE(cursor + 42);
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("Missing fixture ZIP local header");
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const contents = Buffer.from(bytes.subarray(start, start + size));
    if (contents.length !== size || crc32(contents) !== bytes.readUInt32LE(cursor + 16)) throw new Error("Downloaded ZIP failed its independent CRC check");
    entries.push([name, contents]);
    cursor += 46 + nameSize + extra + comment;
  }
  return entries;
}
