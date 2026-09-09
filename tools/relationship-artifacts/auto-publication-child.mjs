import {readFile,writeFile} from 'node:fs/promises';
import {createAutoPublicationFixture} from './auto-publication-fixture.mjs';
const input=JSON.parse(await readFile(process.argv[2],'utf8'));let fixture;
try{fixture=await createAutoPublicationFixture({snapshot:input.snapshot,flags:input.flags});if(input.publishIndex!==undefined)await fixture.publish(input.publishIndex);const result=await fixture.host.retrievePage(input.query??fixture.query);await writeFile(process.argv[3],JSON.stringify({ok:true,result,snapshot:fixture.snapshot}));}catch(error){await writeFile(process.argv[3],JSON.stringify({ok:false,code:error.code??error.message}));}finally{if(fixture)await fixture.routes.close();}
