import { registerHooks, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url),ts=require('typescript');
registerHooks({
 resolve(specifier,context,next){try{return next(specifier,context);}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'&&specifier.endsWith('.js'))return next(specifier.slice(0,-3)+'.ts',context);throw error;}},
 load(url,context,next){
  if(url.startsWith('file:')&&url.endsWith('.ts')){
   const filename=fileURLToPath(url),result=ts.transpileModule(readFileSync(filename,'utf8'),{fileName:filename,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,esModuleInterop:true}});
   const errors=result.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error)??[];
   if(errors.length)throw new SyntaxError(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>process.cwd(),getCanonicalFileName:p=>p,getNewLine:()=> '\n'}));
   return {format:'module',shortCircuit:true,source:result.outputText};
  }
  return next(url,context);
 }
});
