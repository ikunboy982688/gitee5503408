// Moark Web (Cloudflare Pages/Workers)
// - Calls ai.gitee.com via same-origin proxy: /api/* (Pages Functions) to avoid CORS.
// - Downloads images/videos via /dl?url=... (Pages Function) to avoid cross-origin blocks.

const $ = (id) => document.getElementById(id);

// Provider registry: how to talk to each OpenAI-ish host.
// sizeKey / countKey are the important bit — SiliconFlow uses image_size +
// batch_size instead of the OpenAI style size + n. resultKey is where the
// generated images live in the JSON response.
const PROVIDERS = {
  gitee: {
    label: "Gitee AI",
    keyUrl: "https://ai.gitee.com/serverless-api",
    models: ["z-image-turbo"],
    sizeKey: "size",
    countKey: "n",
    resultKey: "data",
    async: true,
  },
  siliconflow: {
    label: "硅基流动 SiliconFlow",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    models: [
      "Qwen/Qwen-Image",
      "Kwai-Kolors/Kolors",
      "black-forest-labs/FLUX.1-schnell",
      "baidu/ERNIE-Image-Turbo",
    ],
    sizeKey: "image_size",
    countKey: "batch_size",
    resultKey: "images",
    async: false,
  },
  zhipu: {
    label: "智谱 BigModel",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    models: ["glm-image", "cogview-4", "cogview-3-flash"],
    sizeKey: "size",
    countKey: null,
    resultKey: "data",
    async: false,
    note: "尺寸需为 32 的倍数，已按官方推荐值预置",
  },
  dashscope: {
    label: "阿里百炼（兼容模式）",
    keyUrl: "https://bailian.console.aliyun.com/",
    models: ["qwen-image-max", "qwen-image-plus", "qwen-image-2.0-pro"],
    sizeKey: "size",
    countKey: "n",
    resultKey: "data",
    async: false,
    note: "阿里云文档说明图像模型可能不支持兼容模式，若报错请改用官方 SDK 接口",
  },
  anges: {
    label: "Agnes AI（免费）",
    keyUrl: "https://platform.agnes-ai.com/",
    models: ["agnes-image-2.1-flash", "agnes-image-2.0-flash"],
    sizeKey: "size",
    countKey: "n",
    resultKey: "data",
    async: false,
    note: "完全免费、无限调用，无需绑卡；返回 URL 或 Base64 均可，默认取 URL",
  },
  hunyuan: {
    label: "腾讯混元（TokenHub）",
    keyUrl: "https://console.cloud.tencent.com/tokenhub",
    models: ["HY-Image-V3.0"],
    sizeKey: "size",
    countKey: "n",
    resultKey: "data",
    async: false,
    note: "走 TokenHub 的 OpenAI 兼容接口；图片面积限制 ≤1024×1024，已按官方约束预置尺寸",
  },
};

// Each provider accepts a different set of resolutions
const SIZES = {
  gitee: {
    "1:1 (2048x2048)": [2048, 2048],
    "1:1 (1024x1024)": [1024, 1024],
    "3:4 (768x1024)": [768, 1024],
    "4:3 (1024x768)": [1024, 768],
    "16:9 (1024x576)": [1024, 576],
    "9:16 (576x1024)": [576, 1024],
  },
  siliconflow: {
    "1:1 (1024x1024)": [1024, 1024],
    "3:4 (768x1024)": [768, 1024],
    "4:3 (1024x768)": [1024, 768],
    "16:9 (1024x576)": [1024, 576],
    "9:16 (576x1024)": [576, 1024],
  },
  zhipu: {
    "1:1 (1280x1280)": [1280, 1280],
    "4:3 (1472x1088)": [1472, 1088],
    "3:4 (1088x1472)": [1088, 1472],
    "16:9 (1728x960)": [1728, 960],
    "9:16 (960x1728)": [960, 1728],
  },
  dashscope: {
    "1:1 (1024x1024)": [1024, 1024],
    "16:9 (1664x928)": [1664, 928],
    "9:16 (928x1664)": [928, 1664],
    "4:3 (1472x1104)": [1472, 1104],
    "3:4 (1104x1472)": [1104, 1472],
  },
  // Agnes AI: 多种清晰度档位与宽高比，沿用 OpenAI 风格 size=WxH
  anges: {
    "1:1 (1024x1024)": [1024, 1024],
    "3:4 (768x1024)": [768, 1024],
    "4:3 (1024x768)": [1024, 768],
    "16:9 (1024x576)": [1024, 576],
    "9:16 (576x1024)": [576, 1024],
  },
  // 腾讯混元 TokenHub Hy-Image-3.0: 宽高 [512,2048]，面积 ≤ 1024×1024
  hunyuan: {
    "1:1 (1024x1024)": [1024, 1024],
    "4:3 (1024x768)": [1024, 768],
    "3:4 (768x1024)": [768, 1024],
    "3:2 (1152x768)": [1152, 768],
    "2:3 (768x1152)": [768, 1152],
  },
};

