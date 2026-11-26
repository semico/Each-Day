/* EachDay Interactive Alignment Studio Frontend */

const state = {
  macos: true,
  sourceLabel: "",
  items: [],
  settings: null,
  selectedIndex: 0,
  showGuides: true,
  showOnion: false,
  playing: false,
  playTimer: null,
  renderVersion: 1,
  pollTimer: null,
  lastExportStamp: 0,
};

const $ = (id) => document.getElementById(id);

function showToast(msg, duration = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), duration);
}

async function apiJson(url, options = {}) {
  const resp = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.detail || `请求失败 (${resp.status})`);
  }
  return data;
}

function currentItem() {
  if (!state.items.length) return null;
  const idx = Math.max(0, Math.min(state.items.length - 1, state.selectedIndex));
  return state.items[idx];
}

function previewUrl(itemId, width = 540, guides = false) {
  return `/api/items/${encodeURIComponent(itemId)}/preview?w=${width}&guides=${guides ? 1 : 0}&v=${state.renderVersion}`;
}

function updatePreviewAspect() {
  const ratio = state.settings?.aspect_ratio || "9:16";
  const [rw, rh] = ratio.split(":").map(Number);
  const frame = $("previewFrame");
  frame.style.aspectRatio = `${rw} / ${rh}`;
}

function syncSettingsUI() {
  const s = state.settings;
  if (!s) return;

  const setSeg = (groupId, val) => {
    document.querySelectorAll(`#${groupId} .seg-btn`).forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.val === val);
    });
  };
  setSeg("aspectGroup", s.aspect_ratio);
  setSeg("resGroup", s.resolution);
  setSeg("fillGroup", s.fill_mode);

  $("rngZoom").value = s.zoom;
  $("valZoom").textContent = `${Number(s.zoom).toFixed(2)}×`;
  $("rngVShift").value = s.vertical_shift;
  $("valVShift").textContent = `${Math.round(s.vertical_shift * 100)}%`;
  $("chkAutoLevel").checked = !!s.auto_level;

  $("chkWatermark").checked = !!s.show_watermark;
  $("watermarkOptions").classList.toggle("hidden", !s.show_watermark);
  $("selWmStyle").value = s.watermark_style;
  $("selWmPos").value = s.watermark_position;

  $("rngFps").value = s.fps;
  $("valFps").textContent = `${s.fps} 张/秒`;
  $("rngHold").value = s.hold_last_sec;
  $("valHold").textContent = `${Number(s.hold_last_sec).toFixed(1)} 秒`;
  $("chkCrossfade").checked = !!s.crossfade;

  updatePreviewAspect();
}

function renderFilmstrip() {
  const track = $("filmstripTrack");
  track.innerHTML = "";

  const enabledCount = state.items.filter((it) => it.enabled).length;
  $("filmstripStats").textContent = `共 ${state.items.length} 张照片 · 已保留 ${enabledCount} 张`;
  $("btnExport").disabled = enabledCount === 0;

  let seq = 0;
  state.items.forEach((item, idx) => {
    if (item.enabled) seq += 1;
    const card = document.createElement("div");
    card.className = "thumb-card" + (idx === state.selectedIndex ? " active" : "") + (!item.enabled ? " disabled" : "");
    card.dataset.index = idx;

    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = previewUrl(item.id, 160, false);
    img.alt = item.filename;
    card.appendChild(img);

    const lbl = document.createElement("div");
    lbl.className = "thumb-label";
    lbl.textContent = item.enabled ? `D${String(seq).padStart(2, "0")} · ${item.date_str.slice(5)}` : "已跳过";
    card.appendChild(lbl);

    if (item.warning) {
      const warn = document.createElement("div");
      warn.className = "thumb-warn";
      warn.title = item.warning;
      warn.textContent = "!";
      card.appendChild(warn);
    }

    card.addEventListener("click", () => selectIndex(idx));
    track.appendChild(card);
  });
}

