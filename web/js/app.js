/** EachDay 100% Local In-Browser Studio Controller. */

import { TRANSLATIONS, detectInitialLang } from "./i18n.js";
import { decodeImageFile, extractCaptureDate, isSupportedFile } from "./images.js";
import { detectPeopleInCanvas, ensurePoseModel } from "./pose.js";
import { computeCandidateTransform, finalizeBatchAlignment } from "./aligner.js";
import { getCanvasSize, renderAlignedToCanvas } from "./renderer.js";
import { exportTimelapseLocal } from "./exporter.js";

const $ = (id) => document.getElementById(id);

const state = {
  lang: detectInitialLang(),
  busy: false,
  items: [],
  proportions: { shoulderToTorso: 0.72, headToTorso: 0.34, naturalRollDeg: 0 },
  selectedIndex: 0,
  showGuides: true,
  showOnion: false,
  playing: false,
  playTimer: null,
  lastExportUrl: null,
  settings: {
    aspectRatio: "9:16",
    resolution: "1080p",
    zoom: 1.0,
    verticalShift: 0.0,
    autoLevel: true,
    fillMode: "blur",
    showWatermark: true,
    watermarkStyle: "day_date",
    watermarkPosition: "bottom_left",
    fps: 6.0,
    holdLastSec: 1.2,
    crossfade: false,
  },
};

function t(key, ...args) {
  const dict = TRANSLATIONS[state.lang] || TRANSLATIONS.zh;
  const val = dict[key];
  return typeof val === "function" ? val(...args) : val ?? key;
}

function showToast(msg, duration = 2800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), duration);
}

function setStatus(visible, text = "", pct = 0) {
  const bar = $("statusBar");
  bar.classList.toggle("hidden", !visible);
  if (visible) {
    $("statusText").textContent = text;
    $("statusProgress").style.width = `${Math.max(4, Math.min(100, pct))}%`;
  }
}

function applyI18n() {
  document.title = t("pageTitle");
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  $("btnLang").textContent = state.lang === "zh" ? "EN" : "中文";
  $("btnPrivacyInfo").title = t("privacyPillTitle");

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const txt = t(key);
    if (typeof txt === "string") el.textContent = txt;
  });

  // Render privacy modal bullet list
  const list = $("privPointsList");
  list.innerHTML = "";
  for (const [title, desc] of TRANSLATIONS[state.lang].privPoints) {
    const div = document.createElement("div");
    div.className = "priv-item";
    div.innerHTML = `<strong>✓ ${title}</strong><span>${desc}</span>`;
    list.appendChild(div);
  }

  $("btnPlay").textContent = state.playing ? t("btnPause") : t("btnPlay");
  syncSettingsUI();
  if (state.items.length) {
    renderFilmstrip();
    renderMainCanvas();
    renderInspector();
  }
}

function currentItem() {
  if (!state.items.length) return null;
  return state.items[Math.max(0, Math.min(state.items.length - 1, state.selectedIndex))];
}

function getEnabledSequenceInfo(itemId) {
  const enabled = state.items.filter((it) => it.enabled);
  if (!enabled.length) return { seqIndex: 1, firstTimestamp: Date.now() / 1000 };
  const firstTimestamp = enabled[0].timestamp;
  const idx = enabled.findIndex((it) => it.id === itemId);
  if (idx >= 0) return { seqIndex: idx + 1, firstTimestamp };
  const target = state.items.find((it) => it.id === itemId);
  const rank = target ? enabled.filter((it) => it.timestamp <= target.timestamp).length + 1 : 1;
  return { seqIndex: rank, firstTimestamp };
}

function syncPreviewResolution() {
  const [fullW, fullH] = getCanvasSize(state.settings);
  const previewW = 540;
  const previewH = Math.round((fullH / fullW) * previewW);

  const c1 = $("previewCanvas");
  const c2 = $("onionCanvas");
  if (c1.width !== previewW || c1.height !== previewH) {
    c1.width = previewW;
    c1.height = previewH;
    c2.width = previewW;
    c2.height = previewH;
  }
  const [rw, rh] = state.settings.aspectRatio.split(":").map(Number);
  $("previewFrame").style.aspectRatio = `${rw} / ${rh}`;
}