function currentProviderId() {
  const el = $("providerSel");
  const v = el && el.value;
  return v && PROVIDERS[v] ? v : "gitee";
}

function currentProvider() {
  return PROVIDERS[currentProviderId()];
}

const EDIT_TASK_TYPES = ["id", "style", "pose", "layout", "color", "background"];

const WAN_RES_PRESETS = {
  "480p 横屏 / 832x480 (推荐 / Recommended)": [832, 480],
  "480p 竖屏 / 480x832": [480, 832],
  "720p 横屏 / 1280x720": [1280, 720],
  "720p 竖屏 / 720x1280": [720, 1280],
  "1024 方图 / 1024x1024": [1024, 1024],
  "2048 方图 / 2048x2048 (高成本 / Expensive)": [2048, 2048],
};

function nowTs() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function setStatus(text, kind="info") {
  const badge = $("statusBadge");
  if (!badge) return;

  badge.textContent = text;
  badge.style.borderColor =
    kind === "ok" ? "rgba(37,194,160,.7)" :
    kind === "err" ? "rgba(255,84,112,.75)" :
    "rgba(255,255,255,.10)";

  badge.style.background =
    kind === "ok" ? "rgba(37,194,160,.10)" :
    kind === "err" ? "rgba(255,84,112,.10)" :
    "rgba(255,255,255,.06)";
}

function waitingStatusText(label, tick, elapsedMs, extra="") {
  const sec = Math.floor(elapsedMs / 1000);
  const extraText = extra ? ` • ${extra}` : "";
  return `${label} 轮询中... 已等待 ${sec}s • 第 ${tick} 次检查${extraText} • 正常等待，并非卡死`;
}

const KEY_PREFIX = "moark_api_key_";

function storageKey(providerId) {
  return KEY_PREFIX + (providerId || currentProviderId());
}

function getApiKey() {
  const key = $("apiKey").value.trim();
  if (!key) throw new Error("请输入 API Key / Please enter API Key");
  return key;
}

function rememberKeyMaybe() {
  const key = $("apiKey").value.trim();
  if ($("rememberKey").checked && key) {
    // Each provider keeps its own key
    localStorage.setItem(storageKey(), key);
  }
}

function loadRememberedKey() {
  const key = localStorage.getItem(storageKey()) || "";
  $("apiKey").value = key;
  $("rememberKey").checked = !!key;
}

function clearRememberedKey() {
  localStorage.removeItem(storageKey());
  $("apiKey").value = "";
  $("rememberKey").checked = false;
}

function showPanel(model) {
  $("panelZ").style.display = model === "z-image" ? "block" : "none";
  $("panelEdit").style.display = model === "Edit-2511" ? "block" : "none";
  $("panelWan").style.display = model === "Wan2.2-I2V-A14B" ? "block" : "none";
  $("panelHunyuan").style.display = model === "HunyuanVideo-1.5" ? "block" : "none";
}

function addOutputItem({title, kind="info", meta="", element=null, rawJson=null, download=null, openUrl=null}) {
  const out = $("output");
  const box = document.createElement("div");
  box.className = "item";

  const h = document.createElement("h3");
  h.textContent = title;
  box.appendChild(h);

  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    box.appendChild(m);
  }

  if (element) box.appendChild(element);

  if (rawJson) {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(rawJson, null, 2);
    box.appendChild(pre);

    const btns = document.createElement("div");
    btns.className = "row";
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = "下载 JSON / Download JSON";
    b.onclick = () => downloadBlob(new Blob([pre.textContent], {type:"application/json"}), `${title}_${nowTs()}.json`);
    btns.appendChild(b);
    box.appendChild(btns);
  }

  if (download) {
    const btn = document.createElement("a");
    btn.className = "btn";
    btn.textContent = "下载 / Download";
    btn.href = download.href;
    btn.download = download.filename || "";
    btn.target = "_blank";
    btn.rel = "noopener";
    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(btn);

    if (openUrl) {
      const b2 = document.createElement("a");
      b2.className = "btn";
      b2.textContent = "打开 file_url";
      b2.href = openUrl;
      b2.target = "_blank";
      b2.rel = "noopener";
      row.appendChild(b2);
    }
    box.appendChild(row);
  } else if (openUrl) {
    const row = document.createElement("div");
    row.className = "row";
    const b2 = document.createElement("a");
    b2.className = "btn";
    b2.textContent = "打开 file_url";
    b2.href = openUrl;
    b2.target = "_blank";
    b2.rel = "noopener";
    row.appendChild(b2);
    box.appendChild(row);
  }

  out.prepend(box);
  return box;
}

