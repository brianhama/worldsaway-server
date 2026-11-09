import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createWorldsAwayServer} from '../dist/src/server.js';
import {environmentConfig,makeConfig} from '../dist/src/config.js';
import {loadServerResources} from '../dist/src/resource-pack.js';
import {asciiField,frame} from '../dist/src/protocol.js';
import {SURVEY_IMPORT_NAMESPACE} from '../dist/src/survey-import.js';

const source=path.resolve(import.meta.dirname,'../content/altaway-regions-2026-11-08.json');

test('configured survey startup preserves players and supports native portal travel and restart',async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'worldsaway-survey-startup-'));
  const resources=loadServerResources(makeConfig());
  const options={dataDir,resources,httpPort:0,worldPort:0,rpcPort:0,seedDemo:false,seedDistricts:false};
  let server=createWorldsAwayServer(options);
  t.after(async()=>{await server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const created=server.store.createAccountWithAvatar('surveycheck','Disposable 42','Survey Check');
  const profile=server.worldStore.ensureAvatar(created.avatar,{classNumber:21});
  const token=server.worldStore.createObject({classNumber:26,regionId:profile.regionId,containerId:profile.objectId,
    ownerId:profile.id,fields:{name:'Retained tokens',position:[2,0,0],denom:73},portable:true,capacity:0});
  const before=server.worldStore.snapshot(),accountsBefore=fs.readFileSync(server.store.filename);
  await server.close();
  server=createWorldsAwayServer({...options,surveyImportFile:source});
  const after=server.worldStore.snapshot(),marker=after.contentMigrations[SURVEY_IMPORT_NAMESPACE];
  assert.equal(Object.keys(marker.regionIds).length,46);
  assert.equal(after.startRegionId,before.startRegionId);
  for(const [id,region] of Object.entries(before.regions))assert.deepEqual(after.regions[id],region);
  for(const [id,object] of Object.entries(before.objects))assert.deepEqual(after.objects[id],object);
  assert.deepEqual(after.avatars,before.avatars);
  assert.deepEqual(fs.readFileSync(server.store.filename),accountsBefore);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir,`world.before-${SURVEY_IMPORT_NAMESPACE}.json`))),before);
  assert.deepEqual(fs.readFileSync(marker.archives[0].filename),fs.readFileSync(source));
  const health=JSON.parse((await server.handleHttpRequest({path:'/health'})).body);
  assert.equal(health.surveyImports[0].regions,46);
  assert.equal(health.surveyImports[0].sourceSha256,marker.archives[0].sha256);

  const output=[],session=server.createWorldSession(bytes=>output.push(Buffer.from(bytes)));
  const ticket=server.store.issueToken(created.account,created.avatar),login=Buffer.alloc(282);
  asciiField(created.account.name,256).copy(login);asciiField(ticket,16).copy(login,256);
  await session.feed(frame(10,11,login));
  const enter=Buffer.alloc(70);asciiField(created.avatar.name,32).copy(enter);enter.writeUInt32BE(1,32);
  await session.feed(frame(10,13,enter));
  assert.equal(session.regionId,before.startRegionId);
  const usePortal=async id=>{
    const portal=server.worldStore.getObject(id);
    await session.feed(frame(session.actorNoid,1570,server.runtime.registry.encodeMessage(1570,{coords:portal.fields.position})));
    await session.feed(frame(server.runtime.objectNoid(session,portal),2351,server.runtime.registry.encodeMessage(2351,{unused:0})));
  };
  await usePortal(marker.portalIds.entry);
  assert.equal(server.worldStore.getRegion(session.regionId).name,'Forest Pathway');
  await usePortal(marker.portalIds.return);
  assert.equal(session.regionId,before.startRegionId);
  assert.equal(server.worldStore.getObject(token.id).fields.denom,73);
  assert.equal(server.worldStore.getAvatar(profile.id).balance,before.avatars[profile.id].balance);
  const count=Object.keys(server.worldStore.snapshot().objects).length;
  await server.close();
  server=createWorldsAwayServer({...options,surveyImportFile:source});
  assert.equal(Object.keys(server.worldStore.snapshot().objects).length,count);
  assert.equal(server.worldStore.getObject(token.id).fields.denom,73);
  assert.deepEqual(fs.readFileSync(server.store.filename),accountsBefore);
});

test('registered and additional avatars first enter Outside The Rose while returning avatars keep their saved region',async t=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'worldsaway-survey-arrival-'));
  const options={dataDir,resources:loadServerResources(makeConfig()),httpPort:0,worldPort:0,rpcPort:0,
    seedDemo:false,seedDistricts:false,surveyImportFile:source};
  let server=createWorldsAwayServer(options);
  t.after(async()=>{await server.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const credentials={account:'rosearrival',password:'Disposable 42'};
  const post=(pathname,fields)=>server.handleHttpRequest({method:'POST',path:pathname,
    headers:{'content-type':'application/x-www-form-urlencoded'},body:Buffer.from(new URLSearchParams(fields).toString())});
  const enter=async name=>{
    const handoff=await post('/connect.iv',{...credentials,avatar:name});
    assert.equal(handoff.status,200,handoff.body.toString());
    const ticket=/^onetimepass=(.+)\r?$/m.exec(handoff.body.toString())[1].trim();
    const session=server.createWorldSession(()=>{}),login=Buffer.alloc(282);
    asciiField(credentials.account,256).copy(login);asciiField(ticket,16).copy(login,256);
    await session.feed(frame(10,11,login));
    const selection=Buffer.alloc(70);asciiField(name,32).copy(selection);selection.writeUInt32BE(1,32);
    await session.feed(frame(10,13,selection));
    assert.equal(session.closed,false,'native entry succeeds');
    return session;
  };
  const assertRegion=(session,regionId)=>{
    const profile=server.worldStore.getAvatar(session.avatar.id);
    assert.equal(session.regionId,regionId);
    assert.equal(profile.regionId,regionId);
    assert.equal(server.worldStore.getObject(profile.objectId).regionId,regionId);
  };
  const rose=server.worldStore.listRegions().find(region=>
    region.properties.surveyImport?.sourceSceneId==='scene-45e1e82adac0f4bb54e3ebe2');
  assert(rose);assert.equal(rose.name,'Outside The Rose');
  assert.notEqual(rose.id,server.worldStore.snapshot().startRegionId);

  const registered=await post('/api/register',{...credentials,avatar:'Rose Arrival'});
  assert.equal(registered.status,201,registered.body.toString());
  const first=await enter('Rose Arrival');
  assertRegion(first,rose.id);
  const destination=server.worldStore.getRegion(2),travel=Buffer.alloc(4);travel.writeUInt32BE(destination.id);
  await first.feed(frame(0,113,travel));
  assertRegion(first,destination.id);

  const additional=await post('/api/avatars',{...credentials,action:'create',name:'Second Arrival'});
  assert.equal(additional.status,201,additional.body.toString());
  const second=await enter('Second Arrival');
  assertRegion(second,rose.id);
  await server.close();
  server=createWorldsAwayServer(options);
  assertRegion(await enter('Rose Arrival'),destination.id);
  assertRegion(await enter('Second Arrival'),rose.id);
});

test('survey import filename is explicit and resolved once at configuration time',()=>{
  assert.equal(makeConfig().surveyImportFile,null);
  assert.equal(makeConfig(environmentConfig({WORLDSAWAY_SURVEY_IMPORT_FILE:source})).surveyImportFile,source);
  assert.throws(()=>makeConfig({surveyImportFile:''}),/nonempty/);
});
