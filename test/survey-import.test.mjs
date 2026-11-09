import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {WorldStore} from '../dist/src/world-store.js';
import {ClassRegistry} from '../dist/src/classes.js';
import {loadServerResources} from '../dist/src/resource-pack.js';
import {makeConfig} from '../dist/src/config.js';
import {importSurvey,planSurveyImport,prepareSurveyArchive,SURVEY_IMPORT_NAMESPACE} from '../dist/src/survey-import.js';

const resources=loadServerResources(makeConfig());
const registry=new ClassRegistry(resources);
function sourceObject(classNumber,noid,patch={}){
  const fields={...registry.defaults(classNumber,{scope:'wire'}),classNumber,noid,container_noid:0,name:`Object ${noid}`,position:[100,220,0],...patch};
  return {classNumber,noid,fields,protocolRecordBase64:registry.encodeObject({classNumber,fields}).toString('base64'),
    inspection:{description:{success:0,text:`Description ${noid}`}}};
}
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'wa-survey-import-')),store=new WorldStore(directory,{clock:()=>1234});
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  const rootA=sourceObject(20,0,{name:'Forest Pathway'}),rootB=sourceObject(20,0,{name:'Beach'});
  const regionA={id:'scene-a',name:'Forest Pathway',properties:rootA.fields,inspectionComplete:true,
    objects:[rootA,sourceObject(21,100,{name:'Live visitor'}),sourceObject(24,101,{container_noid:100}),
      sourceObject(26,102,{container_noid:100,denom:999}),sourceObject(36,50,{name:'Chest',reducedCapacity:10}),
      sourceObject(48,51,{container_noid:50,position:[0,0,0],name:'Café €'}),sourceObject(38,60),sourceObject(56,61,{rideCost:65535}),
      sourceObject(48,89,{container_noid:999})],
    navigation:[{key:'north',kind:'compass',noid:0,fields:{exitDir:0},result:'visited',targetRegionId:'scene-b'},
      {key:'door',kind:'door',noid:60,fields:{unused:0},result:'visited',targetRegionId:'scene-b'},
      {key:'teleport',kind:'teleport',noid:61,fields:{address:'Beach Gallery'},result:'visited',targetRegionId:'scene-b'}],
    additionalObservations:[{rawContentsVectorBase64:'preserved source snapshot',properties:{extraProperty:'preserved'}}]};
  const regionB={id:'scene-b',name:'Beach',properties:rootB.fields,inspectionComplete:true,objects:[rootB,sourceObject(38,62)],
    navigation:[{key:'unknown-door',kind:'door',noid:62,fields:{unused:0},result:'denied'}]};
  const survey={schemaVersion:1,world:{name:'Source'},coverage:{status:'partial_at_user_request'},schemaCatalog:{},regions:[regionA,regionB]};
  const source=path.join(directory,'source.json');fs.writeFileSync(source,JSON.stringify(survey));
  const prepared=prepareSurveyArchive(directory,source);
  return {directory,store,source,survey,...prepared};
}

test('survey import is additive, excludes live identities, preserves all provenance and creates reachable portals',t=>{
  const f=fixture(t),avatar=f.store.ensureAvatar({id:1,accountId:1,name:'Local user'},{classNumber:21});
  const owned=f.store.createObject({classNumber:36,regionId:avatar.regionId,ownerId:avatar.id,containerId:avatar.objectId,capacity:10,fields:{name:'Existing inventory',position:[4,0,0]}});
  const accountFile=path.join(f.directory,'accounts.json');fs.writeFileSync(accountFile,'account sentinel');
  const before=f.store.snapshot(),bytes=fs.readFileSync(f.store.filename);
  const plan=planSurveyImport(before,registry,f.survey,{archive:f.archive,resources});
  assert.equal(plan.regionsCreated,2);assert.equal(plan.objectsExcluded,4);assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(fs.readFileSync(f.store.filename),bytes);
  const report=importSurvey(f.store,registry,f.survey,{archive:f.archive,resources}),after=f.store.snapshot(),a=report.regionIds['scene-a'],b=report.regionIds['scene-b'];
  assert.equal(after.startRegionId,before.startRegionId);assert.deepEqual(after.avatars,before.avatars);assert.deepEqual(after.objects[owned.id],before.objects[owned.id]);
  for(const [id,region] of Object.entries(before.regions))assert.deepEqual(after.regions[id],region);
  assert.equal(fs.readFileSync(accountFile,'utf8'),'account sentinel');assert.deepEqual(fs.readFileSync(report.backupFile),bytes);
  assert.equal(after.regions[a].exits.north,b);assert.equal(after.objects[report.portalIds.entry].regionId,before.startRegionId);
  assert.equal(after.objects[report.portalIds.entry].properties.surveyTravel.destinationRegionId,a);
  assert.equal(after.objects[report.portalIds.return].properties.surveyTravel.destinationRegionId,before.startRegionId);
  const child=after.objects[report.objectIds['scene-a:51']];assert.equal(child.containerId,report.objectIds['scene-a:50']);
  assert.equal(child.fields.name,'Café €');assert.deepEqual(child.properties.surveyImport.wireFields,f.survey.regions[0].objects.find(o=>o.noid===51).fields);
  assert.equal(child.properties.surveyImport.protocolRecordBase64,f.survey.regions[0].objects.find(o=>o.noid===51).protocolRecordBase64);
  assert.equal(Object.hasOwn(child.fields,'noid'),false);assert.equal(Object.hasOwn(child.fields,'container_noid'),false);
  assert.equal(Object.values(after.objects).filter(o=>o.properties?.surveyImport?.namespace===SURVEY_IMPORT_NAMESPACE).some(o=>[21,22].includes(o.classNumber)),false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.archive.filename,'utf8')),f.survey);
  const marker=after.contentMigrations[SURVEY_IMPORT_NAMESPACE];assert.equal(marker.archives[0].sha256,f.archive.sha256);assert.equal(marker.archive,undefined);
  const teleport=after.objects[report.objectIds['scene-a:61']];assert.equal(teleport.fields.rideCost,65535);assert.equal(teleport.properties.surveyTravel.cost,0);
  assert.equal(teleport.properties.surveyTravel.destinations['Beach Gallery'],b);
  const unknown=after.objects[report.objectIds['scene-b:62']];assert.equal(unknown.properties.surveyTravel.destinationRegionId,undefined);assert.ok(unknown.properties.surveyTravel.unresolved.length);
});

