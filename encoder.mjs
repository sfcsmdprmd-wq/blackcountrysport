import { spawn } from "node:child_process";

const env=process.env,required=["SIGNALFLOW_URL","ICECAST_HOST","ICECAST_PORT","ICECAST_MOUNT","ICECAST_SOURCE_USER","ICECAST_SOURCE_PASSWORD"];
for(const key of required)if(!env[key])throw new Error(`Missing required setting: ${key}`);

const site=env.SIGNALFLOW_URL.replace(/\/$/,""),sampleRate=Number(env.AUDIO_SAMPLE_RATE||44100),channels=Number(env.AUDIO_CHANNELS||2),format=(env.AUDIO_FORMAT||"mp3").toLowerCase();
if(!Number.isInteger(sampleRate)||![1,2].includes(channels)||!["mp3","aac"].includes(format))throw new Error("Invalid audio format settings");

const siteHeaders=env.SIGNALFLOW_SITE_TOKEN?{"OAI-Sites-Authorization":`Bearer ${env.SIGNALFLOW_SITE_TOKEN}`}:{},ffmpegHeader=env.SIGNALFLOW_SITE_TOKEN?`OAI-Sites-Authorization: Bearer ${env.SIGNALFLOW_SITE_TOKEN}\r\n`:"";
let encoder=null,decoder=null,fetcher=null,activeSignature="",stopping=false;
const bytesPerSample=2,blockAlign=channels*bytesPerSample;
const requestedFrameMs=Number(env.PCM_FRAME_MS||20),frameMs=Number.isFinite(requestedFrameMs)&&requestedFrameMs>=10&&requestedFrameMs<=100?requestedFrameMs:20;
const frameBytes=Math.max(blockAlign,Math.round(sampleRate*blockAlign*frameMs/1000/blockAlign)*blockAlign),maxBufferBytes=Math.round(sampleRate*blockAlign*2);
let pcmQueue=[],pcmBytes=0,encoderBlocked=false,underrunFrames=0,backpressureEvents=0,droppedBytes=0;
const log=(...args)=>console.log(new Date().toISOString(),...args);
const icecastUrl=()=>{const auth=`${encodeURIComponent(env.ICECAST_SOURCE_USER)}:${encodeURIComponent(env.ICECAST_SOURCE_PASSWORD)}`,mount=env.ICECAST_MOUNT.startsWith("/")?env.ICECAST_MOUNT:`/${env.ICECAST_MOUNT}`;return`icecast://${auth}@${env.ICECAST_HOST}:${env.ICECAST_PORT}${mount}`};

function encoderArgs(){const codec=format==="aac"?["-c:a","aac","-f","adts","-content_type","audio/aac"]:["-c:a","libmp3lame","-f","mp3","-content_type","audio/mpeg"];return["-hide_banner","-loglevel","warning","-f","s16le","-ar",String(sampleRate),"-ac",String(channels),"-i","pipe:0",...codec,"-b:a",env.AUDIO_BITRATE||"128k","-ice_name",env.STATION_NAME||"SignalFlow Radio","-ice_description",env.STATION_DESCRIPTION||"SignalFlow continuous playout","-ice_url",env.STATION_URL||"","-ice_public",env.ICECAST_PUBLIC==="true"?"1":"0",...(env.ICECAST_TLS==="true"?["-tls","1"]:[]),icecastUrl()]}
function startEncoder(){
  if(encoder||stopping)return;
  log("Connecting continuous output to Icecast");
  try{
    const child=spawn("ffmpeg",encoderArgs(),{stdio:["pipe","ignore","pipe"]});
    encoder=child;
    child.stderr.on("data",data=>process.stderr.write(data));
    child.stdin.on("error",error=>log(`Icecast stdin error: ${error.message}`));
    child.stdin.on("drain",()=>{encoderBlocked=false});
    child.on("error",error=>{log(`Unable to start Icecast encoder: ${error.message}`);if(encoder===child)encoder=null;if(!stopping)setTimeout(startEncoder,2000)});
    child.on("exit",(code,signal)=>{log(`Icecast encoder stopped (code=${code ?? "none"}, signal=${signal ?? "none"}); reconnecting`);if(encoder===child)encoder=null;encoderBlocked=false;if(!stopping)setTimeout(startEncoder,2000)});
  }catch(error){log(`Icecast encoder startup failed: ${error.message}`);encoder=null;if(!stopping)setTimeout(startEncoder,2000)}
}