function syncSettingsUI() {
  const s = state.settings;
  const setSeg = (groupId, val) => {
    document.querySelectorAll(`#${groupId} .seg-btn`).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === val);
    });
  };
  setSeg("aspectGroup", s.aspectRatio);
  setSeg("resGroup", s.resolution);
  setSeg("fillGroup", s.fillMode);

  $("rngZoom").value = s.zoom;
  $("valZoom").textContent = `${Number(s.zoom).toFixed(2)}×`;
  $("rngVShift").value = s.verticalShift;
  $("valVShift").textContent = `${Math.round(s.verticalShift * 100)}%`;
  $("chkAutoLevel").checked = !!s.autoLevel;

  $("chkWatermark").checked = !!s.showWatermark;
  $("watermarkOptions").classList.toggle("hidden", !s.showWatermark);
  $("selWmStyle").value = s.watermarkStyle;
  $("selWmPos").value = s.watermarkPosition;

  $("rngFps").value = s.fps;
  $("valFps").textContent = `${s.fps} ${t("unitFps")}`;
  $("rngHold").value = s.holdLastSec;
  $("valHold").textContent = `${Number(s.holdLastSec).toFixed(1)} ${t("unitSec")}`;
  $("chkCrossfade").checked = !!s.crossfade;

  syncPreviewResolution();
}

function renderMainCanvas() {
  const item = currentItem();
  if (!item) return;

  syncPreviewResolution();
  const { seqIndex, firstTimestamp } = getEnabledSequenceInfo(item.id);

  renderAlignedToCanvas($("previewCanvas"), item, state.settings, {
    seqIndex,
    firstTimestamp,
    drawGuides: state.showGuides && !state.playing,
    lang: state.lang,
  });

  $("stageCounter").textContent = `${state.selectedIndex + 1} / ${state.items.length} · ${item.dateStr}`;

  const onion = $("onionCanvas");
  if (state.showOnion && !state.playing && state.items.length > 1) {
    let refItem = null;
    for (let i = state.selectedIndex - 1; i >= 0; i--) {
      if (state.items[i].enabled) {
        refItem = state.items[i];
        break;
      }
    }
    if (!refItem) {
      refItem = state.items.find((it, i) => i !== state.selectedIndex && it.enabled) || null;
    }
    if (refItem) {
      const refInfo = getEnabledSequenceInfo(refItem.id);
      renderAlignedToCanvas(onion, refItem, { ...state.settings, showWatermark: false }, {
        seqIndex: refInfo.seqIndex,
        firstTimestamp: refInfo.firstTimestamp,
        drawGuides: false,
        lang: state.lang,
      });
      onion.classList.remove("hidden");
    } else {
      onion.classList.add("hidden");
    }
  } else {
    onion.classList.add("hidden");
  }
}

function renderThumbCanvas(thumbCanvas, item, seqIndex, firstTimestamp) {
  const [fullW, fullH] = getCanvasSize(state.settings);
  const tw = 120;
  const th = Math.round((fullH / fullW) * tw);
  thumbCanvas.width = tw;
  thumbCanvas.height = th;
  renderAlignedToCanvas(thumbCanvas, item, { ...state.settings, showWatermark: false }, {
    seqIndex,
    firstTimestamp,
    drawGuides: false,
    lang: state.lang,
  });
}

function renderFilmstrip() {
  const track = $("filmstripTrack");
  track.innerHTML = "";

  const enabled = state.items.filter((it) => it.enabled);
  const firstTs = enabled.length ? enabled[0].timestamp : Date.now() / 1000;
  $("filmstripStats").textContent = t("statsFmt", state.items.length, enabled.length);
  $("btnExport").disabled = enabled.length === 0 || state.busy;

  let seq = 0;
  state.items.forEach((item, idx) => {
    if (item.enabled) seq += 1;
    const card = document.createElement("div");
    card.className = "thumb-card" + (idx === state.selectedIndex ? " active" : "") + (!item.enabled ? " disabled" : "");
    card.dataset.index = idx;

    const tc = document.createElement("canvas");
    renderThumbCanvas(tc, item, seq, firstTs);
    card.appendChild(tc);

    const lbl = document.createElement("div");
    lbl.className = "thumb-label";
    lbl.textContent = item.enabled ? `D${String(seq).padStart(2, "0")} · ${item.dateStr.slice(5)}` : t("lblSkip");
    card.appendChild(lbl);

    if (item.warning) {
      const warn = document.createElement("div");
      warn.className = "thumb-warn";
      warn.title = item.warning;
      warn.textContent = "!";
      card.appendChild(warn);
    }

    card.addEventListener("click", () => {
      stopPlay();
      selectIndex(idx);
    });
    track.appendChild(card);
  });
}

