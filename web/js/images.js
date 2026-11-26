/**
 * Browser-side image loading (JPG/PNG/WEBP/HEIC), EXIF orientation, and rock-solid capture date extraction.
 * Includes a built-in zero-dependency binary EXIF TIFF/ExifIFD parser (works 100% offline for JPEG, HEIC/HEIF,
 * PNG, and WebP), backed up by exifr full bundle for XMP/exotic formats.
 */

const SUPPORTED_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
  ".avif",
]);

const FILENAME_DATE_RE =
  /(?<!\d)(20\d{2})[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])(?:[-_ T]?([01]\d|2[0-3])[-_.]?([0-5]\d)(?:[-_.]?([0-5]\d))?)?(?!\d)/;

const EXIF_DATETIME_RE =
  /(20\d{2})[:\-/](0[1-9]|1[0-2])[:\-/](0[1-9]|[12]\d|3[01])(?:\s+([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?)?/;

let exifrFullPromise = null;
let heic2anyPromise = null;

function loadExifrFull() {
  if (!exifrFullPromise) {
    exifrFullPromise = import("https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.js")
      .then((m) => m.default || m)
      .catch(() => null);
  }
  return exifrFullPromise;
}

function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  if (!heic2anyPromise) {
    heic2anyPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
      s.onload = () => resolve(window.heic2any);
      s.onerror = () => reject(new Error("HEIC decoder failed to load"));
      document.head.appendChild(s);
    });
  }
  return heic2anyPromise;
}

export function isSupportedFile(file) {
  if (!file || !file.name || file.name.startsWith(".")) return false;
  const lower = file.name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot >= 0 && SUPPORTED_EXTS.has(lower.slice(dot))) return true;
  return (file.type || "").startsWith("image/");
}

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

function parseDateValue(val) {
  if (!val) return null;
  if (val instanceof Date) {
    if (!Number.isNaN(val.getTime()) && val.getFullYear() >= 2000 && val.getFullYear() <= 2100) {
      return val;
    }
    return null;
  }
  if (typeof val === "string") {
    const m = EXIF_DATETIME_RE.exec(val.trim());
    if (m) {
      const dt = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        m[4] ? Number(m[4]) : 12,
        m[5] ? Number(m[5]) : 0,
        m[6] ? Number(m[6]) : 0
      );
      if (!Number.isNaN(dt.getTime())) return dt;
    }
    const parsed = new Date(val);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2000 && parsed.getFullYear() <= 2100) {
      return parsed;
    }
  }
  return null;
}

function readAscii(view, offset, length) {
  let out = "";
  const end = Math.min(view.byteLength, offset + length);
  for (let i = offset; i < end; i++) {
    const c = view.getUint8(i);
    if (c === 0) break;
    out += String.fromCharCode(c);
  }
  return out;
}

function readIfdTags(view, tiffStart, ifdOffset, littleEndian) {
  const tags = {};
  const absOffset = tiffStart + ifdOffset;
  if (absOffset < tiffStart || absOffset + 2 > view.byteLength) return tags;

  const numEntries = view.getUint16(absOffset, littleEndian);
  if (numEntries > 512) return tags;

  for (let i = 0; i < numEntries; i++) {
    const entry = absOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tagId = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const count = view.getUint32(entry + 4, littleEndian);

    if (tagId === 0x8769 && (type === 4 || type === 3)) {
      // ExifIFDPointer
      tags.exifIfdPointer = type === 4 ? view.getUint32(entry + 8, littleEndian) : view.getUint16(entry + 8, littleEndian);
    } else if ((tagId === 0x9003 || tagId === 0x9004 || tagId === 0x0132) && type === 2 && count > 0 && count < 128) {
      // ASCII datetime tags: DateTimeOriginal (0x9003), DateTimeDigitized (0x9004), DateTime (0x0132)
      const valOffset = count <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, littleEndian);
      if (valOffset >= tiffStart && valOffset + count <= view.byteLength) {
        tags[tagId] = readAscii(view, valOffset, count);
      }
    }
  }
  return tags;
}

function parseTiffExifDate(view, tiffStart) {
  if (tiffStart + 8 > view.byteLength) return null;
  const byteOrder = view.getUint16(tiffStart, false);
  let littleEndian;
  if (byteOrder === 0x4949) littleEndian = true; // "II"
  else if (byteOrder === 0x4d4d) littleEndian = false; // "MM"
  else return null;

  if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return null;
  const firstIfdOffset = view.getUint32(tiffStart + 4, littleEndian);
  const ifd0 = readIfdTags(view, tiffStart, firstIfdOffset, littleEndian);

  let exifIfd = {};
  if (ifd0.exifIfdPointer) {
    exifIfd = readIfdTags(view, tiffStart, ifd0.exifIfdPointer, littleEndian);
  }

  // Priority: DateTimeOriginal (0x9003) > DateTimeDigitized (0x9004) > DateTime (0x0132)
  const raw = exifIfd[0x9003] || exifIfd[0x9004] || ifd0[0x9003] || ifd0[0x0132];
  return parseDateValue(raw);
}

/**
 * Zero-dependency binary EXIF reader supporting JPEG, iPhone HEIC/HEIF, PNG, and WebP.
 */
