"use strict";

let items = [];
let config = null;
let annotations = {};
let index = 0;
let selectedChassis = "";
let selectedObject = "";
let selectedTaskMode = "overall";
let selectedSubtaskIds = [];
let customObjectText = "";
let subtaskSegments = {};
let subtaskThumbs = {};
let subtaskBreakpoints = [];
let sourceSubtaskStatus = "not_loaded";
let sourceSubtaskSegmentCount = null;
let subtaskEdited = false;
let startedAt = Date.now();
let isSeeking = false;

const FPS = 15;
const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];
const SUBTASK_HOTKEYS = ["q", "w", "e", "r", "t", "y"];
const $ = (id) => document.getElementById(id);

async function fetchJson(path, fallback = null) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) {
    if (fallback !== null) return fallback;
    throw new Error(`${path}: ${res.status}`);
  }
  return await res.json();
}

async function fetchJsonl(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const text = await res.text();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function normalizeCustomObject(text) {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[\s/]+/g, "_")
    .replace(/[^a-z0-9_.-]+/g, "")
    .replace(/^_+|_+$/g, "");
}

function resolvedObject() {
  return selectedObject || "";
}

function selectedSubtasks(objectValue = resolvedObject()) {
  const subtasks = expectedSubtasks(objectValue);
  if (selectedTaskMode !== "fragment") return subtasks;
  const selected = new Set(selectedSubtaskIds);
  return subtasks.filter((st) => selected.has(String(st.id)));
}

function fragmentTaskName(subtasks, objectValue = resolvedObject()) {
  const names = subtasks.map((st) => st.subtask_name || st.label).filter(Boolean);
  if (!names.length) return "";
  const prefix = `${objectValue}_`;
  if (names.every((name) => name.startsWith(prefix))) {
    return `${objectValue}_${names.map((name) => name.slice(prefix.length)).join("_")}`;
  }
  return names.join("_");
}

function parseTaskName(name) {
  const task = String(name || "").trim();
  if (!task) return {object: "", mode: "overall", subtaskIds: []};
  if ((config.objects || []).some((obj) => obj.value === task)) {
    return {object: task, mode: "overall", subtaskIds: []};
  }
  for (const obj of config.objects || []) {
    const objectValue = obj.value;
    const subtasks = expectedSubtasks(objectValue);
    for (let start = 0; start < subtasks.length; start += 1) {
      for (let end = start; end < subtasks.length; end += 1) {
        const group = subtasks.slice(start, end + 1);
        if (fragmentTaskName(group, objectValue) === task) {
          return {object: objectValue, mode: "fragment", subtaskIds: group.map((st) => String(st.id))};
        }
      }
    }
  }
  return {object: "", mode: "overall", subtaskIds: []};
}

function taskName() {
  const bad = $("badVideo").checked;
  const object = resolvedObject();
  if (bad && !object) return "";
  if (!object) return "-";
  if (selectedTaskMode === "fragment") return fragmentTaskName(selectedSubtasks(object), object) || "-";
  return object;
}

function refreshCanonical() {
  $("canonicalText").textContent = taskName();
}

function chassisLabel(value = selectedChassis) {
  const found = (config?.chassis_types || []).find((ch) => ch.value === value);
  return found ? found.label.replace(/^\S+\s+/, "") : "";
}

function compactChassisLabel(value = selectedChassis) {
  if (value === "large_case") return "large";
  if (value === "small_case") return "small";
  return "";
}

function templateKeyForObject(objectValue = resolvedObject()) {
  return config.subtask_template_map?.[objectValue] || null;
}

function expectedSubtasks(objectValue = resolvedObject()) {
  const key = templateKeyForObject(objectValue);
  return key ? (config.subtask_schemas?.[key] || []) : [];
}

function optionalExtraBreakpointCount(objectValue = resolvedObject()) {
  return selectedTaskMode === "overall" && objectValue === "gpu" ? 1 : 0;
}

function minBreakpointCount(objectValue = resolvedObject()) {
  return Math.max(0, selectedSubtasks(objectValue).length - 1);
}

function maxBreakpointCount(objectValue = resolvedObject()) {
  return minBreakpointCount(objectValue) + optionalExtraBreakpointCount(objectValue);
}

function effectiveSubtasks(objectValue = resolvedObject()) {
  const base = selectedSubtasks(objectValue).map((st) => ({...st, optional_extra: false}));
  const extraAllowed = optionalExtraBreakpointCount(objectValue);
  if (!extraAllowed || !base.length) return base;

  const standardBreakpointCount = Math.max(0, base.length - 1);
  const extraBreakpointsUsed = Math.max(0, normalizeBreakpoints(subtaskBreakpoints).length - standardBreakpointCount);
  const extraSegments = Math.min(extraAllowed, extraBreakpointsUsed);
  for (let i = 0; i < extraSegments; i += 1) {
    const extraIndex = base.length + i + 1;
    base.push({
      id: String(extraIndex),
      subtask_name: `${objectValue}_extra_segment${i + 1}`,
      label: `${objectValue}_extra_segment${i + 1}`,
      prompt: `optional extra segment for ${objectValue}`,
      optional_extra: true
    });
  }
  return base;
}

function currentSourceSubtaskSegments() {
  const item = items[index] || {};
  if (Array.isArray(item.initial_subtask_segments) && item.initial_subtask_segments.length) {
    return item.initial_subtask_segments;
  }
  const sourceSegments = item.source_subtask?.segments;
  return Array.isArray(sourceSegments) ? sourceSegments : [];
}

function sourceSubtaskMatchesExpected(expectedCount, maxExpectedCount = expectedCount) {
  return sourceSubtaskStatus === "ok"
    && sourceSubtaskSegmentCount >= expectedCount
    && sourceSubtaskSegmentCount <= maxExpectedCount;
}

function subtaskNeedsManualReview(expectedCount, maxExpectedCount = expectedCount) {
  if (selectedTaskMode !== "overall" || expectedCount <= 0) return false;
  return !sourceSubtaskMatchesExpected(expectedCount, maxExpectedCount);
}