function refreshCurrentThumb() {
  const item = currentItem();
  if (!item) return;
  const card = document.querySelector(`.thumb-card[data-index="${state.selectedIndex}"]`);
  if (!card) return;
  const tc = card.querySelector("canvas");
  if (tc) {
    const info = getEnabledSequenceInfo(item.id);
    renderThumbCanvas(tc, item, info.seqIndex, info.firstTimestamp);
  }
}

function renderInspector() {
  const item = currentItem();
  if (!item) {
    $("inspectorEmpty").classList.remove("hidden");
    $("inspectorPanel").classList.add("hidden");
    return;
  }

  $("inspectorEmpty").classList.add("hidden");
  $("inspectorPanel").classList.remove("hidden");

  $("insFilename").textContent = item.filename;
  const srcMap = { exif: t("srcExif"), filename: t("srcFilename"), mtime: t("srcMtime") };
  $("insMeta").textContent = `${item.dateStr} (${srcMap[item.dateSource] || item.dateSource}) · ${item.width}×${item.height}`;

  $("chkItemEnabled").checked = !!item.enabled;
  $("lblItemEnabled").textContent = item.enabled ? t("lblKeep") : t("lblSkip");

  const warnBox = $("insWarning");
  if (item.warning) {
    warnBox.textContent = `⚠️ ${item.warning}`;
    warnBox.classList.remove("hidden");
  } else {
    warnBox.classList.add("hidden");
  }

  $("insCandCount").textContent = `${item.candidates.length} ${t("unitPeople")}`;
  $("sourceImg").src = item.sourceThumbUrl;

  const overlay = $("candidateOverlay");
  overlay.innerHTML = "";
  item.candidates.forEach((cand) => {
    const [x1, y1, x2, y2] = cand.bbox;
    const box = document.createElement("div");
    box.className = "cand-box" + (cand.index === item.selectedCandidate ? " selected" : "");
    box.style.left = `${(x1 / item.width) * 100}%`;
    box.style.top = `${(y1 / item.height) * 100}%`;
    box.style.width = `${((x2 - x1) / item.width) * 100}%`;
    box.style.height = `${((y2 - y1) / item.height) * 100}%`;

    const tag = document.createElement("div");
    tag.className = "cand-tag";
    tag.textContent =
      cand.index === item.selectedCandidate
        ? `✓ ${t("tagSelected")} #${cand.index + 1}`
        : `${t("tagPerson")} #${cand.index + 1}`;
    box.appendChild(tag);

    box.addEventListener("click", () => {
      item.selectedCandidate = cand.index;
      item.transform = computeCandidateTransform(item, cand, state.proportions);
      item.transform.userDx = 0;
      item.transform.userDy = 0;
      item.transform.userScale = 1;
      item.transform.userAngleDeg = 0;
      renderMainCanvas();
      renderInspector();
      refreshCurrentThumb();
    });
    overlay.appendChild(box);
  });

  const tr = item.transform;
  $("rngItemDx").value = tr.userDx;
  $("valItemDx").textContent = `${Math.round(tr.userDx * 100)}%`;
  $("rngItemDy").value = tr.userDy;
  $("valItemDy").textContent = `${Math.round(tr.userDy * 100)}%`;
  $("rngItemScale").value = tr.userScale;
  $("valItemScale").textContent = `${Number(tr.userScale).toFixed(2)}×`;
  $("rngItemAngle").value = tr.userAngleDeg;
  $("valItemAngle").textContent = `${Number(tr.userAngleDeg).toFixed(1)}°`;
}

