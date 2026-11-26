/** EachDay 100% Local In-Browser Universal Timelapse & Alignment Studio Controller. */

import { TRANSLATIONS, detectInitialLang } from "./i18n.js";
import { decodeImageFile, extractCaptureDate, isSupportedFile } from "./images.js";
import { detectPeopleInCanvas, ensurePoseModel } from "./pose.js";
import {
  computeCandidateTransform,
  finalizeBatchAlignment,
  recomputeBatchTransforms,
} from "./aligner.js";
import { computeBatchColorTarget, computePhotoColorStats } from "./color.js";
import { getCanvasSize, renderAlignedToCanvas, renderComparisonCanvas } from "./renderer.js";
import { exportTimelapseLocal } from "./exporter.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_STORAGE_KEY = "eachday_settings_v2";

const DEFAULT_SETTINGS = {
  alignMode: "body", // "body" | "face" | "points"
  aspectRatio: "9:16",
  resolution: "1080p",
  zoom: 1.0,
  verticalShift: 0.0,
  autoLevel: true,
  fillMode: "blur",
  autoColorMatch: false,
  colorMatchStrength: 0.65,
  selfMask: "none", // "none" | "emoji" | "blur" | "mosaic"
  selfEmoji: "😎",
  maskScale: 1.15,
  bgMask: "none", // "none" | "blur" | "mosaic"
  showWatermark: true,
  watermarkStyle: "day_date",
  customPrefix: "OOTD #",
  customUseElapsed: false,
  customShowDate: true,
  watermarkPosition: "bottom_left",
  showProgressBar: false,
  progressBarPos: "top",
  fps: 6.0,
  milestoneHoldSec: 0.8,
  holdLastSec: 1.2,
  crossfade: false,
};

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage quota errors
  }
}

const state = {
  lang: detectInitialLang(),
  busy: false,
  items: [],
  proportions: { shoulderToTorso: 0.72, headToTorso: 0.34, naturalRollDeg: 0, earToEye: 2.1, noseToEye: 0.58 },
  batchColorTarget: null,
  colorRefId: null, // null => batch median, or specific item.id
  pendingProject: null,
  selectedIndex: 0,
  showGuides: true,
  showOnion: false,
  playing: false,
  playTimer: null,
  lastExportUrl: null,
  lastCompareUrl: null,
  settings: loadSavedSettings(),
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
  const totalEnabled = Math.max(1, enabled.length);
  if (!enabled.length) return { seqIndex: 1, totalEnabled: 1, firstTimestamp: Date.now() / 1000 };
  const firstTimestamp = enabled[0].timestamp;
  const idx = enabled.findIndex((it) => it.id === itemId);
  if (idx >= 0) return { seqIndex: idx + 1, totalEnabled, firstTimestamp };
  const target = state.items.find((it) => it.id === itemId);
  const rank = target ? enabled.filter((it) => it.timestamp <= target.timestamp).length + 1 : 1;
  return { seqIndex: rank, totalEnabled, firstTimestamp };
}

function refreshBatchColorTarget() {
  if (state.colorRefId && !state.items.some((it) => it.id === state.colorRefId)) {
    state.colorRefId = null;
  }
  state.batchColorTarget = computeBatchColorTarget(state.items, state.colorRefId);
  syncColorRefSelect();
}

function syncColorRefSelect() {
  const sel = $("selColorRef");
  if (!sel) return;
  sel.innerHTML = "";
  sel.add(new Option(t("colorBaseMedian"), ""));
  state.items.forEach((it, idx) => {
    const label = `#${String(idx + 1).padStart(2, "0")} · ${it.dateStr} (${it.filename})`;
    sel.add(new Option(label, it.id));
  });
  sel.value = state.colorRefId || "";
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
  setSeg("alignModeGroup", s.alignMode);
  setSeg("aspectGroup", s.aspectRatio);
  setSeg("resGroup", s.resolution);
  setSeg("fillGroup", s.fillMode);
  setSeg("selfMaskGroup", s.selfMask);
  setSeg("bgMaskGroup", s.bgMask);
  setSeg("progressPosRow", s.progressBarPos);

  document.querySelectorAll("#heroModeCards .mode-card").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === s.alignMode);
  });

  $("chkColorMatch").checked = !!s.autoColorMatch;
  $("colorMatchOptions").classList.toggle("hidden", !s.autoColorMatch);
  syncColorRefSelect();
  $("rngColorStrength").value = s.colorMatchStrength;
  $("valColorStrength").textContent = `${Math.round(s.colorMatchStrength * 100)}%`;

  $("emojiPickerRow").classList.toggle("hidden", s.selfMask !== "emoji");
  $("maskSizeRow").classList.toggle("hidden", s.selfMask === "none" && s.bgMask === "none");
  document.querySelectorAll("#emojiPickerRow .emoji-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.emoji === s.selfEmoji);
  });
  $("rngMaskScale").value = s.maskScale;
  $("valMaskScale").textContent = `${Number(s.maskScale).toFixed(2)}×`;

  $("rngZoom").value = s.zoom;
  $("valZoom").textContent = `${Number(s.zoom).toFixed(2)}×`;
  $("rngVShift").value = s.verticalShift;
  $("valVShift").textContent = `${Math.round(s.verticalShift * 100)}%`;
  $("chkAutoLevel").checked = !!s.autoLevel;

  $("chkWatermark").checked = !!s.showWatermark;
  $("watermarkOptions").classList.toggle("hidden", !s.showWatermark);
  $("selWmStyle").value = s.watermarkStyle;
  $("customLabelBox").classList.toggle("hidden", s.watermarkStyle !== "custom");
  $("txtCustomPrefix").value = s.customPrefix;
  $("chkCustomElapsed").checked = !!s.customUseElapsed;
  $("chkCustomDate").checked = !!s.customShowDate;
  $("selWmPos").value = s.watermarkPosition;

  $("chkProgressBar").checked = !!s.showProgressBar;
  $("progressPosRow").classList.toggle("hidden", !s.showProgressBar);

  $("rngFps").value = s.fps;
  $("valFps").textContent = `${s.fps} ${t("unitFps")}`;
  $("rngMilestoneHold").value = s.milestoneHoldSec;
  $("valMilestoneHold").textContent = `${Number(s.milestoneHoldSec).toFixed(1)} ${t("unitSec")}`;
  $("rngHold").value = s.holdLastSec;
  $("valHold").textContent = `${Number(s.holdLastSec).toFixed(1)} ${t("unitSec")}`;
  $("chkCrossfade").checked = !!s.crossfade;

  syncPreviewResolution();
}

