import { spawn } from "node:child_process";

const env=process.env,required=["SIGNALFLOW_URL","ICECAST_HOST","ICECAST_PORT","ICECAST_MOUNT","ICECAST_SOURCE_USER","ICECAST_SOURCE_PASSWORD"];
for(const key of required)if(!env[key])throw new Error(`Missing required setting: ${key}`);

const site=env.SIGNALFLOW_URL.replace(/\/$/,""),sampleRate=Number(env.AUDIO_SAMPLE_RATE||44100),channels=Number(env.AUDIO_CHANNELS||2),format=(env.AUDIO_FORMAT||"mp3").toLowerCase();
if(!Number.isInteger(sampleRate)||![1,2].includes(channels)||!["mp3","aac"].includes(format))throw new Error("Invalid audio format settings");

const siteHeaders=env.SIGNALFLOW_SITE_TOKEN?{"OAI-Sites-Authorization":`Bearer ${env.SIGNALFLOW_SITE_TOKEN}`}:{},ffmpegHeader=env.SIGNALFLOW_SITE_TOKEN?`OAI-Sites-Authorization: Bearer ${env.SIGNALFLOW_SITE_TOKEN}\r\n`:"";
let encoder=null,decoder=null,fetcher=null,activeSignature="",lastPcm=0,stopping=false;
const log=(...args)=>console.log(new Date().toISOString(),...args);
const icecastUrl=()=>{const auth=`${encodeURIComponent(env.ICECAST_SOURCE_USER)}:${encodeURIComponent(env.ICECAST_SOURCE_PASSWORD)}`,mount=env.ICECAST_MOUNT.startsWith("/")?env.ICECAST_MOUNT:`/${env.ICECAST_MOUNT}`;return`icecast://${auth}@${env.ICECAST_HOST}:${env.ICECAST_PORT}${mount}`};

function encoderArgs(){const codec=format==="aac"?["-c:a","aac","-f","adts","-content_type","audio/aac"]:["-c:a","libmp3lame","-f","mp3","-content_type","audio/mpeg"];return["-hide_banner","-loglevel","warning","-re","-f","s16le","-ar",String(sampleRate),"-ac",String(channels),"-i","pipe:0",...codec,"-b:a",env.AUDIO_BITRATE||"128k","-ice_name",env.STATION_NAME||"SignalFlow Radio","-ice_description",env.STATION_DESCRIPTION||"SignalFlow continuous playout","-ice_url",env.STATION_URL||"","-ice_public",env.ICECAST_PUBLIC==="true"?"1":"0",...(env.ICECAST_TLS==="true"?["-tls","1"]:[]),icecastUrl()]}
function startEncoder(){if(encoder||stopping)return;log("Connecting continuous output to Icecast");encoder=spawn("ffmpeg",encoderArgs(),{stdio:["pipe","ignore","pipe"]});encoder.stderr.on("data",data=>process.stderr.write(data));encoder.stdin.on("error",()=>{});encoder.on("exit",code=>{log(`Icecast encoder stopped (${code}); reconnecting`);encoder=null;if(!stopping)setTimeout(startEncoder,2000)})}

