import { spawn } from "node:child_process";

const env = process.env;
const required = ["SIGNALFLOW_URL","ICECAST_HOST","ICECAST_PORT","ICECAST_MOUNT","ICECAST_SOURCE_USER","ICECAST_SOURCE_PASSWORD"];
for (const key of required) if (!env[key]) throw new Error(`Missing required setting: ${key}`);

const site = env.SIGNALFLOW_URL.replace(/\/$/, "");
const sampleRate = Number(env.AUDIO_SAMPLE_RATE || 44100);
const channels = Number(env.AUDIO_CHANNELS || 2);
const format = (env.AUDIO_FORMAT || "mp3").toLowerCase();
if (!Number.isInteger(sampleRate) || ![1,2].includes(channels) || !["mp3","aac"].includes(format)) throw new Error("Invalid audio format settings");

const siteHeaders = env.SIGNALFLOW_SITE_TOKEN ? {"OAI-Sites-Authorization": `Bearer ${env.SIGNALFLOW_SITE_TOKEN}`} : {};
const ffmpegHeader = env.SIGNALFLOW_SITE_TOKEN ? `OAI-Sites-Authorization: Bearer ${env.SIGNALFLOW_SITE_TOKEN}\r\n` : "";
let encoder = null, decoder = null, activeId = null, lastPcm = 0, stopping = false;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const icecastUrl = () => {
  const auth = `${encodeURIComponent(env.ICECAST_SOURCE_USER)}:${encodeURIComponent(env.ICECAST_SOURCE_PASSWORD)}`;
  const mount = env.ICECAST_MOUNT.startsWith("/") ? env.ICECAST_MOUNT : `/${env.ICECAST_MOUNT}`;
  return `icecast://${auth}@${env.ICECAST_HOST}:${env.ICECAST_PORT}${mount}`;
};

function encoderArgs(){
  const codec = format === "aac" ? ["-c:a","aac","-f","adts","-content_type","audio/aac"] : ["-c:a","libmp3lame","-f","mp3","-content_type","audio/mpeg"];
  return ["-hide_banner","-loglevel","warning","-re","-f","s16le","-ar",String(sampleRate),"-ac",String(channels),"-i","pipe:0",...codec,"-b:a",env.AUDIO_BITRATE||"128k","-ice_name",env.STATION_NAME||"SignalFlow Radio","-ice_description",env.STATION_DESCRIPTION||"SignalFlow continuous playout","-ice_url",env.STATION_URL||"","-ice_public",env.ICECAST_PUBLIC==="true"?"1":"0",...(env.ICECAST_TLS==="true"?["-tls","1"]:[]),icecastUrl()];
}

function startEncoder(){
  if (encoder || stopping) return;
  log("Connecting continuous output to Icecast");
  encoder = spawn("ffmpeg", encoderArgs(), {stdio:["pipe","ignore","pipe"]});
  encoder.stderr.on("data", d => process.stderr.write(d));
  encoder.on("exit", code => { log(`Icecast encoder stopped (${code}); reconnecting`); encoder=null; if(!stopping)setTimeout(startEncoder,2000); });
  encoder.stdin.on("error",()=>{});
}

function stopDecoder(){
  if (decoder){ decoder.kill("SIGTERM"); decoder=null; }
  activeId=null;
}

function startDecoder(item, playbackUrl){
  stopDecoder();
  if (!item || !playbackUrl) return;
  const input = new URL(playbackUrl, site).toString(), remaining=Math.max(1,(new Date(item.endAt).getTime()-Date.now())/1000), elapsed=Math.max(0,(Date.now()-new Date(item.startAt).getTime())/1000);
  const args=["-hide_banner","-loglevel","warning","-re"];
  if(input.startsWith(site) && ffmpegHeader)args.push("-headers",ffmpegHeader);
  if(item.kind==="upload"&&elapsed>0)args.push("-ss",elapsed.toFixed(3));
  args.push("-i",input,"-t",remaining.toFixed(3));
  if(item.kind==="stream"&&item.timingType==="flexible"&&remaining>3)args.push("-af",`afade=t=out:st=${Math.max(0,remaining-3).toFixed(3)}:d=3`);
  args.push("-vn","-f","s16le","-acodec","pcm_s16le","-ar",String(sampleRate),"-ac",String(channels),"pipe:1");
  activeId=item.id;log(`Starting ${item.title} (${item.id})`);
  decoder=spawn("ffmpeg",args,{stdio:["ignore","pipe","pipe"]});
  decoder.stdout.on("data",chunk=>{lastPcm=Date.now();if(encoder?.stdin.writable)encoder.stdin.write(chunk)});
  decoder.stderr.on("data",d=>process.stderr.write(d));
  decoder.on("exit",code=>{if(activeId===item.id){log(`Source ended (${code})`);decoder=null;activeId=null}});
}

async function readStatus(){
  const response=await fetch(`${site}/api/now`,{headers:siteHeaders,signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error(`SignalFlow returned HTTP ${response.status}`);
  return response.json();
}

async function scheduleLoop(){
  while(!stopping){
    try{const status=await readStatus();const wanted=status.current?.id||null;if(wanted!==activeId)startDecoder(status.current,status.playbackUrl)}catch(error){log(error.message)}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
}

// Keep the Icecast source continuous during empty schedules and brief source changes.
const silenceBytes=Math.floor(sampleRate*channels*2/10),silence=Buffer.alloc(silenceBytes);
setInterval(()=>{if(!stopping&&Date.now()-lastPcm>150&&encoder?.stdin.writable)encoder.stdin.write(silence)},100);

function shutdown(){stopping=true;stopDecoder();if(encoder){encoder.stdin.end();setTimeout(()=>encoder?.kill("SIGTERM"),1000)}setTimeout(()=>process.exit(0),2000)}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
startEncoder();scheduleLoop();