function currentMaxFrame() {
  const itemLength = Number(items[index]?.length);
  if (Number.isFinite(itemLength) && itemLength > 0) return Math.max(0, Math.round(itemLength) - 1);
  const duration = maxVideoDuration();
  if (duration > 0) return Math.max(0, secondsToFrame(duration) - 1);
  return 0;
}

function normalizeBreakpoints(points) {
  const maxFrame = currentMaxFrame();
  const byFrame = new Map();
  for (const point of points || []) {
    const rawFrame = typeof point === "number" ? point : point?.frame;
    const frame = Math.round(Number(rawFrame));
    if (!Number.isFinite(frame)) continue;
    const bounded = Math.max(0, Math.min(Math.max(0, maxFrame - 1), frame));
    byFrame.set(bounded, {
      frame: bounded,
      time: bounded / FPS,
      source: typeof point === "object" ? point.source || null : null,
      preloaded: typeof point === "object" ? Boolean(point.preloaded) : false
    });
  }
  return Array.from(byFrame.values()).sort((a, b) => a.frame - b.frame);
}

function segmentsToBreakpoints(segments) {
  const sorted = (segments || [])
    .filter((seg) => seg && seg.start_frame != null && seg.end_frame != null)
    .map((seg) => ({
      id: String(seg.id ?? ""),
      start_frame: Number(seg.start_frame),
      end_frame: Number(seg.end_frame),
      source: seg.source || null,
      preloaded: Boolean(seg.preloaded)
    }))
    .filter((seg) => Number.isFinite(seg.start_frame) && Number.isFinite(seg.end_frame))
    .sort((a, b) => a.start_frame - b.start_frame || a.end_frame - b.end_frame);
  return normalizeBreakpoints(sorted.slice(0, Math.max(0, sorted.length - 1)).map((seg) => ({
    frame: seg.end_frame,
    source: seg.source || "source_segment_end",
    preloaded: seg.preloaded
  })));
}

function savedBreakpoints(record) {
  if (!record) return [];
  if (Array.isArray(record.subtask_breakpoints)) {
    return normalizeBreakpoints(record.subtask_breakpoints);
  }
  if (Array.isArray(record.subtask_segments)) {
    return segmentsToBreakpoints(record.subtask_segments);
  }
  return [];
}

function hasSavedBreakpointData(record) {
  return Boolean(record)
    && (Array.isArray(record.subtask_breakpoints) || Array.isArray(record.subtask_segments));
}

function sourceBreakpoints() {
  return segmentsToBreakpoints(currentSourceSubtaskSegments());
}

function defaultBreakpointsForItem(item = items[index] || {}) {
  const saved = annotations[item.demo_timestamp];
  if (hasSavedBreakpointData(saved)) {
    return {breakpoints: savedBreakpoints(saved), source: "saved"};
  }
  const fromSource = sourceBreakpoints();
  if (fromSource.length) {
    return {breakpoints: fromSource, source: "source"};
  }
  return {breakpoints: [], source: "empty"};
}

function expectedBreakpointCount(objectValue = resolvedObject()) {
  return minBreakpointCount(objectValue);
}

function sourceBoundaryCount() {
  const value = items[index]?.source_subtask?.num_boundaries_meta;
  if (Number.isInteger(value)) return value;
  if (sourceSubtaskSegmentCount != null && sourceSubtaskSegmentCount > 0) {
    return Math.max(0, sourceSubtaskSegmentCount - 1);
  }
  return 0;
}

function sourceSubtaskInfoText() {
  const count = sourceSubtaskSegmentCount ?? 0;
  return `原始关键帧 ${sourceBoundaryCount()} 个；源分段 ${count} 段（${sourceSubtaskStatus}）`;
}

function ensureSubtaskSegments() {
  const subtasks = effectiveSubtasks();
  const next = {};
  const breakpoints = normalizeBreakpoints(subtaskBreakpoints);
  subtaskBreakpoints = breakpoints;
  const maxFrame = currentMaxFrame();
  for (let i = 0; i < subtasks.length; i += 1) {
    const st = subtasks[i];
    const startFrame = i === 0 ? 0 : (breakpoints[i - 1]?.frame ?? null) + 1;
    const endFrame = i < breakpoints.length ? breakpoints[i].frame : (breakpoints.length === subtasks.length - 1 ? maxFrame : null);
    next[st.id] = {
      id: st.id,
      label: st.label,
      prompt: st.prompt,
      start_time: startFrame != null ? startFrame / FPS : null,
      end_time: endFrame != null ? endFrame / FPS : null,
      start_frame: startFrame,
      end_frame: endFrame,
      source: breakpoints.some((bp) => bp.preloaded) ? "breakpoint_derived_from_source" : "breakpoint_derived",
      preloaded: breakpoints.some((bp) => bp.preloaded),
      optional_extra: Boolean(st.optional_extra)
    };
  }
  subtaskSegments = next;
}

function setObject(value) {
  const changed = selectedObject !== value;
  selectedObject = value;
  if (changed) selectedSubtaskIds = [];
  document.querySelectorAll("[data-object]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.object === value);
  });
  ensureSubtaskSegments();
  renderSubtasks();
  refreshCanonical();
}

function setChassis(value) {
  selectedChassis = value || "";
  document.querySelectorAll("[data-chassis]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.chassis === selectedChassis);
  });
}

function setTaskMode(value) {
  selectedTaskMode = value || "overall";
  if (selectedTaskMode !== "fragment") selectedSubtaskIds = [];
  document.querySelectorAll("[data-task-mode]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.taskMode === selectedTaskMode);
  });
  ensureSubtaskSegments();
  renderSubtasks();
  refreshCanonical();
}

function toggleSelectedSubtask(subtaskId) {
  const id = String(subtaskId);
  const current = new Set(selectedSubtaskIds.map(String));
  if (current.has(id)) current.delete(id);
  else current.add(id);
  const order = expectedSubtasks().map((st) => String(st.id));
  selectedSubtaskIds = order.filter((sid) => current.has(sid));
  ensureSubtaskSegments();
  renderSubtasks();
  refreshCanonical();
}

function subtaskHotkeyForIndex(index) {
  return SUBTASK_HOTKEYS[index] || "";
}

