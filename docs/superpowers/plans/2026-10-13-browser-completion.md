# Company Browser Completion Implementation Plan

> For workers: use the approved company-browser architecture, SWARM parallel execution, and test-driven development. Owner explicitly chose parallel agents and waived further routine design approvals. Root integrates and independently verifies; each writer has a separate worktree. No missing helper execution is claimed.

**Goal:** Complete ordinary public-web browsing, rich interaction/file/PDF/print operations, saved-auth references and reliable actual-client rollout.

**Architecture:** Extend the existing authenticated TypeScript gateway and AgentCore transport, retain DynamoDB/SQS/S3 ownership and effect fencing, and isolate new capabilities behind typed module interfaces. Public-web activation requires full-session connection containment. Provider or local-device gaps are independently measured, never hidden by a source-only fallback.

**Tech Stack:** Existing Node22 deployed/Node24 local, TypeScript, zod, undici, node:test, current Fastify/MCP/SigV4 adapters; no new paid model runtime.

**Spec:** ../specs/2026-10-13-company-browser-platform-design.md (approved; status wording predates approval).

## Global Constraints

- Currentbase5f44a4b; preservelegacyexactHTTPShosts and same-owner session/profile/artifact checks.
- No arbitrary callerJavaScript/CDP/localpath, wildcardIAM, model-visiblecredentials or protectedpersonal/PHIdata.
- Current180seconds/session,20actions,10startattempts/day remainuntilprovider/cost-acceptedmissionbudgetsreplace them;3safejobattempts, unknowneffectsneverreplayed.
- AWS900915535335/us-east1;1200USDgross/month. Cost/latestresourcefactsmustbereconciledbeforechanges; noautomaticpaidfallback.
- Noexistingprofile silentlybecomespersistent; newanonymousvalidationcannotoverwrite savedsign-ins.
- Rootaloneowns sharedinterfaces, manifests/dependencies, cloud/GitHub/CI/release. Workers ownassignednewfilesonly.
- Public_web remainsinactive untilprivateIPv4/IPv6/metadata/loopback/rebinding/background/new-tabconnectionsareblockedbeforeconnection.

## Review Focus

1. Partial/oversized/invalidbinary data mustneverbe published as a complete PDF/file.
2. Cross-owner artifacts, paths, profiles or credentials must fail before provider access.
3. A crashed or expired worker with possible external effects must become reconciliation, not replay.
4. Browser pages, popups, protocols or requests cannot expand an authorized mission or its network boundary.
5. A printer list, provider catalogue or anotherseat's result must not be reported as actual printing/fleet readiness.

## Parallel core interfaces (tasks2–4)

Root will consume these standalone exports; they do not edit existing contract/service/gateway themselves.

### Task2 — typed captures and PDFs

Create src/tools/browser-cloud/captures.ts and captures.test.ts in captureworktree.

Produces `captureBrowserArtifact(cdp:CloudBrowserCdp,page:string,input:BrowserCaptureRequest,remaining:()=>number):Promise<BrowserCapturedArtifact>` using imported existing CloudBrowserCdp.
`BrowserCaptureRequest = {type:'screenshot',format?:'png'|'jpeg'} | {type:'pdf',landscape?:boolean,printBackground?:boolean}`.
`BrowserCapturedArtifact = {contentType:'image/png'|'image/jpeg'|'application/pdf',body:Uint8Array,sha256:string,pageCount?:number}`;4MiBmaxdecoded, strictbase64, matchingmagic, rejectempty/oversized/partialPDF;pageCount onlywhenstructurallyverified, nofabricatedcount. Only known Page.captureScreenshot/Page.printToPDF typedparams; noeval/methodinput. Rootlaterconnectsboundedtransport/artifactstore.

- [ ] TestdecodedvalidPNG/PDFhashes and typedcommandparameters; malformedbase64/magic/truncation/oversize rejection, providererrorredaction; observe RED.
- [ ] Implementminimalexport, GREENfocused, typecheck; commitownfilesonly.
- [ ] Serializedfullsuite, reportallfailure names and actualresults. Providercompatibilityremainsseparate.

### Task3 — transfer broker

Create src/tools/browser-cloud/file-broker.ts and file-broker.test.ts in filesworktree.

Produces `BrowserFileBroker` and exported `BrowserFileRecord`; consumes typed injected `BrowserFileStore` interface definedinmodule. Methods `stage(owner:string,input:{filename:string,contentType:string,body:Uint8Array}):Promise<BrowserFileRecord>`, `get(owner:string,fileId:string):Promise<BrowserFileRecord>`, `verifyUpload(owner:string,fileId:string,evidence:{sha256:string,byteLength:number,completed:boolean}):Promise<{verified:true}>`.
Recordopaqueid/owner/safe basename/MIME/bytes/sha256/status('quarantined'|'ready'|'partial')/expiresAt, no caller paths/secretvalues. Storeholdsdata internally bygeneratedowner-boundkey, neverexposesarbitrarykey.10MiBfilecap; permittedplainCSV/text/PDF/PNG/JPEG; rejectexecutables/HTML/scripts/archives/embeddedNUL,traversal; quarantine requiresan injectedscanner clean result before ready. Defaultmissing scanner failsclosed. Hashactualbytes, verifyuploadreceiptmatched+complete;2ownernegativecases.