function clearOutput() {
  $("output").innerHTML = "";
}

// Same-origin proxy: /api/<provider>/<path> -> that provider's upstream.
// Every call (including task polling) automatically follows the selected provider.
async function apiFetch(path, {method="GET", headers={}, body=null, signal=null}={}) {
  const p = currentProviderId();
  const res = await fetch(`/api/${p}/${path.replace(/^\/+/, "")}`, {
    method,
    headers,
    body,
    signal,
  });
  return res;
}

// Download proxy for arbitrary file_url/image urls to avoid CORS
async function dlFetch(url, {signal=null}={}) {
  const u = `/dl?url=${encodeURIComponent(url)}`;
  const res = await fetch(u, {method:"GET", signal});
  return res;
}

async function readJsonSafely(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _text: text };
  }
}

function clampInt(v, lo, hi, defv) {
  const n = Number.parseInt(String(v), 10);
  if (Number.isFinite(n)) return Math.max(lo, Math.min(hi, n));
  return defv;
}

function clampFloat(v, lo, hi, defv) {
  const n = Number.parseFloat(String(v));
  if (Number.isFinite(n)) return Math.max(lo, Math.min(hi, n));
  return defv;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function fetchAsBlob(url, kindHint="file") {
  const r = await dlFetch(url);
  if (!r.ok) {
    const j = await readJsonSafely(r);
    throw new Error(`下载失败 / Download failed (${r.status}): ${JSON.stringify(j).slice(0, 240)}`);
  }
  const blob = await r.blob();
  const objUrl = URL.createObjectURL(blob);
  return { blob, objUrl };
}

// Poll task status
async function pollTask(taskId, apiKey, {timeoutMs=30*60*1000, intervalMs=6000, onTick=null}={}) {
  const start = Date.now();
  let tick = 0;

  while (Date.now() - start < timeoutMs) {
    tick++;
    const elapsedMs = Date.now() - start;

    if (onTick) {
      onTick({
        tick,
        elapsedMs,
      });
    }

    const res = await apiFetch(`task/${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    const j = await readJsonSafely(res);
    const st = j.status || "unknown";
    if (st === "success" || st === "failed" || st === "cancelled") {
      return { status: st, raw: j };
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }

  return { status: "timeout", raw: { status:"timeout", message:"maximum wait time exceeded" } };
}


// -------- HunyuanVideo-1.5 (Text-to-Video) --------
async function runHunyuanVideo() {
  const apiKey = getApiKey();
  rememberKeyMaybe();

  const prompt = $("hyPrompt").value.trim();
  if (!prompt) throw new Error("请输入提示词 / Please input prompt");

  const negative_prompt = $("hyNeg").value.trim();

  const aspect_ratio = $("hyAspect").value;
  const num_inferenece_steps = clampInt($("hySteps").value, 1, 10, 10);
  const num_frames = clampInt($("hyFrames").value, 81, 241, 241);

  // seed must be positive integer
  const seedRaw = $("hySeed").value;
  const seed = Number.parseInt(String(seedRaw), 10);
  if (!Number.isFinite(seed) || seed <= 0) {
    throw new Error("seed 必须是正整数 / seed must be a positive integer");
  }

  const fps = clampInt($("hyFps").value, 1, 24, 24);
  const openAfter = $("hyOpenUrl").checked;

  // Compose payload (keep server field name: num_inferenece_steps)
  const payload = {
    prompt,
    model: "HunyuanVideo-1.5",
    aspect_ratio,
    negative_prompt,
    num_inferenece_steps,
    num_frames,
    seed,
    fps,
  };

  setStatus("HunyuanVideo 创建任务... / Creating task...");
  const res = await apiFetch("async/videos/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await readJsonSafely(res);
  if (!res.ok) {
    setStatus("HunyuanVideo 失败 / Failed", "err");
    addOutputItem({
      title: "HunyuanVideo 创建任务失败 / Create task failed",
      meta: `HTTP ${res.status}`,
      rawJson: j,
    });
    throw new Error(`API 错误 / API Error (${res.status})`);
  }

  const taskId = j.task_id;
  if (!taskId) {
    setStatus("HunyuanVideo 失败 / Failed", "err");
    addOutputItem({
      title: "HunyuanVideo 未返回 task_id / Missing task_id",
      rawJson: j,
    });
    throw new Error("Task ID not found in response");
  }

  addOutputItem({
    title: "HunyuanVideo 任务已创建 / Task created",
    meta: `task_id=${taskId} • aspect_ratio=${aspect_ratio} • frames=${num_frames} • fps=${fps} • steps=${num_inferenece_steps} • seed=${seed}`,
    rawJson: j,
    openUrl: openAfter ? `https://ai.gitee.com/v1/task/${encodeURIComponent(taskId)}` : null,
  });

  setStatus("HunyuanVideo 任务已创建，开始轮询...");
  const result = await pollTask(taskId, apiKey, {
    intervalMs: 10 * 1000,
    timeoutMs: 30 * 60 * 1000,
    onTick: (info) => {
      setStatus(waitingStatusText("HunyuanVideo", info.tick, info.elapsedMs));
    },
  });

  const st = result.status;
  const raw = result.raw || {};

  if (st !== "success") {
    setStatus(`HunyuanVideo ${st} / ${st}`, st === "failed" ? "err" : "info");
    addOutputItem({
      title: `HunyuanVideo 任务结束：${st} / Task ended: ${st}`,
      rawJson: raw,
      meta: `task_id=${taskId}`,
    });
    return;
  }

  // success
  const fileUrl = raw?.output?.file_url;
  const textRes = raw?.output?.text_result;

  if (fileUrl) {
    const blobInfo = await fetchAsBlob(fileUrl, "video");
    const video = document.createElement("video");
    video.src = blobInfo.objUrl;
    video.controls = true;
    video.playsInline = true;

    addOutputItem({
      title: "HunyuanVideo 输出 / Output",
      meta: `task_id=${taskId} • file_url=${fileUrl}`,
      element: video,
      rawJson: raw,
      download: { href: blobInfo.objUrl, filename: `hunyuan-video-${nowTs()}.mp4` },
      openUrl: openAfter ? fileUrl : null,
    });

    setStatus("HunyuanVideo 成功 / Success", "ok");
  } else if (textRes) {
    addOutputItem({
      title: "HunyuanVideo 文本输出 / Text output",
      meta: `task_id=${taskId}`,
      rawJson: raw,
    });
    setStatus("HunyuanVideo 成功 / Success", "ok");
  } else {
    addOutputItem({
      title: "HunyuanVideo 成功但无输出 / Success but no output",
      meta: `task_id=${taskId}`,
      rawJson: raw,
    });
    setStatus("HunyuanVideo 成功 / Success", "ok");
  }
}

// -------- z-image --------
async function runZImage() {
  const apiKey = getApiKey();
  rememberKeyMaybe();

  const provId = currentProviderId();
  const prov = currentProvider();

  const prompt = $("zPrompt").value.trim();
  if (!prompt) throw new Error("请输入提示词 / Please input prompt");

  const n = clampInt($("zN").value, 1, 4, 1);
  const sizes = SIZES[provId] || SIZES.gitee;
  const sizeSel = sizes[$("zRes").value] ? $("zRes").value : Object.keys(sizes)[0];
  const [w, h] = sizes[sizeSel];
  const size = `${w}x${h}`;
  const model = $("zModel") && $("zModel").value ? $("zModel").value : prov.models[0];

  setStatus("文生图生成中... / Generating...");

  // Providers disagree on field names: SiliconFlow wants image_size + batch_size
  const payload = { prompt, model };
  payload[prov.sizeKey] = size;
  if (prov.countKey) payload[prov.countKey] = n;

  const res = await apiFetch("images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await readJsonSafely(res);
  if (!res.ok) {
    setStatus("文生图失败 / Failed", "err");
    addOutputItem({
      title: "文生图生成失败 / Failed",
      rawJson: j,
      meta: `HTTP ${res.status} • provider=${provId} • model=${model}`,
    });
    throw new Error(`API 错误 / API Error (${res.status})`);
  }

  // OpenAI style returns data[], SiliconFlow returns images[]. Accept either.
  const data =
    (Array.isArray(j[prov.resultKey]) && j[prov.resultKey]) ||
    (Array.isArray(j.data) && j.data) ||
    (Array.isArray(j.images) && j.images) ||
    [];
  if (!data.length) {
    addOutputItem({ title: "z-image 返回无数据 / Empty response", rawJson: j });
    setStatus("z-image 失败 / Failed", "err");
    return;
  }

  for (let i = 0; i < data.length; i++) {
    const item = data[i] || {};
    let blobInfo = null;

    if (item.url) {
      blobInfo = await fetchAsBlob(item.url, "image");
    } else if (item.b64_json) {
      const byteChars = atob(item.b64_json);
      const bytes = new Uint8Array(byteChars.length);
      for (let k = 0; k < byteChars.length; k++) bytes[k] = byteChars.charCodeAt(k);
      const blob = new Blob([bytes], { type: "image/png" });
      blobInfo = { blob, objUrl: URL.createObjectURL(blob) };
    } else {
      addOutputItem({ title: `z-image 第${i+1}张无数据 / No image data`, rawJson: item });
      continue;
    }

    const img = document.createElement("img");
    img.src = blobInfo.objUrl;

    const filename = `z-image-${nowTs()}-${i+1}.png`;
    addOutputItem({
      title: `z-image 输出 #${i+1}`,
      meta: `size=${size}, n=${n}`,
      element: img,
      download: { href: blobInfo.objUrl, filename },
    });
  }

  setStatus("z-image 成功 / Success", "ok");
}

// -------- Edit-2511 --------
async function runEdit() {
  const apiKey = getApiKey();
  rememberKeyMaybe();

  const f1 = $("editImg1").files?.[0];
  const f2 = $("editImg2").files?.[0];
  const prompt = $("editPrompt").value.trim();
  if (!f1 || !f2 || !prompt) throw new Error("请上传2张图片并输入提示词 / Please provide 2 images and prompt");

  const taskTypes = Array.from(document.querySelectorAll("input[name='editTaskType']:checked")).map(x => x.value);
  if (!taskTypes.length) throw new Error("至少选择一个 task_types / Choose at least one task type");

  const steps = clampInt($("editSteps").value, 1, 50, 4);
  const guidance = clampFloat($("editGuidance").value, 0, 10, 1.0);

  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("model", "Qwen-Image-Edit-2511");
  fd.append("num_inference_steps", String(steps));
  fd.append("guidance_scale", String(guidance));
  for (const t of taskTypes) fd.append("task_types", t);
  fd.append("image", f1, f1.name);
  fd.append("image", f2, f2.name);

  setStatus("Edit-2511 创建任务中... / Creating task...");
  const res = await apiFetch("async/images/edits", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: fd,
  });

  const j = await readJsonSafely(res);
  if (!res.ok || !j.task_id) {
    setStatus("Edit-2511 创建失败 / Create failed", "err");
    addOutputItem({
      title: "Edit-2511 创建任务失败 / Create failed",
      meta: `HTTP ${res.status}`,
      rawJson: j,
    });
    throw new Error("创建任务失败 / Create failed");
  }

  const taskId = j.task_id;
  setStatus(`Edit-2511 任务已创建，开始轮询... (${taskId.slice(0,8)})`);

  const result = await pollTask(taskId, apiKey, {
    intervalMs: 6000,
    onTick: (info) => {
      setStatus(
        waitingStatusText(
          "Edit-2511",
          info.tick,
          info.elapsedMs,
          `task=${taskId.slice(0,8)}`
        )
      );
    },
  });

  addOutputItem({ title: `Edit-2511 任务结果 task=${taskId.slice(0,8)}`, rawJson: result.raw });

  if (result.status !== "success") {
    setStatus("Edit-2511 失败 / Failed", "err");
    throw new Error(`任务失败 / Task failed: ${result.status}`);
  }

  const fileUrl = result.raw?.output?.file_url;
  if (!fileUrl) throw new Error("success 但没有 file_url / no file_url");

  setStatus("Edit-2511 下载中... / Downloading...");
  const { objUrl } = await fetchAsBlob(fileUrl, "image");

  const img = document.createElement("img");
  img.src = objUrl;

  addOutputItem({
    title: "Edit-2511 输出图片",
    meta: `task_id=${taskId}`,
    element: img,
    download: { href: objUrl, filename: `edit-2511-${nowTs()}.png` },
    openUrl: $("editOpenUrl").checked ? fileUrl : null,
  });

  setStatus("Edit-2511 成功 / Success", "ok");
}

// -------- Wan2.2 I2V --------
function applyWanResolution() {
  const key = $("wanResPreset").value;
  const [w, h] = WAN_RES_PRESETS[key];
  $("wanW").value = String(w);
  $("wanH").value = String(h);
}

function applyWanPreset() {
  const p = $("wanPreset").value;
  let steps = 30;
  let guidance = 5.0;
  let fps = 24;

  if (p.includes("更清晰")) { steps = 60; guidance = 6.0; }
  else if (p.includes("更动感")) { steps = 40; guidance = 5.0; fps = 30; }
  else if (p.includes("更快")) { steps = 20; guidance = 4.0; }

  $("wanSteps").value = String(steps);
  $("wanGuidance").value = String(guidance);
  $("wanFps").value = String(fps);

  if ($("wanAutoFrames").checked) {
    $("wanFrames").value = String(Math.max(1, Math.min(300, fps * 5)));
  }
}

function buildWanFormData({
  imageFile, prompt, model, numInferenceSteps, numFrames, guidanceScale,
  width, height, negativePrompt, seed, watermark, promptExtend, useTypoField=false
}) {
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("model", model);
  fd.append("num_frames", String(numFrames));
  fd.append("guidance_scale", String(guidanceScale));
  fd.append("height", String(height));
  fd.append("width", String(width));
  if (negativePrompt?.trim()) fd.append("negative_prompt", negativePrompt.trim());
  if (seed !== null && seed !== undefined) fd.append("seed", String(seed));
  if (watermark !== null && watermark !== undefined) fd.append("watermark", watermark ? "true" : "false");
  if (promptExtend !== null && promptExtend !== undefined) fd.append("prompt_extend", promptExtend ? "true" : "false");
  fd.append(useTypoField ? "num_inferenece_steps" : "num_inference_steps", String(numInferenceSteps));
  fd.append("image", imageFile, imageFile.name);
  return fd;
}

async function createWanTask(apiKey, params) {
  // Try correct field name first
  let fd = buildWanFormData({ ...params, useTypoField:false });
  let res = await apiFetch("async/videos/image-to-video", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: fd,
  });
  let j = await readJsonSafely(res);
  if (res.ok && j.task_id) return { ok:true, res, json:j, tried:"num_inference_steps" };

  // Fallback to typo
  fd = buildWanFormData({ ...params, useTypoField:true });
  res = await apiFetch("async/videos/image-to-video", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: fd,
  });
  const j2 = await readJsonSafely(res);
  if (res.ok && j2.task_id) return { ok:true, res, json:j2, tried:"num_inferenece_steps" };

  return { ok:false, res, json:{ _try1: j, _try2: j2 }, tried:"both" };
}