function toggleSubtaskByHotkey(key) {
  if (selectedTaskMode !== "fragment") return false;
  const object = resolvedObject();
  if (!object) return false;
  const hotkey = String(key || "").toLowerCase();
  const subtaskIndex = SUBTASK_HOTKEYS.indexOf(hotkey);
  if (subtaskIndex < 0) return false;
  const subtasks = expectedSubtasks(object);
  const subtask = subtasks[subtaskIndex];
  if (!subtask) return false;
  toggleSelectedSubtask(subtask.id);
  $("saveStatus").classList.remove("error");
  $("saveStatus").textContent = `已${selectedSubtaskIds.map(String).includes(String(subtask.id)) ? "选择" : "取消"} ${subtask.subtask_name || subtask.label}`;
  return true;
}

function renderConfig() {
  const chassisBox = $("chassisButtons");
  chassisBox.innerHTML = "";
  for (const ch of config.chassis_types || []) {
    const btn = document.createElement("button");
    btn.textContent = ch.label;
    btn.dataset.chassis = ch.value;
    btn.className = "choice-btn chassis-btn";
    btn.onclick = () => setChassis(ch.value);
    chassisBox.appendChild(btn);
  }

  const objectBox = $("objectButtons");
  objectBox.innerHTML = "";
  for (const obj of config.objects) {
    const btn = document.createElement("button");
    btn.textContent = obj.label;
    btn.dataset.object = obj.value;
    btn.className = "choice-btn";
    btn.onclick = () => setObject(obj.value);
    objectBox.appendChild(btn);
  }

  const actionBox = $("actionButtons");
  actionBox.innerHTML = "";
  for (const act of config.task_modes || []) {
    const btn = document.createElement("button");
    btn.textContent = act.label;
    btn.dataset.taskMode = act.value;
    btn.className = "choice-btn";
    btn.onclick = () => setTaskMode(act.value);
    actionBox.appendChild(btn);
  }
}

function viewTitle(view) {
  if (view === "hand") return "hand";
  if (view === "view1") return "view1 / external";
  if (view === "view2") return "view2 / wrist";
  return view;
}

function renderPreviews(item) {
  const grid = $("previewGrid");
  grid.innerHTML = "";
  for (const [view, shots] of Object.entries(item.previews || {})) {
    for (const shot of ["start", "middle", "end"]) {
      const src = shots?.[shot];
      const cell = document.createElement("div");
      cell.className = "preview-cell";
      const label = document.createElement("div");
      label.className = "preview-label";
      label.textContent = `${viewTitle(view)} · ${shot}`;
      cell.appendChild(label);
      if (src) {
        const img = document.createElement("img");
        img.src = src;
        img.alt = `${view} ${shot}`;
        cell.appendChild(img);
      } else {
        const empty = document.createElement("div");
        empty.className = "missing-preview";
        empty.textContent = "no preview";
        cell.appendChild(empty);
      }
      grid.appendChild(cell);
    }
  }
}