- [ ] Write REDtests forinvalidnames/types/bounds, clean/quarantine/partial/hash/crossowner; thenminimalimplementation.
- [ ] GREENfocused/typecheck/serializedfullsuite; commitownfiles. No claims of S3mount/provideruploaduntilrootintegration/liveproof.

### Task4 — durable recovery

Create src/tools/browser-cloud-jobs/recovery.ts and recovery.test.ts in recoveryworktree.

Produces `recoverBrowserDispatches(input:{store:BrowserRecoveryStore,dispatch:(jobId:string,owner:string)=>Promise<void>,now:number,limit:number}):Promise<BrowserRecoverySummary>` and `cleanupExpiredBrowserSessions(input:{store:BrowserExpiredSessionStore,stop:(providerSessionId:string)=>Promise<void>,now:number,limit:number}):Promise<BrowserCleanupSummary>`.
Define exported typedstoreports inmodule: indexed/bounded `listPending(now,limit)`, fenced `claimDispatch(id,version,until)` and `markDispatched(id,token)` / `markReconciliation(id,token)`; analogous `listExpired/claimCleanup/markStopped/markCleanupFailed`. RecordscontainopaqueIDs,version/fence/owner/status/effect('none'|'unknown'|'succeeded')/dueAt/attempts, no request/cookiebody. Maxlimit25, finiteattempt3; existingunknown/succeeded effectjobs neverdispatch; leased recordsnotdoubleclaimed. Cleanupstops onlyconfirmedownedexpiredsession, recordsreceipt, noTTLassumption; stopfailure preserved, no fabricatedsuccess. RootlateraddsindexedAWSstore/supervisor.

- [ ] REDtests for duplicate/concurrentclaim,unknown/succeeded effects,attemptceiling,expiredsession andstopfailure; implementminimalprimitives.
- [ ] GREENfocused/typecheck/serializedfullsuite; commitownfiles. No scans or AWSwrites.

## Remaining subprojects

### Task1 — general-web provider boundary

- [ ] Reconcile exactcurrentprovider/officialAPI and whetherwhole-sessionpubliconly/privateDNS containment is supported. Compare managedconfiguration and approvedisolatedegressalternative, exactcost/resources/rollback; no inventedproviderclaim.
- [ ] Rootimplementsversioned broker/profile/session/jobpolicy onlyafter provenremoteboundary. Add HTTPS+HTTPreadmode tests, IPv4/v6/rebinding/redirect/worker/popup/WebSocketdenial beforeconnection and unrelatedpublicsite success. Legacykept.

### Task5 — fleet distribution

- [ ] Enumeratein-scope actualCTO/CFO/CLO/COO/CRO/Developer/WeFunderclients and supportedinvocation/refresh/installinterfaces; protectpersonallegalring.
- [ ] Prepareversionedoperator skill and exactcapabilitymatrix; rootpublishes throughownerworkflowonce, readsreleaseback, asks eachactualseat toload/invokecontrolledmission. No anotherseat substitution.

### Task6 — AWS/OpenAI toolkit fit

- [ ] Review currentpinnedpublicsource/license/API/runtime of relevantAgentCore/DevOps/agent-toolkit/OpenAIPlugins/AgentsJS; useexistingconnections. Reportselectedusefulsourcefeatures and excludedpaid/archived/duplicateproviders separatelyfrominstallation.

### Task7 — remaining browser controls

- [ ] Addtypedtabcreate/select/close, back/forward/reload, focus/select/dialog andOSactions on ownedtargetIDs; pre/postURLpolicychecks plusremoteegress enforcement. Testwrong-target/malformedbounds/unsafedialog/lostackcleanup beforeintegration.

### Task8 — saved-auth/challenge broker

- [ ] Buildowner+origin+accountboundopaquecredentialrefs and runtime-onlyinjection; no modelGetSecretValue. Verifywrongorigin/owner/timeout/trace/screenshotleaknegativefixtures, singlewriterprofile save/reopen, resumablelegitimatechallenge path. Actualaccountenrollmentonlywithsecurebinding.

### Task9 — printing

- [ ] Discoveractualsupporteddevice/printqueuebridge without passwords/rawcustomerdata; addexactprinterID/documenthash/copies/pagebounds andverifiedqueueack. Missingphysicaldevicebinding staysincomplete, PDFnotasubstitute.

### Task10 — integration/release

- [ ] Rootcherry-picksverifiedtaskcommits, integrates strictgateway/service/transport/artifact limits andindexedrecoveryprovider, runsfulltests/build andfreshSolwhole-branchreview.
- [ ] Verifylatestcost/source/runtimeprestate; CI, immutableimage, controlledone-offcapability/rollbacktest andimage-onlystandardrollout. Per-clientactualacceptance andretainedrollbackrequired; nogreenimageequalsdeployedclaim.

## Scope self-review

Thetenworkstreams coverallmasterspeccomponents; isolatedmodules are integration inputs, not inventedfinishedfeatures. Existingpublicprofilepersistence, remoteegress proof, physicalprinter andreal-clientdistribution are visible dependencies, not hidden defaults. Workernewfilesareconflict-free; rootalonechangesconsuminginterfaces. BrowserCaptureRequest/body hashes feedrootfile/artifactintegration; recoveryportsneedindexedprovider beforeactualsupervision. No sourceprototype canpassoverallcompletion byitself.
