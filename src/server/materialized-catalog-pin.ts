import { createHash } from 'node:crypto';

export const MATERIALIZED_CATALOG_PREFIX='graph-trial/20260909/materialized-cfo/';
export const CFO_SOURCE_CATALOG_KEY='otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl';
const SHA=/^[a-f0-9]{64}$/;
const VERSION=/^[A-Za-z0-9._-]{1,1024}$/;
const ID=/^[a-z0-9][a-z0-9_.:-]{0,95}$/;
const MAX_RECEIPT_BYTES=64*1024;
type RawResponse=Readonly<{status:number;headers:Headers;body:Buffer}>;
type RawGet=(request:Readonly<{method:'GET';key:string;signal:AbortSignal}>)=>Promise<RawResponse>;
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:any):string=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}';
const FIXED_LOGICAL_SOURCE_SHA256=hash(canonical({room:'finance',source_index:'finance-cfo-source-docs',url:'https://otchealth-finance-legal-dr-55c84f6b.s3.us-east-1.amazonaws.com/otchealthcfodata/cfo-source-docs/_CATALOG/catalog.jsonl'}));
const plain=(value:unknown):value is Record<string,any>=>!!value&&Object.getPrototypeOf(value)===Object.prototype;
const exact=(value:unknown,keys:string[])=>plain(value)&&Object.keys(value).sort().join('\0')===keys.slice().sort().join('\0');
const safeKey=(value:unknown)=>typeof value==='string'&&value.length>0&&value.length<=1024&&value===value.normalize('NFC')&&!/[\\%?#\u0000-\u001f\u007f]/.test(value)&&value.split('/').every(part=>part!==''&&part!=='.'&&part!=='..');
export type MaterializationPin=Readonly<{catalog_content_sha256:string;source_catalog_version_id:string;materialization_receipt_key:string;materialization_receipt_sha256:string;catalog_version_id:string}>;
export type MaterializationContext=Readonly<{cohort_id:string;policy_sha256:string;source_prefixes:readonly string[];source_scope?:'all_cfo_source_documents';catalog_key:string;catalog_source_sha256:string;materialization:MaterializationPin}>;
export type VerifiedMaterialization=Readonly<{catalogContentSha256:string;catalogVersionId:string}>;
function invalid():never{throw new Error('materialization_pin_invalid');}
export function parseMaterializationPin(value:unknown):MaterializationPin|null{
 if(!exact(value,['catalog_content_sha256','source_catalog_version_id','materialization_receipt_key','materialization_receipt_sha256','catalog_version_id']))return null;
 const pin=value as Record<string,any>;
 if(!SHA.test(pin.catalog_content_sha256)||!SHA.test(pin.materialization_receipt_sha256)||
   ![pin.source_catalog_version_id,pin.catalog_version_id].every(v=>typeof v==='string'&&VERSION.test(v)&&v!=='null')||
   !safeKey(pin.materialization_receipt_key)||!pin.materialization_receipt_key.startsWith(MATERIALIZED_CATALOG_PREFIX)||!pin.materialization_receipt_key.endsWith('.receipt.json'))return null;
 return Object.freeze({...pin}) as MaterializationPin;
}
function validCounts(value:unknown):boolean{if(!exact(value,['source_rows','eligible_rows','duplicate_rows','excluded']))return false;const counts=value as Record<string,any>;
 if(!['source_rows','eligible_rows','duplicate_rows'].every(key=>Number.isSafeInteger(counts[key])&&counts[key]>=0&&counts[key]<=100000)||!plain(counts.excluded)||Object.keys(counts.excluded).length>32||!Object.entries(counts.excluded).every(([key,count])=>ID.test(key)&&Number.isSafeInteger(count)&&count>=0&&count<=100000))return false;
 return counts.source_rows===counts.eligible_rows+counts.duplicate_rows+Object.values(counts.excluded).reduce<number>((total,count)=>total+(count as number),0);}
function bindingWithoutOutcome(receipt:Record<string,any>){const {status,published,catalog_key,catalog_version_id,binding_sha256,...binding}=receipt;return binding;}
function receiptValid(receipt:unknown,context:MaterializationContext):receipt is Record<string,any>{
 const keys=['schema','cohort_id','policy_sha256','source_prefixes_sha256','source_version_id','source_etag_sha256','source_catalog_content_sha256','source_bytes','catalog_content_sha256','catalog_source_sha256','catalog_bytes','counts','lineage','source_current_checked','status','published','catalog_key','catalog_version_id','binding_sha256',...(context.source_scope?['source_scope']:[])];
 if(!exact(receipt,keys))return false;const r=receipt as Record<string,any>;
 if(r.schema!=='cfo-catalog-materialization-v1'||r.cohort_id!==context.cohort_id||r.policy_sha256!==context.policy_sha256||r.source_scope!==context.source_scope||
   r.source_prefixes_sha256!==hash(canonical([...context.source_prefixes].sort()))||r.source_version_id!==context.materialization.source_catalog_version_id||
   !SHA.test(r.source_etag_sha256)||!SHA.test(r.source_catalog_content_sha256)||!Number.isSafeInteger(r.source_bytes)||r.source_bytes<1||r.source_bytes>192*1024*1024||
   r.catalog_content_sha256!==context.materialization.catalog_content_sha256||r.catalog_source_sha256!==FIXED_LOGICAL_SOURCE_SHA256||context.catalog_source_sha256!==FIXED_LOGICAL_SOURCE_SHA256||!Number.isSafeInteger(r.catalog_bytes)||r.catalog_bytes<1||r.catalog_bytes>192*1024*1024||
   !validCounts(r.counts)||r.counts.eligible_rows<1||r.lineage!=='catalog_association_only'||r.source_current_checked!==true||r.status!=='published'||r.published!==true||
   r.catalog_key!==context.catalog_key||r.catalog_version_id!==context.materialization.catalog_version_id||!SHA.test(r.binding_sha256))return false;
 const binding=bindingWithoutOutcome(r);
 if(r.binding_sha256!==hash(canonical(binding)))return false;
 const expectedKey=`${MATERIALIZED_CATALOG_PREFIX}${r.cohort_id}/${r.binding_sha256}/${r.catalog_content_sha256}.jsonl`;
 if(r.catalog_key!==expectedKey||context.materialization.materialization_receipt_key!==expectedKey.replace(/\.jsonl$/,'.receipt.json'))return false;
 return true;
}
/** Reads an immutable, hash-pinned materialization receipt. The raw CFO catalog is never read here. */
export async function verifyMaterializationReceipt(context:MaterializationContext,get:RawGet,signal:AbortSignal):Promise<VerifiedMaterialization>{
 const pin=context.materialization;
 if(!parseMaterializationPin(pin)||!context.catalog_key.startsWith(MATERIALIZED_CATALOG_PREFIX)||!safeKey(context.catalog_key)||context.catalog_source_sha256!==FIXED_LOGICAL_SOURCE_SHA256||!ID.test(context.cohort_id)||!SHA.test(context.policy_sha256)||!Array.isArray(context.source_prefixes)||context.source_scope!==undefined&&context.source_scope!=='all_cfo_source_documents'||
    (context.source_scope==='all_cfo_source_documents' ? context.source_prefixes.length!==0 : (!context.source_prefixes.length||context.source_prefixes.length>16||!context.source_prefixes.every(prefix=>typeof prefix==='string'&&prefix.endsWith('/')&&safeKey(prefix.slice(0,-1))))))invalid();
 const response=await get({method:'GET',key:pin.materialization_receipt_key,signal});
 if(response.status!==200||response.body.length<1||response.body.length>MAX_RECEIPT_BYTES||!VERSION.test(response.headers.get('x-amz-version-id')??'')||response.headers.get('x-amz-version-id')==='null'||hash(response.body)!==pin.materialization_receipt_sha256)invalid();
 let receipt:unknown;try{receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(response.body));}catch{invalid();}
 if(!receiptValid(receipt,context))invalid();
 return Object.freeze({catalogContentSha256:pin.catalog_content_sha256,catalogVersionId:pin.catalog_version_id});
}
