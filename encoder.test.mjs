import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createMediaCache, createPlayback, dueSource, playbackPlan, renderFrame } from "./encoder.mjs";

const iso = ms => new Date(ms).toISOString();
const track = (id, start, end, kind = "upload", assetId = id) => ({
  id, title: id, kind, assetId, startAt: iso(start), endAt: iso(end),
  playbackUrl: kind === "upload" ? `/api/media/${assetId}?v=revision` : `/api/stream/${assetId}`,
  isSustainBlock: id.startsWith("sustain:"),
});
const status = (current, next, serverTime, scheduledNext) => ({
  current, next, scheduledNext, serverTime: iso(serverTime), playbackUrl: current?.playbackUrl ?? null,
});
const flush = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

function fixture({ delayStop = false, download = async () => "/cached" } = {}) {
  let time = 0, timerId = 0, finish;
  const timers = new Map(), events = [];
  const player = createPlayback({
    now: () => time,
    setTimer: (fn, delay) => { timers.set(++timerId, { at: time + delay, fn }); return timerId; },
    clearTimer: id => timers.delete(id),
    open(slot) {
      events.push(["open", slot.item.id, time]);
      return { id: slot.item.id, timeoutMs: 12000, stdout: Readable.from([Buffer.alloc(64, 7)], {objectMode:false}) };
    },
    stop(source) {
      events.push(["stop", source.id, time]);
      if (delayStop) return new Promise(resolve => { finish = resolve; });
    },
    cache: { download, retain: () => {} },
  });
  async function advance(to) {
    await flush();
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > to) break;
      timers.delete(next[0]);
      time = next[1].at;
      next[1].fn();
      await flush();
    }
    time = to;
    await flush();
  }
  return { player, events, advance, completeStop: () => finish?.() };
}

test("v35 fields and v34 legacy stream cap to a fixed start", () => {
  const legacy = track("default:stream", 0, 100000, "stream");
  const scheduled = track("fixed", 1000, 2000);
  const plan = playbackPlan(status(legacy, scheduled, 0));
  assert.equal(dueSource(plan, 999).end, 1000);
  assert.equal(dueSource(plan, 1000).item.id, "fixed");
  assert.equal(dueSource(plan, 2000), null);
  assert.equal(dueSource(plan, 1000, false), null);
});

test("fixed start retires the previous decoder and waits for its actual exit", async () => {
  const f = fixture({delayStop:true});
  const sustain = track("sustain:a", 0, 1000);
  const fixed = track("fixed", 1000, 2000, "stream");
  f.player.accept(status(sustain, fixed, 0, fixed));
  await f.advance(1000);
  assert.deepEqual(f.events,[["open","sustain:a",0],["stop","sustain:a",1000]]);
  assert.equal(f.player.read(20,2,1000), null);
  f.completeStop();
  await flush();
  assert.deepEqual(f.events.at(-1),["open","fixed",1000]);
  await f.advance(2000);
  assert.deepEqual(f.events.at(-1),["stop","fixed",2000]);
  f.completeStop();
  await flush();
});

for (const gap of [0,1,2,3,5,10]) {
  test(`Sustain resumes at the API-selected track after a ${gap}s gap`, async () => {
    const f = fixture();
    const scheduled = track("programme",0,1000,"stream");
    const resumed = track("sustain:b",1000,2000);
    const looped = track("sustain:a:lap2",2000+gap*1000,2200+gap*1000,"upload","a");
    f.player.accept(status(scheduled,resumed,0));
    await f.advance(1000);
    assert.deepEqual(f.events.at(-1),["open","sustain:b",1000]);
    f.player.accept(status(resumed,looped,1000));
    await f.advance(2000);
    if (gap) {
      assert.deepEqual(f.events.at(-1),["stop","sustain:b",2000]);
      assert.deepEqual(renderFrame(f.player.read(20,2,1000),20), Buffer.alloc(20));
      for(let time=2500;time<2000+gap*1000;time+=500) {
        await f.advance(time);
        f.player.accept(status(null,looped,time));
      }
    }
    await f.advance(2000+gap*1000);
    assert.deepEqual(f.events.at(-1),["open","sustain:a:lap2",2000+gap*1000]);
    await f.player.shutdown();
  });
}

test("failure invalidates forecasts and pending operations cannot restart old audio", async () => {
  let resolveOld;
  const f = fixture({download: slot => slot.item.id === "slow" ? new Promise(resolve => {resolveOld=resolve;}) : Promise.resolve("/ok")});
  const slow = track("slow",0,1000), future = track("obsolete",1000,2000,"stream");
  f.player.accept(status(slow,future,0));
  await f.advance(300);
  f.player.unavailable();
  resolveOld("/old");
  await f.advance(1100);
  assert.deepEqual(f.events,[]);
  const recovery = track("sustain:resumed",1000,3500);
  f.player.accept(status(recovery,null,1100));
  await flush();
  assert.deepEqual(f.events,[["open","sustain:resumed",1100]]);
  f.player.accept(status(future,null,1000));
  assert.deepEqual(f.events,[["open","sustain:resumed",1100]]);
  await f.advance(3500);
  assert.deepEqual(f.events.at(-1),["stop","sustain:resumed",3500]);
});

test("plan loss stops an indefinite legacy source when its freshness lease expires", async () => {
  const f = fixture();
  const stream = track("legacy",0,100000,"stream");
  f.player.accept(status(stream,null,0));
  await f.advance(1);
  assert.ok(f.player.read(20,2,1000));
  f.player.unavailable();
  await f.advance(2500);
  assert.deepEqual(f.events,[["open","legacy",0],["stop","legacy",2500]]);
});

test("cache preserves versioned keys and cancels invalid prefetch", async () => {
  const calls = [];
  const cache = createMediaCache("https://example.test",{"OAI-Sites-Authorization":"Bearer fixture"},
    (url, {headers,signal}) => {
      assert.equal(headers["OAI-Sites-Authorization"],"Bearer fixture");
      calls.push({url,signal});
      if(url.includes("obsolete")) return new Promise((_,reject) => signal.addEventListener("abort",()=>reject(signal.reason)));
      return Promise.resolve(new Response("audio"));
    }, async () => {}, "/tmp");
  const asset = track("a",0,1000);
  const first = { item:asset, url:"/api/media/a?v=original" };
  const second = { item:asset, url:"/api/media/a?v=replacement" };
  assert.notEqual(await cache.download(first),await cache.download(second));
  assert.equal(await cache.download(second),await cache.download(second));
  const obsolete = cache.download({item:asset,url:"/api/media/a?v=obsolete"});
  cache.retain([second]);
  await assert.rejects(obsolete, {name:"AbortError"});
  assert.equal(calls.length,3);
});

test("PCM cannot cross an absolute stop within an output frame", async () => {
  const f = fixture();
  f.player.accept(status(track("sustain:last",0,1000,"stream"),null,0));
  await f.advance(995);
  const audio = f.player.read(20,2,1000);
  assert.equal(audio.length,10);
  assert.deepEqual(renderFrame(audio,20).subarray(10),Buffer.alloc(10));
  await f.advance(1000);
  assert.equal(f.player.read(20,2,1000),null);
});