// Optional: zip segments via JSZip loaded dynamically when needed
async function ensureJsZip() {
  if (window.JSZip) return window.JSZip;
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";
  script.crossOrigin = "anonymous";
  document.head.appendChild(script);
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("加载 JSZip 失败 / Failed to load JSZip"));
  });
  return window.JSZip;
}

async function zipAndDownloadMp4s(files, zipName) {
  const JSZip = await ensureJsZip();
  const zip = new JSZip();
  for (const f of files) {
    zip.file(f.name, f.blob);
  }
  const blob = await zip.generateAsync({ type: "blob" });
  downloadBlob(blob, zipName);
}

async function runWan() {
  const apiKey = getApiKey();
  rememberKeyMaybe();

  const img = $("wanImg").files?.[0];
  if (!img) throw new Error("请选择有效图片 / Please select a valid image");

  const prompt = $("wanPrompt").value.trim();
  if (!prompt) throw new Error("请输入提示词 / Please input prompt");

  const neg = $("wanNeg").value.trim();

  const width = clampInt($("wanW").value, 64, 2048, 832);
  const height = clampInt($("wanH").value, 64, 2048, 480);
  const steps = clampInt($("wanSteps").value, 1, 100, 30);
  const guidance = clampFloat($("wanGuidance").value, 0, 20, 5.0);

  const fps = clampInt($("wanFps").value, 1, 60, 24);
  const duration = clampFloat($("wanDuration").value, 0.5, 60, 5.0);

  let numFrames;
  if ($("wanAutoFrames").checked) {
    numFrames = Math.max(1, Math.min(300, fps * 5));
    $("wanFrames").value = String(numFrames);
  } else {
    numFrames = clampInt($("wanFrames").value, 1, 300, 30);
  }

  const seedVal = clampInt($("wanSeed").value, -1, 2147483647, -1);
  const seed = seedVal < 0 ? null : seedVal;

  const watermark = $("wanWatermark").checked;
  const promptExtend = $("wanPromptExtend").checked;

  // segment logic (same spirit as desktop): assume backend returns 5s per segment
  const segmentLen = 5.0;
  const segCount = Math.max(1, Math.ceil(duration / segmentLen));

  const segments = []; // {name, blob, objUrl, fileUrl, taskId}

  for (let i = 0; i < segCount; i++) {
    setStatus(`Wan2.2 分段 ${i+1}/${segCount} 创建中... / Segment ${i+1}/${segCount} creating...`);

    const create = await createWanTask(apiKey, {
      imageFile: img,
      prompt,
      model: "Wan2_2-I2V-A14B",
      numInferenceSteps: steps,
      numFrames,
      guidanceScale: guidance,
      width,
      height,
      negativePrompt: neg,
      seed,
      watermark,
      promptExtend,
    });

    if (!create.ok) {
      setStatus("Wan2.2 创建失败 / Create failed", "err");
      addOutputItem({
        title: `Wan2.2 创建任务失败（分段 ${i+1}）`,
        meta: `tried=${create.tried}, HTTP ${create.res.status}`,
        rawJson: create.json,
      });
      throw new Error("创建任务失败 / Create failed");
    }

    const taskId = create.json.task_id;
    setStatus(`Wan2.2 分段 ${i+1}/${segCount} 任务已创建，开始轮询... (${taskId.slice(0,8)})`);

    const result = await pollTask(taskId, apiKey, {
      timeoutMs: 60*60*1000,
      intervalMs: 8000,
      onTick: (info) => {
        setStatus(
          waitingStatusText(
            `Wan2.2 分段 ${i+1}/${segCount}`,
            info.tick,
            info.elapsedMs,
            `task=${taskId.slice(0,8)}`
          )
        );
      },
    });

    addOutputItem({ title: `Wan2.2 分段 ${i+1} 任务结果`, rawJson: result.raw, meta: `task_id=${taskId}` });

    if (result.status !== "success") {
      setStatus("Wan2.2 失败 / Failed", "err");
      throw new Error(`任务失败 / Task failed: ${result.status}`);
    }

    const fileUrl = result.raw?.output?.file_url;
    if (!fileUrl) throw new Error("success 但没有 file_url / no file_url");

    setStatus(`Wan2.2 分段 ${i+1}/${segCount} 下载中... / Downloading...`);
    const dl = await fetchAsBlob(fileUrl, "video");
    const name = `wan_seg${i+1}_${nowTs()}.mp4`;

    segments.push({ name, blob: dl.blob, objUrl: dl.objUrl, fileUrl, taskId });

    // Show each segment playable + download
    const video = document.createElement("video");
    video.controls = true;
    video.src = dl.objUrl;

    addOutputItem({
      title: `Wan2.2 输出视频（分段 ${i+1}/${segCount}）`,
      meta: `width=${width}, height=${height}, frames=${numFrames}, steps=${steps}, guidance=${guidance}`,
      element: video,
      download: { href: dl.objUrl, filename: name },
      openUrl: $("wanOpenUrl").checked ? fileUrl : null,
    });
  }

  // Optional zip download
  if (segCount > 1 && $("wanZipSegments").checked) {
    try {
      setStatus("Wan2.2 打包 zip 中... / Zipping...");
      await zipAndDownloadMp4s(segments, `wan_segments_${nowTs()}.zip`);
      setStatus("Wan2.2 成功 / Success", "ok");
    } catch (e) {
      addOutputItem({ title: "Wan2.2 zip 打包失败 / Zip failed", meta: String(e) });
      setStatus("Wan2.2 成功（但 zip 失败）/ Success (zip failed)", "ok");
    }
  } else {
    setStatus("Wan2.2 成功 / Success", "ok");
  }
}

