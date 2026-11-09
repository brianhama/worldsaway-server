/** Additive import of observed regions. Source observations remain immutable provenance. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import type {ClassRegistry} from './classes.js';
import type {ResourceProvider} from './resources.js';
import type {DynamicFields, GameObject, WorldState} from './types.js';
import type {WorldStore} from './world-store.js';

export const SURVEY_IMPORT_NAMESPACE='altaway-avagoria-survey-v1';
export interface SurveyObject extends DynamicFields {noid:number;classNumber:number;fields:DynamicFields;protocolRecordBase64?:string;}
export interface SurveyRegion extends DynamicFields {id:string;name:string;properties:DynamicFields;objects:SurveyObject[];navigation:DynamicFields[];}
export interface SurveyDocument extends DynamicFields {schemaVersion:number;regions:SurveyRegion[];schemaCatalog:DynamicFields;}
export interface SurveyArchive {sha256:string;filename:string;bytes:number;}
export interface SurveyImportOptions {archive:SurveyArchive;namespace?:string;dryRun?:boolean;resources?:ResourceProvider;}
export interface SurveyImportReport extends DynamicFields {
  namespace:string;sourceSha256:string;alreadyImported:boolean;dryRun:boolean;
  regionsCreated:number;objectsCreated:number;objectsExcluded:number;existingRegionsPreserved:number;
  regionIds:Record<string,number>;objectIds:Record<string,number>;warnings:DynamicFields[];
  portalIds:{entry:number|null;return:number|null};assetAdmission:DynamicFields;
}
const clone=structuredClone;
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const objectKey=(scene:string,noid:number)=>`${scene}:${noid}`;
const directions=['north','east','south','west'];
function plain(value:unknown):value is DynamicFields{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(`Survey import: ${message}`);}
function checkDocument(survey:SurveyDocument){
  assert(survey?.schemaVersion===1&&Array.isArray(survey.regions)&&plain(survey.schemaCatalog),'Unsupported survey structure');
  const seen=new Set<string>();
  for(const r of survey.regions){
    assert(typeof r.id==='string'&&r.id.length>0&&!seen.has(r.id),'Missing or duplicate scene identity');seen.add(r.id);
    assert(typeof r.name==='string'&&r.name.length>0&&r.name.length<=63&&!r.name.includes('\0'),`Invalid region name in ${r.id}`);
    assert(Array.isArray(r.objects)&&Array.isArray(r.navigation),`Missing objects/navigation in ${r.id}`);
    const noids=new Set<number>();
    for(const o of r.objects){assert(Number.isInteger(o.noid)&&o.noid>=0&&o.noid<=65535&&!noids.has(o.noid),`Invalid or duplicate NOID in ${r.id}`);noids.add(o.noid);
      assert(Number.isInteger(o.classNumber)&&plain(o.fields),`Invalid object in ${r.id}`);
      assert(o.fields.noid===o.noid&&o.fields.classNumber===o.classNumber,`Source object identity mismatch in ${r.id}`);
    }
    assert(r.objects.some(o=>o.noid===0&&o.classNumber===20),`Missing region root in ${r.id}`);
  }
}
function syncDirectory(directory:string){try{const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch{}}
/** Caller owns the AccountStore directory lock before applying an import. */
export function prepareSurveyArchive(dataDir:string,sourceFilename:string):{survey:SurveyDocument;archive:SurveyArchive}{
  const source=fs.readFileSync(sourceFilename);assert(source.length<=64*1024*1024,'Source archive exceeds 64 MiB');
  const survey=JSON.parse(source.toString('utf8')) as SurveyDocument;checkDocument(survey);
  const digest=sha(source),directory=path.join(path.resolve(dataDir),'imports'),filename=path.join(directory,`altaway-survey-${digest}.json`);
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(fs.existsSync(filename))assert(sha(fs.readFileSync(filename))===digest,'Immutable archive content differs from its hash');
  else{
    const temp=filename+`.${randomBytes(6).toString('hex')}.tmp`;let fd:number|undefined;
    try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,source);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
      try{fs.linkSync(temp,filename);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;assert(sha(fs.readFileSync(filename))===digest,'Archive collision');}
      syncDirectory(directory);
    }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  }
  return {survey,archive:{sha256:digest,filename,bytes:source.length}};
}
function archiveOptions(options:SurveyImportOptions){
  const namespace=options.namespace??SURVEY_IMPORT_NAMESPACE;
  assert(/^[a-zA-Z0-9_-]{1,80}$/.test(namespace),'Invalid import namespace');
  assert(/^[a-f0-9]{64}$/.test(options.archive?.sha256)&&typeof options.archive.filename==='string'&&Number.isSafeInteger(options.archive.bytes),'Archive provenance is required');
  return namespace;
}
function excludedObjects(region:SurveyRegion){
  const byNoid=new Map(region.objects.map(o=>[o.noid,o])),excluded=new Map<number,string>();
  for(const o of region.objects)if([21,22].includes(o.classNumber))excluded.set(o.noid,'live_avatar_or_ghost');
  let changed=true;
  while(changed){changed=false;for(const o of region.objects){if(o.noid===0||excluded.has(o.noid))continue;const parent=o.fields.container_noid;
    const reason=excluded.has(parent)?'carried_by_excluded_avatar':parent!==0&&!byNoid.has(parent)?'missing_parent_ownership_unknown':null;
    if(reason){excluded.set(o.noid,reason);changed=true;}
  }}
  return excluded;
}
function portable(o:SurveyObject){return o.noid!==0&&(Number(o.fields.common_flags??0)&(2|256|512))===0;}
function effectiveCost(o:SurveyObject){const cost=Number(o.fields.rideCost??0);return o.classNumber===56?(cost===65535?0:cost===0?1:cost):cost;}
function sourceAddress(namespace:string,id:string){return `aa-${sha(`${namespace}:${id}`).slice(0,24)}`;}
function assetReport(objects:GameObject[],resources?:ResourceProvider){
  const refs=new Map<string,{name:string;expectedVersions:number[];objectIds:number[]}>();
  for(const o of objects)for(const key of Object.keys(o.fields).filter(k=>k==='imageURL'||/^bodyURL\d+$/.test(k))){
    const name=o.fields[key];if(typeof name!=='string'||!name)continue;
    const entry=refs.get(name)??{name,expectedVersions:[],objectIds:[]},version=key==='imageURL'?Number(o.fields.imageVersion??0):0;
    if(!entry.expectedVersions.includes(version))entry.expectedVersions.push(version);entry.objectIds.push(o.id);refs.set(name,entry);
  }
  const missingFiles:DynamicFields[]=[],versionMismatches:DynamicFields[]=[];
  if(resources)for(const entry of refs.values()){
    const info=resources.getFileInfo(entry.name);if(!info)missingFiles.push(entry);
    else if(entry.expectedVersions.some(v=>v!==0&&v!==info.version))versionMismatches.push({...entry,availableVersion:info.version});
  }
  const operationalAdjustments=objects.flatMap(o=>(o.properties?.surveyImport?.operationalAdjustments??[]).map((adjustment:DynamicFields)=>({objectId:o.id,
    ...(o.properties?.surveyImport?.sourceSceneId?{sourceSceneId:o.properties.surveyImport.sourceSceneId,sourceNoid:o.properties.surveyImport.sourceNoid}:{}),...clone(adjustment)})));
  return {checked:Boolean(resources),fileCount:refs.size,missingFiles,versionMismatches,
    operationalAdjustmentCount:operationalAdjustments.length,operationalAdjustments};
}
function normalizeOperationalImageVersion(object:GameObject,resources?:ResourceProvider){
  if(!resources||typeof object.fields.imageURL!=='string'||!object.fields.imageURL)return;
  const admitted=resources.getFileInfo(object.fields.imageURL);if(!admitted||object.fields.imageVersion===admitted.version)return;
  const sourceValue=object.fields.imageVersion??0;
  object.properties!.surveyImport.operationalAdjustments??=[];
  object.properties!.surveyImport.operationalAdjustments.push({field:'imageVersion',imageURL:object.fields.imageURL,
    sourceValue,operationalValue:admitted.version,reason:'Use the version of the admitted backend asset; original wire fields remain in provenance'});
  object.fields.imageVersion=admitted.version;
}
function applyToDraft(draft:WorldState,registry:ClassRegistry,survey:SurveyDocument,options:SurveyImportOptions):SurveyImportReport{
  checkDocument(survey);const namespace=archiveOptions(options),previous=draft.contentMigrations?.[namespace];
  const report:SurveyImportReport={namespace,sourceSha256:options.archive.sha256,alreadyImported:false,dryRun:options.dryRun??false,
    regionsCreated:0,objectsCreated:0,objectsExcluded:0,existingRegionsPreserved:0,regionIds:clone(previous?.regionIds??{}),objectIds:clone(previous?.objectIds??{}),
    warnings:[],portalIds:clone(previous?.portalIds??{entry:null,return:null}),assetAdmission:{checked:false}};
  if(previous?.archives?.some((a:SurveyArchive)=>a.sha256===options.archive.sha256)){
    report.alreadyImported=true;report.existingRegionsPreserved=Object.keys(report.regionIds).length;
    report.assetAdmission=assetReport(Object.values(draft.objects).filter(o=>o.properties?.surveyImport?.namespace===namespace),options.resources);return report;
  }
  const regions=[...survey.regions].sort((a,b)=>a.id.localeCompare(b.id)),newScenes=new Set<string>(),created:GameObject[]=[];
  const sourceObjects=new Map<string,SurveyObject>();
  const exclusions:DynamicFields[]=clone(previous?.exclusions??[]),capacityAdjustments:DynamicFields[]=[];
  for(const region of regions){
    if(report.regionIds[region.id]){report.existingRegionsPreserved++;if(!draft.regions[report.regionIds[region.id]])report.warnings.push({kind:'previously_imported_region_missing',sourceSceneId:region.id});continue;}
    const id=draft.next.region++,rootId=draft.next.object++;report.regionIds[region.id]=id;report.objectIds[objectKey(region.id,0)]=rootId;newScenes.add(region.id);
    const address=sourceAddress(namespace,region.id);
    assert(!Object.values(draft.regions).some(r=>r.properties?.address===address),'Imported address collides with existing region');
    draft.regions[id]={id,name:region.name,objectId:rootId,exits:{},properties:{address,areaCode:Number(region.properties?.areaCode??0),
      surveyImport:{namespace,sourceSceneId:region.id,sourceSha256:options.archive.sha256,archiveFile:options.archive.filename,
        wireFields:clone(region.properties),identityMethod:region.identityMethod??null,inspectionComplete:region.inspectionComplete===true,
        originalIdentity:clone(region.originalIdentity??null),navigation:clone(region.navigation),unresolvedNavigation:[],additionalObservationCount:region.additionalObservations?.length??0}}};
    report.regionsCreated++;
    const excluded=excludedObjects(region);report.objectsExcluded+=excluded.size;
    for(const [noid,reason] of excluded)exclusions.push({sourceSceneId:region.id,sourceNoid:noid,reason});
    for(const o of [...region.objects].sort((a,b)=>a.noid-b.noid)){
      if(excluded.has(o.noid))continue;
      const key=objectKey(region.id,o.noid);sourceObjects.set(key,o);
      if(o.noid!==0)report.objectIds[key]=draft.next.object++;
      const definition=registry.get(o.classNumber);assert(definition,`Unknown native class ${o.classNumber}`);
      const fields={...registry.defaults(o.classNumber),...clone(o.fields)};
      // The runtime assigns view-local lifecycle numbers on every scene encoding.
      delete fields.noid;delete fields.container_noid;
      const properties:DynamicFields={surveyImport:{namespace,sourceSceneId:region.id,sourceNoid:o.noid,sourceSha256:options.archive.sha256,
        archiveFile:options.archive.filename,wireFields:clone(o.fields),protocolRecordBase64:o.protocolRecordBase64??null,
        inspection:clone(o.inspection??null),contentsStatus:o.contentsStatus??null},public:true};
      if(o.inspection?.description?.success===0)properties.description=String(o.inspection.description.text??'');
      if(o.inspection?.URL?.success===0)properties.URL=String(o.inspection.URL.URL??'');
      for(const [name,value] of Object.entries(o.inspection?.commonProperties??{}))if((value as DynamicFields).success===0)properties[name]=(value as DynamicFields).propdata;
      const imported:GameObject={id:report.objectIds[key],classNumber:o.classNumber,regionId:id,containerId:null,ownerId:null,
        capacity:definition.capacity,portable:portable(o),locked:Boolean(Number(fields.common_flags??0)&16),fields,properties};
      if(imported.capacity>0)imported.open=(Number(fields.common_flags??0)&8)===0;
      draft.objects[imported.id]=imported;created.push(imported);
    }
  }
  // References are translated only after every source identity has an allocation.
  for(const o of created){
    const provenance=o.properties!.surveyImport,scene=provenance.sourceSceneId,source=sourceObjects.get(objectKey(scene,provenance.sourceNoid))!;
    const parent=source.fields.container_noid;
    if(source.noid!==0&&parent!==0){const id=report.objectIds[objectKey(scene,parent)];assert(id&&draft.objects[id],`Missing translated parent for ${scene}:${source.noid}`);o.containerId=id;o.slot=Number(source.fields.position?.[0]??0);}
    for(const key of ['following','webfollowing',...([40,201].includes(o.classNumber)?['owner']:[])])if(Object.hasOwn(o.fields,key)){
      const sourceRef=Number(source.fields[key]);o.fields[key]=sourceRef===65535?65535:report.objectIds[objectKey(scene,sourceRef)]??(key==='following'?65535:0);
    }
    if(o.classNumber===37){
      const pages=(source.inspection?.documentPages??[]).filter((p:DynamicFields)=>p.success===0).map((p:DynamicFields)=>String(p.text??''));
      if(pages.length){const text=pages.join('\n');assert(text.length<=65535,'Imported document exceeds local document limit');
        draft.documents[o.id]={objectId:o.id,title:String(source.inspection?.documentHeader?.subject??o.fields.name??'').slice(0,255),text,pages,updatedAt:0};
        o.fields.textid=o.id;
      }else if(o.fields.textid){o.properties!.surveyImport.documentContentUnavailable=true;o.fields.textid=0;}
    }
  }
  for(const o of created){
    const children=created.filter(child=>child.containerId===o.id),declared=Number(o.fields.reducedCapacity??0),needed=Math.max(children.length,...children.map(c=>(c.slot??0)+1),0);
    const actual=Math.max(o.capacity,declared,needed);
    assert(actual<=65535,`Container ${o.id} exceeds native capacity range`);
    if(actual>o.capacity){capacityAdjustments.push({objectId:o.id,nativeClassCapacity:o.capacity,actualCapacity:actual,observedChildren:children.length});o.capacity=actual;}
    if(declared>0&&declared<needed)o.fields.reducedCapacity=needed;
  }
  for(const region of regions){if(!newScenes.has(region.id))continue;
    const local=draft.regions[report.regionIds[region.id]],unresolved:DynamicFields[]=[];
    for(const edge of region.navigation){
      const target=edge.result==='visited'?draft.regions[report.regionIds[edge.targetRegionId]]:null;
      if(edge.kind==='compass'){
        const d=Number(edge.fields?.exitDir);if(target&&Number.isInteger(d)&&d>=0&&d<4)local.exits[directions[d]]=target.id;
        else unresolved.push({...clone(edge),importReason:target?'Invalid compass direction':'Destination was not successfully catalogued'});
      }
    }
    local.properties.surveyImport.unresolvedNavigation=unresolved;
    for(const o of created.filter(o=>o.regionId===local.id&&[38,39,56,209].includes(o.classNumber))){
      const source=sourceObjects.get(objectKey(region.id,o.properties!.surveyImport.sourceNoid))!;
      const edges=region.navigation.filter(e=>Number(e.noid)===source.noid&&e.kind!=='compass'),destinations:Record<string,number>={},routes:DynamicFields[]=[],blocked:DynamicFields[]=[],ambiguousAddresses=new Set<string>();
      const targets=new Set<number>();
      for(const edge of edges){
        const target=edge.result==='visited'?draft.regions[report.regionIds[edge.targetRegionId]]:null;
        if(!target){blocked.push({...clone(edge),importReason:'Destination was not successfully catalogued'});continue;}
        targets.add(target.id);const address=edge.fields?.home===1?'home':String(edge.fields?.address??'');
        routes.push({kind:edge.kind,address,targetRegionId:target.id,sourceEdgeKey:edge.key});
        if(address){if(ambiguousAddresses.has(address)||destinations[address]&&destinations[address]!==target.id){delete destinations[address];ambiguousAddresses.add(address);blocked.push({...clone(edge),importReason:'Address has multiple observed destinations'});}
          else destinations[address]=target.id;}
      }
      const destinationRegionId=targets.size===1?[...targets][0]:undefined;
      o.properties!.surveyTravel={version:1,destinations,routes,unresolved:blocked,cost:effectiveCost(source),
        ...(destinationRegionId!==undefined?{destinationRegionId}:{})};
      if(o.classNumber===38&&destinationRegionId!==undefined)o.properties!.destinationRegionId=destinationRegionId;
      if([39,56].includes(o.classNumber))o.properties!['.popDests']=Object.keys(destinations).filter(a=>a!=='home').join('|');
      if(!edges.length)o.properties!.surveyTravel.unresolved.push({importReason:'No successful public destination was recorded'});
      local.properties.surveyImport.unresolvedNavigation.push(...blocked);
    }
  }
  if(!previous){
    const entry=regions.find(r=>r.name==='Forest Pathway')??regions[0],entryId=entry?report.regionIds[entry.id]:null;
    const start=draft.startRegionId,sourceDoor=regions.flatMap(r=>r.objects).find(o=>o.classNumber===38);
    if(start&&entryId&&draft.regions[start]&&draft.regions[entryId]&&sourceDoor&&registry.get(38)){
      const addPortal=(regionId:number,targetRegionId:number,name:string)=>{
        const id=draft.next.object++,fields={...registry.defaults(38),name,position:[80,300,0],common_flags:2,
          imageURL:sourceDoor.fields.imageURL,imageVersion:sourceDoor.fields.imageVersion,imageDefault:sourceDoor.fields.imageDefault,colorMap:clone(sourceDoor.fields.colorMap)};
        const portal:GameObject={id,classNumber:38,regionId,containerId:null,ownerId:null,capacity:0,portable:false,locked:false,fields,
          properties:{description:'Travel between WorldsAway.app and the imported AltAway regions.',destinationRegionId:targetRegionId,
            surveyImport:{namespace,syntheticPortal:true,sourceSha256:options.archive.sha256,archiveFile:options.archive.filename,wireFields:clone(fields)},
            surveyTravel:{version:1,destinations:{},destinationRegionId:targetRegionId,cost:0,routes:[{kind:'entry_portal',targetRegionId}],unresolved:[]}}};
        draft.objects[id]=portal;created.push(portal);return id;
      };
      report.portalIds={entry:addPortal(start,entryId,'Explore AltAway'),return:addPortal(entryId,start,'Return to WorldsAway')};
    }else report.warnings.push({kind:'entry_portal_unavailable',reason:'An existing start region, imported entry and Door asset are required'});
  }
  for(const o of created){normalizeOperationalImageVersion(o,options.resources);registry.validateObject(o,{includeServer:true,strictFields:true});
    const seen=new Set([o.id]);let parent=o.containerId;
    while(parent!==null){assert(!seen.has(parent),'Imported containment cycle');seen.add(parent);const container=draft.objects[parent];assert(container&&container.regionId===o.regionId,'Imported container crosses regions');parent=container.containerId;}
  }
  report.objectsCreated=created.length;report.assetAdmission=assetReport(created,options.resources);
  if(capacityAdjustments.length)report.warnings.push({kind:'capacity_adjustments',adjustments:capacityAdjustments});
  draft.contentMigrations??={};draft.contentMigrations[namespace]={id:namespace,version:1,regionIds:clone(report.regionIds),objectIds:clone(report.objectIds),
    portalIds:clone(report.portalIds),archives:[...(previous?.archives??[]),clone(options.archive)],exclusions,capacityAdjustments,
    assetAdmission:clone(report.assetAdmission),operationalAdjustmentCount:report.assetAdmission.operationalAdjustmentCount,
    operationalAdjustments:clone(report.assetAdmission.operationalAdjustments),
    sourceCoverageStatus:survey.coverage?.status??null,allServerRegions:false,sourceRegionCount:survey.regions.length};
  return report;
}
/** Pure dry-run: IDs and changes are computed against an isolated state clone. */
export function planSurveyImport(state:WorldState,registry:ClassRegistry,survey:SurveyDocument,options:SurveyImportOptions):SurveyImportReport{
  return applyToDraft(clone(state),registry,survey,{...options,dryRun:true});
}
function backupBeforeImport(store:WorldStore,namespace:string){
  const filename=path.join(store.dataDir,`world.before-${namespace}.json`);
  if(!fs.existsSync(filename)){
    fs.copyFileSync(store.filename,filename,fs.constants.COPYFILE_EXCL);const fd=fs.openSync(filename,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(store.dataDir);
  }
  return filename;
}
/** The caller must hold the data-directory account lock. Existing entities are never replaced. */
export function importSurvey(store:WorldStore,registry:ClassRegistry,survey:SurveyDocument,options:SurveyImportOptions):SurveyImportReport{
  const plan=planSurveyImport(store.snapshot(),registry,survey,options);
  if(options.dryRun)return plan;
  if(plan.alreadyImported)return {...plan,dryRun:false};
  const backupFile=backupBeforeImport(store,plan.namespace);
  const report=store.transaction(draft=>applyToDraft(draft,registry,survey,{...options,dryRun:false}),
    {action:'survey-regions-imported',details:{namespace:plan.namespace,sourceSha256:options.archive.sha256}});
  return {...report,backupFile};
}