function renderVideos(item) {
  const grid = $("videoGrid");
  grid.innerHTML = "";
  const order = ["hand", "view1", "view2"];
  const entries = Object.entries(item.videos || {}).sort((a, b) => {
    const ia = order.indexOf(a[0]);
    const ib = order.indexOf(b[0]);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  for (const [view, src] of entries) {
    const panel = document.createElement("div");
    panel.className = "video-panel";
    const title = document.createElement("h2");
    title.textContent = viewTitle(view);
    panel.appendChild(title);
    const video = document.createElement("video");
    video.src = src;
    video.controls = true;
    video.preload = "metadata";
    video.muted = true;
    video.dataset.view = view;
    video.playbackRate = Number($("speedSelect").value);
    video.addEventListener("loadedmetadata", refreshSeekLimits);
    video.addEventListener("durationchange", refreshSeekLimits);
    video.addEventListener("canplay", refreshSeekLimits);
    video.addEventListener("timeupdate", () => {
      if (video === allVideos()[0]) updateSeekFromVideo();
    });
    panel.appendChild(video);
    grid.appendChild(panel);
  }
  refreshSeekLimits();
}

function loadExistingForItem(item) {
  const saved = annotations[item.demo_timestamp];
  selectedChassis = "";
  selectedObject = "";
  selectedTaskMode = "overall";
  selectedSubtaskIds = [];
  customObjectText = "";
  subtaskSegments = {};
  subtaskThumbs = {};
  subtaskBreakpoints = defaultBreakpointsForItem(item).breakpoints;
  sourceSubtaskStatus = item.source_subtask?.status || "not_loaded";
  sourceSubtaskSegmentCount = Number.isInteger(item.source_subtask?.segment_count)
    ? item.source_subtask.segment_count
    : currentSourceSubtaskSegments().length;
  subtaskEdited = false;
  $("badVideo").checked = false;
  $("mainViewSevereOffset").checked = false;
  $("hasJump").checked = false;
  $("noteInput").value = "";

  if (saved) {
    selectedChassis = saved.chassis_type || saved.chassis || (saved.chasis_label === "large" ? "large_case" : saved.chasis_label === "small" ? "small_case" : "");
    const parsedTask = parseTaskName(saved.task_name || saved.canonical_label || "");
    selectedObject = parsedTask.object || saved.object_code || saved.object || "";
    if (selectedObject === "ram1") selectedObject = "ram";
    if (!config.objects.some((o) => o.value === selectedObject)) selectedObject = "";
    selectedTaskMode = parsedTask.mode || (saved.action_prefix && saved.action_prefix !== "none" ? "fragment" : "overall");
    selectedSubtaskIds = parsedTask.subtaskIds || [];
    $("badVideo").checked = Boolean(saved.bad_demo ?? saved.bad_video);
    $("mainViewSevereOffset").checked = Boolean(saved.camera_shift ?? saved.main_view_severe_offset);
    $("hasJump").checked = Boolean(saved["是否跳变"] ?? saved.has_jump);
    $("noteInput").value = saved.note || "";
    subtaskEdited = true;
    $("saveStatus").textContent = `已标注：${saved.task_name || saved.canonical_label || "bad_demo"}`;
  } else {
    $("saveStatus").textContent = "未保存";
  }
  ensureSubtaskSegments();
}

function renderItem() {
  if (!items.length) {
    $("progressText").textContent = "没有 items.jsonl";
    return;
  }
  index = Math.max(0, Math.min(index, items.length - 1));
  const item = items[index];
  startedAt = Date.now();
  $("progressText").textContent = `${index + 1} / ${items.length}`;
  $("timestampText").textContent = item.demo_timestamp;
  loadExistingForItem(item);
  renderPreviews(item);
  renderVideos(item);
  setChassis(selectedChassis);
  setObject(selectedObject);
  setTaskMode(selectedTaskMode || "overall");
  ensureSubtaskSegments();
  renderSubtasks();
  refreshCanonical();
}

function previousItem() {
  if (index > 0) {
    index -= 1;
    renderItem();
  }
}

function nextItem() {
  if (index < items.length - 1) {
    index += 1;
    renderItem();
  }
}

function allVideos() {
  return Array.from(document.querySelectorAll("video"));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function currentSeconds() {
  const primary = allVideos()[0];
  return primary && Number.isFinite(primary.currentTime) ? primary.currentTime : 0;
}

function secondsToFrame(seconds) {
  return Math.max(0, Math.round((seconds || 0) * FPS));
}

function frameToSeconds(frame) {
  return Math.max(0, frame / FPS);
}

function maxVideoDuration() {
  const durations = allVideos()
    .map((v) => v.duration)
    .filter((v) => Number.isFinite(v) && v > 0);
  return durations.length ? Math.max(...durations) : 0;
}

function timelineDuration() {
  const videoDuration = maxVideoDuration();
  if (videoDuration > 0) return videoDuration;
  const itemLength = Number(items[index]?.length);
  if (Number.isFinite(itemLength) && itemLength > 0) return itemLength / FPS;
  const sourceSegments = currentSourceSubtaskSegments();
  const lastEnd = sourceSegments
    .map((seg) => Number(seg.end_time))
    .filter((v) => Number.isFinite(v) && v > 0)
    .sort((a, b) => b - a)[0];
  return lastEnd || 0;
}

function boundedPercent(seconds, duration) {
  if (!duration || duration <= 0 || !Number.isFinite(seconds)) return 0;
  return Math.max(0, Math.min(100, (seconds / duration) * 100));
}

function activeTimelineSegments() {
  return Object.values(subtaskSegments).filter(
    (seg) => seg && seg.start_frame != null && seg.end_frame != null && seg.end_frame >= seg.start_frame
  );
}

function normalizeTimelineSegments(segments) {
  const validSegments = [];
  for (const seg of segments || []) {
    const startTime = Number.isFinite(Number(seg.start_time))
      ? Number(seg.start_time)
      : (Number(seg.start_frame) || 0) / FPS;
    const endTime = Number.isFinite(Number(seg.end_time))
      ? Number(seg.end_time)
      : (Number(seg.end_frame) || 0) / FPS;
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime >= startTime) {
      validSegments.push({...seg, start_time: startTime, end_time: endTime});
    }
  }
  return validSegments;
}

function appendTimelineSegment(timeline, seg, idx, duration, {reference = false} = {}) {
  const left = boundedPercent(seg.start_time, duration);
  const right = boundedPercent(seg.end_time, duration);
  const width = Math.max(0.35, right - left);
  const div = document.createElement("div");
  div.className = reference ? "timeline-segment source-reference" : "timeline-segment";
  div.style.left = `${left}%`;
  div.style.width = `${width}%`;
  if (!reference) {
    div.style.background = `hsla(${(idx * 47) % 360}, 72%, 58%, 0.22)`;
    div.style.borderColor = `hsla(${(idx * 47) % 360}, 72%, 42%, 0.35)`;
  }
  div.textContent = reference ? `源${seg.id ?? idx + 1}` : (seg.id ? `S${seg.id}` : String(idx + 1));
  div.title = `${reference ? "原始参考分段（不保存）" : "当前可保存分段"} ${seg.id ?? idx + 1}: ${formatTime(seg.start_time)} → ${formatTime(seg.end_time)}`;
  timeline.appendChild(div);
}

function appendTimelineMarker(timeline, bp, idx, duration, {reference = false} = {}) {
  const marker = document.createElement("div");
  marker.className = reference ? "timeline-marker source-reference" : "timeline-marker breakpoint";
  marker.style.left = `${boundedPercent(bp.time, duration)}%`;
  marker.title = reference
    ? `原始参考断点 B${idx + 1}: ${formatTime(bp.time)} / frame ${bp.frame}；仅显示，不会保存`
    : `当前断点 B${idx + 1}: ${formatTime(bp.time)} / frame ${bp.frame}；移动到附近按 S 取消`;
  timeline.appendChild(marker);
}

function currentBreakpointSummary() {
  return normalizeBreakpoints(subtaskBreakpoints)
    .map((bp, i) => `B${i + 1}=frame ${bp.frame} (${formatTime(bp.time)})`)
    .join("；");
}

function updateTimelinePlayhead() {
  const playhead = $("timelinePlayhead");
  if (!playhead) return;
  const duration = timelineDuration();
  playhead.style.left = `${boundedPercent(currentSeconds(), duration)}%`;
}

function setBreakpointWarning(message = "") {
  const el = $("breakpointWarning");
  if (!el) return;
  el.textContent = message;
}

function toggleBreakpointAtFrame(frame) {
  const minExpected = minBreakpointCount();
  const maxAllowed = maxBreakpointCount();
  const extraAllowed = optionalExtraBreakpointCount();
  if (maxAllowed <= 0) {
    $("saveStatus").textContent = "当前 object 没有标准分段模板，不能添加断点。";
    setBreakpointWarning("当前任务没有标准分段模板，不能添加断点。");
    return;
  }
  const normalized = normalizeBreakpoints(subtaskBreakpoints);
  const targetFrame = Math.max(0, Math.min(Math.max(0, currentMaxFrame() - 1), Math.round(frame)));
  const threshold = Math.max(6, Math.round(FPS * 0.75));
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  normalized.forEach((bp, i) => {
    const dist = Math.abs(bp.frame - targetFrame);
    if (dist < nearestDistance) {
      nearestDistance = dist;
      nearestIndex = i;
    }
  });
  if (nearestIndex >= 0 && nearestDistance <= threshold) {
    normalized.splice(nearestIndex, 1);
    $("saveStatus").textContent = `已取消断点 frame ${targetFrame}`;
    setBreakpointWarning("");
  } else if (normalized.length >= maxAllowed) {
    const extraText = extraAllowed > 0 ? `，该任务允许额外 +${extraAllowed}` : "";
    const message = `断点已满：当前上限 ${maxAllowed} 个（标准 ${minExpected}${extraText}）。请先 Reset，或把播放位置移到已有断点附近按 S 删除一帧。`;
    $("saveStatus").textContent = message;
    $("saveStatus").classList.add("error");
    setBreakpointWarning(message);
    return;
  } else {
    normalized.push({frame: targetFrame, time: targetFrame / FPS, source: "manual_keyboard_or_button", preloaded: false});
    $("saveStatus").textContent = `已添加断点 frame ${targetFrame}`;
    setBreakpointWarning("");
  }
  $("saveStatus").classList.remove("error");
  subtaskBreakpoints = normalizeBreakpoints(normalized);
  subtaskEdited = true;
  ensureSubtaskSegments();
  renderSubtasks();
}

function toggleBreakpointAtCurrentFrame() {
  toggleBreakpointAtFrame(secondsToFrame(currentSeconds()));
}

function resetBreakpoints() {
  subtaskBreakpoints = [];
  subtaskThumbs = {};
  subtaskEdited = true;
  $("saveStatus").classList.remove("error");
  $("saveStatus").textContent = "已清空当前可保存断点；灰色原始分段仅作参考，不会保存";
  setBreakpointWarning("");
  ensureSubtaskSegments();
  renderSubtasks();
}

function renderSubtaskTimeline() {
  const timeline = $("subtaskTimeline");
  const info = $("subtaskTimelineInfo");
  if (!timeline || !info) return;

  const playhead = $("timelinePlayhead");
  timeline.innerHTML = "";
  if (playhead) timeline.appendChild(playhead);

  const duration = timelineDuration();
  const hasObject = Boolean(resolvedObject());
  const sourceSegments = normalizeTimelineSegments(currentSourceSubtaskSegments());
  const currentSegments = hasObject ? normalizeTimelineSegments(activeTimelineSegments()) : [];
  const sourceBps = sourceBreakpoints();
  const currentBps = hasObject ? normalizeBreakpoints(subtaskBreakpoints) : [];
  const sourceText = sourceSubtaskInfoText();
  const minBp = hasObject ? minBreakpointCount() : 0;
  const maxBp = hasObject ? maxBreakpointCount() : 0;
  const extraBp = hasObject ? optionalExtraBreakpointCount() : 0;
  const bpLimitText = maxBp > minBp ? `${minBp}–${maxBp}` : String(minBp);
  const bpSummary = currentBreakpointSummary();
  const sourceEnd = sourceSegments.reduce((mx, seg) => Math.max(mx, Number(seg.end_time) || 0), 0);
  const sourceGap = sourceSegments.length && duration > 0 ? duration - sourceEnd : 0;
  const sourceMismatch = sourceGap > Math.max(2.0, duration * 0.05);
  const sourceHint = sourceSegments.length || sourceBps.length
    ? `灰色=原始参考，仅显示不保存`
    : `无可视化原始参考`;
  const mismatchHint = sourceMismatch
    ? ` ⚠️ 源分段只覆盖到 ${formatTime(sourceEnd)}，但视频/时间轴到 ${formatTime(duration)}；可能是测试包或 metadata 与视频不一致，请以视频为准重标/核对。`
    : "";
  info.classList.toggle("warn", Boolean(sourceMismatch));
  const extraHint = extraBp > 0 ? `；该任务允许额外 +${extraBp} 个可选断点` : "";
  const currentHint = hasObject
    ? `红色=当前可保存断点 ${currentBps.length}/${bpLimitText}${bpSummary ? `：${bpSummary}` : ""}。上限=${maxBp}${extraHint}；按 S 或按钮添加/取消，Reset 清空当前断点。`
    : `先选择 object 后再统计/保存当前断点；未选择前只显示灰色原始参考。`;
  info.textContent = `${sourceText}；${sourceHint}；${currentHint}${mismatchHint}`;

  if (duration <= 0) {
    updateTimelinePlayhead();
    return;
  }

  sourceSegments.forEach((seg, idx) => appendTimelineSegment(timeline, seg, idx, duration, {reference: true}));
  sourceBps.forEach((bp, idx) => appendTimelineMarker(timeline, bp, idx, duration, {reference: true}));
  currentSegments.forEach((seg, idx) => appendTimelineSegment(timeline, seg, idx, duration));
  currentBps.forEach((bp, idx) => appendTimelineMarker(timeline, bp, idx, duration));
  updateTimelinePlayhead();
}

function refreshSeekLimits() {
  const duration = maxVideoDuration();
  $("syncSeek").max = duration ? String(duration) : "0";
  $("syncSeek").step = String(1 / FPS);
  $("durationText").textContent = formatTime(duration);
  $("durationFrameText").textContent = String(secondsToFrame(duration));
  updateSeekFromVideo();
  renderSubtaskTimeline();
}

function seekVideoWhenReady(video, seconds) {
  const doSeek = () => {
    const target = Number.isFinite(video.duration) && video.duration > 0 ? Math.min(seconds, video.duration) : seconds;
    video.pause();
    try {
      if (typeof video.fastSeek === "function") {
        try {
          video.fastSeek(Math.max(0, target));
        } catch {
          video.currentTime = Math.max(0, target);
        }
      } else {
        video.currentTime = Math.max(0, target);
      }
    } catch {
      // Keep UI responsive even if a browser refuses a particular seek.
    }
  };

  if (video.readyState >= 1) {
    doSeek();
  } else {
    video.addEventListener("loadedmetadata", doSeek, {once: true});
    video.load();
  }
}

function updateSeekFromVideo() {
  if (isSeeking) return;
  const current = currentSeconds();
  $("syncSeek").value = Number.isFinite(current) ? String(current) : "0";
  $("currentTimeText").textContent = formatTime(current);
  $("currentFrameText").textContent = String(secondsToFrame(current));
  updateTimelinePlayhead();
}

function seekAll(seconds) {
  const targetSeconds = Math.max(0, seconds);
  for (const v of allVideos()) {
    seekVideoWhenReady(v, targetSeconds);
  }
  $("syncSeek").value = String(targetSeconds);
  $("currentTimeText").textContent = formatTime(targetSeconds);
  $("currentFrameText").textContent = String(secondsToFrame(targetSeconds));
  updateTimelinePlayhead();
}

function stepFrames(deltaFrames) {
  const target = frameToSeconds(secondsToFrame(currentSeconds()) + deltaFrames);
  seekAll(target);
  updateSeekFromVideo();
}

function jumpToFrameInput() {
  const frame = Number($("jumpFrameInput").value);
  if (Number.isFinite(frame)) {
    seekAll(frameToSeconds(frame));
    updateSeekFromVideo();
  }
}

function jumpToSecondInput() {
  const sec = Number($("jumpSecondInput").value);
  if (Number.isFinite(sec)) {
    seekAll(sec);
    updateSeekFromVideo();
  }
}

function togglePlay() {
  const videos = allVideos();
  if (!videos.length) return;
  const shouldPlay = videos.every((v) => v.paused);
  for (const v of videos) {
    if (shouldPlay) v.play().catch(() => {});
    else v.pause();
  }
}

function applySpeed() {
  const rate = Number($("speedSelect").value);
  for (const v of allVideos()) v.playbackRate = rate;
}

function changeSpeed(delta) {
  const current = Number($("speedSelect").value);
  let idx = SPEEDS.findIndex((x) => Math.abs(x - current) < 1e-6);
  if (idx < 0) idx = SPEEDS.indexOf(1);
  idx = Math.max(0, Math.min(SPEEDS.length - 1, idx + delta));
  $("speedSelect").value = String(SPEEDS[idx]);
  applySpeed();
}

function captureCurrentThumb() {
  const videos = allVideos();
  const video = videos.find((v) => v.dataset.view === "view1") || videos[0];
  if (!video || !video.videoWidth || !video.videoHeight) return "";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 180;
    canvas.height = Math.max(1, Math.round(180 * video.videoHeight / video.videoWidth));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.72);
  } catch {
    return "";
  }
}