export function parseExifDateFromBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const len = bytes.length;
  if (len < 16) return null;

  // 1. Fast path for JPEG: walk APP markers cleanly
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < len) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xda || marker === 0xd9) break; // SOS or EOI
      if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8)) {
        offset += 2;
        continue;
      }
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2 || offset + 2 + segLen > len) break;
      if (marker === 0xe1 && segLen >= 14) {
        // Check "Exif\0\0"
        if (
          bytes[offset + 4] === 0x45 &&
          bytes[offset + 5] === 0x78 &&
          bytes[offset + 6] === 0x69 &&
          bytes[offset + 7] === 0x66 &&
          bytes[offset + 8] === 0x00 &&
          bytes[offset + 9] === 0x00
        ) {
          const dt = parseTiffExifDate(view, offset + 10);
          if (dt) return dt;
        }
      }
      offset += 2 + segLen;
    }
  }

  // 2. Universal scan for "Exif\0\0" followed by TIFF header ("II*\0" or "MM\0*")
  //    Handles iPhone HEIC/HEIF (ISOBMFF), WebP, AVIF, and non-standard JPEG layouts!
  for (let i = 0; i < len - 14; i++) {
    if (
      bytes[i] === 0x45 && // E
      bytes[i + 1] === 0x78 && // x
      bytes[i + 2] === 0x69 && // i
      bytes[i + 3] === 0x66 && // f
      bytes[i + 4] === 0x00 &&
      bytes[i + 5] === 0x00
    ) {
      const dt = parseTiffExifDate(view, i + 6);
      if (dt) return dt;
    }
  }

  // 3. PNG eXIf chunk (starts directly with TIFF header after "eXIf")
  for (let i = 0; i < len - 12; i++) {
    if (
      bytes[i] === 0x65 && // e
      bytes[i + 1] === 0x58 && // X
      bytes[i + 2] === 0x49 && // I
      bytes[i + 3] === 0x66 // f
    ) {
      const dt = parseTiffExifDate(view, i + 4);
      if (dt) return dt;
    }
  }

  return null;
}

export async function extractCaptureDate(file) {
  // 1. Built-in 100% offline binary EXIF parser (fast 512KB head scan, then full file scan for HEIC/HDR photos)
  try {
    const headBuf = await file.slice(0, Math.min(file.size, 512 * 1024)).arrayBuffer();
    let dt = parseExifDateFromBuffer(headBuf);
    if (!dt && file.size > 512 * 1024 && file.size <= 40 * 1024 * 1024) {
      // Some iPhone HEIC/HDR photos store the Exif item later inside the file
      const fullBuf = await file.arrayBuffer();
      dt = parseExifDateFromBuffer(fullBuf);
    }
    if (dt) {
      return {
        timestamp: dt.getTime() / 1000,
        dateStr: formatDateYMD(dt),
        dateSource: "exif",
      };
    }
  } catch {
    // Continue to secondary parser
  }

  // 2. Backup: exifr FULL bundle (supports HEIC/HEIF, XMP, PNG, AVIF, TIFF)
  try {
    const exifr = await loadExifrFull();
    if (exifr) {
      const meta = await exifr.parse(file, { tiff: true, exif: true, xmp: true });
      const dt =
        parseDateValue(meta?.DateTimeOriginal) ||
        parseDateValue(meta?.CreateDate) ||
        parseDateValue(meta?.DateTimeDigitized) ||
        parseDateValue(meta?.ModifyDate);
      if (dt) {
        return {
          timestamp: dt.getTime() / 1000,
          dateStr: formatDateYMD(dt),
          dateSource: "exif",
        };
      }
    }
  } catch {
    // Ignore and fall back cleanly
  }

  // 3. Fallback to date pattern in filename (e.g., IMG_20250512_183022.jpg)
  const m = FILENAME_DATE_RE.exec(file.name);
  if (m) {
    const dt = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      m[4] ? Number(m[4]) : 12,
      m[5] ? Number(m[5]) : 0,
      m[6] ? Number(m[6]) : 0
    );
    if (!Number.isNaN(dt.getTime())) {
      return {
        timestamp: dt.getTime() / 1000,
        dateStr: formatDateYMD(dt),
        dateSource: "filename",
      };
    }
  }

  // 4. Fallback to file lastModified
  const dt = new Date(file.lastModified || Date.now());
  return {
    timestamp: dt.getTime() / 1000,
    dateStr: formatDateYMD(dt),
    dateSource: "mtime",
  };
}

/**
 * Decode a File (including iPhone HEIC) into an EXIF-oriented HTMLCanvasElement
 * capped at `maxSide` so dozens of 12MP iPhone photos stay lightweight and fast in browser memory.
 */
export async function decodeImageFile(file, maxSide = 1600) {
  let blob = file;
  let bitmap = null;

  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    const lower = file.name.toLowerCase();
    if (
      lower.endsWith(".heic") ||
      lower.endsWith(".heif") ||
      (file.type || "").includes("heic") ||
      (file.type || "").includes("heif")
    ) {
      const heic2any = await loadHeic2Any();
      const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
      blob = Array.isArray(converted) ? converted[0] : converted;
      bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
    } else {
      throw new Error(`Unsupported or corrupted image: ${file.name}`);
    }
  }

  const origW = bitmap.width;
  const origH = bitmap.height;
  let w = origW;
  let h = origH;

  if (Math.max(w, h) > maxSide) {
    const ratio = maxSide / Math.max(w, h);
    w = Math.max(1, Math.round(w * ratio));
    h = Math.max(1, Math.round(h * ratio));
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  const thumbMax = 440;
  const tScale = Math.min(1, thumbMax / Math.max(w, h));
  const tw = Math.max(1, Math.round(w * tScale));
  const th = Math.max(1, Math.round(h * tScale));
  const thumbCanvas = document.createElement("canvas");
  thumbCanvas.width = tw;
  thumbCanvas.height = th;
  thumbCanvas.getContext("2d").drawImage(canvas, 0, 0, tw, th);
  const sourceThumbUrl = thumbCanvas.toDataURL("image/jpeg", 0.82);

  return { canvas, width: w, height: h, sourceThumbUrl };
}
