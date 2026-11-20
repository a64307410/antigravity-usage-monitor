import crypto, { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import * as metrics from '../trajectory-metrics.mjs';
import { stripModuleSyntax } from '../scripts/build-bundle.mjs';

const REAL_CATALOG_RAW = JSON.parse(
  fs.readFileSync(new URL('../../../pricing-catalog.json', import.meta.url), 'utf8')
);
const REAL_SEED_BANK_ZIP = fs.readFileSync(
  new URL('../vendor/seed-bank.zip', import.meta.url)
);
const DEFAULT_BUNDLED_CATALOG = {
  schemaVersion: 1,
  pricing: REAL_CATALOG_RAW.pricing,
  placeholders: REAL_CATALOG_RAW.placeholders,
};

const BACKEND_MODULE_FILES = [
  '../shared/settings-normalization.mjs',
  '../shared/telemetry-display-rules.mjs',
  '../shared/window-bridge-protocol.mjs',
  '../backend/context-windows.mjs',
  '../backend/account-oauth.mjs',
  '../backend/account-switch.mjs',
  '../backend/http-helpers.mjs',
  '../backend/settings-schema.mjs',
  '../backend/config.mjs',
  '../backend/endpoint-registry.mjs',
  '../backend/sqlite-client.mjs',
  '../backend/proto-wire.mjs',
  '../backend/cli-sqlite-reader.mjs',
  '../backend/cli-statusline-config.mjs',
  '../backend/ls-discovery.mjs',
  '../backend/pricing-catalog.mjs',
  '../backend/plugin-updater.mjs',
  '../backend/ls-rpc.mjs',
  '../backend/model-pricing.mjs',
  '../backend/quota-pools.mjs',
  '../backend/local-scanner.mjs',
  '../backend/usage-aggregator.mjs',
  '../backend/inference-health.mjs',
  '../backend/telemetry-builder.mjs',
  '../backend/model-detector-core.mjs',
  '../backend/model-detector.mjs',
  '../backend/desktop-launcher-config.mjs',
  '../backend/window-bridge.mjs',
  '../backend/api-actions.mjs',
  '../main.mjs',
];

function loadCombinedBackendSource() {
  return BACKEND_MODULE_FILES.map((relPath) =>
    fs.readFileSync(new URL(relPath, import.meta.url), 'utf8')
  ).join('\n');
}

function stripEsmSyntax(rawSource, mainUrl) {
  return stripModuleSyntax(rawSource).replaceAll('import.meta.url', JSON.stringify(mainUrl));
}

export function backendHarness({
  cache={},
  deepStats=null,
  transcripts={},
  swarmMembers={},
  diskDirs={},
  settings={},
  trajectories={},
  summaries={},
  userStatus={},
  availableModels={},
  quotaSummary={groups:[]},
  localCatalog=DEFAULT_BUNDLED_CATALOG,
  remoteCatalog=null,
  pluginManifest=null,
  hasGitDir=false,
  gitConfigText=null,
  pluginRootPath=null,
  remoteFetch=null,
  execFileImpl=null,
  seedBankZip=REAL_SEED_BANK_ZIP,
  sourceText=null,
  clock=null,
  timerApi={ setTimeout, clearTimeout },
  metricsImplementation=metrics,
}={}) {
  const mainUrl = pluginRootPath ? `file://${pluginRootPath}/sidecars/panel/main.mjs` : 'file:///test/sidecars/panel/main.mjs';
  const mainPath = pluginRootPath ? `${pluginRootPath}/sidecars/panel/main.mjs` : '/test/sidecars/panel/main.mjs';
  const source = stripEsmSyntax(sourceText ?? loadCombinedBackendSource(), mainUrl);
  const state={calls:[],errors:[],saves:[],virtualFiles:new Map(),virtualMtimes:new Map(),virtualTick:10,settings,trajectories,summaries,transcripts,transcriptMtimeMs:1,swarmMembers,swarmMembersMtimeMs:1,userStatus,quotaSummary,localCatalog,remoteCatalog,pluginManifest,hasGitDir,gitConfigText,deepStats,deepStatsMtimeMs:1};
  const touchVirtual=(norm)=>{const t=++state.virtualTick;state.virtualMtimes.set(norm,t);return t;};
  const ctx={
    ...metricsImplementation, URL, AbortSignal, Buffer, TextDecoder, crypto, zlib, DataView, Float32Array, Uint8Array, ...timerApi, isDeepStrictEqual, createHash, randomUUID,
    ...(clock ? { Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock()])); }
      static now() { return clock(); }
    } } : {}),
    process:{pid:process.pid,kill:process.kill.bind(process),platform:'win32',env:{ANTIGRAVITY_EXECUTABLE_DATA_DIR:'/test-data',ANTIGRAVITY_LS_ADDRESS:'test.invalid',ANTIGRAVITY_CSRF_TOKEN:'test'}},
    console:{error:m=>state.errors.push(m)},
    cpSync:()=>{},
    rmSync:()=>{},
    openSync:p=>String(p).replace(/\\/g, '/'),
    readSync:(fd,buf,offset,length,position)=>{
      const src = state.virtualFiles.get(fd);
      if (!src) return 0;
      const start = Math.max(0, Number(position || 0));
      const end = Math.min(src.length, start + length);
      if (end <= start) return 0;
      src.copy(buf, offset, start, end);
      return end - start;
    },
    closeSync:()=>{},
    chmodSync:()=>{},
    readlinkSync:()=>'',
    realpathSync:p=>p,
    renameSync:(fromPath,toPath)=>{
      const normFrom = String(fromPath).replace(/\\/g, '/');
      const normTo = String(toPath).replace(/\\/g, '/');
      if (state.virtualFiles.has(normFrom)) {
        state.virtualFiles.set(normTo, state.virtualFiles.get(normFrom));
        state.virtualFiles.delete(normFrom);
        touchVirtual(normTo);
      }
    },
    unlinkSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      state.virtualFiles.delete(norm);
      state.virtualMtimes.delete(norm);
    },
    execFile:execFileImpl || ((cmd,args,opts,cb)=>{
      const fn = typeof opts === 'function' ? opts : cb;
      fn(new Error('execFile not mocked'));
    }),
    existsSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) return true;
      if (norm.endsWith('/vendor/seed-bank.zip')) return Boolean(seedBankZip);
      if (norm.endsWith('settings.json') || norm.endsWith('trajectory_usage_cache.json')) return true;
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return Boolean(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return Boolean(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return Boolean(state.remoteCatalog);
      if (norm.endsWith('plugin.json')) return Boolean(state.pluginManifest);
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        return Boolean(m && state.transcripts?.[m[1]]);
      }
      if (norm.endsWith('/.system_generated/swarm/members.json')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/swarm\/members\.json$/i);
        return Boolean(m && state.swarmMembers?.[m[1]]);
      }
      if (norm.endsWith('/.git')) return Boolean(state.hasGitDir || state.gitConfigText);
      if (norm.endsWith('/.git/config')) return Boolean(state.gitConfigText);
      if (diskDirs && Object.prototype.hasOwnProperty.call(diskDirs, norm)) return true;
      return false;
    },
    mkdirSync:()=>{},
    readdirSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (diskDirs && Array.isArray(diskDirs[norm])) return diskDirs[norm];
      return [];
    },
    statSync:p=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) {
        const buf = state.virtualFiles.get(norm);
        return {
          mtimeMs: state.virtualMtimes.get(norm) || 10,
          size: buf.length,
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        if (lines) {
          const text = Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines);
          return {mtimeMs:state.transcriptMtimeMs,size:Buffer.byteLength(text,'utf8')};
        }
      }
      if (norm.endsWith('/.system_generated/swarm/members.json')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/swarm\/members\.json$/i);
        const obj = m && state.swarmMembers?.[m[1]];
        if (obj) {
          const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
          return {mtimeMs:state.swarmMembersMtimeMs,size:Buffer.byteLength(text,'utf8')};
        }
      }
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json') && state.deepStats) {
        return {mtimeMs:state.deepStatsMtimeMs,size:JSON.stringify(state.deepStats).length};
      }
      return {mtimeMs:0,size:0};
    },
    readFileSync:(p,enc)=>{
      const norm = String(p).replace(/\\/g, '/');
      if (state.virtualFiles.has(norm)) {
        const buf = state.virtualFiles.get(norm);
        return enc ? buf.toString(enc) : buf;
      }
      if (norm.endsWith('/vendor/seed-bank.zip')) return seedBankZip;
      if (norm.endsWith('/.system_generated/logs/transcript.jsonl')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/logs\/transcript\.jsonl$/i);
        const lines = m && state.transcripts?.[m[1]];
        return Array.isArray(lines) ? lines.map(x => JSON.stringify(x)).join('\n') : String(lines || '');
      }
      if (norm.endsWith('/.system_generated/swarm/members.json')) {
        const m = norm.match(/\/brain\/([^/]+)\/\.system_generated\/swarm\/members\.json$/i);
        const obj = m && state.swarmMembers?.[m[1]];
        return typeof obj === 'string' ? obj : JSON.stringify(obj || {});
      }
      if (norm.endsWith('settings.json')) return JSON.stringify(state.settings);
      if (norm.endsWith('/antigravity/brain/.deep_stats_cache.json')) return JSON.stringify(state.deepStats);
      if (norm.endsWith('pricing-catalog.json')) return JSON.stringify(state.localCatalog);
      if (norm.endsWith('remote_pricing_cache.json')) return JSON.stringify(state.remoteCatalog);
      if (norm.endsWith('plugin.json')) return JSON.stringify(state.pluginManifest);
      if (norm.endsWith('/.git/config')) return String(state.gitConfigText || '');
      return JSON.stringify(cache);
    },
    writeFileSync:(p,s)=>{
      const norm = String(p).replace(/\\/g, '/');
      const buf = Buffer.isBuffer(s) ? Buffer.from(s) : Buffer.from(String(s), 'utf8');
      state.virtualFiles.set(norm, buf);
      touchVirtual(norm);
      let parsed = s;
      if (typeof s === 'string') {
        try {
          parsed = JSON.parse(s);
        } catch {
          parsed = s;
        }
      }
      if (!norm.endsWith('.tmp') && !Buffer.isBuffer(s)) {
        state.saves.push({path:p,data:parsed});
      }
      if (norm.endsWith('settings.json')) {
        state.settings = parsed;
      }
      if (norm.endsWith('remote_pricing_cache.json')) {
        state.remoteCatalog = parsed;
      }
    },
    writeTrajectoryCacheFile:(p,data)=>{
      if (state.cacheWriteError) throw state.cacheWriteError;
      state.saves.push({path:p,data:JSON.parse(JSON.stringify(data))});
    },
    homedir:()=>'/test-home',dirname:path.dirname,join:path.join,basename:path.basename,delimiter:path.delimiter,pathToFileURL,fileURLToPath:()=>mainPath,
    Response:class {constructor(body,options){this.body=body;this.options=options;}},
    SidecarApp:class {page(){} api(){} run(){}},
    fetch:async(url,options={})=>{
      if (/^https?:\/\/(?!test\.invalid)/i.test(String(url)) && remoteFetch) {
        return remoteFetch(url, options);
      }
      const method=url.split('/').pop(); const body=options.body ? JSON.parse(options.body) : {};state.calls.push({method,body});
      if(method==='GetCascadeTrajectory') {
        const data=state.trajectories[body.cascadeId];
        if(data instanceof Error) throw data;
        return {ok:true,json:async()=>data||{}};
      }
      if(method==='RetrieveUserQuotaSummary') {
        const qs=await state.quotaSummary;
        if(qs instanceof Error) throw qs;
        return {ok:true,json:async()=>({response:qs})};
      }
      const data={GetUserStatus:{userStatus:state.userStatus},GetAvailableModels:{response:{models:availableModels}},GetAllCascadeTrajectories:{trajectorySummaries:state.summaries},DeleteCascadeTrajectory:{},CancelCascadeInvocation:{}} [method];
      return {ok:true,json:async()=>data||{}};
    },
  };
  vm.runInNewContext(source+'\n globalThis.api={buildTelemetryPayloadInternal,executeTelemetryAction,dispatchBridgeApiRequest,executeAccountCredentialAction,callLsRpc,computeStepCost,resolveModelInfo,resolvePricingAt,inferFamilyFromProviderOrKey,isNeonModelIdentifier,isArgonModelIdentifier,isCarbonModelIdentifier,getBaseModelLabel,formatUpstreamModelId,PLACEHOLDER_MAP,normalizeQuotaFraction,classifyOfficialBucketWindow,classifyQuotaPoolIdentity,buildOfficialQuotaPools,resolveTimeWindow,sanitizeCatalogPayload,rebuildActiveCatalog,getPricingPhaseEpoch,detectCustomGitForkRepo,persistTrajectoryCacheIfNeeded,flushTrajectoryCacheNow,getCachedTrajectory,listCachedTrajectoryEntries,hasPendingTrajectoryCacheSave,syncCloudCatalog,getCloudStatus,isValidSemver,compareSemver,performPluginUpdate,resolveMigratedGitRemoteUrl,loadSettings,executeSettingsAction,executeModelContextWindowAction,executeResetSettingsAction,executeRebuildCacheAction,clearRuntimeCaches,normalizeTopbarCapsuleSlots,normalizeHoverModules,normalizeHoverMetrics:typeof normalizeHoverMetrics!=="undefined"?normalizeHoverMetrics:undefined,normalizeOverviewModules,normalizeOverviewMetrics,normalizeStepTableColumns,normalizeStepTokenComboFormat,parseStepTokenComboSegments,normalizeModelDisplayMode,normalizePopoverWidthMode,normalizePopoverWidth,normalizeStandalonePort,setStandalonePortListener,parseAnnotationPbtxtTitle,readLocalSummarySnapshot,readLocalSqliteTrajectory,computeSqliteWalSig,buildCliStatusSnapshot,buildCliStatusLineCommand,isManagedCliStatusLineCommand,applyCliStatusLineToSettingsObject,cliDisplayWidth,parseCliModelAndEffort,formatCliStatusLineCapsule,registerRemoteEndpoint,getRegisteredRemoteEndpoint,resolveEndpointContext,clearRemoteEndpointCaches,clearRemoteEndpointRegistry,setRemoteWindowRpcInvoker,setLoopbackHttpsRequester,getEndpointCacheStore,pruneStaleRemoteEndpoints,trackEndpointRequestStart,trackEndpointRequestEnd,shouldRemoteEndpointPreferTier2,markRemoteEndpointPreferTier2,evaluateAgentInferenceHealth,mergeAggregatedInferenceHealth,ensureDetectorEngine,resolveAntigravityDetectorCatalog,resolveProbeExecutionModel,extractTieredModelBase,resolveAgentApiBinary,getModelDetectorStatus,startAntigravityModelDetection,cancelAntigravityModelDetection,syncDetectorBank,suggestAntigravityReference,compareForDisplay,formatDiagnosisSummary};',ctx);
  return {...ctx.api,state};
}
