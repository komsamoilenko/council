// Fabricated previous server: one continuing job using its own copied job-store.
// Only the preflighted installer harness runs this; no vendor or process helper.
'use strict';
const store=require('./lib/jobstore'),path=require('node:path');
const paths={jobsRoot:path.resolve(__dirname,'..','..','work','jobs')};
const id=store.newJobId(),files=store.createJobDir(paths,id,[]).files;
store.atomicWriteJSON(files.request,{job_id:id,created_ms:Date.now()});
const heartbeat=()=>store.atomicWriteJSON(files.state,{state:'running',heartbeat_ms:Date.now()});
heartbeat();process.stdout.write(id+'\n');
const timer=setInterval(heartbeat,100);
process.stdin.once('data',()=>{clearInterval(timer);process.exit(0);});