function clearPcm(){pcmQueue=[];pcmBytes=0}
function stopDecoder(){if(fetcher){fetcher.kill("SIGTERM");fetcher=null}if(decoder){decoder.kill("SIGTERM");decoder=null}activeSignature="";clearPcm()}
function enqueuePcm(chunk){if(!chunk?.length)return;pcmQueue.push(chunk);pcmBytes+=chunk.length;if(pcmBytes>maxBufferBytes){let excess=pcmBytes-Math.floor(maxBufferBytes/2);while(excess>0&&pcmQueue.length){const head=pcmQueue[0];if(head.length<=excess){pcmQueue.shift();pcmBytes-=head.length;droppedBytes+=head.length;excess-=head.length}else{pcmQueue[0]=head.subarray(excess);pcmBytes-=excess;droppedBytes+=excess;excess=0}}}}
function dequeuePcm(size){if(pcmBytes<size)return null;const out=Buffer.allocUnsafe(size);let offset=0;while(offset<size){const head=pcmQueue[0],take=Math.min(head.length,size-offset);head.copy(out,offset,0,take);offset+=take;pcmBytes-=take;if(take===head.length)pcmQueue.shift();else pcmQueue[0]=head.subarray(take)}return out}
function signature(status){return[status.current?.id||"",...(status.overlays||[]).map(item=>item.id).sort()].join(":")}
function startDecoder(status){
  stopDecoder();if(!status.current||!status.playbackUrl)return;
  const now=Date.now(),inputs=[...(status.overlays||[]).map(item=>({item,playbackUrl:item.playbackUrl,outgoing:true})),{item:status.current,playbackUrl:status.playbackUrl,outgoing:false}],args=["-hide_banner","-loglevel","warning"],overrideHost=env.STREAM_HOST_OVERRIDE_HOST?.trim(),overrideIp=env.STREAM_HOST_OVERRIDE_IP?.trim();let override=null;
  for(const input of inputs){let url=new URL(input.playbackUrl,site).toString(),remote=input.item.kind==="stream"&&input.item.sourceUrl?new URL(input.item.sourceUrl):null,useOverride=!!remote&&!!overrideHost&&!!overrideIp&&remote.hostname===overrideHost&&!override;if(useOverride){url="pipe:0";override=remote}if(input.item.kind==="upload")args.push("-re");if(url!=="pipe:0"&&/^https?:/i.test(url))args.push("-thread_queue_size","8192","-reconnect","1","-reconnect_streamed","1","-reconnect_delay_max","5");if(url.startsWith(site)&&ffmpegHeader)args.push("-headers",ffmpegHeader);const rawElapsed=Math.max(0,(now-new Date(input.item.startAt).getTime())/1000),elapsed=input.item.loop&&input.item.durationSeconds?rawElapsed%input.item.durationSeconds:rawElapsed;if(input.item.loop)args.push("-stream_loop","-1");if(input.item.kind==="upload"&&elapsed>0)args.push("-ss",elapsed.toFixed(3));args.push("-i",url)}
  const currentRemaining=Math.max(.1,(new Date(status.current.endAt).getTime()-now)/1000);
  if(inputs.length>1){const filters=[],labels=[];inputs.forEach((input,index)=>{const base=`aresample=${sampleRate}:async=1000:min_hard_comp=0.100:first_pts=0`;if(input.outgoing){const remaining=Math.max(.1,(new Date(input.item.endAt).getTime()-now)/1000),label=`out${index}`;filters.push(`[${index}:a]${base},afade=t=out:st=0:d=${remaining.toFixed(3)}[${label}]`);labels.push(`[${label}]`)}else{const label=`current${index}`,remaining=new Date(input.item.endAt).getTime()-now,fade=input.item.kind==="stream"&&input.item.timingType==="flexible"&&remaining<3000?`,afade=t=out:st=0:d=${Math.max(.1,remaining/1000).toFixed(3)}`:"";filters.push(`[${index}:a]${base}${fade}[${label}]`);labels.push(`[${label}]`)}});filters.push(`${labels.join("")}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95,aresample=${sampleRate}:async=1000:first_pts=0[mix]`);args.push("-filter_complex",filters.join(";"),"-map","[mix]")}
  else {const chain=[`aresample=${sampleRate}:async=1000:min_hard_comp=0.100:first_pts=0`];if(status.current.kind==="stream"&&status.current.timingType==="flexible"&&currentRemaining>3)chain.push(`afade=t=out:st=${Math.max(0,currentRemaining-3).toFixed(3)}:d=3`);args.push("-af",chain.join(","))}
  args.push("-t",currentRemaining.toFixed(3),"-vn","-f","s16le","-acodec","pcm_s16le","-ar",String(sampleRate),"-ac",String(channels),"pipe:1");
  activeSignature=signature(status);log(inputs.length>1?`Mixing ${(status.overlays||[]).map(item=>item.title).join(", ")} under ${status.current.title}`:`Starting ${status.current.title} (${status.current.id})`);const thisSignature=activeSignature;
  let thisDecoder;
  try{
    thisDecoder=spawn("ffmpeg",args,{stdio:[override?"pipe":"ignore","pipe","pipe"]});decoder=thisDecoder;
  }catch(error){log(`Source pipeline startup failed: ${error.message}`);decoder=null;activeSignature="";return}
  thisDecoder.on("error",error=>{log(`Source pipeline error: ${error.message}`);if(decoder===thisDecoder){decoder=null;if(activeSignature===thisSignature)activeSignature=""}});
  if(override){
    const port=override.port||(override.protocol==="https:"?"443":"80");log(`Using DNS override ${overrideHost} -> ${overrideIp}`);
    try{
      const child=spawn("curl",["--fail","--silent","--show-error","--location","--no-buffer","--resolve",`${overrideHost}:${port}:${overrideIp}`,override.toString()],{stdio:["ignore","pipe","pipe"]});fetcher=child;
      child.on("error",error=>log(`Stream fetcher error: ${error.message}`));
      child.stdout.pipe(thisDecoder.stdin);child.stderr.on("data",data=>process.stderr.write(data));child.on("exit",()=>{if(fetcher===child)fetcher=null;if(!thisDecoder.stdin.destroyed)thisDecoder.stdin.end()});thisDecoder.stdin.on("error",error=>log(`Source stdin error: ${error.message}`));
    }catch(error){log(`Stream fetcher startup failed: ${error.message}`);thisDecoder.kill("SIGTERM")}
  }
  thisDecoder.stdout.on("data",enqueuePcm);thisDecoder.stderr.on("data",data=>process.stderr.write(data));thisDecoder.on("exit",(code,signal)=>{if(decoder===thisDecoder){log(`Source pipeline ended (code=${code ?? "none"}, signal=${signal ?? "none"})`);decoder=null;if(activeSignature===thisSignature)activeSignature=""}});
}