function refreshMainPreview() {
  const item = currentItem();
  if (!item) return;

  $("previewImg").src = previewUrl(item.id, 600, state.showGuides && !state.playing);
  $("stageCounter").textContent = `${state.selectedIndex + 1} / ${state.items.length} · ${item.date_str}`;

  // Onion-skin reference: previous enabled item (or first enabled item if at index 0)
  const onion = $("onionImg");
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
      onion.src = previewUrl(refItem.id, 600, false);
      onion.classList.remove("hidden");
    } else {
      onion.classList.add("hidden");
    }
  } else {
    onion.classList.add("hidden");
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
  const srcMap = { exif: "EXIF日期", filename: "文件名日期", mtime: "文件时间" };
  $("insMeta").textContent = `${item.date_str} (${srcMap[item.date_source] || item.date_source}) · ${item.width}×${item.height}`;

  $("chkItemEnabled").checked = !!item.enabled;
  $("lblItemEnabled").textContent = item.enabled ? "已保留" : "已跳过";

  const warnBox = $("insWarning");
  if (item.warning) {
    warnBox.textContent = `⚠️ ${item.warning}`;
    warnBox.classList.remove("hidden");
  } else {
    warnBox.classList.add("hidden");
  }

  // Candidate bounding box picker on original photo
  $("insCandCount").textContent = `${item.candidates.length} 人`;
  const srcImg = $("sourceImg");
  srcImg.src = `/api/items/${encodeURIComponent(item.id)}/source?max_side=520`;

  const overlay = $("candidateOverlay");
  overlay.innerHTML = "";
  item.candidates.forEach((cand) => {
    const [x1, y1, x2, y2] = cand.bbox;
    const box = document.createElement("div");
    box.className = "cand-box" + (cand.index === item.selected_candidate ? " selected" : "");
    box.style.left = `${(x1 / item.width) * 100}%`;
    box.style.top = `${(y1 / item.height) * 100}%`;
    box.style.width = `${((x2 - x1) / item.width) * 100}%`;
    box.style.height = `${((y2 - y1) / item.height) * 100}%`;

    const tag = document.createElement("div");
    tag.className = "cand-tag";
    tag.textContent = cand.index === item.selected_candidate ? `✓ 主体 #${cand.index + 1}` : `人物 #${cand.index + 1}`;
    box.appendChild(tag);

    box.addEventListener("click", () => patchCurrentItem({ selected_candidate: cand.index }, true));
    overlay.appendChild(box);
  });

  // Per-frame fine-tuning sliders
  const t = item.transform;
  $("rngItemDx").value = t.user_dx;
  $("valItemDx").textContent = `${Math.round(t.user_dx * 100)}%`;
  $("rngItemDy").value = t.user_dy;
  $("valItemDy").textContent = `${Math.round(t.user_dy * 100)}%`;
  $("rngItemScale").value = t.user_scale;
  $("valItemScale").textContent = `${Number(t.user_scale).toFixed(2)}×`;
  $("rngItemAngle").value = t.user_angle_deg;
  $("valItemAngle").textContent = `${Number(t.user_angle_deg).toFixed(1)}°`;
}

function selectIndex(idx) {
  if (!state.items.length) return;
  state.selectedIndex = (idx + state.items.length) % state.items.length;

  document.querySelectorAll(".thumb-card").forEach((el) => {
    const active = Number(el.dataset.index) === state.selectedIndex;
    el.classList.toggle("active", active);
    if (active) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  });

  refreshMainPreview();
  renderInspector();
}

function updateActiveWorkspaceVisibility() {
  const hasItems = state.items.length > 0;
  $("emptyState").classList.toggle("hidden", hasItems);
  $("canvasWorkspace").classList.toggle("hidden", !hasItems);
  $("filmstripBar").classList.toggle("hidden", !hasItems);
  $("sourceLabel").textContent = state.sourceLabel || "自动对齐健身照片主体，生成成长延时视频";
}