function renderMainCanvas() {
  const item = currentItem();
  if (!item) return;

  syncPreviewResolution();
  const { seqIndex, totalEnabled, firstTimestamp } = getEnabledSequenceInfo(item.id);

  renderAlignedToCanvas($("previewCanvas"), item, state.settings, {
    seqIndex,
    totalEnabled,
    firstTimestamp,
    drawGuides: state.showGuides && !state.playing,
    lang: state.lang,
    batchColorTarget: state.batchColorTarget,
  });

  const starMark = item.milestone ? " ★" : "";
  $("stageCounter").textContent = `${state.selectedIndex + 1} / ${state.items.length} · ${item.dateStr}${starMark}`;

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
      renderAlignedToCanvas(onion, refItem, { ...state.settings, showWatermark: false, showProgressBar: false }, {
        seqIndex: refInfo.seqIndex,
        totalEnabled: refInfo.totalEnabled,
        firstTimestamp: refInfo.firstTimestamp,
        drawGuides: false,
        lang: state.lang,
        batchColorTarget: state.batchColorTarget,
      });
      onion.classList.remove("hidden");
    } else {
      onion.classList.add("hidden");
    }
  } else {
    onion.classList.add("hidden");
  }
}

function renderThumbCanvas(thumbCanvas, item, seqIndex, totalEnabled, firstTimestamp) {
  const [fullW, fullH] = getCanvasSize(state.settings);
  const tw = 120;
  const th = Math.round((fullH / fullW) * tw);
  thumbCanvas.width = tw;
  thumbCanvas.height = th;
  renderAlignedToCanvas(
    thumbCanvas,
    item,
    { ...state.settings, showWatermark: false, showProgressBar: false },
    {
      seqIndex,
      totalEnabled,
      firstTimestamp,
      drawGuides: false,
      lang: state.lang,
      batchColorTarget: state.batchColorTarget,
    }
  );
}

let draggedThumbIdx = null;

function moveItem(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= state.items.length || toIdx >= state.items.length) {
    return;
  }
  const activeId = currentItem()?.id;
  const [moved] = state.items.splice(fromIdx, 1);
  state.items.splice(toIdx, 0, moved);
  $("selSort").value = "custom";
  const newActiveIdx = state.items.findIndex((it) => it.id === activeId);
  state.selectedIndex = newActiveIdx >= 0 ? newActiveIdx : toIdx;
  renderFilmstrip();
  renderMainCanvas();
  renderInspector();
}

