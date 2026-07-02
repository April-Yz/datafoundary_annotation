"use strict";

let items = [];
let config = null;
let annotations = {};
let index = 0;
let selectedChassis = "";
let selectedObject = "";
let selectedAction = "none";
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
  if (selectedObject === "custom_object") {
    return normalizeCustomObject(customObjectText || $("customObjectInput").value);
  }
  return selectedObject || "";
}

function canonicalLabel() {
  const bad = $("badVideo").checked;
  const object = resolvedObject();
  if (bad && !object) return "bad_video";
  if (!object) return "-";
  if (!selectedAction || selectedAction === "none") return object;
  return `${selectedAction}_${object}`;
}

function refreshCanonical() {
  $("canonicalText").textContent = canonicalLabel();
}

function chassisLabel(value = selectedChassis) {
  const found = (config?.chassis_types || []).find((ch) => ch.value === value);
  return found ? found.label.replace(/^\S+\s+/, "") : "";
}

function templateKeyForObject(objectValue = resolvedObject()) {
  return config.subtask_template_map?.[objectValue] || null;
}

function expectedSubtasks(objectValue = resolvedObject()) {
  const key = templateKeyForObject(objectValue);
  return key ? (config.subtask_schemas?.[key] || []) : [];
}

function optionalExtraBreakpointCount(objectValue = resolvedObject()) {
  const raw = config?.optional_extra_breakpoints?.[objectValue];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function minBreakpointCount(objectValue = resolvedObject()) {
  return Math.max(0, expectedSubtasks(objectValue).length - 1);
}

function maxBreakpointCount(objectValue = resolvedObject()) {
  return minBreakpointCount(objectValue) + optionalExtraBreakpointCount(objectValue);
}

function effectiveSubtasks(objectValue = resolvedObject()) {
  const base = expectedSubtasks(objectValue).map((st) => ({...st, optional_extra: false}));
  const extraAllowed = optionalExtraBreakpointCount(objectValue);
  if (!extraAllowed || !base.length) return base;

  const standardBreakpointCount = Math.max(0, base.length - 1);
  const extraBreakpointsUsed = Math.max(0, normalizeBreakpoints(subtaskBreakpoints).length - standardBreakpointCount);
  const extraSegments = Math.min(extraAllowed, extraBreakpointsUsed);
  const key = templateKeyForObject(objectValue) || objectValue || "task";
  const baseCount = base.length;
  for (let i = 0; i < extraSegments; i += 1) {
    const extraIndex = baseCount + i + 1;
    base.push({
      id: String(extraIndex),
      label: `${key}_subtask_${extraIndex}`,
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
  if (selectedAction !== "none" || expectedCount <= 0) return false;
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

function sourceBreakpoints() {
  return segmentsToBreakpoints(currentSourceSubtaskSegments());
}

function defaultBreakpointsForItem(item = items[index] || {}) {
  const saved = annotations[item.demo_timestamp];
  const fromSaved = savedBreakpoints(saved);
  if (fromSaved.length) {
    return {breakpoints: fromSaved, source: "saved"};
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
  selectedObject = value;
  document.querySelectorAll("[data-object]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.object === value);
  });
  const customBox = $("customObjectBox");
  customBox.classList.toggle("hidden", value !== "custom_object");
  if (value === "custom_object") {
    $("customObjectInput").focus();
  }
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

function setAction(value) {
  selectedAction = value || "none";
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.action === selectedAction);
  });
  renderSubtasks();
  refreshCanonical();
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
  for (const act of config.action_prefixes) {
    const btn = document.createElement("button");
    btn.textContent = act.label;
    btn.dataset.action = act.value;
    btn.className = "choice-btn";
    btn.onclick = () => setAction(act.value);
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
  selectedAction = "none";
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
  $("customObjectInput").value = "";
  $("noteInput").value = "";

  if (saved) {
    selectedChassis = saved.chassis_type || saved.chassis || "";
    selectedObject = saved.object_code || saved.object || "";
    if (selectedObject === "ram1") selectedObject = "ram";
    if (selectedObject && !config.objects.some((o) => o.value === selectedObject)) {
      customObjectText = saved.object || selectedObject;
      selectedObject = "custom_object";
    }
    if (selectedObject === "custom_object") {
      customObjectText = saved.custom_object_text || saved.object || "";
      $("customObjectInput").value = customObjectText;
    }
    selectedAction = saved.action_prefix || "none";
    $("badVideo").checked = Boolean(saved.bad_video);
    $("mainViewSevereOffset").checked = Boolean(saved.main_view_severe_offset);
    $("hasJump").checked = Boolean(saved.has_jump);
    $("noteInput").value = saved.note || "";
    subtaskEdited = true;
    $("saveStatus").textContent = `已标注：${saved.canonical_label || "bad_video"}`;
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
  setAction(selectedAction || "none");
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
  const sourceSegments = normalizeTimelineSegments(currentSourceSubtaskSegments());
  const currentSegments = normalizeTimelineSegments(activeTimelineSegments());
  const sourceBps = sourceBreakpoints();
  const currentBps = normalizeBreakpoints(subtaskBreakpoints);
  const sourceText = sourceSubtaskInfoText();
  const minBp = minBreakpointCount();
  const maxBp = maxBreakpointCount();
  const extraBp = optionalExtraBreakpointCount();
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
  info.textContent = `${sourceText}；${sourceHint}；红色=当前可保存断点 ${currentBps.length}/${bpLimitText}${bpSummary ? `：${bpSummary}` : ""}。上限=${maxBp}${extraHint}；按 S 或按钮添加/取消，Reset 清空当前断点。${mismatchHint}`;

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
  const baseSubtasks = expectedSubtasks();
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
    summary.textContent = `先选择 object；如果 action 为 none，只需要标 N-1 个断点生成 N 段。${sourceSubtaskInfoText()}。`;
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
  const subtasks = effectiveSubtasks(object);
  const expected = completion.expected;
  const required = selectedAction === "none";
  const sourceText = sourceSubtaskSegmentCount != null
    ? `源 parquet 分段：${sourceSubtaskSegmentCount} 段（${sourceSubtaskStatus}）。`
    : `源 parquet 分段：未读取。`;
  const sourceMatches = sourceSubtaskMatchesExpected(completion.baseExpected, completion.expected);
  const needsManual = subtaskNeedsManualReview(completion.baseExpected, completion.expected);
  const breakpointTextForSummary = completion.maxBreakpoints > completion.expectedBreakpoints
    ? `${completion.expectedBreakpoints}–${completion.maxBreakpoints}`
    : `${completion.expectedBreakpoints}`;
  const extraText = completion.optionalExtraBreakpoints > 0
    ? `该任务可额外 +${completion.optionalExtraBreakpoints} 个可选断点；`
    : "";
  summary.textContent = `${object} 使用 ${templateKey} 模板：标准 ${completion.baseExpected} 段，需要 ${breakpointTextForSummary} 个断点。当前断点 ${completion.breakpoints}/${breakpointTextForSummary}，当前生成 ${expected} 段。${extraText}${sourceText}${required ? " 当前 action=none。" : " 当前 action 非 none，分段不强制但建议核对。"}`;
  if (required && !completion.breakpointComplete) {
    const delta = completion.expectedBreakpoints - completion.breakpoints;
    warning.textContent = delta > 0 ? `需补 ${delta} 个断点` : `多 ${completion.breakpoints - completion.maxBreakpoints} 个断点`;
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
    const seg = subtaskSegments[st.id] || {};
    const row = document.createElement("div");
    row.className = "subtask-row";
    row.innerHTML = `
      <div class="subtask-title">
        <strong>${st.id}. ${st.label}${st.optional_extra ? "（可选额外段）" : ""}</strong>
        <span>${st.prompt}</span>
      </div>
      <div class="subtask-times">
        frame: <code>${seg.start_frame ?? "-"}</code>
        → <code>${seg.end_frame ?? "-"}</code>
        <span class="muted">(${seg.start_time != null ? formatTime(seg.start_time) : "-"} → ${seg.end_time != null ? formatTime(seg.end_time) : "-"})</span>
      </div>
    `;
    rows.appendChild(row);
  }
  renderSubtaskTimeline();
}

function buildRecord() {
  const item = items[index];
  const badVideo = $("badVideo").checked;
  const object = resolvedObject();
  const qualityFlags = [];
  if (badVideo) qualityFlags.push("bad_video");
  if ($("mainViewSevereOffset").checked) qualityFlags.push("main_view_severe_offset");
  if ($("hasJump").checked) qualityFlags.push("has_jump");
  ensureSubtaskSegments();
  const segments = Object.values(subtaskSegments).map((seg) => ({...seg}));
  const completion = subtaskCompletion();
  const breakpoints = normalizeBreakpoints(subtaskBreakpoints).map((bp, i) => ({
    id: `B${i + 1}`,
    frame: bp.frame,
    time: Math.round(bp.time * 1000) / 1000,
    source: bp.source || null,
    preloaded: Boolean(bp.preloaded)
  }));
  const templateKey = templateKeyForObject(object);
  const sourceMatchesExpected = sourceSubtaskMatchesExpected(completion.baseExpected, completion.expected);
  const needsManualReview = subtaskNeedsManualReview(completion.baseExpected, completion.expected);
  return {
    item_id: item.item_id,
    demo_timestamp: item.demo_timestamp,
    episode_index: item.episode_index,
    chassis_type: selectedChassis,
    chassis_label: chassisLabel(selectedChassis),
    action_prefix: selectedAction || "none",
    object_code: selectedObject,
    object: object,
    custom_object_text: selectedObject === "custom_object" ? $("customObjectInput").value.trim() : "",
    canonical_label: canonicalLabel(),
    bad_video: badVideo,
    main_view_severe_offset: $("mainViewSevereOffset").checked,
    has_jump: $("hasJump").checked,
    quality_flags: qualityFlags,
    subtask_template: templateKey,
    subtask_expected_count: completion.expected,
    subtask_base_expected_count: completion.baseExpected,
    subtask_expected_breakpoint_count: completion.expectedBreakpoints,
    subtask_max_breakpoint_count: completion.maxBreakpoints,
    subtask_optional_extra_breakpoints: completion.optionalExtraBreakpoints,
    subtask_breakpoint_count: completion.breakpoints,
    subtask_complete_count: completion.complete,
    subtask_complete: completion.expected > 0 ? completion.breakpointComplete : null,
    subtask_source_status: sourceSubtaskStatus,
    subtask_source_segment_count: sourceSubtaskSegmentCount,
    subtask_source_matches_expected: sourceMatchesExpected,
    subtask_needs_manual_review: needsManualReview,
    subtask_manual_edited: subtaskEdited,
    subtask_breakpoints: breakpoints,
    subtask_segments: segments,
    note: $("noteInput").value.trim(),
    ui_version: config.version,
    review_seconds: Math.round(((Date.now() - startedAt) / 1000) * 10) / 10,
    created_at: new Date().toISOString()
  };
}

function validateRecord(record) {
  if (!record.chassis_type) return "请先选择机箱类型：大机箱或小机箱。每条都必须选择后才能保存。";
  if (record.bad_video) return "";
  if (!record.object_code) return "请先选择任务物体（1 cpu / 2 disk / 3 gpu / 4 ram / 5 ram2 / 8 自定义），再保存并进入下一条。";
  if (record.object_code === "custom_object" && !record.custom_object_text.trim()) {
    return "选择 8 自定义时，需要填写自定义物体名。";
  }
  if (!record.object) return "正常视频至少要选一个物体；如果看不清请勾 bad video。";
  if (record.action_prefix === "none" && record.subtask_expected_count > 0 && !record.subtask_complete) {
    const minBp = record.subtask_expected_breakpoint_count;
    const maxBp = record.subtask_max_breakpoint_count ?? minBp;
    const bpText = maxBp > minBp ? `${minBp}–${maxBp}` : `${minBp}`;
    const extraText = record.subtask_optional_extra_breakpoints > 0
      ? `（允许 ${record.subtask_optional_extra_breakpoints} 个可选额外断点/段）`
      : "";
    return `action=none 表示完整任务，需要 ${bpText} 个断点生成标准 ${record.subtask_base_expected_count ?? record.subtask_expected_count} 段${extraText}；当前 ${record.subtask_breakpoint_count}/${bpText}。`;
  }
  if (record.action_prefix === "none" && record.subtask_expected_count > 0 && record.subtask_needs_manual_review && !record.subtask_manual_edited) {
    return `源 subtask 与当前任务模板不一致或缺失：源 ${record.subtask_source_segment_count ?? 0} 段，当前标准需要 ${record.subtask_base_expected_count ?? record.subtask_expected_count} 段。请人工确认/重标分段后再保存。`;
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
    $("saveStatus").textContent = `已保存：${record.canonical_label}`;
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

  $("customObjectInput").addEventListener("input", () => {
    customObjectText = $("customObjectInput").value;
    renderSubtasks();
    refreshCanonical();
  });
  $("customObjectInput").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      saveAndNext();
    } else {
      ev.stopPropagation();
    }
  });

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
      setAction("none");
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "q") {
      setAction("pick_up");
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "w") {
      setAction("insert");
      ev.preventDefault();
      return;
    }
    if (key.toLowerCase() === "e") {
      setAction("pick_up_and_insert");
      ev.preventDefault();
      return;
    }
    if (key === "9") {
      setAction("other_action");
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
