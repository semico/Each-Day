/** EachDay 100% Local In-Browser Universal Timelapse & Alignment Studio Controller. */

import { TRANSLATIONS, detectInitialLang } from "./i18n.js";
import { decodeImageFile, extractCaptureDate, isSupportedFile } from "./images.js";
import { detectPeopleInCanvas, ensurePoseModel } from "./pose.js";
import { detectObjectsInCanvas, ensureObjectModel, formatObjectLabel } from "./objects.js";
import {
  computeCandidateTransform,
  finalizeBatchAlignment,
  finalizeBatchObjects,
  recomputeBatchTransforms,
  trackSelectedObjectAcrossBatch,
  trackSelectedPersonAcrossBatch,
} from "./aligner.js";
import { computeBatchColorTarget, computePhotoColorStats } from "./color.js";
import {
  LABEL_THEME_PRESETS,
  getCanvasSize,
  renderAlignedToCanvas,
  renderComparisonCanvas,
  renderGridPosterCanvas,
} from "./renderer.js";
import { exportGifLocal, exportTimelapseLocal, exportWipeVideoLocal } from "./exporter.js";
import { LocalAudioManager, computeTappedBpm } from "./audio.js";
import { generateDemoItems } from "./demo.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_STORAGE_KEY = "eachday_settings_v2";
const audioMgr = new LocalAudioManager();

