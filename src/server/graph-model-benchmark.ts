/** Pure synthetic quality benchmark for graph extraction candidates. No provider calls. */
export type Assertion = Readonly<{ id:string; subject:string; predicate:string; object:string; citations:string[]; causation?:boolean }>;
export type Candidate = Readonly<{ subject:string; predicate:string; object:string; citations:string[]; causation?:boolean }>;
export type ModelRun = Readonly<{ provider:string; model:string; candidates:Candidate[]; elapsed_ms:number; attempts:number }>;
export type Score = Readonly<{ precision:number; recall:number; citation_validity:number; false_merges:number; unsupported_causation:number; elapsed_ms:number; attempts:number }>;
const key=(x:{subject:string;predicate:string;object:string})=>`${x.subject}\u0000${x.predicate}\u0000${x.object}`;
export function scoreGraphRun(assertions:Assertion[], run:ModelRun):Score {
 const truth=new Map(assertions.map(x=>[key(x),x]));let matched=0,citations=0,merges=0,causation=0;
 for(const c of run.candidates){const expected=truth.get(key(c));if(expected){matched++;if(c.citations.length>0&&c.citations.every(id=>expected.citations.includes(id)))citations++;if(c.causation===true&&expected.causation!==true)causation++;}else merges++;}
 return {precision:run.candidates.length?matched/run.candidates.length:1,recall:assertions.length?matched/assertions.length:1,citation_validity:run.candidates.length?citations/run.candidates.length:1,false_merges:merges,unsupported_causation:causation,elapsed_ms:run.elapsed_ms,attempts:run.attempts};
}
export function qualityGate(score:Score):boolean{return score.precision>=.95&&score.recall>=.9&&score.citation_validity>=.98&&score.false_merges===0&&score.unsupported_causation===0&&score.attempts<=2;}
export function benchmarkManifest(assertions:Assertion[], runs:ModelRun[]){return {schema:'graph-model-benchmark-v1',assertions:assertions.length,runs:runs.map(run=>({provider:run.provider,model:run.model,score:scoreGraphRun(assertions,run),quality_gate:qualityGate(scoreGraphRun(assertions,run))}))};}