test('repeated import preserves consumed stock, user edits and durable IDs without another revision',t=>{
  const f=fixture(t),first=importSurvey(f.store,registry,f.survey,{archive:f.archive});
  f.store.deleteObject(first.objectIds['scene-a:51'],{admin:true});
  f.store.updateObject(first.objectIds['scene-a:50'],{fields:{name:'Operator renamed chest'}},{admin:true});
  const before=f.store.snapshot(),bytes=fs.readFileSync(f.store.filename),again=importSurvey(f.store,registry,f.survey,{archive:f.archive});
  assert.equal(again.alreadyImported,true);assert.equal(again.regionsCreated,0);assert.equal(again.objectsCreated,0);
  assert.deepEqual(again.regionIds,first.regionIds);assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(fs.readFileSync(f.store.filename),bytes);
  assert.equal(f.store.getObject(first.objectIds['scene-a:51']),null);
  assert.equal(f.store.getObject(first.objectIds['scene-a:50']).fields.name,'Operator renamed chest');
});

test('malformed imported fields and containment abort without committing any world changes',t=>{
  const f=fixture(t),before=f.store.snapshot(),bytes=fs.readFileSync(f.store.filename);
  const bad=structuredClone(f.survey);bad.regions[0].objects[0].fields.horizon=70000;
  assert.throws(()=>importSurvey(f.store,registry,bad,{archive:f.archive}),/range|unsigned|integer/i);
  const cycle=structuredClone(f.survey);cycle.regions[0].objects.find(o=>o.noid===50).fields.container_noid=51;
  assert.throws(()=>importSurvey(f.store,registry,cycle,{archive:f.archive}),/cycle/);
  assert.deepEqual(f.store.snapshot(),before);assert.deepEqual(fs.readFileSync(f.store.filename),bytes);
  assert.equal(fs.existsSync(path.join(f.directory,`world.before-${SURVEY_IMPORT_NAMESPACE}.json`)),false);
});

test('operational image versions match admitted assets while source versions and missing assets remain exact',t=>{
  const f=fixture(t),sourceDoor=f.survey.regions[0].objects.find(o=>o.noid===60),sourceChest=f.survey.regions[0].objects.find(o=>o.noid===50);
  Object.assign(sourceDoor.fields,{imageURL:'known-test.img',imageVersion:12});
  Object.assign(sourceChest.fields,{imageURL:'missing-test.img',imageVersion:456});
  for(const source of [sourceDoor,sourceChest])source.protocolRecordBase64=registry.encodeObject({classNumber:source.classNumber,fields:source.fields}).toString('base64');
  fs.writeFileSync(f.source,JSON.stringify(f.survey));const {archive}=prepareSurveyArchive(f.directory,f.source);
  const admitted={getFileInfo:name=>name==='known-test.img'?{version:999,data:Buffer.from('admitted image')}:null};
  const report=importSurvey(f.store,registry,f.survey,{archive,resources:admitted});
  const door=f.store.getObject(report.objectIds['scene-a:60']),chest=f.store.getObject(report.objectIds['scene-a:50']);
  assert.equal(door.fields.imageVersion,999);assert.equal(door.properties.surveyImport.wireFields.imageVersion,12);
  assert.deepEqual(door.properties.surveyImport.wireFields,sourceDoor.fields);
  assert.equal(JSON.parse(fs.readFileSync(archive.filename,'utf8')).regions[0].objects.find(o=>o.noid===60).fields.imageVersion,12);
  assert.equal(door.properties.surveyImport.operationalAdjustments[0].sourceValue,12);
  assert.equal(door.properties.surveyImport.operationalAdjustments[0].operationalValue,999);
  for(const id of Object.values(report.portalIds)){
    const portal=f.store.getObject(id);assert.equal(portal.fields.imageVersion,999);
    assert.equal(portal.properties.surveyImport.wireFields.imageVersion,12);
  }
  assert.equal(chest.fields.imageURL,'missing-test.img');assert.equal(chest.fields.imageVersion,456);
  assert.equal(chest.properties.surveyImport.operationalAdjustments,undefined);
  assert.ok(report.assetAdmission.missingFiles.some(a=>a.name==='missing-test.img'));
  assert.equal(report.assetAdmission.operationalAdjustmentCount,3);
  const marker=f.store.snapshot().contentMigrations[SURVEY_IMPORT_NAMESPACE];assert.equal(marker.operationalAdjustmentCount,3);
  assert.equal(marker.operationalAdjustments.length,3);
  const bytes=fs.readFileSync(f.store.filename),replay=importSurvey(f.store,registry,f.survey,{archive,resources:admitted});
  assert.equal(replay.alreadyImported,true);assert.equal(replay.assetAdmission.operationalAdjustmentCount,3);
  assert.deepEqual(fs.readFileSync(f.store.filename),bytes);
});
