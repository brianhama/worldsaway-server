/** Actual browser bridge -> native sockets -> authoritative world integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompatibilityServer} from '../dist/src/server.js';
import {avatarList} from '../dist/src/protocol.js';

const bridgeModule = new URL('../../browser-client/dist/server/index.js',import.meta.url);
const cacheModule = new URL('../../browser-client/dist/native/resources.js',import.meta.url);
const unavailable=!existsSync(bridgeModule)||!existsSync(cacheModule);

test('native avatar chooser advertises creation only when the account has an available slot',()=>{
 const avatar={id:1,name:'Demo'};
 assert.equal(avatarList([avatar],3).readUInt16BE(10),1);
 assert.equal(avatarList([avatar],1).readUInt16BE(10),0);
});

async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'worldsaway-browser-integration-'));
 let world,bridge;
 t.after(async()=>{await bridge?.close();await world?.close();await rm(directory,{recursive:true,force:true});});
 const {createBridgeServer}=await import(bridgeModule);
 const {ResourceStore}=await import(cacheModule);
 world=createCompatibilityServer({dataDir:join(directory,'world'),httpPort:0,worldPort:0,rpcPort:0,worldName:'WorldsAway.app'});
 await world.start();
 // Begin with a clean browser cache: classes and every scene asset must come
 // from this world rather than a pre-existing original client installation.
 bridge=createBridgeServer({port:0,launcherUrl:world.baseUrl,resources:new ResourceStore({clientDir:directory,allowEmpty:true})});
 await bridge.start();
 let cookie='';
 async function request(route,body) {
  const response=await fetch(bridge.baseUrl+route,{headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
  const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0];
  const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
 }
 return {world,bridge,request,get session(){return [...bridge.sessions.values()][0];}};
}

async function action(f,noid,id,fields) {
 const sent=await f.request('/api/action',{noid,id,fields});
 await f.session.waitFor(state=>state.history.some(entry=>entry.type==='message'&&entry.requestSeq===sent.seq));
 const reply=f.session.state.history.find(entry=>entry.type==='message'&&entry.requestSeq===sent.seq);
 assert.equal(reply.fields.success??0,0,JSON.stringify(reply));
 return reply;
}

test('browser bridge signs in, receives bootstrap, materializes, walks, speaks and uses bank over native sockets',
 {skip:unavailable?'Requires sibling browser-client build':false},async t=>{
 const f=await fixture(t);
 const config=await f.request('/api/config');assert.equal(config.launcherUrl,f.world.baseUrl);
 const directory=await f.request('/api/worlds');assert.equal(directory.worlds[0].name,'WorldsAway.app');
 // Deliberately omit launcherUrl to verify the configured backend is honored.
 const login=await f.request('/api/login',{account:'demo',password:'demo'});
 assert.equal(login.state.status,'avatars');assert(login.state.avatars.some(avatar=>avatar.name==='Demo'));
 assert.equal(login.state.newAvatarAllowed,true,'The chooser advertises available avatar slots');
 const entered=await f.request('/api/enter',{avatar:'Demo'});
 assert.equal(entered.state.status,'connected');assert.equal(entered.state.worldName,'WorldsAway.app');
 assert.equal(entered.state.sceneNeedsRefresh,false);
 assert.equal(f.session.registry.classes.size,58);
 assert.equal(f.session.registry.messages.size,710);
 assert.equal(entered.state.actorNoid,15);
 await action(f,15,2005,{coords:[250,220,0]});
 const actorNoid=f.session.state.actorNoid;assert.notEqual(actorNoid,15);
 assert.equal(f.session.objects.get(actorNoid).classNumber,21);
 await action(f,actorNoid,1570,{coords:[180,205,0]});
 assert.deepEqual(f.session.objects.get(actorNoid).fields.position,[180,205,0]);
 const speech=await action(f,actorNoid,72,{type:0,dummyfielda:0,text:'Hello from WorldsAway.app'});
 assert.equal(speech.fields.text,'Hello from WorldsAway.app');
 const atm=[...f.session.objects.values()].find(object=>object.classNumber===33);assert(atm);
 const balance=await action(f,atm.noid,2801,{unused:0});
 assert.equal(balance.fields.balance,1000);
 const actor=f.session.objects.get(actorNoid);
 const image=await f.session.fetchFile(actor.fields.imageURL,actor.fields.imageVersion);
 assert(image.length>0,'Scene body asset is available through the filename RPC');
 const metadata=await f.request('/api/classes');assert.equal(metadata.classes.length,58);
 const logout=await f.request('/api/logout',{});assert.equal(logout.loggedOut,true);
 assert.equal((await f.request('/api/state')).status,'disconnected');
});

test('browser chooser creates an owned avatar on WorldsAway.app and enters it with a fresh ticket',
 {skip:unavailable?'Requires sibling browser-client build':false},async t=>{
 const f=await fixture(t);
 await f.request('/api/login',{account:'demo',password:'demo',launcherUrl:f.world.baseUrl});
 const result=await f.request('/api/avatars',{action:'create',name:'BrowserTest'});
 assert.equal(result.created.name,'BrowserTest');assert.equal(result.state.status,'connected');
 assert.equal(result.state.avatar,'BrowserTest');
 const account=f.world.store.account('demo');
 assert(f.world.store.listAvatars(account).some(avatar=>avatar.name==='BrowserTest'));
 assert.equal(f.bridge.sessions.size,1,'The old avatar chooser session is replaced');
 assert(!JSON.stringify(result).includes('password'));
});