function setBoundary(subtaskId, kind) {
  ensureSubtaskSegments();
  const seg = subtaskSegments[subtaskId];
  if (!seg) return;
  const sec = currentSeconds();
  const frame = secondsToFrame(sec);
  seg[`${kind}_time`] = Math.round(sec * 1000) / 1000;
  seg[`${kind}_frame`] = frame;
  subtaskThumbs[subtaskId] = subtaskThumbs[subtaskId] || {};
  subtaskThumbs[subtaskId][kind] = captureCurrentThumb();
  subtaskEdited = true;
  renderSubtasks();
}

function clearSegment(subtaskId) {
  if (subtaskSegments[subtaskId]) {
    subtaskSegments[subtaskId].start_time = null;
    subtaskSegments[subtaskId].end_time = null;
    subtaskSegments[subtaskId].start_frame = null;
    subtaskSegments[subtaskId].end_frame = null;
  }
  if (subtaskThumbs[subtaskId]) delete subtaskThumbs[subtaskId];
  subtaskEdited = true;
  renderSubtasks();
}

function subtaskCompletion() {
  const baseSubtasks = selectedSubtasks();
  const optionalExtraBreakpoints = optionalExtraBreakpointCount();
  const expectedBreakpoints = Math.max(0, baseSubtasks.length - 1);
  const maxBreakpoints = expectedBreakpoints + optionalExtraBreakpoints;
  const breakpoints = normalizeBreakpoints(subtaskBreakpoints);
  const effectiveCount = baseSubtasks.length + Math.min(optionalExtraBreakpoints, Math.max(0, breakpoints.length - expectedBreakpoints));
  const breakpointComplete = baseSubtasks.length > 0
    ? breakpoints.length >= expectedBreakpoints && breakpoints.length <= maxBreakpoints
    : breakpoints.length === 0;
  const complete = breakpointComplete
    ? effectiveCount
    : Math.min(effectiveCount, breakpoints.length + 1);
  return {
    complete,
    expected: effectiveCount,
    baseExpected: baseSubtasks.length,
    breakpoints: breakpoints.length,
    expectedBreakpoints,
    maxBreakpoints,
    optionalExtraBreakpoints,
    breakpointComplete
  };
}

