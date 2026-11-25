import {createServer} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const chunks=[], logs=[], hits=[];
let connections=0, origin;
const server=createServer();
const sockets=new Set();
const sink=tcpServer(socket=>{
 sockets.add(socket);
 connections++;
 let headers=Buffer.alloc(0), ready=false;
 socket.on('data',data=>{
  if(ready){chunks.push(data);return}
  headers=Buffer.concat([headers,data]);
  const end=headers.indexOf('\r\n\r\n');
  if(end<0)return;
  assert.match(headers.toString(),/^PUT \/test-mount/);
  socket.write('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\n\r\n');
  ready=true;
  if(headers.length>end+4)chunks.push(headers.subarray(end+4));
 });
 socket.on('close',()=>sockets.delete(socket));
});
sink.listen(0,'127.0.0.1');
await once(sink,'listening');
function fixture(frequency, duration, misleadingDuration){
 const samples=Math.round(44100*duration);
 const wav=Buffer.alloc(44+2*samples);
 wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
 wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
 wav.writeUInt32LE(44100,24); wav.writeUInt32LE(88200,28); wav.writeUInt16LE(2,32); wav.writeUInt16LE(16,34);
 wav.write('data',36); wav.writeUInt32LE(Math.round(44100*2*misleadingDuration),40);
 for(let i=0;i<samples;i++)wav.writeInt16LE(Math.round(10000*Math.sin(i*frequency*2*Math.PI/44100)),44+i*2);
 return wav;
}
const a=fixture(440,3.2,8), b=fixture(880,1.5,1.5);
const iso=ms=>new Date(ms).toISOString();
function upload(id,start,end,assetId){return{id,title:id,kind:'upload',assetId,isSustainBlock:true,startAt:iso(origin+start),endAt:iso(origin+end),playbackUrl:`/api/media/${assetId}?v=fixture-smoke-3`}}
function handle(req,res){
 if(req.url==='/api/now'){
  const slots=[upload('sustain:A',0,4000,'a'),upload('sustain:B',7000,11000,'b')];
  const now=Date.now();
  const current=slots.find(s=>Date.parse(s.startAt)<=now&&Date.parse(s.endAt)>now)??null;
  const next=slots.find(s=>Date.parse(s.startAt)>now)??null;
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({current,next,scheduledNext:null,serverTime:iso(now),playbackUrl:current?.playbackUrl??null,sustain:{gapSeconds:1}}));
  return;
 }
 if(req.url.startsWith('/api/media/')){
  hits.push(req.url);
  assert.equal(req.headers['oai-sites-authorization'],'Bearer smoke');
  res.end(req.url.includes('/a?')?a:b);
  return;
 }
 res.writeHead(404).end();
}
server.on('request',handle);
server.on('checkContinue',(req,res)=>{res.writeContinue();handle(req,res)});
server.listen(0,'127.0.0.1');
await once(server,'listening');
const {port}=server.address();
origin=Date.now()+700;
const child=spawn(process.execPath,['encoder.mjs'],{env:{...process.env,SIGNALFLOW_URL:'http://127.0.0.1:'+port,SIGNALFLOW_SITE_TOKEN:'smoke',ICECAST_HOST:'127.0.0.1',ICECAST_PORT:String(sink.address().port),ICECAST_MOUNT:'/test-mount',ICECAST_SOURCE_USER:'source',ICECAST_SOURCE_PASSWORD:'fixture'}});
child.stdout.on('data',c=>logs.push(c.toString()));
child.stderr.on('data',c=>logs.push(c.toString()));
await new Promise(r=>setTimeout(r,11500));
child.kill('SIGTERM');
await once(child,'exit');
server.closeAllConnections();
server.close();
for(const socket of sockets)socket.destroy();
sink.close();
const output=logs.join('');
assert.match(output,/Starting sustain:A/);
assert.equal((output.match(/Starting sustain:A/g)||[]).length,1,output);
assert.doesNotMatch(output,/Output file is empty|ended or stalled/);
assert.match(output,/Starting sustain:B/);
assert.equal(connections,1,output);
assert.equal(hits.length,2);
const sample=Buffer.concat(chunks);
assert.ok(sample.length>70000,output);

const decoded=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-ac','1','-ar','8000','-f','s16le','pipe:1'],{input:sample});
const rms=(start,end)=>{let total=0;for(let i=start*8000|0;i<end*8000;i++)total+=decoded.readInt16LE(i*2)**2;return Math.sqrt(total/((end-start)*8000))};
assert.ok(rms(3.56,3.76)>800,output);
assert.ok(rms(4.3,7.3)<10,output);
assert.ok(rms(8,9)>800,output);
console.log('PASS short Sustain with overstated WAV data length: decoded tail, silent interval, one decoder start per slot and one output connection');