// ---- init UI ----
function fillSelect(el, values, keepValue) {
  if (!el) return;
  el.innerHTML = "";
  for (const k of values) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    el.appendChild(o);
  }
  if (keepValue && values.indexOf(keepValue) !== -1) el.value = keepValue;
}

function refreshProviderUi() {
  const provId = currentProviderId();
  const prov = PROVIDERS[provId];

  fillSelect($("zModel"), prov.models);
  fillSelect($("zRes"), Object.keys(SIZES[provId] || SIZES.gitee));

  const link = $("providerKeyUrl");
  if (link) {
    link.textContent = prov.keyUrl;
    link.href = prov.keyUrl;
  }
  const note = $("providerNote");
  if (note) note.textContent = prov.note || "";

  // Async models (Edit / Wan / Hunyuan) only exist on Gitee
  const modelSel = $("modelSel");
  if (modelSel) {
    Array.from(modelSel.options).forEach((opt) => {
      opt.disabled = !prov.async && opt.value !== "z-image";
    });
    if (!prov.async && modelSel.value !== "z-image") modelSel.value = "z-image";
    showPanel(modelSel.value);
  }

  loadRememberedKey();
}

function initUi() {
  // fill provider select
  const pSel = $("providerSel");
  if (pSel) {
    for (const id of Object.keys(PROVIDERS)) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = PROVIDERS[id].label;
      pSel.appendChild(o);
    }
    const saved = localStorage.getItem("moark_provider");
    if (saved && PROVIDERS[saved]) pSel.value = saved;
    pSel.addEventListener("change", () => {
      localStorage.setItem("moark_provider", pSel.value);
      refreshProviderUi();
    });
  }

  refreshProviderUi();

  const wanRes = $("wanResPreset");
  for (const k of Object.keys(WAN_RES_PRESETS)) {
    const o = document.createElement("option");
    o.value = k; o.textContent = k;
    wanRes.appendChild(o);
  }
  wanRes.value = Object.keys(WAN_RES_PRESETS)[0];
  applyWanResolution();

  // task type checkboxes
  const box = $("editTaskTypes");
  for (const t of EDIT_TASK_TYPES) {
    const label = document.createElement("label");
    label.className = "chk";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "editTaskType";
    input.value = t;
    input.checked = (t === "id" || t === "style");
    label.appendChild(input);
    label.appendChild(document.createTextNode(" " + t));
    box.appendChild(label);
  }

  // model selection
  $("modelSel").addEventListener("change", (e) => showPanel(e.target.value));
  showPanel($("modelSel").value);

  // buttons
  $("btnZRun").onclick = async () => {
    try { await runZImage(); }
    catch (e) { addOutputItem({ title:"z-image 错误 / Error", meta:String(e) }); }
  };
  $("btnEditRun").onclick = async () => {
    try { await runEdit(); }
    catch (e) { addOutputItem({ title:"Edit-2511 错误 / Error", meta:String(e) }); }
  };
  $("btnWanRun").onclick = async () => {
    try { await runWan(); }
    catch (e) { addOutputItem({ title:"Wan2.2 错误 / Error", meta:String(e) }); }
  };

  $("btnHyRun").onclick = async () => {
    try { await runHunyuanVideo(); }
    catch (e) { addOutputItem({ title:"HunyuanVideo 错误 / Error", meta:String(e) }); }
  };

  $("btnClearOutput").onclick = clearOutput;

  $("btnWanApplyPreset").onclick = applyWanPreset;
  $("wanResPreset").addEventListener("change", applyWanResolution);
  $("wanAutoFrames").addEventListener("change", () => {
    if ($("wanAutoFrames").checked) {
      const fps = clampInt($("wanFps").value, 1, 60, 24);
      $("wanFrames").value = String(Math.max(1, Math.min(300, fps * 5)));
    }
  });
  $("wanFps").addEventListener("change", () => {
    if ($("wanAutoFrames").checked) {
      const fps = clampInt($("wanFps").value, 1, 60, 24);
      $("wanFrames").value = String(Math.max(1, Math.min(300, fps * 5)));
    }
  });

  $("btnClearKey").onclick = clearRememberedKey;

  loadRememberedKey();
}

window.addEventListener("DOMContentLoaded", () => {
  initUi();
  setStatus("准备就绪 / Ready");
});