async function fetchFullState(preserveSelection = true) {
  const data = await apiJson("/api/state");
  state.macos = data.macos;
  state.sourceLabel = data.source_label;
  state.items = data.items || [];
  state.settings = data.settings;

  if (!state.macos) {
    $("btnPhotosAlbum").classList.add("hidden");
    $("btnEmptyPhotos").classList.add("hidden");
  }

  if (!preserveSelection || state.selectedIndex >= state.items.length) {
    state.selectedIndex = 0;
  }

  state.renderVersion += 1;
  syncSettingsUI();
  updateActiveWorkspaceVisibility();
  renderFilmstrip();
  refreshMainPreview();
  renderInspector();
  applyStatus(data.status);
}

function applyStatus(st) {
  if (!st) return;
  const bar = $("statusBar");
  const busy = st.state === "importing" || st.state === "analyzing" || st.state === "exporting";

  if (busy) {
    bar.classList.remove("hidden");
    $("statusText").textContent = st.message || "处理中...";
    const pct = st.total > 0 ? Math.min(100, Math.round((st.current / st.total) * 100)) : 25;
    $("statusProgress").style.width = `${pct}%`;
    startPolling();
  } else {
    bar.classList.add("hidden");
    if (st.error) {
      showToast(`❌ ${st.error}`, 4500);
    }
    if (st.last_export && st.last_export.timestamp > state.lastExportStamp) {
      state.lastExportStamp = st.last_export.timestamp;
      openExportModal(st.last_export);
    }
  }
}

function startPolling() {
  if (state.pollTimer) return;
  let prevState = "busy";
  state.pollTimer = setInterval(async () => {
    try {
      const st = await apiJson("/api/status");
      const busy = st.state === "importing" || st.state === "analyzing" || st.state === "exporting";
      applyStatus(st);
      if (!busy && prevState === "busy") {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
        await fetchFullState(false);
        if (st.message && !st.error) showToast(st.message);
      }
      prevState = busy ? "busy" : "idle";
    } catch (e) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }, 450);
}

let settingsDebounce = null;
function patchSettings(patch, immediate = false) {
  state.settings = { ...state.settings, ...patch };
  syncSettingsUI();
  const commit = async () => {
    try {
      state.settings = await apiJson("/api/settings", {
        method: "POST",
        body: JSON.stringify(patch),
      });
      state.renderVersion += 1;
      syncSettingsUI();
      refreshMainPreview();
      // Refresh visible filmstrip thumbnails if visual settings changed
      if ("aspect_ratio" in patch || "zoom" in patch || "vertical_shift" in patch || "fill_mode" in patch || "auto_level" in patch) {
        renderFilmstrip();
      }
    } catch (e) {
      showToast(e.message);
    }
  };
  clearTimeout(settingsDebounce);
  if (immediate) commit();
  else settingsDebounce = setTimeout(commit, 120);
}