const DEFAULT_SETTINGS = {
  alignMode: "body", // "body" | "face" | "points"
  aspectRatio: "9:16",
  resolution: "1080p",
  zoom: 1.0,
  verticalShift: 0.0,
  autoLevel: true,
  fillMode: "blur",
  bgBokeh: false,
  bgBokehStrength: 0.6,
  bgBokehSize: 1.12,
  autoColorMatch: false,
  colorMatchStrength: 0.65,
  selfMask: "none", // "none" | "emoji" | "blur" | "mosaic"
  selfEmoji: "😎",
  maskScale: 1.15,
  bgMask: "none", // "none" | "blur" | "mosaic" | "emoji"
  bgEmoji: "😶",
  showWatermark: true,
  labelTheme: "pill", // "pill" | "magazine" | "minimal" | "film" | "sports"
  magazineTitle: "EACHDAY",
  labelFont: "sans",
  labelSize: 1.0,
  labelColor: "#ffffff",
  labelAccent: "#3b82f6",
  labelBgStyle: "glass",
  labelBgOpacity: 0.64,
  labelUppercase: false,
  labelTracking: 0,
  watermarkStyle: "day_date", // "day_date" | "count_date" | "date_only" | "day_only" | "custom" | "template"
  labelTemplate: "Day {n2} · {date}",
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
  beatSync: false,
  beatMode: "onset", // "onset" (real beat-cut) | "bpm" (uniform BPM)
  beatSensitivity: 0.55,
  bgmStartSec: 0,
  bpm: 120,
  beatDiv: 1,
  bgmVolume: 0.8,
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
  drawBoxMode: false,
  playing: false,
  auditioningBgm: false,
  playTimer: null,
  playRafId: null,
  auditionRafId: null,
  styleEditorOpen: false,
  lastExportUrl: null,
  lastCompareUrl: null,
  lastPosterUrl: null,
  posterGridCount: 9,
  customStickerImg: null,
  customStickerUrl: null,
  undoStack: [],
  redoStack: [],
  tapTimes: [],
  deferredInstallPrompt: null,
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
  if ($("txtCustomSticker")) $("txtCustomSticker").placeholder = t("phCustomSticker");
  if ($("txtBgEmoji")) $("txtBgEmoji").placeholder = t("phBgEmoji");
  if ($("txtMagazineTitle")) $("txtMagazineTitle").placeholder = t("phMagTitle");
  if ($("btnUndo")) $("btnUndo").title = t("btnUndoTitle");
  if ($("btnRedo")) $("btnRedo").title = t("btnRedoTitle");
  if ($("txtPosterTitle") && !$("txtPosterTitle").dataset.edited) {
    $("txtPosterTitle").value = t("posterDefaultTitle");
  }

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

function fitPreviewFrameToViewport() {
  const wrap = document.querySelector(".viewport-wrap");
  const frame = $("previewFrame");
  if (!wrap || !frame) return;
  const rect = wrap.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;

  const [rw, rh] = state.settings.aspectRatio.split(":").map(Number);
  const aspect = rw / rh;
  let w = rect.width;
  let h = w / aspect;
  if (h > rect.height) {
    h = rect.height;
    w = h * aspect;
  }
  frame.style.width = `${Math.floor(w)}px`;
  frame.style.height = `${Math.floor(h)}px`;
}

function syncPreviewResolution() {
  const [fullW, fullH] = getCanvasSize(state.settings);
  const maxPreviewSide = 720;
  const scale = maxPreviewSide / Math.max(fullW, fullH);
  const previewW = Math.max(240, Math.round(fullW * scale));
  const previewH = Math.max(240, Math.round(fullH * scale));

  const c1 = $("previewCanvas");
  const c2 = $("onionCanvas");
  if (c1.width !== previewW || c1.height !== previewH) {
    c1.width = previewW;
    c1.height = previewH;
    c2.width = previewW;
    c2.height = previewH;
  }
  fitPreviewFrameToViewport();
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
  setSeg("labelThemeGroup", s.labelTheme || "pill");
  setSeg("progressPosRow", s.progressBarPos);

  document.querySelectorAll("#heroModeCards .mode-card").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === s.alignMode);
  });

  $("chkBgBokeh").checked = !!s.bgBokeh;
  $("bokehStrengthRow").classList.toggle("hidden", !s.bgBokeh);
  $("rngBokehStrength").value = s.bgBokehStrength;
  $("valBokehStrength").textContent = `${Math.round(s.bgBokehStrength * 100)}%`;
  $("rngBokehSize").value = s.bgBokehSize ?? 1.12;
  $("valBokehSize").textContent = `${Number(s.bgBokehSize ?? 1.12).toFixed(2)}×`;

  $("chkColorMatch").checked = !!s.autoColorMatch;
  $("colorMatchOptions").classList.toggle("hidden", !s.autoColorMatch);
  syncColorRefSelect();
  $("rngColorStrength").value = s.colorMatchStrength;
  $("valColorStrength").textContent = `${Math.round(s.colorMatchStrength * 100)}%`;

  $("emojiPickerRow").classList.toggle("hidden", s.selfMask !== "emoji");
  $("bgEmojiPickerRow").classList.toggle("hidden", s.bgMask !== "emoji");
  $("maskSizeRow").classList.toggle("hidden", s.selfMask === "none" && s.bgMask === "none");
  document.querySelectorAll("#emojiPickerRow .emoji-btn").forEach((btn) => {
    btn.classList.toggle("active", !state.customStickerImg && btn.dataset.emoji === s.selfEmoji);
  });
  document.querySelectorAll("#bgEmojiPickerRow .emoji-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.bgEmoji === (s.bgEmoji || "😶"));
  });
  if ($("txtCustomSticker") && document.activeElement !== $("txtCustomSticker")) {
    $("txtCustomSticker").value = state.customStickerImg ? "" : (s.selfEmoji ?? "");
  }
  if ($("txtBgEmoji") && document.activeElement !== $("txtBgEmoji")) {
    $("txtBgEmoji").value = s.bgEmoji ?? "😶";
  }
  $("customStickerPreview").classList.toggle("hidden", !state.customStickerImg);
  if (state.customStickerUrl) $("customStickerThumb").src = state.customStickerUrl;
  $("rngMaskScale").value = s.maskScale;
  $("valMaskScale").textContent = `${Number(s.maskScale).toFixed(2)}×`;

  $("rngZoom").value = s.zoom;
  $("valZoom").textContent = `${Number(s.zoom).toFixed(2)}×`;
  $("rngVShift").value = s.verticalShift;
  $("valVShift").textContent = `${Math.round(s.verticalShift * 100)}%`;
  $("chkAutoLevel").checked = !!s.autoLevel;

  $("chkWatermark").checked = !!s.showWatermark;
  $("watermarkOptions").classList.toggle("hidden", !s.showWatermark);
  const curTheme = s.labelTheme || "pill";
  $("magazineTitleRow").classList.toggle("hidden", curTheme !== "magazine");
  if ($("txtMagazineTitle") && document.activeElement !== $("txtMagazineTitle")) {
    $("txtMagazineTitle").value = s.magazineTitle ?? "EACHDAY";
  }
  $("styleEditorBox").classList.toggle("hidden", !state.styleEditorOpen);
  $("selLabelFont").value = s.labelFont || "sans";
  $("rngLabelSize").value = s.labelSize ?? 1.0;
  $("valLabelSize").textContent = `${Number(s.labelSize ?? 1.0).toFixed(2)}×`;
  $("inpLabelColor").value = s.labelColor || "#ffffff";
  $("inpLabelAccent").value = s.labelAccent || "#3b82f6";
  setSeg("labelBgStyleGroup", s.labelBgStyle || "glass");
  $("rngLabelBgOpacity").value = s.labelBgOpacity ?? 0.64;
  $("valLabelBgOpacity").textContent = `${Math.round((s.labelBgOpacity ?? 0.64) * 100)}%`;
  $("rngLabelTracking").value = s.labelTracking ?? 0;
  $("valLabelTracking").textContent = String(s.labelTracking ?? 0);
  $("chkLabelUppercase").checked = !!s.labelUppercase;
  $("wmPosRow").classList.toggle("hidden", curTheme === "magazine");
  $("selWmStyle").value = s.watermarkStyle;
  $("customLabelBox").classList.toggle("hidden", s.watermarkStyle !== "custom");
  $("templateBox").classList.toggle("hidden", s.watermarkStyle !== "template");
  if ($("txtLabelTemplate") && document.activeElement !== $("txtLabelTemplate")) {
    $("txtLabelTemplate").value = s.labelTemplate ?? "Day {n2} · {date}";
  }
  if ($("txtCustomPrefix") && document.activeElement !== $("txtCustomPrefix")) {
    $("txtCustomPrefix").value = s.customPrefix ?? "";
  }
  $("chkCustomElapsed").checked = !!s.customUseElapsed;
  $("chkCustomDate").checked = !!s.customShowDate;
  $("selWmPos").value = s.watermarkPosition;

  $("chkProgressBar").checked = !!s.showProgressBar;
  $("progressPosRow").classList.toggle("hidden", !s.showProgressBar);

  $("rngFps").value = s.fps;
  $("valFps").textContent = `${Number(s.fps).toFixed(s.fps % 1 === 0 ? 0 : 1)} ${t("unitFps")}`;
  $("rngMilestoneHold").value = s.milestoneHoldSec;
  $("valMilestoneHold").textContent = `${Number(s.milestoneHoldSec).toFixed(1)} ${t("unitSec")}`;
  $("rngHold").value = s.holdLastSec;
  $("valHold").textContent = `${Number(s.holdLastSec).toFixed(1)} ${t("unitSec")}`;
  $("chkCrossfade").checked = !!s.crossfade;

  // BGM & Real Beat-Cut ("卡点") UI
  const hasAudio = audioMgr.hasAudio();
  $("bgmChip").classList.toggle("hidden", !hasAudio);
  $("bgmWaveWrap").classList.toggle("hidden", !hasAudio);
  $("bgmVolRow").classList.toggle("hidden", !hasAudio);
  if (hasAudio) {
    const mins = Math.floor(audioMgr.duration / 60);
    const secs = String(Math.floor(audioMgr.duration % 60)).padStart(2, "0");
    $("bgmName").textContent = `${audioMgr.filename} (${mins}:${secs})`;
    const maxStart = Math.max(0, Number((audioMgr.duration - 1).toFixed(1)));
    const clampedStart = Math.max(0, Math.min(maxStart, Number(s.bgmStartSec) || 0));
    s.bgmStartSec = clampedStart;
    $("rngBgmStart").max = String(maxStart);
    $("rngBgmStart").value = String(clampedStart);
    $("valBgmStart").textContent = `${clampedStart.toFixed(1)}s`;
    $("beatStats").textContent = t("beatStatsFmt", audioMgr.beats.length, audioMgr.detectedBpm);
    audioMgr.renderWaveform(
      $("beatWaveformCanvas"),
      clampedStart,
      audioMgr.isPlaying() ? audioMgr.getTrackPositionSec() : -1
    );
  }
  const audBtn = $("btnAuditionBgm");
  if (audBtn) {
    audBtn.classList.toggle("active", state.auditioningBgm);
    audBtn.textContent = state.auditioningBgm ? t("btnAuditionStop") : t("btnAuditionPlay");
  }
  $("rngBgmVol").value = s.bgmVolume;
  $("valBgmVol").textContent = `${Math.round(s.bgmVolume * 100)}%`;
  audioMgr.setVolume(s.bgmVolume);

  $("chkBeatSync").checked = !!s.beatSync;
  $("beatSyncBox").classList.toggle("hidden", !s.beatSync);
  const beatMode = s.beatMode || "onset";
  setSeg("beatModeGroup", beatMode);
  $("onsetControls").classList.toggle("hidden", beatMode !== "onset");
  $("bpmControls").classList.toggle("hidden", beatMode !== "bpm");
  $("beatNeedAudioHint").classList.toggle("hidden", hasAudio);
  $("rngBeatSens").value = s.beatSensitivity ?? 0.55;
  $("valBeatSens").textContent = `${Math.round((s.beatSensitivity ?? 0.55) * 100)}%`;
  $("numBpm").value = s.bpm;
  document.querySelectorAll("#beatDivGroup .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.val) === Number(s.beatDiv));
  });

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
    customStickerImg: state.customStickerImg,
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
  const maxThumb = 140;
  const scale = maxThumb / Math.max(fullW, fullH);
  const tw = Math.max(64, Math.round(fullW * scale));
  const th = Math.max(64, Math.round(fullH * scale));
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
      customStickerImg: state.customStickerImg,
    }
  );
}

let draggedThumbIdx = null;

function captureSnapshot() {
  return {
    sortMode: $("selSort").value,
    selectedId: currentItem()?.id || null,
    orderIds: state.items.map((it) => it.id),
    byId: Object.fromEntries(
      state.items.map((it) => [
        it.id,
        {
          enabled: it.enabled,
          milestone: it.milestone,
          dateStr: it.dateStr,
          timestamp: it.timestamp,
          dateSource: it.dateSource,
          selectedCandidate: it.selectedCandidate,
          selectedObject: it.selectedObject,
          customPoints: it.customPoints.map((p) => ({ x: p.x, y: p.y })),
          userTransform: {
            userDx: it.transform.userDx,
            userDy: it.transform.userDy,
            userScale: it.transform.userScale,
            userAngleDeg: it.transform.userAngleDeg,
          },
        },
      ])
    ),
  };
}