function selectIndex(idx) {
  if (!state.items.length) return;
  state.selectedIndex = (idx + state.items.length) % state.items.length;

  document.querySelectorAll(".thumb-card").forEach((el) => {
    const active = Number(el.dataset.index) === state.selectedIndex;
    el.classList.toggle("active", active);
    if (active) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  });

  renderMainCanvas();
  renderInspector();
}

function updateWorkspaceVisibility() {
  const has = state.items.length > 0;
  $("emptyState").classList.toggle("hidden", has);
  $("canvasWorkspace").classList.toggle("hidden", !has);
  $("filmstripBar").classList.toggle("hidden", !has);
  $("btnExport").disabled = !has || state.busy;
}

// Local File Import & In-Browser Pose Pipeline
async function ingestFiles(fileList, append = false) {
  if (state.busy) return;
  const files = Array.from(fileList || []).filter(isSupportedFile);
  if (!files.length) {
    showToast(t("errNoImages"), 3200);
    return;
  }

  stopPlay();
  state.busy = true;
  $("btnExport").disabled = true;

  try {
    const newItems = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      setStatus(true, t("stReading", i + 1, files.length, f.name), Math.round(((i + 1) / files.length) * 28));
      try {
        const [{ canvas, width, height, sourceThumbUrl }, dateInfo] = await Promise.all([
          decodeImageFile(f, 1600),
          extractCaptureDate(f),
        ]);
        newItems.push({
          id: `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          filename: f.name,
          canvas,
          sourceThumbUrl,
          width,
          height,
          timestamp: dateInfo.timestamp,
          dateStr: dateInfo.dateStr,
          dateSource: dateInfo.dateSource,
          enabled: true,
          detected: false,
          selectedCandidate: 0,
          candidates: [],
          transform: { srcCx: width * 0.5, srcCy: height * 0.32, scale: 1 / Math.max(60, height * 0.28), angleDeg: 0, userDx: 0, userDy: 0, userScale: 1, userAngleDeg: 0 },
          warning: null,
        });
      } catch (err) {
        console.warn("Failed to decode image:", f.name, err);
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!newItems.length) {
      throw new Error(t("errNoImages"));
    }

    setStatus(true, t("stLoadingModel"), 32);
    await ensurePoseModel();

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      setStatus(
        true,
        t("stAnalyzing", i + 1, newItems.length, item.filename),
        35 + Math.round(((i + 1) / newItems.length) * 58)
      );
      try {
        const candidates = await detectPeopleInCanvas(item.canvas);
        item.candidates = candidates;
        item.detected = candidates.length > 0;
        item.selectedCandidate = 0;
        item.warning = candidates.length ? null : t("warnNoPerson");
      } catch (err) {
        console.error("Pose error:", item.filename, err);
        item.warning = String(err.message || err);
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    setStatus(true, t("stIdentity"), 96);
    const merged = append ? [...state.items, ...newItems] : newItems;
    sortItemsList(merged, $("selSort").value);
    state.proportions = finalizeBatchAlignment(merged);
    state.items = merged;
    state.selectedIndex = 0;

    updateWorkspaceVisibility();
    renderFilmstrip();
    renderMainCanvas();
    renderInspector();
    showToast(t("stDone", state.items.length), 3200);
  } catch (err) {
    console.error(err);
    showToast(`❌ ${err.message || err}`, 4500);
  } finally {
    state.busy = false;
    setStatus(false);
    updateWorkspaceVisibility();
  }
}

function sortItemsList(list, mode) {
  if (mode === "date_desc") {
    list.sort((a, b) => b.timestamp - a.timestamp || b.filename.localeCompare(a.filename));
  } else if (mode === "filename_asc") {
    list.sort((a, b) => a.filename.localeCompare(b.filename));
  } else {
    list.sort((a, b) => a.timestamp - b.timestamp || a.filename.localeCompare(b.filename));
  }
}

// Live Playback Preview
function togglePlay() {
  if (state.playing) {
    stopPlay();
    return;
  }
  const enabledIndices = state.items.map((it, i) => (it.enabled ? i : -1)).filter((i) => i >= 0);
  if (enabledIndices.length < 2) {
    showToast(t("errNeed2"));
    return;
  }

  state.playing = true;
  $("btnPlay").classList.add("active");
  $("btnPlay").textContent = t("btnPause");
  $("onionCanvas").classList.add("hidden");

  let pos = Math.max(0, enabledIndices.indexOf(state.selectedIndex));
  const intervalMs = Math.round(1000 / Math.max(1, state.settings.fps));

  const tick = () => {
    if (!state.playing) return;
    const idx = enabledIndices[pos];
    state.selectedIndex = idx;
    const item = state.items[idx];
    const info = getEnabledSequenceInfo(item.id);
    renderAlignedToCanvas($("previewCanvas"), item, state.settings, {
      seqIndex: info.seqIndex,
      firstTimestamp: info.firstTimestamp,
      drawGuides: false,
      lang: state.lang,
    });
    $("stageCounter").textContent = `▶ ${pos + 1} / ${enabledIndices.length} · ${item.dateStr}`;
    pos = (pos + 1) % enabledIndices.length;
  };

  tick();
  state.playTimer = setInterval(tick, intervalMs);
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  clearInterval(state.playTimer);
  state.playTimer = null;
  $("btnPlay").classList.remove("active");
  $("btnPlay").textContent = t("btnPlay");
  selectIndex(state.selectedIndex);
}

// Export Local Video
async function handleExport() {
  if (state.busy || !state.items.some((it) => it.enabled)) return;
  stopPlay();
  state.busy = true;
  $("btnExport").disabled = true;

  try {
    const { blob, ext } = await exportTimelapseLocal(
      state.items,
      state.settings,
      state.lang,
      (cur, tot, phase) => {
        if (phase === "finalizing") {
          setStatus(true, t("stFinalizing"), 98);
        } else {
          setStatus(true, t("stExporting", cur, tot), Math.round((cur / tot) * 95));
        }
      }
    );

    if (state.lastExportUrl) URL.revokeObjectURL(state.lastExportUrl);
    const url = URL.createObjectURL(blob);
    state.lastExportUrl = url;

    const sizeMb = (blob.size / (1024 * 1024)).toFixed(2);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
    const filename = `eachday_gym_${stamp}.${ext}`;

    const video = $("exportVideoPlayer");
    video.src = url;
    const dl = $("btnDownloadMp4");
    dl.href = url;
    dl.download = filename;
    $("exportMeta").textContent = `${filename} · ${sizeMb} MB`;
    $("exportModal").classList.remove("hidden");
    showToast(t("stExportDone", sizeMb), 3500);
  } catch (err) {
    console.error(err);
    showToast(`❌ ${err.message || err}`, 4500);
  } finally {
    state.busy = false;
    setStatus(false);
    updateWorkspaceVisibility();
  }
}

// Drag & Drop support (handles both files and dropped directories!)
async function collectDroppedFiles(dataTransfer) {
  const out = [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const readEntry = (entry) =>
    new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => {
          out.push(f);
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) {
              resolve();
              return;
            }
            for (const ent of entries) await readEntry(ent);
            readBatch();
          }, () => resolve());
        };
        readBatch();
      } else {
        resolve();
      }
    });

  let usedEntries = false;
  for (const item of items) {
    if (typeof item.webkitGetAsEntry === "function") {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        usedEntries = true;
        await readEntry(entry);
      }
    }
  }
  if (!usedEntries && dataTransfer.files) {
    return Array.from(dataTransfer.files);
  }
  return out;
}

// Interactive Drag & Wheel fine-tuning on Preview Frame
function bindPreviewInteractions() {
  const frame = $("previewFrame");
  let dragging = false;
  let startX = 0,
    startY = 0,
    origDx = 0,
    origDy = 0;

  frame.addEventListener("mousedown", (e) => {
    if (state.playing) return;
    const item = currentItem();
    if (!item) return;
    dragging = true;
    frame.classList.add("dragging");
    startX = e.clientX;
    startY = e.clientY;
    origDx = item.transform.userDx;
    origDy = item.transform.userDy;
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const item = currentItem();
    if (!item) return;
    const rect = frame.getBoundingClientRect();
    const dx = Math.max(-0.3, Math.min(0.3, origDx + (e.clientX - startX) / rect.width));
    const dy = Math.max(-0.3, Math.min(0.3, origDy + (e.clientY - startY) / rect.height));
    item.transform.userDx = dx;
    item.transform.userDy = dy;
    $("rngItemDx").value = dx;
    $("valItemDx").textContent = `${Math.round(dx * 100)}%`;
    $("rngItemDy").value = dy;
    $("valItemDy").textContent = `${Math.round(dy * 100)}%`;
    renderMainCanvas();
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    frame.classList.remove("dragging");
    refreshCurrentThumb();
  });

  frame.addEventListener(
    "wheel",
    (e) => {
      if (state.playing) return;
      const item = currentItem();
      if (!item) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.03 : -0.03;
      const next = Math.max(0.6, Math.min(1.6, item.transform.userScale + delta));
      item.transform.userScale = next;
      $("rngItemScale").value = next;
      $("valItemScale").textContent = `${next.toFixed(2)}×`;
      renderMainCanvas();
      refreshCurrentThumb();
    },
    { passive: false }
  );
}

function updateGlobalSetting(patch, rebuildThumbs = false) {
  Object.assign(state.settings, patch);
  syncSettingsUI();
  if (state.items.length) {
    renderMainCanvas();
    if (rebuildThumbs) renderFilmstrip();
  }
}

function bindEvents() {
  $("btnLang").addEventListener("click", () => {
    state.lang = state.lang === "zh" ? "en" : "zh";
    localStorage.setItem("eachday_lang", state.lang);
    applyI18n();
  });

  $("btnPrivacyInfo").addEventListener("click", () => $("privacyModal").classList.remove("hidden"));

  $("fileInput").addEventListener("change", (e) => {
    const append = state.items.length > 0;
    ingestFiles(e.target.files, append);
    e.target.value = "";
  });

  $("folderInput").addEventListener("change", (e) => {
    ingestFiles(e.target.files, false);
    e.target.value = "";
  });

  $("btnClearAll").addEventListener("click", () => {
    stopPlay();
    state.items = [];
    state.selectedIndex = 0;
    updateWorkspaceVisibility();
    renderInspector();
  });

  // Drag & drop anywhere on the page
  const dz = $("dropZone");
  ["dragenter", "dragover"].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
    });
  });
  window.addEventListener("drop", async (e) => {
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) ingestFiles(files, state.items.length > 0);
  });

  // Global settings
  document.querySelectorAll("#aspectGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ aspectRatio: btn.dataset.val }, true))
  );
  document.querySelectorAll("#resGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ resolution: btn.dataset.val }, false))
  );
  document.querySelectorAll("#fillGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ fillMode: btn.dataset.val }, true))
  );

  $("rngZoom").addEventListener("input", (e) => updateGlobalSetting({ zoom: parseFloat(e.target.value) }, false));
  $("rngZoom").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("rngVShift").addEventListener("input", (e) => updateGlobalSetting({ verticalShift: parseFloat(e.target.value) }, false));
  $("rngVShift").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("chkAutoLevel").addEventListener("change", (e) => updateGlobalSetting({ autoLevel: e.target.checked }, true));

  $("chkWatermark").addEventListener("change", (e) => updateGlobalSetting({ showWatermark: e.target.checked }, false));
  $("selWmStyle").addEventListener("change", (e) => updateGlobalSetting({ watermarkStyle: e.target.value }, false));
  $("selWmPos").addEventListener("change", (e) => updateGlobalSetting({ watermarkPosition: e.target.value }, false));

  $("rngFps").addEventListener("input", (e) => {
    updateGlobalSetting({ fps: parseFloat(e.target.value) }, false);
    if (state.playing) {
      stopPlay();
      togglePlay();
    }
  });
  $("rngHold").addEventListener("input", (e) => updateGlobalSetting({ holdLastSec: parseFloat(e.target.value) }, false));
  $("chkCrossfade").addEventListener("change", (e) => updateGlobalSetting({ crossfade: e.target.checked }, false));

  // Stage controls
  $("btnPlay").addEventListener("click", togglePlay);
  $("btnGuides").addEventListener("click", () => {
    state.showGuides = !state.showGuides;
    $("btnGuides").classList.toggle("active", state.showGuides);
    renderMainCanvas();
  });
  $("btnOnion").addEventListener("click", () => {
    state.showOnion = !state.showOnion;
    $("btnOnion").classList.toggle("active", state.showOnion);
    renderMainCanvas();
  });
  $("btnPrev").addEventListener("click", () => {
    stopPlay();
    selectIndex(state.selectedIndex - 1);
  });
  $("btnNext").addEventListener("click", () => {
    stopPlay();
    selectIndex(state.selectedIndex + 1);
  });

  // Inspector controls
  $("chkItemEnabled").addEventListener("change", (e) => {
    const item = currentItem();
    if (!item) return;
    item.enabled = e.target.checked;
    renderInspector();
    renderFilmstrip();
    renderMainCanvas();
  });

  $("btnResetItem").addEventListener("click", () => {
    const item = currentItem();
    if (!item) return;
    item.transform.userDx = 0;
    item.transform.userDy = 0;
    item.transform.userScale = 1;
    item.transform.userAngleDeg = 0;
    renderInspector();
    renderMainCanvas();
    refreshCurrentThumb();
  });

  $("rngItemDx").addEventListener("input", (e) => {
    const item = currentItem();
    if (!item) return;
    item.transform.userDx = parseFloat(e.target.value);
    $("valItemDx").textContent = `${Math.round(item.transform.userDx * 100)}%`;
    renderMainCanvas();
  });
  $("rngItemDx").addEventListener("change", refreshCurrentThumb);

  $("rngItemDy").addEventListener("input", (e) => {
    const item = currentItem();
    if (!item) return;
    item.transform.userDy = parseFloat(e.target.value);
    $("valItemDy").textContent = `${Math.round(item.transform.userDy * 100)}%`;
    renderMainCanvas();
  });
  $("rngItemDy").addEventListener("change", refreshCurrentThumb);

  $("rngItemScale").addEventListener("input", (e) => {
    const item = currentItem();
    if (!item) return;
    item.transform.userScale = parseFloat(e.target.value);
    $("valItemScale").textContent = `${item.transform.userScale.toFixed(2)}×`;
    renderMainCanvas();
  });
  $("rngItemScale").addEventListener("change", refreshCurrentThumb);

  $("rngItemAngle").addEventListener("input", (e) => {
    const item = currentItem();
    if (!item) return;
    item.transform.userAngleDeg = parseFloat(e.target.value);
    $("valItemAngle").textContent = `${item.transform.userAngleDeg.toFixed(1)}°`;
    renderMainCanvas();
  });
  $("rngItemAngle").addEventListener("change", refreshCurrentThumb);

  // Sort dropdown
  $("selSort").addEventListener("change", (e) => {
    stopPlay();
    sortItemsList(state.items, e.target.value);
    state.selectedIndex = 0;
    renderFilmstrip();
    renderMainCanvas();
    renderInspector();
  });

  $("btnExport").addEventListener("click", handleExport);

  // Modal close buttons & backdrop click
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.close;
      $(target).classList.add("hidden");
      if (target === "exportModal") $("exportVideoPlayer").pause();
    });
  });
  document.querySelectorAll(".modal-backdrop").forEach((bg) => {
    bg.addEventListener("click", (e) => {
      if (e.target === bg) {
        bg.classList.add("hidden");
        if (bg.id === "exportModal") $("exportVideoPlayer").pause();
      }
    });
  });

  // Keyboard shortcuts
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || !state.items.length) return;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      stopPlay();
      selectIndex(state.selectedIndex - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      stopPlay();
      selectIndex(state.selectedIndex + 1);
    } else if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key.toLowerCase() === "g") {
      $("btnGuides").click();
    } else if (e.key.toLowerCase() === "o") {
      $("btnOnion").click();
    } else if (e.key.toLowerCase() === "x") {
      const item = currentItem();
      if (item) {
        item.enabled = !item.enabled;
        renderInspector();
        renderFilmstrip();
        renderMainCanvas();
      }
    }
  });

  bindPreviewInteractions();
}

bindEvents();
applyI18n();
updateWorkspaceVisibility();