let itemDebounce = null;
function patchCurrentItem(patch, immediate = false) {
  const item = currentItem();
  if (!item) return;

  const commit = async () => {
    try {
      const updated = await apiJson(`/api/items/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      state.items[state.selectedIndex] = updated;
      state.renderVersion += 1;
      refreshMainPreview();
      renderInspector();
      // Update single thumbnail
      const card = document.querySelector(`.thumb-card[data-index="${state.selectedIndex}"]`);
      if (card) {
        card.classList.toggle("disabled", !updated.enabled);
        const img = card.querySelector("img");
        if (img) img.src = previewUrl(updated.id, 160, false);
      }
      if ("enabled" in patch) renderFilmstrip();
    } catch (e) {
      showToast(e.message);
    }
  };

  clearTimeout(itemDebounce);
  if (immediate) commit();
  else itemDebounce = setTimeout(commit, 90);
}

// Playback preview
function togglePlay() {
  if (state.playing) {
    stopPlay();
    return;
  }
  const enabledIndices = state.items.map((it, i) => (it.enabled ? i : -1)).filter((i) => i >= 0);
  if (enabledIndices.length < 2) {
    showToast("至少需要 2 张启用的照片才能播放预览");
    return;
  }
  state.playing = true;
  $("btnPlay").classList.add("active");
  $("btnPlay").textContent = "⏸ 暂停预览";

  // Preload images into browser cache for ultra-smooth playback
  const preloaded = enabledIndices.map((idx) => {
    const im = new Image();
    im.src = previewUrl(state.items[idx].id, 600, false);
    return { idx, url: im.src };
  });

  let pos = Math.max(0, enabledIndices.indexOf(state.selectedIndex));
  const fps = Math.max(1, state.settings?.fps || 6);
  const intervalMs = Math.round(1000 / fps);

  const tick = () => {
    if (!state.playing) return;
    const entry = preloaded[pos];
    state.selectedIndex = entry.idx;
    $("previewImg").src = entry.url;
    $("onionImg").classList.add("hidden");
    const it = state.items[entry.idx];
    $("stageCounter").textContent = `▶ ${pos + 1} / ${preloaded.length} · ${it.date_str}`;
    pos = (pos + 1) % preloaded.length;
  };

  tick();
  state.playTimer = setInterval(tick, intervalMs);
}

function stopPlay() {
  state.playing = false;
  clearInterval(state.playTimer);
  state.playTimer = null;
  $("btnPlay").classList.remove("active");
  $("btnPlay").textContent = "▶ 播放预览";
  selectIndex(state.selectedIndex);
}

// Import flows
async function importFolder(folderPath) {
  stopPlay();
  try {
    await apiJson("/api/import/folder", {
      method: "POST",
      body: JSON.stringify({ folder: folderPath, recursive: false }),
    });
    applyStatus({ state: "analyzing", current: 0, total: 1, message: "正在扫描文件夹..." });
  } catch (e) {
    showToast(`❌ ${e.message}`, 3500);
  }
}

async function openFolderPicker() {
  try {
    const res = await apiJson("/api/pick-folder", { method: "POST" });
    if (res.path) {
      await importFolder(res.path);
    }
  } catch (e) {
    showToast(`❌ ${e.message}`);
  }
}

async function uploadFiles(fileList) {
  if (!fileList || !fileList.length) return;
  stopPlay();
  const fd = new FormData();
  for (const f of fileList) fd.append("files", f);
  try {
    applyStatus({ state: "importing", current: 0, total: fileList.length, message: `正在上传 ${fileList.length} 张照片...` });
    const resp = await fetch("/api/import/upload", { method: "POST", body: fd });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.detail || "上传失败");
    startPolling();
  } catch (e) {
    $("statusBar").classList.add("hidden");
    showToast(`❌ ${e.message}`, 3500);
  }
}

async function openPhotosModal() {
  $("photosModal").classList.remove("hidden");
  const list = $("albumList");
  list.innerHTML = `<div class="muted-center">正在读取 macOS「照片」相簿列表...</div>`;
  try {
    const data = await apiJson("/api/photos/albums");
    const albums = data.albums || [];
    if (!albums.length) {
      list.innerHTML = `<div class="muted-center">未找到包含照片的自定义相簿。<br/>你可以先在「照片」App 中把健身照放进一个相簿，再点此导入。</div>`;
      return;
    }
    list.innerHTML = "";
    albums.forEach((alb) => {
      const btn = document.createElement("button");
      btn.className = "album-row";
      btn.innerHTML = `<span>📁 ${alb.name}</span><span class="badge">${alb.count} 张</span>`;
      btn.addEventListener("click", async () => {
        $("photosModal").classList.add("hidden");
        stopPlay();
        try {
          await apiJson("/api/import/photos-album", {
            method: "POST",
            body: JSON.stringify({ album_name: alb.name }),
          });
          applyStatus({ state: "importing", current: 0, total: 1, message: `正在导出相簿「${alb.name}」...` });
        } catch (e) {
          showToast(`❌ ${e.message}`, 4000);
        }
      });
      list.appendChild(btn);
    });
  } catch (e) {
    list.innerHTML = `<div class="warning-box">${e.message}</div>`;
  }
}

function openExportModal(exp) {
  $("exportModal").classList.remove("hidden");
  const video = $("exportVideoPlayer");
  video.src = `/api/export/download?t=${Date.now()}`;
  $("exportMeta").textContent = `已保存至：${exp.path}（${exp.size_mb} MB）`;
}

// Interactive Drag & Wheel on Preview Frame
function bindPreviewInteractions() {
  const frame = $("previewFrame");
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origDx = 0;
  let origDy = 0;

  frame.addEventListener("mousedown", (e) => {
    if (state.playing) return;
    const item = currentItem();
    if (!item) return;
    dragging = true;
    frame.classList.add("dragging");
    startX = e.clientX;
    startY = e.clientY;
    origDx = item.transform.user_dx;
    origDy = item.transform.user_dy;
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = frame.getBoundingClientRect();
    const dx = origDx + (e.clientX - startX) / rect.width;
    const dy = origDy + (e.clientY - startY) / rect.height;
    const clampedDx = Math.max(-0.3, Math.min(0.3, dx));
    const clampedDy = Math.max(-0.3, Math.min(0.3, dy));
    $("rngItemDx").value = clampedDx;
    $("valItemDx").textContent = `${Math.round(clampedDx * 100)}%`;
    $("rngItemDy").value = clampedDy;
    $("valItemDy").textContent = `${Math.round(clampedDy * 100)}%`;
    patchCurrentItem({ user_dx: clampedDx, user_dy: clampedDy });
  });

  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    frame.classList.remove("dragging");
  });

  frame.addEventListener(
    "wheel",
    (e) => {
      if (state.playing) return;
      const item = currentItem();
      if (!item) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.03 : -0.03;
      const nextScale = Math.max(0.6, Math.min(1.6, Number(item.transform.user_scale) + delta));
      item.transform.user_scale = nextScale;
      $("rngItemScale").value = nextScale;
      $("valItemScale").textContent = `${nextScale.toFixed(2)}×`;
      patchCurrentItem({ user_scale: nextScale });
    },
    { passive: false }
  );
}

function bindEvents() {
  // Import buttons
  $("btnPickFolder").addEventListener("click", openFolderPicker);
  $("btnEmptyFolder").addEventListener("click", openFolderPicker);
  $("btnPhotosAlbum").addEventListener("click", openPhotosModal);
  $("btnEmptyPhotos").addEventListener("click", openPhotosModal);
  $("fileInput").addEventListener("change", (e) => uploadFiles(e.target.files));

  $("btnLoadManualPath").addEventListener("click", () => {
    const val = $("manualPathInput").value.trim();
    if (val) importFolder(val);
  });
  $("manualPathInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const val = e.target.value.trim();
      if (val) importFolder(val);
    }
  });

  // Drag & drop anywhere on dropZone
  const dz = $("dropZone");
  ["dragenter", "dragover"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    })
  );
  ["dragleave", "drop"].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
    })
  );
  dz.addEventListener("drop", (e) => {
    if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
  });

  // Global setting segmented controls
  document.querySelectorAll("#aspectGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => patchSettings({ aspect_ratio: btn.dataset.val }, true))
  );
  document.querySelectorAll("#resGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => patchSettings({ resolution: btn.dataset.val }, true))
  );
  document.querySelectorAll("#fillGroup .seg-btn").forEach((btn) =>
    btn.addEventListener("click", () => patchSettings({ fill_mode: btn.dataset.val }, true))
  );

  $("rngZoom").addEventListener("input", (e) => patchSettings({ zoom: parseFloat(e.target.value) }));
  $("rngVShift").addEventListener("input", (e) => patchSettings({ vertical_shift: parseFloat(e.target.value) }));
  $("chkAutoLevel").addEventListener("change", (e) => patchSettings({ auto_level: e.target.checked }, true));

  $("chkWatermark").addEventListener("change", (e) => patchSettings({ show_watermark: e.target.checked }, true));
  $("selWmStyle").addEventListener("change", (e) => patchSettings({ watermark_style: e.target.value }, true));
  $("selWmPos").addEventListener("change", (e) => patchSettings({ watermark_position: e.target.value }, true));

  $("rngFps").addEventListener("input", (e) => patchSettings({ fps: parseFloat(e.target.value) }));
  $("rngHold").addEventListener("input", (e) => patchSettings({ hold_last_sec: parseFloat(e.target.value) }));
  $("chkCrossfade").addEventListener("change", (e) => patchSettings({ crossfade: e.target.checked }, true));

  // Stage toolbar
  $("btnPlay").addEventListener("click", togglePlay);
  $("btnGuides").addEventListener("click", () => {
    state.showGuides = !state.showGuides;
    $("btnGuides").classList.toggle("active", state.showGuides);
    refreshMainPreview();
  });
  $("btnOnion").addEventListener("click", () => {
    state.showOnion = !state.showOnion;
    $("btnOnion").classList.toggle("active", state.showOnion);
    refreshMainPreview();
  });
  $("btnPrev").addEventListener("click", () => { stopPlay(); selectIndex(state.selectedIndex - 1); });
  $("btnNext").addEventListener("click", () => { stopPlay(); selectIndex(state.selectedIndex + 1); });

  // Right inspector controls
  $("chkItemEnabled").addEventListener("change", (e) => patchCurrentItem({ enabled: e.target.checked }, true));
  $("btnResetItem").addEventListener("click", () => patchCurrentItem({ reset_transform: true }, true));
  $("rngItemDx").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    $("valItemDx").textContent = `${Math.round(v * 100)}%`;
    patchCurrentItem({ user_dx: v });
  });
  $("rngItemDy").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    $("valItemDy").textContent = `${Math.round(v * 100)}%`;
    patchCurrentItem({ user_dy: v });
  });
  $("rngItemScale").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    $("valItemScale").textContent = `${v.toFixed(2)}×`;
    patchCurrentItem({ user_scale: v });
  });
  $("rngItemAngle").addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    $("valItemAngle").textContent = `${v.toFixed(1)}°`;
    patchCurrentItem({ user_angle_deg: v });
  });

  // Sort dropdown
  $("selSort").addEventListener("change", async (e) => {
    stopPlay();
    try {
      const res = await apiJson("/api/items/reorder", {
        method: "POST",
        body: JSON.stringify({ mode: e.target.value }),
      });
      state.items = res.items;
      state.selectedIndex = 0;
      state.renderVersion += 1;
      renderFilmstrip();
      refreshMainPreview();
      renderInspector();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Export button
  $("btnExport").addEventListener("click", async () => {
    stopPlay();
    try {
      await apiJson("/api/export", { method: "POST", body: JSON.stringify({}) });
      applyStatus({ state: "exporting", current: 0, total: state.items.length, message: "正在导出高清 MP4..." });
    } catch (e) {
      showToast(`❌ ${e.message}`, 4000);
    }
  });

  $("btnRevealFinder").addEventListener("click", async () => {
    try {
      await apiJson("/api/export/reveal", { method: "POST" });
    } catch (e) {
      showToast(e.message);
    }
  });

  // Modal close buttons
  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.close;
      $(target).classList.add("hidden");
      if (target === "exportModal") $("exportVideoPlayer").pause();
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
      if (item) patchCurrentItem({ enabled: !item.enabled }, true);
    }
  });

  bindPreviewInteractions();
}

bindEvents();
fetchFullState(false);