function renderSubtasks() {
  const object = resolvedObject();
  const templateKey = templateKeyForObject(object);
  const baseSubtasks = expectedSubtasks(object);
  const rows = $("subtaskRows");
  if (!rows) return;
  rows.innerHTML = "";

  const summary = $("subtaskSummary");
  const warning = $("subtaskWarning");
  warning.textContent = "";
  warning.className = "subtask-warning";

  if (!object) {
    summary.textContent = `先选择 object 和任务模式。整个任务使用全部 subtask；任务片段需要勾选若干 subtask。断点数必须等于选中 subtask 数 - 1。${sourceSubtaskInfoText()}。`;
    renderSubtaskTimeline();
    return;
  }

  if (!templateKey || !baseSubtasks.length) {
    summary.textContent = `${object} 没有标准 subtask 模板；可保存任务名，但建议备注说明。${sourceSubtaskInfoText()}。`;
    warning.textContent = "无标准模板";
    warning.classList.add("warn");
    renderSubtaskTimeline();
    return;
  }

  ensureSubtaskSegments();
  const completion = subtaskCompletion();
  const subtasks = selectedTaskMode === "overall" ? effectiveSubtasks(object) : expectedSubtasks(object);
  const selected = selectedSubtasks(object);
  const expected = completion.expected;
  const required = true;
  const sourceText = sourceSubtaskSegmentCount != null
    ? `源 parquet 分段：${sourceSubtaskSegmentCount} 段（${sourceSubtaskStatus}）。`
    : `源 parquet 分段：未读取。`;
  const sourceMatches = selectedTaskMode === "overall" && sourceSubtaskMatchesExpected(completion.baseExpected, completion.expected);
  const needsManual = selectedTaskMode === "overall" && subtaskNeedsManualReview(completion.baseExpected, completion.expected);
  const breakpointTextForSummary = completion.maxBreakpoints > completion.expectedBreakpoints
    ? `${completion.expectedBreakpoints}–${completion.maxBreakpoints}`
    : `${completion.expectedBreakpoints}`;
  const selectedNames = selected.map((st) => st.subtask_name || st.label).join(" + ") || "未选择";
  const extraText = completion.optionalExtraBreakpoints > 0
    ? `；允许额外 +${completion.optionalExtraBreakpoints} 个可选断点/段`
    : "";
  const hotkeyHint = selectedTaskMode === "fragment"
    ? ` Subtask 快捷键：${subtasks.map((st, i) => `${subtaskHotkeyForIndex(i).toUpperCase()}=${st.subtask_name || st.label}`).join("，")}。`
    : "";
  summary.textContent = `${object} 使用 ${templateKey} 模板。当前模式：${selectedTaskMode === "overall" ? "整个任务" : "任务片段"}；选中 ${selected.length} 段：${selectedNames}${extraText}；必须 ${breakpointTextForSummary} 个断点。当前断点 ${completion.breakpoints}/${breakpointTextForSummary}。${sourceText}${hotkeyHint}`;
  if (required && !completion.breakpointComplete) {
    warning.textContent = completion.breakpoints < completion.expectedBreakpoints
      ? `需补 ${completion.expectedBreakpoints - completion.breakpoints} 个断点`
      : `多 ${completion.breakpoints - completion.maxBreakpoints} 个断点`;
    warning.classList.add("warn");
  } else if (needsManual && !subtaskEdited) {
    warning.textContent = `源分段不匹配，需人工确认`;
    warning.classList.add("warn");
  } else if (required && sourceMatches) {
    warning.textContent = "源分段匹配，可直接保存";
    warning.classList.add("ok");
  } else {
    warning.textContent = "分段数量 OK";
    warning.classList.add("ok");
  }

  const breakpoints = normalizeBreakpoints(subtaskBreakpoints);
  const breakpointText = breakpoints.length
    ? breakpoints.map((bp, i) => `B${i + 1}: frame ${bp.frame} (${formatTime(bp.time)})`).join("；")
    : "暂无断点；请把视频停在目标帧，按 S 添加。";
  const bpBox = document.createElement("div");
  bpBox.className = "breakpoint-list";
  bpBox.innerHTML = `<strong>当前断点：</strong><span>${breakpointText}</span>`;
  rows.appendChild(bpBox);

  for (let i = 0; i < subtasks.length; i += 1) {
    const st = subtasks[i];
    const isSelected = selectedTaskMode !== "fragment" || selectedSubtaskIds.map(String).includes(String(st.id));
    const seg = subtaskSegments[st.id] || {};
    const row = document.createElement("div");
    row.className = `subtask-row${isSelected ? "" : " subtask-row-unselected"}`;
    const hotkey = subtaskHotkeyForIndex(i).toUpperCase();
    const selector = selectedTaskMode === "fragment"
      ? `<label class="subtask-select"><input type="checkbox" data-subtask-select="${st.id}" ${isSelected ? "checked" : ""} /> ${hotkey ? `${hotkey} ` : ""}选中</label>`
      : `<span class="subtask-select overall">整体任务包含</span>`;
    row.innerHTML = `
      ${selector}
      <div class="subtask-title">
        <strong>${st.id}. ${st.subtask_name || st.label}${st.optional_extra ? "（可选额外段）" : ""}</strong>
        <span>${st.prompt}</span>
      </div>
      <div class="subtask-times">
        ${isSelected ? `frame: <code>${seg.start_frame ?? "-"}</code>
        → <code>${seg.end_frame ?? "-"}</code>
        <span class="muted">(${seg.start_time != null ? formatTime(seg.start_time) : "-"} → ${seg.end_time != null ? formatTime(seg.end_time) : "-"})</span>` : `<span class="muted">未选入 task fragment</span>`}
      </div>
    `;
    rows.appendChild(row);
  }
  rows.querySelectorAll("[data-subtask-select]").forEach((input) => {
    input.addEventListener("change", () => toggleSelectedSubtask(input.dataset.subtaskSelect));
  });
  renderSubtaskTimeline();
}

