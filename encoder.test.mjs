import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createMediaCache, createPlayback, createPcmClock, dueSource, fadeScheduledStream, playbackPlan, renderFrame } from "./encoder.mjs";

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

test("monotonic clock writes the exact sample count over an hour with jitter and short backpressure", () => {
  let time = 0, total = 0, reads = 0;
  const sink = { writable:true, writableNeedDrain:false, write(chunk) { total += chunk.length; } };
  const clock = createPcmClock({
    sampleRate:22050, bytesPerSampleFrame:4,
    monotonicNow:()=>time, wallNow:()=>time,
    read() { reads++; return null; },
    onResync() { assert.fail("short stalls must catch up without resync"); },
  });
  for (time = 23; time < 3600000; time += 23) {
    sink.writableNeedDrain = time % 997 < 85;
    const previous = reads;
    clock.pump(sink);
    if (sink.writableNeedDrain) assert.equal(reads, previous);
  }
  time=3600000;
  sink.writableNeedDrain=false;
  clock.pump(sink);
  assert.equal(total,22050*4*3600);
});

test("prolonged backpressure signals a resync without draining stale PCM", () => {
  let time=0, reads=0;
  const events=[];
  const blocked={writable:true,writableNeedDrain:true,write(){assert.fail("blocked");}};
  const clock=createPcmClock({sampleRate:44100,bytesPerSampleFrame:4,monotonicNow:()=>time,
    read(){reads++;},onResync:(...args)=>events.push(args)});
  time=100;
  clock.pump(blocked);
  time=300;
  clock.pump(blocked);
  assert.deepEqual(events,[[30,true]]);
  assert.equal(reads,0);
});

test("scheduled stream fades against wall time and Sustain upload remains unchanged", () => {
  const sample = Buffer.alloc(4);
  sample.writeInt16LE(12000,0);
  sample.writeInt16LE(12000,2);
  const stream = playbackPlan(status(track("stream",0,5000,"stream"),null,0)).current;
  assert.equal(fadeScheduledStream(Buffer.from(sample),stream,3500,2,1000).readInt16LE(0),6000);
  const sustain = playbackPlan(status(track("sustain:a",0,5000),null,0)).current;
  assert.deepEqual(fadeScheduledStream(Buffer.from(sample),sustain,4998,2,1000),sample);
});

test("a failed decoder is retired and a following slot bypasses its retry backoff", async () => {
  const events=[];
  let time=0;
  const player=createPlayback({now:()=>time,setTimer:()=>0,clearTimer:()=>{},
    cache:{download:async()=>"/cached",retain(){}},
    open(slot) {
      events.push("open:"+slot.item.id);
      return {id:slot.item.id,exited:true,timeoutMs:12000,stdout:Readable.from([],{objectMode:false})};
    },
    stop(source) {events.push("stop:"+source.id);},
  });
  const broken=track("broken",0,250,"stream"), next=track("next",250,1500);
  player.accept(status(broken,next,0));
  assert.equal(player.read(20,2,1000),null);
  time=250;
  player.accept(status(next,null,250));
  await flush();
  assert.deepEqual(events,["open:broken","stop:broken","open:next"]);
});

test("prepared PCM remains gated until its slot is due and the old decoder exits", async () => {
  const f = fixture({delayStop:true});
  const current=track("outgoing",0,1000,"stream");
  const next=track("sustain:warmed",1000,2000);
  f.player.accept(status(current,next,0));
  await f.advance(999);
  assert.deepEqual(f.events,[["open","outgoing",0]]);
  await f.advance(1000);
  assert.equal(f.player.read(20,2,1000,999),null);
  f.completeStop();
  await flush();
  assert.equal(f.player.read(20,2,1000,999),null);
  assert.deepEqual(f.events.at(-1),["open","sustain:warmed",1000]);
});

test("output resync chooses the current API slot and does not retry an expired source", async () => {
  const f=fixture();
  const first=track("first",0,500,"stream"), second=track("second",500,1500,"stream");
  f.player.accept(status(first,second,0));
  await f.advance(800);
  f.player.accept(status(second,null,800));
  f.player.resync(true);
  await flush();
  assert.deepEqual(f.events.at(-1),["stop","second",800]);
  f.player.accept(status(second,null,801));
  await flush();
  await f.advance(1600);
  f.player.resync();
  await flush();
  assert.deepEqual(f.events,[
    ["open","first",0],["stop","first",500],
    ["open","second",500],["stop","second",800],
    ["open","second",800],["stop","second",1500],
  ]);
});