function renderFilmstrip() {
  const track = $("filmstripTrack");
  track.innerHTML = "";

  const enabled = state.items.filter((it) => it.enabled);
  const totalEnabled = Math.max(1, enabled.length);
  const firstTs = enabled.length ? enabled[0].timestamp : Date.now() / 1000;
  $("filmstripStats").textContent = t("statsFmt", state.items.length, enabled.length);
  $("btnExport").disabled = enabled.length === 0 || state.busy;
  $("btnCompare").disabled = enabled.length < 2 || state.busy;

  let seq = 0;
  state.items.forEach((item, idx) => {
    if (item.enabled) seq += 1;
    const card = document.createElement("div");
    card.className = "thumb-card" + (idx === state.selectedIndex ? " active" : "") + (!item.enabled ? " disabled" : "");
    card.dataset.index = idx;
    card.draggable = true;

    const tc = document.createElement("canvas");
    renderThumbCanvas(tc, item, seq, totalEnabled, firstTs);
    card.appendChild(tc);

    const lbl = document.createElement("div");
    lbl.className = "thumb-label";
    lbl.textContent = item.enabled ? `D${String(seq).padStart(2, "0")} · ${item.dateStr.slice(5)}` : t("lblSkip");
    card.appendChild(lbl);

    if (item.milestone) {
      const star = document.createElement("div");
      star.className = "thumb-star";
      star.textContent = "★";
      card.appendChild(star);
    }

    const showWarn = state.settings.alignMode !== "points" ? !!item.warning : item.customPoints.length < 2;
    if (showWarn) {
      const warn = document.createElement("div");
      warn.className = "thumb-warn";
      warn.title = state.settings.alignMode === "points" ? t("pointsStatus", item.customPoints.length) : item.warning;
      warn.textContent = "!";
      card.appendChild(warn);
    }

    card.addEventListener("click", () => {
      stopPlay();
      selectIndex(idx);
    });

    // Drag-to-reorder events
    card.addEventListener("dragstart", (e) => {
      draggedThumbIdx = idx;
      card.classList.add("dragging-thumb");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(idx));
    });
    card.addEventListener("dragend", () => {
      draggedThumbIdx = null;
      card.classList.remove("dragging-thumb");
      track.querySelectorAll(".thumb-card").forEach((c) => c.classList.remove("drop-before", "drop-after"));
    });
    card.addEventListener("dragover", (e) => {
      if (draggedThumbIdx === null || draggedThumbIdx === idx) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = card.getBoundingClientRect();
      const isLeft = e.clientX < rect.left + rect.width * 0.5;
      card.classList.toggle("drop-before", isLeft);
      card.classList.toggle("drop-after", !isLeft);
    });
    card.addEventListener("dragleave", () => {
      card.classList.remove("drop-before", "drop-after");
    });
    card.addEventListener("drop", (e) => {
      if (draggedThumbIdx === null) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = card.getBoundingClientRect();
      const isLeft = e.clientX < rect.left + rect.width * 0.5;
      let targetIdx = isLeft ? idx : idx + 1;
      if (draggedThumbIdx < targetIdx) targetIdx -= 1;
      const from = draggedThumbIdx;
      draggedThumbIdx = null;
      moveItem(from, targetIdx);
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
    renderThumbCanvas(tc, item, info.seqIndex, info.totalEnabled, info.firstTimestamp);
  }
}

function renderPointsSvg(item) {
  const svg = $("pointsOverlay");
  const pts = item.customPoints || [];
  let html = "";
  if (pts.length === 2) {
    const ax = (pts[0].x / item.width) * 100;
    const ay = (pts[0].y / item.height) * 100;
    const bx = (pts[1].x / item.width) * 100;
    const by = (pts[1].y / item.height) * 100;
    html += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#10b981" stroke-width="0.9" stroke-dasharray="2.5 1.5" />`;
  }
  pts.forEach((p, idx) => {
    const px = (p.x / item.width) * 100;
    const py = (p.y / item.height) * 100;
    const color = idx === 0 ? "#10b981" : "#3b82f6";
    const label = idx === 0 ? "A" : "B";
    html += `<circle cx="${px}" cy="${py}" r="3.4" fill="${color}" stroke="#ffffff" stroke-width="0.9" />`;
    html += `<text x="${px}" y="${py + 1.2}" text-anchor="middle" font-size="3.6" font-weight="800" fill="#ffffff">${label}</text>`;
  });
  svg.innerHTML = html;
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

  const msBtn = $("btnMilestone");
  msBtn.classList.toggle("active", !!item.milestone);
  msBtn.textContent = item.milestone ? t("btnMilestoneOn") : t("btnMilestoneOff");

  const crBtn = $("btnSetColorRef");
  const isColorRef = state.settings.autoColorMatch && state.colorRefId === item.id;
  crBtn.classList.toggle("active", isColorRef);
  crBtn.textContent = isColorRef ? t("btnColorRefOn") : t("btnColorRefOff");

  const isPointsMode = state.settings.alignMode === "points";
  const warnBox = $("insWarning");
  if (!isPointsMode && item.warning) {
    warnBox.textContent = `⚠️ ${item.warning}`;
    warnBox.classList.remove("hidden");
  } else {
    warnBox.classList.add("hidden");
  }

  $("sourceImg").src = item.sourceThumbUrl;
  const wrap = $("sourcePickerWrap");
  const candOverlay = $("candidateOverlay");
  const ptsOverlay = $("pointsOverlay");
  const ptsActions = $("pointsActions");

  if (isPointsMode) {
    wrap.classList.add("points-mode");
    $("insPickerTitle").textContent = t("secPoints");
    $("insPickerHint").textContent = t("pointsHint");
    $("insCandCount").textContent = t("pointsStatus", item.customPoints.length);
    candOverlay.classList.add("hidden");
    ptsOverlay.classList.remove("hidden");
    ptsActions.classList.remove("hidden");
    renderPointsSvg(item);
  } else {
    wrap.classList.remove("points-mode");
    $("insPickerTitle").textContent = t("secSubject");
    $("insPickerHint").textContent = t("subjectHint");
    $("insCandCount").textContent = `${item.candidates.length} ${t("unitPeople")}`;
    candOverlay.classList.remove("hidden");
    ptsOverlay.classList.add("hidden");
    ptsActions.classList.add("hidden");

    candOverlay.innerHTML = "";
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
        item.transform = computeCandidateTransform(item, cand, state.proportions, state.settings.alignMode);
        item.transform.userDx = 0;
        item.transform.userDy = 0;
        item.transform.userScale = 1;
        item.transform.userAngleDeg = 0;
        renderMainCanvas();
        renderInspector();
        refreshCurrentThumb();
      });
      candOverlay.appendChild(box);
    });
  }

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
  const enabledCount = state.items.filter((it) => it.enabled).length;
  $("emptyState").classList.toggle("hidden", has);
  $("canvasWorkspace").classList.toggle("hidden", !has);
  $("filmstripBar").classList.toggle("hidden", !has);
  $("btnExport").disabled = enabledCount === 0 || state.busy;
  $("btnCompare").disabled = enabledCount < 2 || state.busy;
}