function buildRecord() {
  const item = items[index];
  ensureSubtaskSegments();
  const breakpoints = normalizeBreakpoints(subtaskBreakpoints).map((bp, i) => ({
    id: `B${i + 1}`,
    frame: bp.frame
  }));
  return {
    episode_index: Number(item.episode_index),
    demo_timestamp: String(item.demo_timestamp),
    task_name: taskName() === "-" ? "" : taskName(),
    subtask_breakpoints: breakpoints.map((bp) => String(bp.frame)),
    camera_shift: $("mainViewSevereOffset").checked,
    bad_demo: $("badVideo").checked,
    "是否跳变": $("hasJump").checked,
    chasis_label: compactChassisLabel(selectedChassis)
  };
}

function validateRecord(record) {
  if (!record.chasis_label) return "请先选择机箱类型：大机箱或小机箱。每条都必须选择后才能保存。";
  if (!selectedObject) return "请先选择任务物体（1 cpu / 2 disk / 3 gpu / 4 ram / 5 ram2），再保存并进入下一条。";
  if (!record.task_name) return "请先选择完整任务，或在任务片段模式下至少选择一个子任务。";
  const completion = subtaskCompletion();
  if (selectedTaskMode === "fragment" && selectedSubtaskIds.length === 0) {
    return "任务片段模式下必须至少选择一个子任务。";
  }
  if (!completion.breakpointComplete) {
    const bpText = completion.maxBreakpoints > completion.expectedBreakpoints
      ? `${completion.expectedBreakpoints}–${completion.maxBreakpoints}`
      : `${completion.expectedBreakpoints}`;
    return `${selectedTaskMode === "overall" ? "整个任务" : "任务片段"} ${record.task_name} 需要 ${bpText} 个断点；当前 ${completion.breakpoints}/${bpText}。`;
  }
  if (selectedTaskMode === "overall" && subtaskNeedsManualReview(completion.baseExpected, completion.expected) && !subtaskEdited) {
    return `源 subtask 与当前任务模板不一致或缺失：源 ${sourceSubtaskSegmentCount ?? 0} 段，当前标准需要 ${completion.expected} 段。请人工确认/重标分段后再保存。`;
  }
  return "";
}

