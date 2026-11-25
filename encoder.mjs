import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const pollMs = 250;
const planLeaseMs = 2500;
const frameMs = 10;
const retryMaxMs = 30000;
const prefixSeconds = 2;

function timedItem(item, url) {
  if (!item || !url) return null;
  const start = Date.parse(item.startAt), end = Date.parse(item.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { item, url, start, end, key: JSON.stringify([item.id, start, url]) };
}

function playbackUrl(item) {
  return item.playbackUrl || (item.kind === "stream" ? `/api/stream/${item.assetId}` : `/api/media/${item.assetId}`);
}

export function playbackPlan(status) {
  const current = timedItem(status.current, status.playbackUrl || status.current?.playbackUrl);
  const next = timedItem(status.next, status.next && playbackUrl(status.next));
  const scheduledNext = timedItem(status.scheduledNext, status.scheduledNext && playbackUrl(status.scheduledNext));
  if (current && next && next.start > current.start) current.end = Math.min(current.end, next.start);
  return { current, next, scheduledNext };
}

export function dueSource(plan, now, allowNext = true) {
  const { current, next } = plan;
  if (allowNext && next && next.start <= now && now < next.end) return next;
  if (current && current.start <= now && now < current.end) return current;
  return null;
}

export function createMediaCache(site, headers, fetchMedia = fetch, saveFile = writeFile, root = tmpdir(), prepare = null) {
  const entries = new Map();
  const warmEntries = new Map();
  const resolve = url => new URL(url, site).href;

  function download(slot) {
    const key = resolve(slot.url);
    const cached = entries.get(key);
    if (cached && (!prepare || !cached.complete || cached.prefix !== undefined)) return cached.task;
    const controller = new AbortController();
    const entry = { controller, complete: false };
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    entry.task = (async () => {
      let path = cached?.path;
      if (!path) {
        const response = await fetchMedia(key, { headers, signal });
        if (!response.ok) throw new Error(`Audio download returned HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length) throw new Error("Downloaded audio file was empty");
        signal.throwIfAborted();
        const hash = createHash("sha256").update(key).digest("hex");
        path = join(root, `signalflow-${hash}.audio`);
        await saveFile(path, bytes);
      }
      entry.path = path;
      signal.throwIfAborted();
      if (prepare) entry.prefix = await prepare(path, signal);
      signal.throwIfAborted();
      if (entry.prefix?.length) {
        warmEntries.set(key, entry);
        if (warmEntries.size > 24) {
          const [oldKey, oldEntry] = warmEntries.entries().next().value;
          oldEntry.prefix = undefined;
          warmEntries.delete(oldKey);
        }
      }
      entry.complete = true;
      return path;
    })().catch(error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key, entry);
    return entry.task;
  }

  function retain(slots) {
    const wanted = new Set(slots.filter(slot => slot?.item.kind === "upload").map(slot => resolve(slot.url)));
    for (const [key, entry] of entries) {
      if (!entry.complete && !wanted.has(key)) {
        entries.delete(key);
        entry.controller.abort();
      }
    }
  }

  return { download, retain, prefix: slot => entries.get(resolve(slot.url))?.prefix };
}

export function createPlayback({
  now = Date.now, open, stop, cache, onError = () => {}, onFirstAudio = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let plan = { current: null, next: null, scheduledNext: null };
  let lastServerTime = -Infinity;
  let expires = 0, healthy = false, halted = false, timer, job, closing;
  let retryKey, retryAt = 0, failures = 0;

  function desired(time) {
    if (halted || time >= expires) return null;
    if (!healthy) {
      return job?.hasAudio && job.slot.key === plan.current?.key && plan.current.end > time
        ? plan.current : null;
    }
    return dueSource(plan, time);
  }

  function retire() {
    const previous = job;
    job = null;
    if (!previous?.source) return;
    const stopped = Promise.resolve(stop(previous.source));
    closing = stopped;
    void stopped.then(() => {
      if (closing === stopped) closing = null;
      reconcile();
    }, error => {
      // Fail closed if the process exit cannot be verified.
      onError(error);
    });
  }

  function failed(attempt, error) {
    if (job !== attempt) return;
    const key = attempt.slot.key;
    failures = retryKey === key ? failures + 1 : 1;
    retryKey = key;
    retryAt = now() + Math.min(retryMaxMs, 500 * 2 ** Math.min(failures - 1, 6));
    if (error) onError(error);
    retire();
    reconcile();
  }

  async function start(attempt) {
    try {
      const { slot } = attempt;
      const prepared = slot.item.kind === "upload" ? await cache.download(slot) : null;
      const time = now(), target = desired(time);
      if (job !== attempt || target?.key !== slot.key) return;
      attempt.source = open(target, prepared, time, error => failed(attempt, error), cache.prefix?.(target));
      attempt.lastAudioAt = now();
    } catch (error) { failed(attempt, error); }
  }

  function reconcile() {
    clearTimer(timer);
    if (halted) return;
    const time = now(), target = desired(time);
    const future = healthy && time < expires
      ? [plan.next, plan.scheduledNext].filter(slot => slot && slot.start > time && slot.start - time < 30000)
      : [];
    cache.retain([target, ...future]);
    if (job && job.slot.key !== target?.key) retire();
    if (target && !job && !closing && (target.key !== retryKey || time >= retryAt)) {
      const attempt = { slot: target, source: null, lastAudioAt: time };
      job = attempt;
      void start(attempt);
    }
    const boundaries = [
      expires, plan.current?.start, plan.current?.end, plan.next?.start, plan.next?.end, retryAt,
    ].filter(value => value > time);
    if (boundaries.length) timer = setTimer(reconcile, Math.min(30000, Math.min(...boundaries) - time));
  }

  function accept(status) {
    const serverTime = Date.parse(status.serverTime);
    if (Number.isFinite(serverTime) && serverTime < lastServerTime) return;
    if (Number.isFinite(serverTime)) lastServerTime = serverTime;
    plan = playbackPlan(status);
    healthy = true;
    expires = now() + planLeaseMs;
    reconcile();
    for (const slot of [plan.next, plan.scheduledNext]) {
      if (slot?.item.kind === "upload" && slot.start > now() && slot.start - now() < 30000) {
        void cache.download(slot).catch(() => {});
      }
    }
  }

  function unavailable() {
    healthy = false;
    reconcile();
  }

  function read(frameBytes, bytesPerSampleFrame, sampleRate, frameTime = now()) {
    const time = now();
    const target = desired(time);
    if (job && job.slot.key !== target?.key) {
      reconcile();
      return null;
    }
    const source = job?.source;
    if (!source || frameTime < target.start) return null;
    const limit = Math.floor((Math.min(target.end, expires) - frameTime) * sampleRate / 1000) * bytesPerSampleFrame;
    frameBytes = Math.min(frameBytes, limit);
    if (frameBytes <= 0) return null;
    const prefix = source.prefix?.subarray(source.prefixOffset, source.prefixOffset + frameBytes);
    if (prefix) source.prefixOffset += prefix.length;
    const remaining = frameBytes - (prefix?.length ?? 0);
    const available = source.stdout.readableLength;
    const decoded = remaining && source.stdout.read(source.exited && available && available < remaining ? available : remaining);
    const chunk = prefix?.length
      ? decoded ? Buffer.concat([prefix, decoded]) : Buffer.from(prefix)
      : decoded;
    if (chunk?.length) {
      job.lastAudioAt = time;
      if (!job.hasAudio) onFirstAudio(target, time);
      job.hasAudio = true;
      retryKey = undefined;
      failures = 0;
      return fadeScheduledStream(chunk, target, frameTime, bytesPerSampleFrame, sampleRate);
    }
    if (source.exited || time - job.lastAudioAt > source.timeoutMs) {
      failed(job, new Error(`Source ended or stalled: ${job.slot.item.title}`));
    }
    return null;
  }

  function shutdown() {
    halted = true;
    clearTimer(timer);
    cache.retain([]);
    retire();
    return closing;
  }
  function resync(requireFresh = false) {
    if (requireFresh) healthy = false;
    retire();
    reconcile();
  }
  return { accept, unavailable, read, shutdown, resync };
}

export function fadeScheduledStream(audio, slot, frameTime, bytesPerSampleFrame, sampleRate) {
  if (slot.item.kind !== "stream" || slot.item.isDefault) return audio;
  const fadeMs = Math.min(3000, slot.end - slot.start);
  if (frameTime + audio.length / bytesPerSampleFrame * 1000 / sampleRate <= slot.end - fadeMs) return audio;
  for (let offset = 0; offset + 1 < audio.length; offset += 2) {
    const time = frameTime + Math.floor(offset / bytesPerSampleFrame) * 1000 / sampleRate;
    const gain = Math.max(0, Math.min(1, (slot.end - time) / fadeMs));
    audio.writeInt16LE(Math.trunc(audio.readInt16LE(offset) * gain), offset);
  }
  return audio;
}

export function createPcmClock({ sampleRate, bytesPerSampleFrame, read, onResync,
  monotonicNow = () => performance.now(), wallNow = Date.now, maxLagMs = 250 }) {
  let origin = monotonicNow(), tick = 0, blocked = false;
  function reset() {
    origin = monotonicNow();
    tick = 0;
    blocked = false;
  }
  function pump(writable) {
    const elapsed = monotonicNow() - origin;
    const due = Math.floor(elapsed / frameMs);
    if (elapsed - tick * frameMs > maxLagMs) {
      const stalled = blocked || !writable || writable.writableNeedDrain;
      onResync(due - tick, stalled);
      reset();
      return;
    }
    if (!writable?.writable || writable.writableNeedDrain) {
      blocked = true;
      return;
    }
    blocked = false;
    const wall = wallNow();
    while (tick < due && !writable.writableNeedDrain) {
      const samples = Math.floor((tick + 1) * sampleRate * frameMs / 1000) -
        Math.floor(tick * sampleRate * frameMs / 1000);
      const bytes = samples * bytesPerSampleFrame;
      const frameTime = wall - (elapsed - (++tick * frameMs));
      writable.write(renderFrame(read(bytes, bytesPerSampleFrame, sampleRate, frameTime), bytes));
    }
    blocked = writable.writableNeedDrain;
  }
  return { pump, reset };
}

export function renderFrame(audio, bytes) {
  if (audio?.length === bytes) return audio;
  const frame = Buffer.alloc(bytes);
  audio?.copy(frame);
  return frame;
}

function processExit(child) {
  return new Promise(resolve => {
    child.once("exit", resolve);
    child.on("error", () => { if (!child.pid) resolve(); });
  });
}

async function stopChild(child, exited) {
  if (!child) return;
  child.kill("SIGTERM");
  const escalate = setTimeout(() => child.kill("SIGKILL"), 500);
  try { await exited; }
  finally { clearTimeout(escalate); }
}

function runEncoder(env = process.env) {
  const required = ["SIGNALFLOW_URL", "ICECAST_HOST", "ICECAST_PORT", "ICECAST_MOUNT", "ICECAST_SOURCE_USER", "ICECAST_SOURCE_PASSWORD"];
  for (const key of required) if (!env[key]) throw new Error(`Missing required setting: ${key}`);
  const site = env.SIGNALFLOW_URL.replace(/\/$/, "");
  const siteOrigin = new URL(site).origin;
  const sampleRate = Number(env.AUDIO_SAMPLE_RATE || 44100);
  const channels = Number(env.AUDIO_CHANNELS || 2);
  const format = (env.AUDIO_FORMAT || "mp3").toLowerCase();
  if (!Number.isInteger(sampleRate) || sampleRate <= 0 || ![1, 2].includes(channels) || !["mp3", "aac"].includes(format)) {
    throw new Error("Invalid audio format settings");
  }
  const siteHeaders = env.SIGNALFLOW_SITE_TOKEN
    ? { "OAI-Sites-Authorization": `Bearer ${env.SIGNALFLOW_SITE_TOKEN}` } : {};
  const ffmpegHeader = env.SIGNALFLOW_SITE_TOKEN
    ? `OAI-Sites-Authorization: Bearer ${env.SIGNALFLOW_SITE_TOKEN}\r\n` : "";
  const bytesPerSampleFrame = channels * 2;
  const execute = promisify(execFile);
  async function prepare(path, signal) {
    try {
      const { stdout } = await execute("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-i", path, "-t", String(prefixSeconds),
        "-vn", "-ar", String(sampleRate), "-ac", String(channels), "-f", "s16le", "pipe:1",
      ], { encoding: "buffer", maxBuffer: sampleRate * bytesPerSampleFrame * (prefixSeconds + 1),
        signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
      return stdout;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }
  const cache = createMediaCache(site, siteHeaders, fetch, writeFile, tmpdir(), prepare);
  const log = (...args) => console.log(new Date().toISOString(), ...args);

  function open(slot, cached, now, onError, prefix) {
    const { item } = slot;
    const args = ["-hide_banner", "-loglevel", "warning", "-thread_queue_size", "2048"];
    let input = cached;
    let override, prefixOffset = 0;
    if (item.kind === "upload") {
      args.push("-analyzeduration", "20000000", "-probesize", "20000000");
      if (item.loop) args.push("-stream_loop", "-1");
      const elapsed = (now - slot.start) / 1000;
      const seek = item.loop && item.durationSeconds ? elapsed % item.durationSeconds : elapsed;
      const seekSamples = Math.floor(seek * sampleRate);
      prefixOffset = seekSamples * bytesPerSampleFrame;
      const tail = prefix && prefixOffset < prefix.length && (!item.loop || item.durationSeconds > prefixSeconds)
        ? prefix.length / bytesPerSampleFrame / sampleRate : seek;
      if (tail === seek) prefix = null;
      if (tail > 0) args.push("-ss", tail.toFixed(6));
    } else {
      const remote = item.sourceUrl && new URL(item.sourceUrl);
      const host = env.STREAM_HOST_OVERRIDE_HOST?.trim();
      const ip = env.STREAM_HOST_OVERRIDE_IP?.trim();
      if (env.STREAM_HOST_OVERRIDE_ENABLED === "true" && remote && host && ip && remote.hostname === host) {
        override = remote;
        input = "pipe:0";
      } else {
        const url = new URL(slot.url, site);
        input = url.href;
        if (url.origin === siteOrigin && ffmpegHeader) args.push("-headers", ffmpegHeader);
      }
    }
    args.push("-i", input);
    const layout = channels === 1 ? "mono" : "stereo";
    const filters = [`aresample=${sampleRate}:async=1:first_pts=0`, `aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=${layout}`];
    args.push("-vn", "-af", filters.join(","), "-f", "s16le", "-acodec", "pcm_s16le",
      "-ar", String(sampleRate), "-ac", String(channels), "pipe:1");
    const child = spawn("ffmpeg", args, { stdio: [override ? "pipe" : "ignore", "pipe", "pipe"] });
    const exited = processExit(child);
    const source = { child, stdout: child.stdout, childExit: exited, exited: false, timeoutMs: 12000, prefix, prefixOffset };
    child.stderr.on("data", data => process.stderr.write(data));
    child.once("error", onError);
    child.stdout.on("error", onError);
    void exited.then(() => { source.exited = true; });
    if (override) {
      const port = override.port || (override.protocol === "https:" ? "443" : "80");
      log(`Using configured DNS override for ${override.hostname}`);
      const fetcher = spawn("curl", ["--fail", "--silent", "--show-error", "--location", "--no-buffer",
        "--connect-timeout", "8", "--resolve", `${override.hostname}:${port}:${env.STREAM_HOST_OVERRIDE_IP.trim()}`,
        override.href], { stdio: ["ignore", "pipe", "pipe"] });
      source.fetcher = fetcher;
      source.fetcherExit = processExit(fetcher);
      fetcher.stderr.on("data", data => process.stderr.write(data));
      fetcher.once("error", onError);
      child.stdin.on("error", () => {});
      fetcher.stdout.pipe(child.stdin);
    }
    log(`Starting ${item.title} (${item.id})`);
    return source;
  }

  async function stop(source) {
    source.stdout.destroy();
    await Promise.all([stopChild(source.fetcher, source.fetcherExit), stopChild(source.child, source.childExit)]);
  }

  const playback = createPlayback({ open, stop, cache, onError: error => log(error.message),
    onFirstAudio: (slot, time) => log(`First PCM for ${slot.item.title}: ${Math.max(0, time - slot.start)}ms after start`),
  });
  const icecastUrl = () => {
    const auth = `${encodeURIComponent(env.ICECAST_SOURCE_USER)}:${encodeURIComponent(env.ICECAST_SOURCE_PASSWORD)}`;
    const mount = env.ICECAST_MOUNT.startsWith("/") ? env.ICECAST_MOUNT : `/${env.ICECAST_MOUNT}`;
    return `icecast://${auth}@${env.ICECAST_HOST}:${env.ICECAST_PORT}${mount}`;
  };

  let encoder, stopping = false;
  function startEncoder() {
    if (encoder || stopping) return;
    const codec = format === "aac" ? ["-c:a", "aac", "-f", "adts", "-content_type", "audio/aac"]
      : ["-c:a", "libmp3lame", "-f", "mp3", "-content_type", "audio/mpeg"];
    const args = ["-hide_banner", "-loglevel", "warning", "-f", "s16le", "-ar", String(sampleRate),
      "-ac", String(channels), "-i", "pipe:0", ...codec, "-b:a", env.AUDIO_BITRATE || "128k",
      "-ice_name", env.STATION_NAME || "SignalFlow Radio",
      "-ice_description", env.STATION_DESCRIPTION || "SignalFlow continuous playout",
      "-ice_url", env.STATION_URL || "", "-ice_public", env.ICECAST_PUBLIC === "true" ? "1" : "0",
      ...(env.ICECAST_TLS === "true" ? ["-tls", "1"] : []), icecastUrl()];
    log("Connecting continuous output to Icecast");
    const child = spawn("ffmpeg", args, { stdio: ["pipe", "ignore", "pipe"] });
    encoder = child;
    clock.reset();
    playback.resync(true);
    child.stderr.on("data", data => process.stderr.write(data));
    child.stdin.on("error", () => {});
    void processExit(child).then(() => {
      if (encoder !== child) return;
      encoder = null;
      if (!stopping) setTimeout(startEncoder, 2000);
    });
  }

  // One writer sends an audio frame or zeros on every tick. Decoders never write
  // to the destination, so buffered output from a retired source cannot leak.
  const clock = createPcmClock({
    sampleRate, bytesPerSampleFrame, read: playback.read,
    onResync(missedTicks, stalled) {
      log(`Output clock resync after ${missedTicks * frameMs}ms of backlog`);
      if (stalled && encoder) encoder.kill("SIGKILL");
      playback.resync();
    },
  });
  const pump = setInterval(() => {
    if (encoder) clock.pump(encoder.stdin);
  }, frameMs);

  async function poll() {
    while (!stopping) {
      try {
        const response = await fetch(`${site}/api/now`, { headers: siteHeaders, cache: "no-store", signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error(`SignalFlow returned HTTP ${response.status}`);
        const status = await response.json();
        if (!status || !("current" in status) || !("next" in status)) throw new Error("Invalid SignalFlow status");
        if (!stopping) playback.accept(status);
      } catch (error) {
        playback.unavailable();
        log(error.message);
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(pump);
    encoder?.stdin.end();
    const timeout = setTimeout(() => { encoder?.kill("SIGTERM"); process.exit(0); }, 2000);
    timeout.unref();
    await playback.shutdown();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  startEncoder();
  void poll();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runEncoder();