// Project Save & Resume (.eachday.json)
function saveProjectConfig() {
  if (!state.items.length) return;
  const colorRefItem = state.colorRefId ? state.items.find((it) => it.id === state.colorRefId) : null;
  const payload = {
    version: 1,
    app: "EachDay",
    savedAt: new Date().toISOString(),
    sortMode: $("selSort").value,
    colorRefKey: colorRefItem ? `${colorRefItem.filename}::${colorRefItem.dateStr}` : null,
    settings: { ...state.settings },
    photos: state.items.map((it, idx) => ({
      key: `${it.filename}::${it.dateStr}`,
      filename: it.filename,
      dateStr: it.dateStr,
      order: idx,
      enabled: !!it.enabled,
      milestone: !!it.milestone,
      selectedCandidate: it.selectedCandidate,
      customPoints: it.customPoints.map((p) => ({
        nx: Number((p.x / it.width).toFixed(5)),
        ny: Number((p.y / it.height).toFixed(5)),
      })),
      userTransform: {
        userDx: it.transform.userDx || 0,
        userDy: it.transform.userDy || 0,
        userScale: it.transform.userScale || 1,
        userAngleDeg: it.transform.userAngleDeg || 0,
      },
    })),
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `eachday_project_${new Date().toISOString().slice(0, 10)}.eachday.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(t("stSavedProject"), 3400);
}

function applyProjectConfigToLoadedItems(proj) {
  if (proj.settings && typeof proj.settings === "object") {
    state.settings = { ...DEFAULT_SETTINGS, ...proj.settings };
    persistSettings(state.settings);
    syncSettingsUI();
  }

  const byKey = new Map();
  const byName = new Map();
  for (const p of proj.photos || []) {
    if (p.key) byKey.set(p.key, p);
    if (p.filename && !byName.has(p.filename)) byName.set(p.filename, p);
  }

  let matched = 0;
  for (const item of state.items) {
    const rec = byKey.get(`${item.filename}::${item.dateStr}`) || byName.get(item.filename);
    if (!rec) {
      item._savedOrder = 1e9;
      continue;
    }
    matched += 1;
    item._savedOrder = typeof rec.order === "number" ? rec.order : 1e8;
    if (typeof rec.enabled === "boolean") item.enabled = rec.enabled;
    if (typeof rec.milestone === "boolean") item.milestone = rec.milestone;
    if (
      typeof rec.selectedCandidate === "number" &&
      rec.selectedCandidate >= 0 &&
      rec.selectedCandidate < item.candidates.length
    ) {
      item.selectedCandidate = rec.selectedCandidate;
    }
    if (Array.isArray(rec.customPoints) && rec.customPoints.length) {
      item.customPoints = rec.customPoints.slice(0, 2).map((pt) => ({
        x: (pt.nx !== undefined ? pt.nx * item.width : pt.x) || 0,
        y: (pt.ny !== undefined ? pt.ny * item.height : pt.y) || 0,
      }));
    }
    if (rec.userTransform) {
      item.transform.userDx = Number(rec.userTransform.userDx) || 0;
      item.transform.userDy = Number(rec.userTransform.userDy) || 0;
      item.transform.userScale = Number(rec.userTransform.userScale) || 1;
      item.transform.userAngleDeg = Number(rec.userTransform.userAngleDeg) || 0;
    }
  }

  if (proj.sortMode === "custom" && matched > 0) {
    state.items.sort((a, b) => (a._savedOrder - b._savedOrder) || (a.timestamp - b.timestamp));
    $("selSort").value = "custom";
  } else if (proj.sortMode) {
    $("selSort").value = proj.sortMode;
    sortItemsList(state.items, proj.sortMode);
  }
  state.items.forEach((it) => delete it._savedOrder);

  state.colorRefId = null;
  if (proj.colorRefKey) {
    const matchRef = state.items.find((it) => `${it.filename}::${it.dateStr}` === proj.colorRefKey);
    if (matchRef) state.colorRefId = matchRef.id;
  }

  recomputeBatchTransforms(state.items, state.proportions, state.settings.alignMode);
  refreshBatchColorTarget();
  renderFilmstrip();
  renderMainCanvas();
  renderInspector();

  const added = Math.max(0, state.items.length - matched);
  showToast(t("stLoadedProject", matched, added), 3800);
}

async function handleLoadProjectFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const proj = JSON.parse(text);
    if (!proj || proj.app !== "EachDay" || !proj.settings) {
      throw new Error(t("errBadProject"));
    }
    if (state.items.length > 0) {
      const needPose = proj.settings.alignMode !== "points" && state.items.some((it) => !it.poseAnalyzed);
      if (needPose) {
        state.busy = true;
        updateWorkspaceVisibility();
        await runPoseDetectionOnItems(state.items);
        state.proportions = finalizeBatchAlignment(state.items, proj.settings.alignMode);
        state.busy = false;
        setStatus(false);
        updateWorkspaceVisibility();
      }
      applyProjectConfigToLoadedItems(proj);
    } else {
      state.pendingProject = proj;
      if (proj.settings) {
        state.settings = { ...DEFAULT_SETTINGS, ...proj.settings };
        persistSettings(state.settings);
        syncSettingsUI();
      }
      showToast(t("stPendingProject"), 4200);
    }
  } catch (err) {
    showToast(`❌ ${err.message || t("errBadProject")}`, 4000);
  }
}

async function runPoseDetectionOnItems(targetItems) {
  const unanalyzed = targetItems.filter((it) => !it.poseAnalyzed);
  if (!unanalyzed.length) return;

  setStatus(true, t("stLoadingModel"), 30);
  await ensurePoseModel();

  for (let i = 0; i < unanalyzed.length; i++) {
    const item = unanalyzed[i];
    setStatus(
      true,
      t("stAnalyzing", i + 1, unanalyzed.length, item.filename),
      35 + Math.round(((i + 1) / unanalyzed.length) * 58)
    );
    try {
      const candidates = await detectPeopleInCanvas(item.canvas);
      item.candidates = candidates;
      item.detected = candidates.length > 0;
      item.selectedCandidate = 0;
      item.poseAnalyzed = true;
      item.warning = candidates.length ? null : t("warnNoPerson");
    } catch (err) {
      console.error("Pose error:", item.filename, err);
      item.warning = String(err.message || err);
    }
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function ingestFiles(fileList, append = false) {
  if (state.busy) return;
  const files = Array.from(fileList || []).filter(isSupportedFile);
  if (!files.length) {
    showToast(t("errNoImages"), 3200);
    return;
  }

  stopPlay();
  state.busy = true;
  updateWorkspaceVisibility();

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
        const colorStats = computePhotoColorStats(canvas);
        newItems.push({
          id: `${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`,
          filename: f.name,
          canvas,
          sourceThumbUrl,
          colorStats,
          width,
          height,
          timestamp: dateInfo.timestamp,
          dateStr: dateInfo.dateStr,
          dateSource: dateInfo.dateSource,
          enabled: true,
          milestone: false,
          detected: false,
          poseAnalyzed: false,
          selectedCandidate: 0,
          candidates: [],
          customPoints: [],
          transform: {
            srcCx: width * 0.5,
            srcCy: height * 0.4,
            scale: 1 / Math.max(60, height * 0.3),
            angleDeg: 0,
            userDx: 0,
            userDy: 0,
            userScale: 1,
            userAngleDeg: 0,
          },
          warning: null,
        });
      } catch (err) {
        console.warn("Failed to decode image:", f.name, err);
      }
      await new Promise((r) => setTimeout(r, 0));
    }

    if (!newItems.length) throw new Error(t("errNoImages"));

    const merged = append ? [...state.items, ...newItems] : newItems;
    if ($("selSort").value !== "custom") {
      sortItemsList(merged, $("selSort").value);
    }

    if (state.settings.alignMode === "points") {
      recomputeBatchTransforms(merged, state.proportions, "points");
      state.items = merged;
      state.selectedIndex = 0;
      refreshBatchColorTarget();
      if (state.pendingProject) {
        const proj = state.pendingProject;
        state.pendingProject = null;
        applyProjectConfigToLoadedItems(proj);
      } else {
        updateWorkspaceVisibility();
        renderFilmstrip();
        renderMainCanvas();
        renderInspector();
        showToast(t("stPointsReady", state.items.length), 3600);
      }
    } else {
      await runPoseDetectionOnItems(merged);
      setStatus(true, t("stIdentity"), 96);
      state.proportions = finalizeBatchAlignment(merged, state.settings.alignMode);
      state.items = merged;
      state.selectedIndex = 0;
      refreshBatchColorTarget();
      if (state.pendingProject) {
        const proj = state.pendingProject;
        state.pendingProject = null;
        applyProjectConfigToLoadedItems(proj);
      } else {
        updateWorkspaceVisibility();
        renderFilmstrip();
        renderMainCanvas();
        renderInspector();
        showToast(t("stDone", state.items.length), 3200);
      }
    }
  } catch (err) {
    console.error(err);
    showToast(`❌ ${err.message || err}`, 4500);
  } finally {
    state.busy = false;
    setStatus(false);
    updateWorkspaceVisibility();
  }
}

async function switchAlignMode(nextMode) {
  if (state.settings.alignMode === nextMode) return;
  stopPlay();
  state.settings.alignMode = nextMode;
  persistSettings(state.settings);
  syncSettingsUI();

  if (!state.items.length) return;

  if (nextMode !== "points" && state.items.some((it) => !it.poseAnalyzed)) {
    state.busy = true;
    updateWorkspaceVisibility();
    try {
      await runPoseDetectionOnItems(state.items);
      state.proportions = finalizeBatchAlignment(state.items, nextMode);
    } catch (err) {
      showToast(`❌ ${err.message || err}`, 4000);
    } finally {
      state.busy = false;
      setStatus(false);
      updateWorkspaceVisibility();
    }
  } else {
    recomputeBatchTransforms(state.items, state.proportions, nextMode);
  }

  renderFilmstrip();
  renderMainCanvas();
  renderInspector();
}

function sortItemsList(list, mode) {
  if (mode === "custom") return;
  if (mode === "date_desc") {
    list.sort((a, b) => b.timestamp - a.timestamp || b.filename.localeCompare(a.filename));
  } else if (mode === "filename_asc") {
    list.sort((a, b) => a.filename.localeCompare(b.filename));
  } else {
    list.sort((a, b) => a.timestamp - b.timestamp || a.filename.localeCompare(b.filename));
  }
}

// Live Playback Preview (honors Milestone Extra Hold!)
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
  const baseMs = Math.round(1000 / Math.max(1, state.settings.fps));

  const scheduleNext = () => {
    if (!state.playing) return;
    const idx = enabledIndices[pos];
    state.selectedIndex = idx;
    const item = state.items[idx];
    const info = getEnabledSequenceInfo(item.id);
    renderAlignedToCanvas($("previewCanvas"), item, state.settings, {
      seqIndex: info.seqIndex,
      totalEnabled: info.totalEnabled,
      firstTimestamp: info.firstTimestamp,
      drawGuides: false,
      lang: state.lang,
      batchColorTarget: state.batchColorTarget,
    });
    const starMark = item.milestone ? " ★" : "";
    $("stageCounter").textContent = `▶ ${pos + 1} / ${enabledIndices.length} · ${item.dateStr}${starMark}`;

    const delay = baseMs + (item.milestone ? Math.round((Number(state.settings.milestoneHoldSec) || 0.8) * 1000) : 0);
    pos = (pos + 1) % enabledIndices.length;
    state.playTimer = setTimeout(scheduleNext, delay);
  };

  scheduleNext();
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  clearTimeout(state.playTimer);
  state.playTimer = null;
  $("btnPlay").classList.remove("active");
  $("btnPlay").textContent = t("btnPlay");
  selectIndex(state.selectedIndex);
}

// Before / After Comparison Modal
function openCompareModal() {
  const enabled = state.items.filter((it) => it.enabled);
  if (enabled.length < 2) {
    showToast(t("errNeed2"));
    return;
  }
  stopPlay();

  const selL = $("selCmpLeft");
  const selR = $("selCmpRight");
  selL.innerHTML = "";
  selR.innerHTML = "";

  enabled.forEach((it, idx) => {
    const label = `#${String(idx + 1).padStart(2, "0")} · ${it.dateStr} (${it.filename})`;
    selL.add(new Option(label, String(idx)));
    selR.add(new Option(label, String(idx)));
  });
  selL.value = "0";
  selR.value = String(enabled.length - 1);

  $("compareModal").classList.remove("hidden");
  updateComparePreview();
}