async function saveAndNext() {
  const record = buildRecord();
  const error = validateRecord(record);
  if (error) {
    $("saveStatus").textContent = error;
    $("saveStatus").classList.add("error");
    return;
  }
  $("saveStatus").classList.remove("error");
  try {
    const res = await fetch("/api/save", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(record)
    });
    const payload = await res.json();
    if (!payload.ok) throw new Error(payload.error || "save failed");
    annotations[record.demo_timestamp] = record;
    $("saveStatus").textContent = `已保存：${record.task_name}`;
    localStorage.setItem("last_annotation_backup", JSON.stringify(record));
    nextItem();
  } catch (err) {
    localStorage.setItem(`annotation_backup_${record.demo_timestamp}`, JSON.stringify(record));
    $("saveStatus").textContent = `保存到服务器失败，已本地备份：${err}`;
    $("saveStatus").classList.add("error");
  }
}

function setupHandlers() {
  $("prevBtn").onclick = previousItem;
  $("nextBtn").onclick = nextItem;
  $("playPauseBtn").onclick = togglePlay;
  $("saveBtn").onclick = saveAndNext;
  $("toggleBreakpointBtn").onclick = toggleBreakpointAtCurrentFrame;
  $("resetBreakpointsBtn").onclick = resetBreakpoints;
  $("speedSelect").onchange = applySpeed;
  $("speedDownBtn").onclick = () => changeSpeed(-1);
  $("speedUpBtn").onclick = () => changeSpeed(1);
  $("badVideo").onchange = refreshCanonical;
  $("mainViewSevereOffset").onchange = refreshCanonical;
  $("hasJump").onchange = refreshCanonical;

  const beginSeek = () => {
    isSeeking = true;
  };
  const endSeek = () => {
    seekAll(Number($("syncSeek").value));
    isSeeking = false;
    updateSeekFromVideo();
  };
  $("syncSeek").addEventListener("pointerdown", beginSeek);
  $("syncSeek").addEventListener("mousedown", beginSeek);
  $("syncSeek").addEventListener("touchstart", beginSeek);
  $("syncSeek").addEventListener("pointerup", endSeek);
  $("syncSeek").addEventListener("mouseup", endSeek);
  $("syncSeek").addEventListener("touchend", endSeek);
  $("syncSeek").addEventListener("change", endSeek);
  $("syncSeek").addEventListener("input", () => {
    isSeeking = true;
    seekAll(Number($("syncSeek").value));
  });

  $("noteInput").addEventListener("keydown", (ev) => ev.stopPropagation());
  $("jumpFrameInput").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") jumpToFrameInput();
  });
  $("jumpSecondInput").addEventListener("keydown", (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") jumpToSecondInput();
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id === "jumpFrameBtn") jumpToFrameInput();
    if (target.id === "jumpSecondBtn") jumpToSecondInput();
    if (target.id === "stepBack10Btn") stepFrames(-10);
    if (target.id === "stepBack1Btn") stepFrames(-1);
    if (target.id === "stepForward1Btn") stepFrames(1);
    if (target.id === "stepForward10Btn") stepFrames(10);
    if (target.id === "speedDownBtn") changeSpeed(-1);
    if (target.id === "speedUpBtn") changeSpeed(1);
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.target && ["INPUT", "TEXTAREA", "SELECT"].includes(ev.target.tagName)) return;
    const key = ev.key;
    if (key === "6" && !(ev.altKey || ev.metaKey || ev.ctrlKey)) {
      setChassis("large_case");
      ev.preventDefault();
      return;
    }
    if (key === "7" && !(ev.altKey || ev.metaKey || ev.ctrlKey)) {
      setChassis("small_case");
      ev.preventDefault();
      return;
    }
    if (((key >= "1" && key <= "5") || key === "8") && !(ev.altKey || ev.metaKey || ev.ctrlKey)) {
      const obj = config.objects.find((o) => o.key === key);
      if (obj) setObject(obj.value);
      ev.preventDefault();
      return;
    }
    if (key === "0") {
      setTaskMode("overall");
      ev.preventDefault();
      return;
    }
    if (key === "9") {
      setTaskMode("fragment");
      ev.preventDefault();
      return;
    }
    if (!(ev.altKey || ev.metaKey || ev.ctrlKey) && toggleSubtaskByHotkey(key)) {
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "b") {
      $("badVideo").checked = !$("badVideo").checked;
      refreshCanonical();
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "c") {
      $("mainViewSevereOffset").checked = !$("mainViewSevereOffset").checked;
      refreshCanonical();
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "d") {
      $("hasJump").checked = !$("hasJump").checked;
      refreshCanonical();
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "s") {
      toggleBreakpointAtCurrentFrame();
      ev.preventDefault();
      return;
    }
    if (key === "Enter") {
      saveAndNext();
      ev.preventDefault();
      return;
    }
    if (key === "ArrowLeft") {
      previousItem();
      ev.preventDefault();
      return;
    }
    if (key === "ArrowRight") {
      nextItem();
      ev.preventDefault();
      return;
    }
    if (key === " ") {
      togglePlay();
      ev.preventDefault();
      return;
    }
    if (key === ",") {
      stepFrames(-1);
      ev.preventDefault();
      return;
    }
    if (key === ".") {
      stepFrames(1);
      ev.preventDefault();
      return;
    }
    if (key === "<") {
      stepFrames(-10);
      ev.preventDefault();
      return;
    }
    if (key === ">") {
      stepFrames(10);
      ev.preventDefault();
      return;
    }
    if (key === "[") {
      changeSpeed(-1);
      ev.preventDefault();
      return;
    }
    if (key === "]") {
      changeSpeed(1);
      ev.preventDefault();
    }
  });
}

async function init() {
  try {
    config = await fetchJson("label_config.json");
    items = await fetchJsonl("items.jsonl");
    annotations = await fetchJson("/api/annotations_latest.json", {});
    renderConfig();
    setupHandlers();
    renderItem();
  } catch (err) {
    $("progressText").textContent = `加载失败：${err}`;
    console.error(err);
  }
}

init();

// Small debug hooks for local QA. They do not affect annotation output.
window.annotationSeekAll = seekAll;
window.annotationCurrentTimes = () => allVideos().map((v) => v.currentTime);