function applySnapshot(snap) {
  if (!snap) return;
  const map = new Map(state.items.map((it) => [it.id, it]));
  const reordered = [];
  for (const id of snap.orderIds) {
    if (map.has(id)) {
      reordered.push(map.get(id));
      map.delete(id);
    }
  }
  for (const rest of map.values()) reordered.push(rest);
  state.items = reordered;

  for (const it of state.items) {
    const s = snap.byId[it.id];
    if (!s) continue;
    it.enabled = s.enabled;
    it.milestone = s.milestone;
    it.dateStr = s.dateStr;
    it.timestamp = s.timestamp;
    it.dateSource = s.dateSource;
    it.selectedCandidate = s.selectedCandidate;
    it.selectedObject = s.selectedObject;
    it.customPoints = s.customPoints.map((p) => ({ x: p.x, y: p.y }));
    it.transform.userDx = s.userTransform.userDx;
    it.transform.userDy = s.userTransform.userDy;
    it.transform.userScale = s.userTransform.userScale;
    it.transform.userAngleDeg = s.userTransform.userAngleDeg;
  }

  $("selSort").value = snap.sortMode;
  recomputeBatchTransforms(state.items, state.proportions, state.settings.alignMode);
  refreshBatchColorTarget();
  const idx = state.items.findIndex((it) => it.id === snap.selectedId);
  if (idx >= 0) state.selectedIndex = idx;
  renderFilmstrip();
  renderMainCanvas();
  renderInspector();
}

function syncUndoButtons() {
  if ($("btnUndo")) $("btnUndo").disabled = state.undoStack.length === 0;
  if ($("btnRedo")) $("btnRedo").disabled = state.redoStack.length === 0;
}

function pushHistory() {
  if (!state.items.length) return;
  state.undoStack.push(captureSnapshot());
  if (state.undoStack.length > 40) state.undoStack.shift();
  state.redoStack = [];
  syncUndoButtons();
}

function performUndo() {
  if (!state.undoStack.length) return;
  stopPlay();
  state.redoStack.push(captureSnapshot());
  const prev = state.undoStack.pop();
  applySnapshot(prev);
  syncUndoButtons();
}

function performRedo() {
  if (!state.redoStack.length) return;
  stopPlay();
  state.undoStack.push(captureSnapshot());
  const next = state.redoStack.pop();
  applySnapshot(next);
  syncUndoButtons();
}