function updateComparePreview() {
  const enabled = state.items.filter((it) => it.enabled);
  if (enabled.length < 2) return;
  const li = Math.max(0, Math.min(enabled.length - 1, Number($("selCmpLeft").value) || 0));
  const ri = Math.max(0, Math.min(enabled.length - 1, Number($("selCmpRight").value) || enabled.length - 1));
  const leftItem = enabled[li];
  const rightItem = enabled[ri];
  const firstTs = enabled[0].timestamp;

  const cmpCanvas = renderComparisonCanvas(
    leftItem,
    rightItem,
    li + 1,
    ri + 1,
    firstTs,
    state.settings,
    state.lang,
    state.batchColorTarget
  );
  cmpCanvas.toBlob((blob) => {
    if (!blob) return;
    if (state.lastCompareUrl) URL.revokeObjectURL(state.lastCompareUrl);
    state.lastCompareUrl = URL.createObjectURL(blob);
    $("comparePreviewImg").src = state.lastCompareUrl;
    const dl = $("btnDownloadCompare");
    dl.href = state.lastCompareUrl;
    dl.download = `eachday_compare_${leftItem.dateStr}_vs_${rightItem.dateStr}.png`;
  }, "image/png");
}

// Local MP4 Export
async function handleExport() {
  if (state.busy || !state.items.some((it) => it.enabled)) return;
  stopPlay();
  state.busy = true;
  updateWorkspaceVisibility();

  try {
    const { blob, ext } = await exportTimelapseLocal(
      state.items,
      state.settings,
      state.lang,
      state.batchColorTarget,
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
    const filename = `eachday_${stamp}.${ext}`;

    $("exportVideoPlayer").src = url;
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

async function collectDroppedFiles(dataTransfer) {
  const out = [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const readEntry = (entry) =>
    new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { out.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => {
          reader.readEntries(async (entries) => {
            if (!entries.length) { resolve(); return; }
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
      if (entry) { usedEntries = true; await readEntry(entry); }
    }
  }
  return !usedEntries && dataTransfer.files ? Array.from(dataTransfer.files) : out;
}

function bindPreviewInteractions() {
  const frame = $("previewFrame");
  let dragging = false;
  let startX = 0, startY = 0, origDx = 0, origDy = 0;

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

  $("sourcePickerWrap").addEventListener("click", (e) => {
    if (state.settings.alignMode !== "points") return;
    const item = currentItem();
    if (!item) return;
    const rect = $("sourceImg").getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const pt = { x: nx * item.width, y: ny * item.height };

    if (item.customPoints.length >= 2) {
      item.customPoints = [pt];
    } else {
      item.customPoints.push(pt);
    }

    if (item.customPoints.length === 2) {
      item.transform.userDx = 0;
      item.transform.userDy = 0;
      item.transform.userScale = 1;
      item.transform.userAngleDeg = 0;
      recomputeBatchTransforms(state.items, state.proportions, "points");
    }

    renderInspector();
    renderMainCanvas();
    renderFilmstrip();
  });
}

function updateGlobalSetting(patch, rebuildThumbs = false) {
  Object.assign(state.settings, patch);
  persistSettings(state.settings);
  syncSettingsUI();
  if (state.items.length) {
    renderMainCanvas();
    if (rebuildThumbs) renderFilmstrip();
  }
}

function toggleMilestoneCurrent() {
  const item = currentItem();
  if (!item) return;
  item.milestone = !item.milestone;
  renderInspector();
  renderFilmstrip();
  renderMainCanvas();
}

function bindEvents() {
  $("btnLang").addEventListener("click", () => {
    state.lang = state.lang === "zh" ? "en" : "zh";
    localStorage.setItem("eachday_lang", state.lang);
    applyI18n();
  });

  $("btnPrivacyInfo").addEventListener("click", () => $("privacyModal").classList.remove("hidden"));
  $("btnCompare").addEventListener("click", openCompareModal);
  $("selCmpLeft").addEventListener("change", updateComparePreview);
  $("selCmpRight").addEventListener("change", updateComparePreview);

  $("btnSaveProject").addEventListener("click", saveProjectConfig);
  $("projectInput").addEventListener("change", (e) => {
    handleLoadProjectFile(e.target.files?.[0]);
    e.target.value = "";
  });

  $("fileInput").addEventListener("change", (e) => {
    ingestFiles(e.target.files, state.items.length > 0);
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
    state.colorRefId = null;
    state.batchColorTarget = null;
    syncColorRefSelect();
    updateWorkspaceVisibility();
    renderInspector();
  });

  const dz = $("dropZone");
  ["dragenter", "dragover"].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (draggedThumbIdx !== null) return;
      e.preventDefault();
      dz.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((ev) => {
    window.addEventListener(ev, (e) => {
      if (draggedThumbIdx !== null) return;
      e.preventDefault();
      dz.classList.remove("dragover");
    });
  });
  window.addEventListener("drop", async (e) => {
    if (draggedThumbIdx !== null) return;
    const files = await collectDroppedFiles(e.dataTransfer);
    const jsonFile = files.find((f) => f.name.toLowerCase().endsWith(".json"));
    if (jsonFile && files.length === 1) {
      handleLoadProjectFile(jsonFile);
      return;
    }
    if (files.length) ingestFiles(files, state.items.length > 0);
  });

  // Alignment modes
  document.querySelectorAll("#alignModeGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchAlignMode(btn.dataset.val))
  );
  document.querySelectorAll("#heroModeCards .mode-card").forEach((btn) =>
    btn.addEventListener("click", () => switchAlignMode(btn.dataset.mode))
  );

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

  // Auto Exposure & Color Match
  $("chkColorMatch").addEventListener("change", (e) => {
    refreshBatchColorTarget();
    updateGlobalSetting({ autoColorMatch: e.target.checked }, true);
    renderInspector();
  });
  $("selColorRef").addEventListener("change", (e) => {
    state.colorRefId = e.target.value || null;
    refreshBatchColorTarget();
    renderMainCanvas();
    renderFilmstrip();
    renderInspector();
  });
  $("btnSetColorRef").addEventListener("click", () => {
    const item = currentItem();
    if (!item) return;
    if (state.settings.autoColorMatch && state.colorRefId === item.id) {
      // Toggle back to Batch Median
      state.colorRefId = null;
    } else {
      state.colorRefId = item.id;
      state.settings.autoColorMatch = true;
      persistSettings(state.settings);
    }
    refreshBatchColorTarget();
    syncSettingsUI();
    renderMainCanvas();
    renderFilmstrip();
    renderInspector();
  });
  $("rngColorStrength").addEventListener("input", (e) =>
    updateGlobalSetting({ colorMatchStrength: parseFloat(e.target.value) }, false)
  );
  $("rngColorStrength").addEventListener("change", () => state.items.length && renderFilmstrip());

  // Privacy mask controls
  document.querySelectorAll("#selfMaskGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ selfMask: btn.dataset.val }, true))
  );
  document.querySelectorAll("#bgMaskGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ bgMask: btn.dataset.val }, true))
  );
  document.querySelectorAll("#emojiPickerRow .emoji-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ selfEmoji: btn.dataset.emoji }, true))
  );
  $("rngMaskScale").addEventListener("input", (e) => updateGlobalSetting({ maskScale: parseFloat(e.target.value) }, false));
  $("rngMaskScale").addEventListener("change", () => state.items.length && renderFilmstrip());

  $("rngZoom").addEventListener("input", (e) => updateGlobalSetting({ zoom: parseFloat(e.target.value) }, false));
  $("rngZoom").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("rngVShift").addEventListener("input", (e) => updateGlobalSetting({ verticalShift: parseFloat(e.target.value) }, false));
  $("rngVShift").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("chkAutoLevel").addEventListener("change", (e) => updateGlobalSetting({ autoLevel: e.target.checked }, true));

  // Watermark & Progress Bar
  $("chkWatermark").addEventListener("change", (e) => updateGlobalSetting({ showWatermark: e.target.checked }, false));
  $("selWmStyle").addEventListener("change", (e) => updateGlobalSetting({ watermarkStyle: e.target.value }, false));
  $("selWmPos").addEventListener("change", (e) => updateGlobalSetting({ watermarkPosition: e.target.value }, false));
  $("txtCustomPrefix").addEventListener("input", (e) => updateGlobalSetting({ customPrefix: e.target.value }, false));
  $("chkCustomElapsed").addEventListener("change", (e) => updateGlobalSetting({ customUseElapsed: e.target.checked }, false));
  $("chkCustomDate").addEventListener("change", (e) => updateGlobalSetting({ customShowDate: e.target.checked }, false));
  document.querySelectorAll(".preset-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      updateGlobalSetting({ watermarkStyle: "custom", customPrefix: chip.dataset.prefix }, false);
    });
  });

  $("chkProgressBar").addEventListener("change", (e) => updateGlobalSetting({ showProgressBar: e.target.checked }, false));
  document.querySelectorAll("#progressPosRow .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ progressBarPos: btn.dataset.val }, false))
  );

  // Video pacing
  $("rngFps").addEventListener("input", (e) => {
    updateGlobalSetting({ fps: parseFloat(e.target.value) }, false);
    if (state.playing) { stopPlay(); togglePlay(); }
  });
  $("rngMilestoneHold").addEventListener("input", (e) =>
    updateGlobalSetting({ milestoneHoldSec: parseFloat(e.target.value) }, false)
  );
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
  $("btnPrev").addEventListener("click", () => { stopPlay(); selectIndex(state.selectedIndex - 1); });
  $("btnNext").addEventListener("click", () => { stopPlay(); selectIndex(state.selectedIndex + 1); });

  // 2-point helper buttons
  $("btnCopyPrevPts").addEventListener("click", () => {
    const item = currentItem();
    if (!item || state.selectedIndex <= 0) return;
    const prev = state.items[state.selectedIndex - 1];
    if (!prev || prev.customPoints.length < 2) return;
    item.customPoints = prev.customPoints.map((p) => ({
      x: (p.x / prev.width) * item.width,
      y: (p.y / prev.height) * item.height,
    }));
    recomputeBatchTransforms(state.items, state.proportions, "points");
    renderInspector();
    renderMainCanvas();
    renderFilmstrip();
  });

  $("btnClearPts").addEventListener("click", () => {
    const item = currentItem();
    if (!item) return;
    item.customPoints = [];
    recomputeBatchTransforms(state.items, state.proportions, "points");
    renderInspector();
    renderMainCanvas();
    renderFilmstrip();
  });

  // Inspector controls
  $("chkItemEnabled").addEventListener("change", (e) => {
    const item = currentItem();
    if (!item) return;
    item.enabled = e.target.checked;
    refreshBatchColorTarget();
    renderInspector();
    renderFilmstrip();
    renderMainCanvas();
  });

  $("btnMilestone").addEventListener("click", toggleMilestoneCurrent);

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

  $("selSort").addEventListener("change", (e) => {
    stopPlay();
    if (e.target.value === "custom") return;
    sortItemsList(state.items, e.target.value);
    state.selectedIndex = 0;
    renderFilmstrip();
    renderMainCanvas();
    renderInspector();
  });

  $("btnExport").addEventListener("click", handleExport);

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

  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT" || !state.items.length) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); stopPlay(); selectIndex(state.selectedIndex - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stopPlay(); selectIndex(state.selectedIndex + 1); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === "g") { $("btnGuides").click(); }
    else if (e.key.toLowerCase() === "o") { $("btnOnion").click(); }
    else if (e.key.toLowerCase() === "m") { toggleMilestoneCurrent(); }
    else if (e.key.toLowerCase() === "x") {
      const item = currentItem();
      if (item) {
        item.enabled = !item.enabled;
        refreshBatchColorTarget();
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