function stopDecoder(){if(fetcher){fetcher.kill("SIGTERM");fetcher=null}if(decoder){decoder.kill("SIGTERM");decoder=null}activeSignature=""}
function signature(status){return[status.current?.id||"",...(status.overlays||[]).map(item=>item.id).sort()].join(":")}
function startDecoder(status){
  stopDecoder();if(!status.current||!status.playbackUrl)return;
  const now=Date.now(),inputs=[...(status.overlays||[]).map(item=>({item,playbackUrl:item.playbackUrl,outgoing:true})),{item:status.current,playbackUrl:status.playbackUrl,outgoing:false}],args=["-hide_banner","-loglevel","warning"],overrideHost=env.STREAM_HOST_OVERRIDE_HOST?.trim(),overrideIp=env.STREAM_HOST_OVERRIDE_IP?.trim();let override=null;
  for(const input of inputs){let url=new URL(input.playbackUrl,site).toString(),remote=input.item.kind==="stream"&&input.item.sourceUrl?new URL(input.item.sourceUrl):null,useOverride=!!remote&&!!overrideHost&&!!overrideIp&&remote.hostname===overrideHost&&!override;if(useOverride){url="pipe:0";override=remote}if(input.item.kind==="stream")args.push("-re");else args.push("-thread_queue_size","512","-analyzeduration","10000000","-probesize","10000000");if(url.startsWith(site)&&ffmpegHeader)args.push("-headers",ffmpegHeader);const rawElapsed=Math.max(0,(now-new Date(input.item.startAt).getTime())/1000),elapsed=input.item.loop&&input.item.durationSeconds?rawElapsed%input.item.durationSeconds:rawElapsed;input.elapsed=elapsed;if(input.item.loop)args.push("-stream_loop","-1");args.push("-i",url)}
  const currentRemaining=Math.max(.1,(new Date(status.current.endAt).getTime()-now)/1000);
  const filters=[],labels=[],layout=channels===1?"mono":"stereo";
  inputs.forEach((input,index)=>{const chain=[];if(input.item.kind==="upload"&&input.elapsed>.01)chain.push(`atrim=start=${input.elapsed.toFixed(3)}`,"asetpts=PTS-STARTPTS");chain.push(`aresample=${sampleRate}:async=1:first_pts=0`,`aformat=sample_fmts=s16:sample_rates=${sampleRate}:channel_layouts=${layout}`);if(input.outgoing){const remaining=Math.max(.1,(new Date(input.item.endAt).getTime()-now)/1000);chain.push(`afade=t=out:st=0:d=${remaining.toFixed(3)}`)}else if(input.item.kind==="stream"&&input.item.timingType==="flexible")chain.push(`afade=t=out:st=${Math.max(0,currentRemaining-3).toFixed(3)}:d=${Math.min(3,currentRemaining).toFixed(3)}`);const label=`in${index}`;filters.push(`[${index}:a]${chain.join(",")}[${label}]`);labels.push(`[${label}]`)});
  if(inputs.length>1){filters.push(`${labels.join("")}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[mix]`);args.push("-filter_complex",filters.join(";"),"-map","[mix]")}
  else args.push("-filter_complex",filters.join(";"),"-map",labels[0]);
  args.push("-t",currentRemaining.toFixed(3),"-vn","-f","s16le","-acodec","pcm_s16le","-ar",String(sampleRate),"-ac",String(channels),"pipe:1");
  activeSignature=signature(status);log(inputs.length>1?`Mixing ${(status.overlays||[]).map(item=>item.title).join(", ")} under ${status.current.title}`:`Starting ${status.current.title} (${status.current.id})`);const thisSignature=activeSignature;
  decoder=spawn("ffmpeg",args,{stdio:[override?"pipe":"ignore","pipe","pipe"]});const thisDecoder=decoder;
  if(override){const port=override.port||(override.protocol==="https:"?"443":"80");log(`Using DNS override ${overrideHost} -> ${overrideIp}`);fetcher=spawn("curl",["--fail","--silent","--show-error","--location","--no-buffer","--resolve",`${overrideHost}:${port}:${overrideIp}`,override.toString()],{stdio:["ignore","pipe","pipe"]});fetcher.stdout.pipe(decoder.stdin);fetcher.stderr.on("data",data=>process.stderr.write(data));fetcher.on("exit",()=>{fetcher=null;thisDecoder.stdin.end()});decoder.stdin.on("error",()=>{})}
  decoder.stdout.on("data",chunk=>{if(decoder!==thisDecoder)return;lastPcm=Date.now();if(encoder?.stdin.writable&&!encoder.stdin.write(chunk)){thisDecoder.stdout.pause();encoder.stdin.once("drain",()=>{if(decoder===thisDecoder)thisDecoder.stdout.resume()})}});decoder.stderr.on("data",data=>process.stderr.write(data));decoder.on("exit",code=>{if(decoder===thisDecoder){log(`Source pipeline ended (${code})`);decoder=null;if(activeSignature===thisSignature)activeSignature=""}});
}

async function readStatus(){const response=await fetch(`${site}/api/now`,{headers:siteHeaders,signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error(`SignalFlow returned HTTP ${response.status}`);return response.json()}
async function scheduleLoop(){while(!stopping){try{const status=await readStatus(),wanted=signature(status);if(wanted!==activeSignature)startDecoder(status)}catch(error){log(error.message)}await new Promise(resolve=>setTimeout(resolve,250))}}

const silenceBytes=Math.floor(sampleRate*channels*2/10),silence=Buffer.alloc(silenceBytes);setInterval(()=>{if(!stopping&&Date.now()-lastPcm>150&&encoder?.stdin.writable)encoder.stdin.write(silence)},100);
function shutdown(){stopping=true;stopDecoder();if(encoder){encoder.stdin.end();setTimeout(()=>encoder?.kill("SIGTERM"),1000)}setTimeout(()=>process.exit(0),2000)}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);startEncoder();scheduleLoop();