function moveItem(fromIdx, toIdx) {
  if (fromIdx === toIdx || fromIdx < 0 || toIdx < 0 || fromIdx >= state.items.length || toIdx >= state.items.length) {
    return;
  }
  pushHistory();
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
  $("btnExportGif").disabled = enabled.length === 0 || state.busy;
  $("btnCompare").disabled = enabled.length < 2 || state.busy;

  const [arW, arH] = state.settings.aspectRatio.split(":").map(Number);
  const thumbH = 86;
  const thumbW = Math.max(54, Math.min(132, Math.round((thumbH * arW) / arH)));

  let seq = 0;
  state.items.forEach((item, idx) => {
    if (item.enabled) seq += 1;
    const card = document.createElement("div");
    card.className = "thumb-card" + (idx === state.selectedIndex ? " active" : "") + (!item.enabled ? " disabled" : "");
    card.style.width = `${thumbW}px`;
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

    const mode = state.settings.alignMode;
    const showWarn =
      mode === "points"
        ? item.customPoints.length < 2
        : mode === "object"
        ? !!item.objectWarning
        : !!item.warning;
    if (showWarn) {
      const warn = document.createElement("div");
      warn.className = "thumb-warn";
      warn.title =
        mode === "points"
          ? t("pointsStatus", item.customPoints.length)
          : mode === "object"
          ? item.objectWarning
          : item.warning;
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
  const srcMap = { exif: t("srcExif"), filename: t("srcFilename"), mtime: t("srcMtime"), manual: t("srcManual") };
  $("insMeta").textContent = `${item.dateStr} (${srcMap[item.dateSource] || item.dateSource}) · ${item.width}×${item.height}`;
  if ($("inpItemDate")) {
    $("inpItemDate").value = item.dateStr.replace(/\./g, "-");
  }

  $("chkItemEnabled").checked = !!item.enabled;
  $("lblItemEnabled").textContent = item.enabled ? t("lblKeep") : t("lblSkip");

  const msBtn = $("btnMilestone");
  msBtn.classList.toggle("active", !!item.milestone);
  msBtn.textContent = item.milestone ? t("btnMilestoneOn") : t("btnMilestoneOff");

  const crBtn = $("btnSetColorRef");
  const isColorRef = state.settings.autoColorMatch && state.colorRefId === item.id;
  crBtn.classList.toggle("active", isColorRef);
  crBtn.textContent = isColorRef ? t("btnColorRefOn") : t("btnColorRefOff");

  const mode = state.settings.alignMode;
  const isPointsMode = mode === "points";
  const isObjectMode = mode === "object";

  const activeWarning = isPointsMode ? null : isObjectMode ? item.objectWarning : item.warning;
  const warnBox = $("insWarning");
  if (activeWarning) {
    warnBox.textContent = `⚠️ ${activeWarning}`;
    warnBox.classList.remove("hidden");
  } else {
    warnBox.classList.add("hidden");
  }

  $("sourceImg").src = item.sourceThumbUrl;
  const wrap = $("sourcePickerWrap");
  const candOverlay = $("candidateOverlay");
  const ptsOverlay = $("pointsOverlay");
  const ptsActions = $("pointsActions");
  const trackActions = $("trackActions");
  const btnDrawBox = $("btnDrawBox");
  const btnTrackAll = $("btnTrackAll");

  wrap.classList.toggle("points-mode", isPointsMode);
  wrap.classList.toggle("draw-mode", isObjectMode && state.drawBoxMode);

  if (isPointsMode) {
    $("insPickerTitle").textContent = t("secPoints");
    $("insPickerHint").textContent = t("pointsHint");
    $("insCandCount").textContent = t("pointsStatus", item.customPoints.length);
    candOverlay.classList.add("hidden");
    ptsOverlay.classList.remove("hidden");
    ptsActions.classList.remove("hidden");
    trackActions.classList.add("hidden");
    renderPointsSvg(item);
  } else if (isObjectMode) {
    const objList = item.objectCandidates || [];
    $("insPickerTitle").textContent = t("secObjectPicker");
    $("insPickerHint").textContent = t("objectHint");
    $("insCandCount").textContent = `${objList.length} ${t("unitObjects")}`;
    candOverlay.classList.remove("hidden");
    ptsOverlay.classList.add("hidden");
    ptsActions.classList.add("hidden");
    trackActions.classList.remove("hidden");
    btnDrawBox.classList.remove("hidden");
    btnDrawBox.classList.toggle("active", state.drawBoxMode);
    btnDrawBox.textContent = state.drawBoxMode ? t("btnDrawBoxOn") : t("btnDrawBoxOff");
    btnTrackAll.disabled = state.busy || objList.length === 0 || state.items.length < 2;

    candOverlay.innerHTML = "";
    objList.forEach((cand) => {
      const [x1, y1, x2, y2] = cand.bbox;
      const box = document.createElement("div");
      box.className = "cand-box" + (cand.index === item.selectedObject ? " selected" : "");
      box.style.left = `${(x1 / item.width) * 100}%`;
      box.style.top = `${(y1 / item.height) * 100}%`;
      box.style.width = `${((x2 - x1) / item.width) * 100}%`;
      box.style.height = `${((y2 - y1) / item.height) * 100}%`;

      const tag = document.createElement("div");
      tag.className = "cand-tag";
      const lbl = formatObjectLabel(cand, state.lang);
      tag.textContent = cand.index === item.selectedObject ? `✓ ${lbl}` : lbl;
      box.appendChild(tag);

      box.addEventListener("click", (e) => {
        if (state.drawBoxMode) return;
        e.stopPropagation();
        item.selectedObject = cand.index;
        item.transform = computeCandidateTransform(item, null, state.proportions, "object");
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
  } else {
    $("insPickerTitle").textContent = t("secSubject");
    $("insPickerHint").textContent = t("subjectHint");
    $("insCandCount").textContent = `${item.candidates.length} ${t("unitPeople")}`;
    candOverlay.classList.remove("hidden");
    ptsOverlay.classList.add("hidden");
    ptsActions.classList.add("hidden");
    btnDrawBox.classList.add("hidden");
    // Show "Auto-Track Across All" button whenever there are multiple photos & a person is detected
    const showTrackBtn = state.items.length >= 2 && item.candidates.length > 0;
    trackActions.classList.toggle("hidden", !showTrackBtn);
    btnTrackAll.disabled = state.busy || !showTrackBtn;

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
  if (has) requestAnimationFrame(fitPreviewFrameToViewport);
  $("btnExport").disabled = enabledCount === 0 || state.busy;
  $("btnExportGif").disabled = enabledCount === 0 || state.busy;
  $("btnCompare").disabled = enabledCount < 2 || state.busy;
  syncUndoButtons();

  const item = currentItem();
  const mode = state.settings.alignMode;
  const hasTrackTarget =
    !!item &&
    state.items.length >= 2 &&
    (mode === "object"
      ? (item.objectCandidates?.length || 0) > 0
      : (mode === "body" || mode === "face") && (item.candidates?.length || 0) > 0);
  if ($("btnTrackAll")) {
    $("btnTrackAll").disabled = state.busy || !hasTrackTarget;
  }
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
      timestamp: it.timestamp,
      dateSource: it.dateSource,
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
    if (rec.dateSource === "manual" && rec.dateStr && rec.timestamp) {
      item.dateStr = rec.dateStr;
      item.timestamp = rec.timestamp;
      item.dateSource = "manual";
    }
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

async function runObjectDetectionOnItems(targetItems) {
  const unanalyzed = targetItems.filter((it) => !it.objectAnalyzed);
  if (!unanalyzed.length) return;

  setStatus(true, t("stLoadingObjModel"), 30);
  await ensureObjectModel();

  for (let i = 0; i < unanalyzed.length; i++) {
    const item = unanalyzed[i];
    setStatus(
      true,
      t("stDetectingObjects", i + 1, unanalyzed.length, item.filename),
      35 + Math.round(((i + 1) / unanalyzed.length) * 58)
    );
    try {
      const objs = await detectObjectsInCanvas(item.canvas);
      item.objectCandidates = objs;
      item.selectedObject = 0;
      item.objectAnalyzed = true;
      item.objectWarning = objs.length ? null : t("warnNoObject");
    } catch (err) {
      console.error("Object detect error:", item.filename, err);
      item.objectWarning = String(err.message || err);
    }
    await new Promise((r) => setTimeout(r, 0));
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
          objectAnalyzed: false,
          selectedCandidate: 0,
          candidates: [],
          selectedObject: 0,
          objectCandidates: [],
          objectWarning: null,
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
    } else if (state.settings.alignMode === "object") {
      await runObjectDetectionOnItems(merged);
      finalizeBatchObjects(merged);
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
  state.drawBoxMode = false;
  state.settings.alignMode = nextMode;
  persistSettings(state.settings);
  syncSettingsUI();

  if (!state.items.length) return;

  if (nextMode === "object" && state.items.some((it) => !it.objectAnalyzed)) {
    state.busy = true;
    updateWorkspaceVisibility();
    try {
      await runObjectDetectionOnItems(state.items);
      finalizeBatchObjects(state.items);
    } catch (err) {
      showToast(`❌ ${err.message || err}`, 4000);
    } finally {
      state.busy = false;
      setStatus(false);
      updateWorkspaceVisibility();
    }
  } else if ((nextMode === "body" || nextMode === "face") && state.items.some((it) => !it.poseAnalyzed)) {
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

async function handleAutoTrackSubject() {
  if (state.busy || state.items.length < 2) return;
  const mode = state.settings.alignMode;
  const refIdx = state.selectedIndex;
  stopPlay();
  state.drawBoxMode = false;

  if (mode === "body" || mode === "face") {
    state.proportions = trackSelectedPersonAcrossBatch(state.items, refIdx, mode);
    renderFilmstrip();
    renderMainCanvas();
    renderInspector();
    showToast(t("stTrackedDone", state.items.length), 3200);
  } else if (mode === "object") {
    state.busy = true;
    updateWorkspaceVisibility();
    try {
      await trackSelectedObjectAcrossBatch(state.items, refIdx, (cur, tot, name) => {
        setStatus(true, t("stTrackingSubject", cur, tot, name), Math.round((cur / tot) * 96));
      });
      renderFilmstrip();
      renderMainCanvas();
      renderInspector();
      showToast(t("stTrackedDone", state.items.length), 3200);
    } catch (err) {
      console.error(err);
      showToast(`❌ ${err.message || err}`, 4000);
    } finally {
      state.busy = false;
      setStatus(false);
      updateWorkspaceVisibility();
    }
  }
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

function loadDemoSession() {
  if (state.busy) return;
  stopPlay();
  const demoItems = generateDemoItems();
  state.undoStack = [];
  state.redoStack = [];
  state.colorRefId = null;
  state.items = demoItems;
  state.selectedIndex = 0;
  state.proportions = finalizeBatchAlignment(state.items, state.settings.alignMode);
  refreshBatchColorTarget();
  updateWorkspaceVisibility();
  renderFilmstrip();
  renderMainCanvas();
  renderInspector();
  showToast(t("stDemoLoaded"), 4200);
}

function stopAuditionBgm() {
  if (!state.auditioningBgm) return;
  state.auditioningBgm = false;
  cancelAnimationFrame(state.auditionRafId);
  state.auditionRafId = null;
  if (!state.playing) audioMgr.stop();
  const audBtn = $("btnAuditionBgm");
  if (audBtn) {
    audBtn.classList.remove("active");
    audBtn.textContent = t("btnAuditionPlay");
  }
  if (audioMgr.hasAudio()) {
    audioMgr.renderWaveform($("beatWaveformCanvas"), state.settings.bgmStartSec || 0, -1);
  }
}

function toggleAuditionBgm() {
  if (!audioMgr.hasAudio()) return;
  if (state.auditioningBgm) {
    stopAuditionBgm();
    return;
  }
  stopPlay();
  state.auditioningBgm = true;
  const startSec = state.settings.bgmStartSec || 0;
  audioMgr.setVolume(state.settings.bgmVolume);
  audioMgr.playLoop(startSec);
  const audBtn = $("btnAuditionBgm");
  if (audBtn) {
    audBtn.classList.add("active");
    audBtn.textContent = t("btnAuditionStop");
  }
  const tickWave = () => {
    if (!state.auditioningBgm) return;
    audioMgr.renderWaveform($("beatWaveformCanvas"), state.settings.bgmStartSec || 0, audioMgr.getTrackPositionSec());
    state.auditionRafId = requestAnimationFrame(tickWave);
  };
  tickWave();
}

// Live Playback Preview (Audio-clock locked for real beat-cut "真卡点" + Milestone Hold!)
function togglePlay() {
  if (state.playing) {
    stopPlay();
    return;
  }
  stopAuditionBgm();
  const enabledIndices = state.items.map((it, i) => (it.enabled ? i : -1)).filter((i) => i >= 0);
  if (enabledIndices.length < 2) {
    showToast(t("errNeed2"));
    return;
  }

  const enabledItems = enabledIndices.map((i) => state.items[i]);
  const schedule = audioMgr.buildPhotoSchedule(enabledItems, state.settings);
  const totalDur = Math.max(0.2, schedule.totalDurationSec);

  state.playing = true;
  $("btnPlay").classList.add("active");
  $("btnPlay").textContent = t("btnPause");
  $("onionCanvas").classList.add("hidden");

  const startOffsetSec = state.settings.bgmStartSec || 0;
  const hasBgm = audioMgr.hasAudio();
  if (hasBgm) {
    audioMgr.setVolume(state.settings.bgmVolume);
    audioMgr.playLoop(startOffsetSec);
  }

  const startPos = Math.max(0, enabledIndices.indexOf(state.selectedIndex));
  // In real beat-cut mode with BGM, start cleanly from frame 0 so frame cuts align 1:1 with music beats!
  const initialTimeOffset = hasBgm && schedule.mode === "onset" ? 0 : schedule.startTimesSec[startPos] || 0;
  const fallbackStartPerf = performance.now();
  let lastRenderedPos = -1;

  const findPosForTime = (tSec) => {
    const tMod = ((tSec % totalDur) + totalDur) % totalDur;
    let lo = 0;
    let hi = schedule.startTimesSec.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (schedule.startTimesSec[mid] <= tMod) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const renderLoop = () => {
    if (!state.playing) return;
    const elapsedSec = hasBgm ? audioMgr.getPlaybackTime() : (performance.now() - fallbackStartPerf) / 1000;
    const pos = findPosForTime(initialTimeOffset + elapsedSec);

    if (pos !== lastRenderedPos) {
      lastRenderedPos = pos;
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
        customStickerImg: state.customStickerImg,
      });
      const starMark = item.milestone ? " ★" : "";
      const beatBadge = schedule.mode === "onset" ? " 🥁" : "";
      $("stageCounter").textContent = `▶ ${pos + 1} / ${enabledIndices.length} · ${item.dateStr}${starMark}${beatBadge}`;
    }

    if (hasBgm) {
      audioMgr.renderWaveform($("beatWaveformCanvas"), startOffsetSec, audioMgr.getTrackPositionSec());
    }

    state.playRafId = requestAnimationFrame(renderLoop);
  };

  renderLoop();
}

function stopPlay() {
  if (!state.playing) return;
  state.playing = false;
  clearTimeout(state.playTimer);
  state.playTimer = null;
  cancelAnimationFrame(state.playRafId);
  state.playRafId = null;
  audioMgr.stop();
  $("btnPlay").classList.remove("active");
  $("btnPlay").textContent = t("btnPlay");
  if (audioMgr.hasAudio()) {
    audioMgr.renderWaveform($("beatWaveformCanvas"), state.settings.bgmStartSec || 0, -1);
  }
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
  switchCompareTab("compare");
  updateComparePreview();
}

function switchCompareTab(tab) {
  document.querySelectorAll("#compareTabGroup .seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  $("tabComparePane").classList.toggle("hidden", tab !== "compare");
  $("tabPosterPane").classList.toggle("hidden", tab !== "poster");
  if (tab === "poster") updatePosterPreview();
}

function updatePosterPreview() {
  const enabled = state.items.filter((it) => it.enabled);
  if (enabled.length < 2) return;
  const title = $("txtPosterTitle").value.trim();
  const posterCanvas = renderGridPosterCanvas(enabled, state.settings, {
    gridCount: state.posterGridCount,
    title,
    lang: state.lang,
    batchColorTarget: state.batchColorTarget,
    customStickerImg: state.customStickerImg,
  });
  posterCanvas.toBlob((blob) => {
    if (!blob) return;
    if (state.lastPosterUrl) URL.revokeObjectURL(state.lastPosterUrl);
    state.lastPosterUrl = URL.createObjectURL(blob);
    $("posterPreviewImg").src = state.lastPosterUrl;
    const dl = $("btnDownloadPoster");
    dl.href = state.lastPosterUrl;
    dl.download = `eachday_poster_${state.posterGridCount}grid.png`;
  }, "image/png");
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
    state.batchColorTarget,
    state.customStickerImg
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

function openExportResultModal(blob, filename, kind = "video", extraMeta = "") {
  if (state.lastExportUrl) URL.revokeObjectURL(state.lastExportUrl);
  const url = URL.createObjectURL(blob);
  state.lastExportUrl = url;
  const sizeMb = (blob.size / (1024 * 1024)).toFixed(2);

  const isGif = kind === "gif";
  const video = $("exportVideoPlayer");
  const gifImg = $("exportGifPreview");
  video.classList.toggle("hidden", isGif);
  gifImg.classList.toggle("hidden", !isGif);
  if (isGif) {
    video.pause();
    video.removeAttribute("src");
    gifImg.src = url;
    $("exportModalTitle").textContent = t("expModalTitleGif");
    $("btnDownloadMp4").textContent = t("expDownloadGif");
  } else {
    gifImg.removeAttribute("src");
    video.muted = false;
    video.volume = 1.0;
    video.src = url;
    video.play().catch(() => {});
    $("exportModalTitle").textContent = t("expModalTitle");
    $("btnDownloadMp4").textContent = t("expDownload");
  }

  const dl = $("btnDownloadMp4");
  dl.href = url;
  dl.download = filename;
  $("exportMeta").textContent = `${filename} · ${sizeMb} MB${extraMeta ? ` · ${extraMeta}` : ""}`;
  $("exportModal").classList.remove("hidden");
  return sizeMb;
}

// Local MP4 Export (with optional Local BGM AAC Audio + Real Beat-Cut Schedule!)
async function handleExport() {
  const enabled = state.items.filter((it) => it.enabled);
  if (state.busy || !enabled.length) return;
  stopPlay();
  stopAuditionBgm();
  state.busy = true;
  updateWorkspaceVisibility();

  try {
    const schedule = audioMgr.buildPhotoSchedule(enabled, state.settings);
    const audioOpts = {
      audioBuffer: audioMgr.hasAudio() ? audioMgr.audioBuffer : null,
      volume: state.settings.bgmVolume,
      startOffsetSec: state.settings.bgmStartSec || 0,
      photoDurationsSec: schedule.mode === "onset" || schedule.mode === "bpm" ? schedule.durationsSec : null,
    };

    const { blob, ext, audioIncluded, audioCodec } = await exportTimelapseLocal(
      state.items,
      state.settings,
      state.lang,
      state.batchColorTarget,
      state.customStickerImg,
      audioOpts,
      (cur, tot, phase) => {
        if (phase === "finalizing") {
          setStatus(true, t("stFinalizing"), 98);
        } else {
          setStatus(true, t("stExporting", cur, tot), Math.round((cur / tot) * 95));
        }
      }
    );

    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
    const audioNote = audioOpts.audioBuffer
      ? audioIncluded
        ? state.lang === "en"
          ? `🔊 Music included (${(audioCodec || "AAC").toUpperCase()})`
          : `🔊 已合入配乐 (${(audioCodec || "AAC").toUpperCase()})`
        : state.lang === "en"
        ? "⚠️ Browser does not support audio muxing"
        : "⚠️ 当前浏览器不支持音频封装"
      : "";
    const sizeMb = openExportResultModal(blob, `eachday_${stamp}.${ext}`, "video", audioNote);
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

// Local Animated GIF Export
async function handleExportGif() {
  if (state.busy || !state.items.some((it) => it.enabled)) return;
  stopPlay();
  state.busy = true;
  updateWorkspaceVisibility();

  try {
    const enabled = state.items.filter((it) => it.enabled);
    const schedule = audioMgr.buildPhotoSchedule(enabled, state.settings);
    const customDurs = schedule.mode === "onset" || schedule.mode === "bpm" ? schedule.durationsSec : null;
    const { blob } = await exportGifLocal(
      state.items,
      state.settings,
      state.lang,
      state.batchColorTarget,
      state.customStickerImg,
      (cur, tot, phase) => {
        if (phase === "finalizing") {
          setStatus(true, t("stFinalizing"), 98);
        } else {
          setStatus(true, t("stExportingGif", cur, tot), Math.round((cur / tot) * 95));
        }
      },
      customDurs
    );
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
    const sizeMb = openExportResultModal(blob, `eachday_${stamp}.gif`, "gif");
    showToast(t("stGifDone", sizeMb), 3500);
  } catch (err) {
    console.error(err);
    showToast(`❌ ${err.message || err}`, 4500);
  } finally {
    state.busy = false;
    setStatus(false);
    updateWorkspaceVisibility();
  }
}

// Local Before / After Animated Curtain Wipe MP4 Export
async function handleExportWipeVideo() {
  const enabled = state.items.filter((it) => it.enabled);
  if (state.busy || enabled.length < 2) return;
  const li = Math.max(0, Math.min(enabled.length - 1, Number($("selCmpLeft").value) || 0));
  const ri = Math.max(0, Math.min(enabled.length - 1, Number($("selCmpRight").value) || enabled.length - 1));

  $("compareModal").classList.add("hidden");
  stopPlay();
  state.busy = true;
  updateWorkspaceVisibility();

  try {
    const audioOpts = audioMgr.hasAudio()
      ? {
          audioBuffer: audioMgr.audioBuffer,
          volume: state.settings.bgmVolume,
          startOffsetSec: state.settings.bgmStartSec || 0,
        }
      : null;

    const { blob, audioIncluded, audioCodec } = await exportWipeVideoLocal(
      enabled[li],
      enabled[ri],
      li + 1,
      ri + 1,
      enabled[0].timestamp,
      state.settings,
      state.lang,
      state.batchColorTarget,
      state.customStickerImg,
      audioOpts,
      (cur, tot, phase) => {
        if (phase === "finalizing") setStatus(true, t("stFinalizing"), 98);
        else setStatus(true, t("stExportingWipe", cur, tot), Math.round((cur / tot) * 95));
      }
    );
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").slice(0, 14);
    const audioNote = audioOpts
      ? audioIncluded
        ? state.lang === "en"
          ? `🔊 Music included (${(audioCodec || "AAC").toUpperCase()})`
          : `🔊 已合入配乐 (${(audioCodec || "AAC").toUpperCase()})`
        : ""
      : "";
    const sizeMb = openExportResultModal(blob, `eachday_wipe_${stamp}.mp4`, "video", audioNote);
    showToast(t("stWipeDone", sizeMb), 3500);
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
    pushHistory();
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

  // Interactive custom box drag-drawing in Object Mode
  const pickerWrap = $("sourcePickerWrap");
  const marquee = $("drawBoxMarquee");
  let drawingBox = false;
  let drawStartX = 0;
  let drawStartY = 0;

  pickerWrap.addEventListener("mousedown", (e) => {
    if (state.settings.alignMode !== "object" || !state.drawBoxMode) return;
    const item = currentItem();
    if (!item) return;
    const rect = $("sourceImg").getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    e.preventDefault();
    drawingBox = true;
    drawStartX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    drawStartY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    marquee.style.left = `${(drawStartX / rect.width) * 100}%`;
    marquee.style.top = `${(drawStartY / rect.height) * 100}%`;
    marquee.style.width = "0%";
    marquee.style.height = "0%";
    marquee.classList.remove("hidden");
  });

  window.addEventListener("mousemove", (e) => {
    if (!drawingBox) return;
    const rect = $("sourceImg").getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const x1 = Math.min(drawStartX, curX);
    const y1 = Math.min(drawStartY, curY);
    const w = Math.abs(curX - drawStartX);
    const h = Math.abs(curY - drawStartY);
    marquee.style.left = `${(x1 / rect.width) * 100}%`;
    marquee.style.top = `${(y1 / rect.height) * 100}%`;
    marquee.style.width = `${(w / rect.width) * 100}%`;
    marquee.style.height = `${(h / rect.height) * 100}%`;
  });

  window.addEventListener("mouseup", (e) => {
    if (!drawingBox) return;
    drawingBox = false;
    marquee.classList.add("hidden");
    const item = currentItem();
    if (!item) return;
    const rect = $("sourceImg").getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const curX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const curY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    const x1 = (Math.min(drawStartX, curX) / rect.width) * item.width;
    const y1 = (Math.min(drawStartY, curY) / rect.height) * item.height;
    const x2 = (Math.max(drawStartX, curX) / rect.width) * item.width;
    const y2 = (Math.max(drawStartY, curY) / rect.height) * item.height;
    if (x2 - x1 < 12 || y2 - y1 < 12) return;

    if (!item.objectCandidates) item.objectCandidates = [];
    // Replace any existing custom box on this photo
    item.objectCandidates = item.objectCandidates.filter((c) => !c.isCustom);
    item.objectCandidates.forEach((c, idx) => { c.index = idx; });
    const customCand = {
      index: item.objectCandidates.length,
      classId: -1,
      label: "custom",
      detConf: 1.0,
      score: 1.0,
      bbox: [x1, y1, x2, y2],
      isCustom: true,
    };
    item.objectCandidates.push(customCand);
    item.selectedObject = customCand.index;
    item.objectWarning = null;
    state.drawBoxMode = false;
    item.transform = computeCandidateTransform(item, null, state.proportions, "object");
    item.transform.userDx = 0;
    item.transform.userDy = 0;
    item.transform.userScale = 1;
    item.transform.userAngleDeg = 0;
    renderInspector();
    renderMainCanvas();
    refreshCurrentThumb();
  });

  pickerWrap.addEventListener("click", (e) => {
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
  pushHistory();
  item.milestone = !item.milestone;
  renderInspector();
  renderFilmstrip();
  renderMainCanvas();
}

function applyBpmToFps() {
  if (!state.settings.beatSync) return;
  const bpm = Math.max(50, Math.min(220, Number(state.settings.bpm) || 120));
  const div = Number(state.settings.beatDiv) || 1;
  const syncedFps = Math.max(1, Math.min(15, Math.round(((bpm / 60) * div) * 2) / 2));
  updateGlobalSetting({ fps: syncedFps }, false);
  if (state.playing) {
    stopPlay();
    togglePlay();
  }
}

function bindEvents() {
  $("btnLang").addEventListener("click", () => {
    state.lang = state.lang === "zh" ? "en" : "zh";
    localStorage.setItem("eachday_lang", state.lang);
    applyI18n();
  });

  $("btnPrivacyInfo").addEventListener("click", () => $("privacyModal").classList.remove("hidden"));
  $("btnCompare").addEventListener("click", openCompareModal);
  $("btnExportGif").addEventListener("click", handleExportGif);
  $("btnExportWipe").addEventListener("click", handleExportWipeVideo);
  $("btnLoadDemo").addEventListener("click", loadDemoSession);
  $("btnUndo").addEventListener("click", performUndo);
  $("btnRedo").addEventListener("click", performRedo);

  document.querySelectorAll("#compareTabGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchCompareTab(btn.dataset.tab))
  );
  document.querySelectorAll("#posterGridGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.posterGridCount = Number(btn.dataset.val) || 9;
      document.querySelectorAll("#posterGridGroup .seg-btn").forEach((b) =>
        b.classList.toggle("active", Number(b.dataset.val) === state.posterGridCount)
      );
      updatePosterPreview();
    })
  );
  $("txtPosterTitle").addEventListener("input", () => {
    $("txtPosterTitle").dataset.edited = "1";
    updatePosterPreview();
  });

  $("selCmpLeft").addEventListener("change", updateComparePreview);
  $("selCmpRight").addEventListener("change", updateComparePreview);

  // Local BGM Audio, Audition & Real Musical Beat-Cut ("真卡点")
  $("audioInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    stopPlay();
    stopAuditionBgm();
    try {
      audioMgr.lastSensitivity = state.settings.beatSensitivity ?? 0.55;
      const info = await audioMgr.loadFile(file);
      state.settings.bgmStartSec = 0;
      state.settings.bpm = info.detectedBpm || state.settings.bpm;
      state.settings.beatSync = true;
      state.settings.beatMode = "onset";
      persistSettings(state.settings);
      syncSettingsUI();
      showToast(t("stAudioLoaded", info.filename, info.beatCount, info.detectedBpm), 3800);
    } catch (err) {
      console.error("Audio load error:", err);
      showToast(`❌ ${t("errAudioLoad")}`, 3800);
    }
  });
  $("btnAuditionBgm").addEventListener("click", toggleAuditionBgm);
  $("btnClearBgm").addEventListener("click", () => {
    stopAuditionBgm();
    audioMgr.clear();
    state.settings.bgmStartSec = 0;
    persistSettings(state.settings);
    syncSettingsUI();
  });
  $("beatWaveformCanvas").addEventListener("click", (e) => {
    if (!audioMgr.hasAudio()) return;
    const rect = $("beatWaveformCanvas").getBoundingClientRect();
    const ratio = Math.max(0, Math.min(0.98, (e.clientX - rect.left) / Math.max(1, rect.width)));
    const nextStart = Number((ratio * audioMgr.duration).toFixed(1));
    updateGlobalSetting({ bgmStartSec: nextStart }, false);
    if (state.auditioningBgm) {
      audioMgr.playLoop(nextStart);
    } else if (state.playing) {
      stopPlay();
      togglePlay();
    }
  });
  $("rngBgmStart").addEventListener("input", (e) => {
    const nextStart = parseFloat(e.target.value) || 0;
    updateGlobalSetting({ bgmStartSec: nextStart }, false);
  });
  $("rngBgmStart").addEventListener("change", () => {
    if (state.auditioningBgm) audioMgr.playLoop(state.settings.bgmStartSec || 0);
    else if (state.playing) {
      stopPlay();
      togglePlay();
    }
  });
  $("rngBgmVol").addEventListener("input", (e) => {
    updateGlobalSetting({ bgmVolume: parseFloat(e.target.value) }, false);
  });
  $("chkBeatSync").addEventListener("change", (e) => {
    updateGlobalSetting({ beatSync: e.target.checked }, false);
    if (e.target.checked && state.settings.beatMode === "bpm") applyBpmToFps();
    if (state.playing) {
      stopPlay();
      togglePlay();
    }
  });
  document.querySelectorAll("#beatModeGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      updateGlobalSetting({ beatMode: btn.dataset.val }, false);
      if (btn.dataset.val === "bpm") applyBpmToFps();
      if (state.playing) {
        stopPlay();
        togglePlay();
      }
    })
  );
  $("rngBeatSens").addEventListener("input", (e) => {
    const sens = parseFloat(e.target.value) || 0.55;
    state.settings.beatSensitivity = sens;
    if (audioMgr.hasAudio()) audioMgr.detectBeats(sens);
    persistSettings(state.settings);
    syncSettingsUI();
  });
  $("rngBeatSens").addEventListener("change", () => {
    if (state.playing) {
      stopPlay();
      togglePlay();
    }
  });
  $("numBpm").addEventListener("input", (e) => {
    const val = Math.max(50, Math.min(220, Number(e.target.value) || 120));
    state.settings.bpm = val;
    persistSettings(state.settings);
    applyBpmToFps();
  });
  $("btnTapBpm").addEventListener("click", () => {
    const now = performance.now();
    if (state.tapTimes.length && now - state.tapTimes[state.tapTimes.length - 1] > 2200) {
      state.tapTimes = [];
    }
    state.tapTimes.push(now);
    if (state.tapTimes.length > 8) state.tapTimes.shift();
    const bpm = computeTappedBpm(state.tapTimes);
    if (bpm) {
      state.settings.bpm = bpm;
      state.settings.beatSync = true;
      state.settings.beatMode = "bpm";
      persistSettings(state.settings);
      syncSettingsUI();
      applyBpmToFps();
    }
  });
  document.querySelectorAll("#beatDivGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.settings.beatDiv = Number(btn.dataset.val) || 1;
      persistSettings(state.settings);
      syncSettingsUI();
      if (state.settings.beatMode === "bpm") applyBpmToFps();
      if (state.playing) {
        stopPlay();
        togglePlay();
      }
    })
  );

  // Manual Photo Date Editor
  $("inpItemDate").addEventListener("change", (e) => {
    const item = currentItem();
    const raw = e.target.value; // YYYY-MM-DD
    if (!item || !raw) return;
    const parts = raw.split("-").map(Number);
    if (parts.length !== 3) return;
    const dt = new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0);
    if (Number.isNaN(dt.getTime())) return;

    pushHistory();
    const activeId = item.id;
    item.timestamp = dt.getTime() / 1000;
    item.dateStr = `${parts[0]}.${String(parts[1]).padStart(2, "0")}.${String(parts[2]).padStart(2, "0")}`;
    item.dateSource = "manual";

    const sortMode = $("selSort").value;
    if (sortMode === "date_asc" || sortMode === "date_desc") {
      sortItemsList(state.items, sortMode);
      const newIdx = state.items.findIndex((it) => it.id === activeId);
      if (newIdx >= 0) state.selectedIndex = newIdx;
    }
    renderFilmstrip();
    renderMainCanvas();
    renderInspector();
  });

  // PWA Install Prompt
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    $("btnInstallPwa").classList.remove("hidden");
  });
  $("btnInstallPwa").addEventListener("click", async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $("btnInstallPwa").classList.add("hidden");
  });

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

  // Depth-of-Field Subject Background Bokeh
  $("chkBgBokeh").addEventListener("change", (e) => {
    updateGlobalSetting({ bgBokeh: e.target.checked }, true);
  });
  $("rngBokehStrength").addEventListener("input", (e) =>
    updateGlobalSetting({ bgBokehStrength: parseFloat(e.target.value) }, false)
  );
  $("rngBokehStrength").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("rngBokehSize").addEventListener("input", (e) =>
    updateGlobalSetting({ bgBokehSize: parseFloat(e.target.value) }, false)
  );
  $("rngBokehSize").addEventListener("change", () => state.items.length && renderFilmstrip());

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
  document.querySelectorAll("#bgEmojiPickerRow .emoji-btn").forEach((btn) =>
    btn.addEventListener("click", () =>
      updateGlobalSetting({ bgMask: "emoji", bgEmoji: btn.dataset.bgEmoji }, true)
    )
  );
  $("txtBgEmoji").addEventListener("input", (e) => {
    const val = e.target.value.trim();
    updateGlobalSetting({ bgMask: "emoji", bgEmoji: val }, false);
  });
  $("txtBgEmoji").addEventListener("change", () => state.items.length && renderFilmstrip());
  document.querySelectorAll("#emojiPickerRow .emoji-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.customStickerImg = null;
      if (state.customStickerUrl) {
        URL.revokeObjectURL(state.customStickerUrl);
        state.customStickerUrl = null;
      }
      updateGlobalSetting({ selfMask: "emoji", selfEmoji: btn.dataset.emoji }, true);
    })
  );
  $("txtCustomSticker").addEventListener("input", (e) => {
    const val = e.target.value.trim();
    state.customStickerImg = null;
    if (state.customStickerUrl) {
      URL.revokeObjectURL(state.customStickerUrl);
      state.customStickerUrl = null;
    }
    updateGlobalSetting({ selfMask: "emoji", selfEmoji: val }, false);
  });
  $("txtCustomSticker").addEventListener("change", () => state.items.length && renderFilmstrip());

  $("stickerImgInput").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });
      if (state.customStickerUrl) URL.revokeObjectURL(state.customStickerUrl);
      state.customStickerImg = img;
      state.customStickerUrl = url;
      updateGlobalSetting({ selfMask: "emoji" }, true);
    } catch {
      showToast("❌ Failed to load sticker image");
    }
  });

  $("btnClearStickerImg").addEventListener("click", () => {
    state.customStickerImg = null;
    if (state.customStickerUrl) {
      URL.revokeObjectURL(state.customStickerUrl);
      state.customStickerUrl = null;
    }
    syncSettingsUI();
    if (state.items.length) {
      renderMainCanvas();
      renderFilmstrip();
    }
  });

  // Keep preview frame locked to exact target aspect ratio on any window/layout resize
  const vpWrap = document.querySelector(".viewport-wrap");
  if (vpWrap && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => fitPreviewFrameToViewport()).observe(vpWrap);
  }
  window.addEventListener("resize", fitPreviewFrameToViewport);
  $("rngMaskScale").addEventListener("input", (e) => updateGlobalSetting({ maskScale: parseFloat(e.target.value) }, false));
  $("rngMaskScale").addEventListener("change", () => state.items.length && renderFilmstrip());

  $("rngZoom").addEventListener("input", (e) => updateGlobalSetting({ zoom: parseFloat(e.target.value) }, false));
  $("rngZoom").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("rngVShift").addEventListener("input", (e) => updateGlobalSetting({ verticalShift: parseFloat(e.target.value) }, false));
  $("rngVShift").addEventListener("change", () => state.items.length && renderFilmstrip());
  $("chkAutoLevel").addEventListener("change", (e) => updateGlobalSetting({ autoLevel: e.target.checked }, true));

  // Watermark & Progress Bar + Editable Visual Style
  $("chkWatermark").addEventListener("change", (e) => updateGlobalSetting({ showWatermark: e.target.checked }, false));
  document.querySelectorAll("#labelThemeGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const theme = btn.dataset.val;
      const preset = LABEL_THEME_PRESETS[theme] || LABEL_THEME_PRESETS.pill;
      updateGlobalSetting({ labelTheme: theme, ...preset }, false);
    })
  );
  $("btnToggleStyleEditor").addEventListener("click", () => {
    state.styleEditorOpen = !state.styleEditorOpen;
    $("styleEditorBox").classList.toggle("hidden", !state.styleEditorOpen);
  });
  $("btnResetStyle").addEventListener("click", () => {
    const theme = state.settings.labelTheme || "pill";
    const preset = LABEL_THEME_PRESETS[theme] || LABEL_THEME_PRESETS.pill;
    updateGlobalSetting({ ...preset }, false);
  });
  $("selLabelFont").addEventListener("change", (e) => updateGlobalSetting({ labelFont: e.target.value }, false));
  $("rngLabelSize").addEventListener("input", (e) =>
    updateGlobalSetting({ labelSize: parseFloat(e.target.value) }, false)
  );
  $("inpLabelColor").addEventListener("input", (e) => updateGlobalSetting({ labelColor: e.target.value }, false));
  document.querySelectorAll(".color-swatch").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ labelColor: btn.dataset.color }, false))
  );
  $("inpLabelAccent").addEventListener("input", (e) => updateGlobalSetting({ labelAccent: e.target.value }, false));
  document.querySelectorAll(".accent-swatch").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ labelAccent: btn.dataset.accent }, false))
  );
  document.querySelectorAll("#labelBgStyleGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => updateGlobalSetting({ labelBgStyle: btn.dataset.val }, false))
  );
  $("rngLabelBgOpacity").addEventListener("input", (e) =>
    updateGlobalSetting({ labelBgOpacity: parseFloat(e.target.value) }, false)
  );
  $("rngLabelTracking").addEventListener("input", (e) =>
    updateGlobalSetting({ labelTracking: parseInt(e.target.value, 10) || 0 }, false)
  );
  $("chkLabelUppercase").addEventListener("change", (e) =>
    updateGlobalSetting({ labelUppercase: e.target.checked }, false)
  );
  $("txtMagazineTitle").addEventListener("input", (e) =>
    updateGlobalSetting({ magazineTitle: e.target.value }, false)
  );
  $("selWmStyle").addEventListener("change", (e) => updateGlobalSetting({ watermarkStyle: e.target.value }, false));
  $("selWmPos").addEventListener("change", (e) => updateGlobalSetting({ watermarkPosition: e.target.value }, false));
  $("txtLabelTemplate").addEventListener("input", (e) =>
    updateGlobalSetting({ labelTemplate: e.target.value }, false)
  );
  document.querySelectorAll(".token-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const inp = $("txtLabelTemplate");
      const token = chip.dataset.token || "";
      const start = inp.selectionStart ?? inp.value.length;
      const end = inp.selectionEnd ?? inp.value.length;
      const nextVal = inp.value.slice(0, start) + token + inp.value.slice(end);
      inp.value = nextVal;
      inp.focus();
      const pos = start + token.length;
      inp.setSelectionRange(pos, pos);
      updateGlobalSetting({ watermarkStyle: "template", labelTemplate: nextVal }, false);
    });
  });
  document.querySelectorAll(".tpl-preset-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      const tpl = chip.dataset.tpl || "Day {n2} · {date}";
      $("txtLabelTemplate").value = tpl;
      updateGlobalSetting({ watermarkStyle: "template", labelTemplate: tpl }, false);
    });
  });
  $("txtCustomPrefix").addEventListener("input", (e) => updateGlobalSetting({ customPrefix: e.target.value }, false));
  $("chkCustomElapsed").addEventListener("change", (e) => updateGlobalSetting({ customUseElapsed: e.target.checked }, false));
  $("chkCustomDate").addEventListener("change", (e) => updateGlobalSetting({ customShowDate: e.target.checked }, false));
  document.querySelectorAll("#customLabelBox .preset-chip").forEach((chip) => {
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

  // Auto-Track & Custom Box buttons
  $("btnTrackAll").addEventListener("click", handleAutoTrackSubject);
  $("btnDrawBox").addEventListener("click", () => {
    state.drawBoxMode = !state.drawBoxMode;
    renderInspector();
  });

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
    pushHistory();
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
    pushHistory();
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
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) performRedo();
      else performUndo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      performRedo();
      return;
    }
    if (e.key === "ArrowLeft") { e.preventDefault(); stopPlay(); selectIndex(state.selectedIndex - 1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); stopPlay(); selectIndex(state.selectedIndex + 1); }
    else if (e.key === " ") { e.preventDefault(); togglePlay(); }
    else if (e.key.toLowerCase() === "g") { $("btnGuides").click(); }
    else if (e.key.toLowerCase() === "o") { $("btnOnion").click(); }
    else if (e.key.toLowerCase() === "m") { toggleMilestoneCurrent(); }
    else if (e.key.toLowerCase() === "x") {
      const item = currentItem();
      if (item) {
        pushHistory();
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

// Register Offline-First PWA Service Worker
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

bindEvents();
applyI18n();
updateWorkspaceVisibility();