async function readStatus(){const response=await fetch(`${site}/api/now`,{headers:siteHeaders,signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`SignalFlow returned HTTP ${response.status}`);return response.json()}
async function scheduleLoop(){while(!stopping){try{const status=await readStatus(),wanted=signature(status);if(wanted!==activeSignature)startDecoder(status)}catch(error){log(error.message)}await new Promise(resolve=>setTimeout(resolve,250))}}

const silenceFrame=Buffer.alloc(frameBytes);
const pump=setInterval(()=>{if(stopping||!encoder?.stdin.writable||encoderBlocked)return;let frame=dequeuePcm(frameBytes);if(!frame){frame=silenceFrame;underrunFrames++}if(!encoder.stdin.write(frame)){encoderBlocked=true;backpressureEvents++}},frameMs);
setInterval(()=>{if(stopping)return;const bufferMs=Math.round(pcmBytes/(sampleRate*blockAlign)*1000),droppedMs=Math.round(droppedBytes/(sampleRate*blockAlign)*1000);log(`Audio health: buffer=${bufferMs}ms underruns=${underrunFrames} backpressure=${backpressureEvents} dropped=${droppedMs}ms`);underrunFrames=0;backpressureEvents=0;droppedBytes=0},30000);
function shutdown(){stopping=true;clearInterval(pump);stopDecoder();if(encoder){encoder.stdin.end();setTimeout(()=>encoder?.kill("SIGTERM"),1000)}setTimeout(()=>process.exit(0),2000)}
process.on("uncaughtException",error=>log(`Uncaught exception: ${error?.stack||error}`));
process.on("unhandledRejection",error=>log(`Unhandled rejection: ${error?.stack||error}`));
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);startEncoder();scheduleLoop().catch(error=>{log(`Schedule loop stopped unexpectedly: ${error?.stack||error}`);if(!stopping)setTimeout(()=>scheduleLoop().catch(err=>log(`Schedule loop restart failed: ${err?.stack||err}`)),1000)});
