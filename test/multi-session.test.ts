import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reserveNative,releaseNative,type NativeOwner } from '../src/omp-extension.ts';
import { controlServer,daemonAddress,control } from '../src/control.ts';

test('native ownership rejects competing hosts and hardlink aliases until release',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ompw-ownership-'));
  try {
    const file=join(directory,'native.jsonl'),alias=join(directory,'alias.jsonl');
    await writeFile(file,''); await link(file,alias);
    const first:NativeOwner={id:'first',runId:'run-a',hostDir:join(directory,'host-a'),managerPid:process.pid};
    const second:NativeOwner={id:'second',runId:'run-b',hostDir:join(directory,'host-b'),managerPid:process.pid};
    const locks=join(directory,'locks');
    reserveNative(locks,first,file);
    assert.throws(()=>reserveNative(locks,second,file),/already reserved/);
    assert.throws(()=>reserveNative(locks,second,alias),/already reserved/);
    releaseNative(locks,first);
    reserveNative(locks,second,alias);
    assert.throws(()=>reserveNative(locks,first,file),/already reserved/);
    releaseNative(locks,second);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('local control rejects browser origins and invalid bearer tokens before executing commands',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ompw-control-'));
  let calls=0;
  const listener=await controlServer(directory,'http://127.0.0.1:4310',async()=>{calls++;return {calls};},async()=>{});
  try{
    const address=(await daemonAddress(directory))!;
    const endpoint=`http://127.0.0.1:${address.port}/control`;
    const rejectedHeaders: Record<string,string>[] = [{Authorization:'Bearer '+'0'.repeat(64)},{Authorization:`Bearer ${address.token}`,Origin:'http://localhost'},{Authorization:`Bearer ${address.token}`,'Sec-Fetch-Site':'same-origin'}];
    for(const headers of rejectedHeaders){
      const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:'{"type":"status"}'});
      assert.equal(response.status,403);
    }
    assert.equal(calls,0);
    await control(address,{type:'status'}); assert.equal(calls,1);
    await listener.pause();
    await assert.rejects(control(address,{type:'status'}),/stopping/);
    assert.equal(calls,1);
    listener.resume(); await control(address,{type:'status'});assert.equal(calls,2);
  }finally{await listener.close();await rm(directory,{recursive:true,force:true});}
});
