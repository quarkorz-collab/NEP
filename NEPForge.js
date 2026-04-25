// ─── NEPForge: expose script-scope globals to window ──────────────────────
// const/let in a <script> block are NOT on window – expose them explicitly
// so that the modloader (and mod code running via new Function) can reach them.
(function _nepExportGlobals() {
  const _safeGet = (name, val) => { try { if (!(name in window)) window[name] = val; } catch(_) {} };
  _safeGet('Game',                Game);
  _safeGet('Player',              Player);
  _safeGet('WaveDirector',        WaveDirector);
  _safeGet('EnemyFactory',        EnemyFactory);
  _safeGet('BulletAffixCatalog',  BulletAffixCatalog);
  _safeGet('EnemyTraitCatalog',   EnemyTraitCatalog);
  _safeGet('EmitterCatalog',      EmitterCatalog);
  _safeGet('CompositeWrappers',   CompositeWrappers);
  _safeGet('MoveCatalog',         MoveCatalog);
  _safeGet('Fortress',            Fortress);
  _safeGet('BODY_KINDS',          BODY_KINDS);
  _safeGet('enemies',             enemies);
  _safeGet('bulletsP',            bulletsP);
  _safeGet('bulletsE',            bulletsE);
  _safeGet('beams',               beams);
  _safeGet('ctx',                 ctx);
  _safeGet('spawnBullet',         spawnBullet);
  _safeGet('spawnForgeEnemy',     spawnForgeEnemy);
  _safeGet('spawnShockwave',      spawnShockwave);
  _safeGet('spawnBeam',           spawnBeam);
  _safeGet('textPop',             textPop);
  _safeGet('sparks',              sparks);
  _safeGet('baseEnemy',           baseEnemy);
  _safeGet('findNearestEnemy',    findNearestEnemy);
  _safeGet('applyEnemyTraits',    applyEnemyTraits);
  _safeGet('drawEnemyGenericBody',drawEnemyGenericBody);
_safeGet('WrapperFieldDefs',    WrapperFieldDefs);
_safeGet('PlayerEmitterCatalog', PlayerEmitterCatalog);
_safeGet('setupPlayerEmittersFromBuild', setupPlayerEmittersFromBuild);
  // W and H are synced on every resize (see resize() above); do initial sync
  window.W = W; window.H = H;
  // step is a function declaration so it IS on window already, but ensure it's current
  // (it may have been assigned later in the script)
  window.step = step;
})();

// ─── NEPForge: extend setMenuPage to support injected tabs ───────────────
// The modloader injects a MODS tab page; we patch setMenuPage here so it
// knows how to activate/deactivate any pages whose IDs are registered.
(function _nepPatchMenuNav() {
  const _origSMP = window.setMenuPage;
  window.setMenuPage = function(key) {
    // Deactivate / activate any NEPForge-registered pages
    const extras = window.__NEP_EXTRA_PAGES__ || {};
    for (const [k, el] of Object.entries(extras))
      if (el) el.classList.toggle('active', k === key);
    if (_origSMP) _origSMP(key);
  };
  window.__NEP_EXTRA_PAGES__ = {};

  // Helper for the modloader to register a page element
  window._nepRegisterMenuPage = function(key, el) {
    window.__NEP_EXTRA_PAGES__[key] = el;
  };
})();


document.getElementById('inpDynZoom')?.addEventListener('change', (e)=>{
  Camera.enabled = (e.target.value === '1');
});


/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║  NEP FORGE  ·  Mod Loader  ·  v4.0                                  ║
 * ║  Not Enough Plane · In-menu tab UI · Hot-pluggable                   ║
 * ║                                                                      ║
 * ║  v4 Changes (all bugs fixed):                                        ║
 * ║  · Global vars now resolved correctly (no window['X'] ambiguity)    ║
 * ║  · UI is a proper in-game menu tab, not a floating window           ║
 * ║  · WaveTimer → Fortress shim (transparent, backward-compatible)     ║
 * ║  · UpgradePool shim created if absent                               ║
 * ║  · Wave hook fires AFTER original onWave (mod changes persist)      ║
 * ║  · PatchMgr: before / after / replace / around (full hook freedom)  ║
 * ║  · api.ui – DOM injection helpers for mod-defined HUD / panels      ║
 * ║  · All window.xxx references in examples fixed                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */
(function NEPForgeBootstrap() {
'use strict';

/* ─── Guard ─────────────────────────────────────────────────────────────── */
if (window.__NEPForge_installed__) {
  console.warn('[NEPForge] Already installed.');
  // Do not force-switch users back to MODS tab when script is re-evaluated.
  // This prevents unexpected tab jumps during external mod reload flows.
  return;
}
window.__NEPForge_installed__ = true;

/* ═══════════════════════════════════════════════════════════════════════
   0. UTILITIES
   ═══════════════════════════════════════════════════════════════════════ */
const isFunc  = v => typeof v === 'function';
const isStr   = v => typeof v === 'string';
const isNum   = v => typeof v === 'number' && isFinite(v);
const isObj   = v => v !== null && typeof v === 'object';
const clamp   = (v,a,b) => Math.max(a, Math.min(b, v));
const uid     = () => Math.random().toString(36).slice(2,9);

function mkEl(tag, style='', html='', attrs={}) {
  const el = document.createElement(tag);
  if (style) el.style.cssText = style;
  if (html)  el.innerHTML = html;
  for (const [k,v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function safeCall(fn, args=[], context='?', fallback=undefined) {
  if (!isFunc(fn)) return fallback;
  try { return fn(...args); }
  catch(e) {
    _FORGE_LOG.push({ t: Date.now(), lvl: 'error',
      msg: `[safeCall:${context}] ${e.message || e}` });
    return fallback;
  }
}

function compileJS(code, argNames=[], context='unknown') {
  try { return new Function(...argNames, code); }
  catch(e) {
    _FORGE_LOG.push({ t: Date.now(), lvl: 'error',
      msg: `Compile error in ${context}: ${e.message}` });
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   1. GLOBAL RESOLVER
   ═══════════════════════════════════════════════════════════════════════
   The game declares its key objects with const/let in <script> scope.
   The game HTML now exports them to window explicitly (see _nepExportGlobals).
   This resolver reads from window (or a manually set context).
   ═══════════════════════════════════════════════════════════════════════ */
const GlobalResolver = (() => {
  let _ctx = null;
  const _overrides = new Map();
  // Only probe keys that actually exist in the game
  const PROBE_KEYS = ['Game', 'Player', 'BulletAffixCatalog', 'WaveDirector'];

  function _hasGame(w) {
    try { return w && PROBE_KEYS.some(k => w[k] != null); }
    catch(_) { return false; }
  }

  function _scan() {
    if (_hasGame(window)) return window;
    try {
      for (const f of document.querySelectorAll('iframe')) {
        try { if (_hasGame(f.contentWindow)) return f.contentWindow; } catch(_) {}
      }
    } catch(_) {}
    try { if (window.parent !== window && _hasGame(window.parent)) return window.parent; } catch(_) {}
    try { if (window.opener && _hasGame(window.opener)) return window.opener; } catch(_) {}
    return window;
  }

  return {
    init() { _ctx = _scan(); return _hasGame(_ctx) ? 'found' : 'not_found'; },
    setContext(obj) { if (!isObj(obj)) throw new TypeError('setContext: object expected'); _ctx = obj; },
    getContext() { return _ctx || window; },
    override(key, value) { _overrides.set(key, value); },
    clearOverride(key)   { _overrides.delete(key); },
    clearAllOverrides()  { _overrides.clear(); },

    get(key) {
      if (_overrides.has(key)) return _overrides.get(key);
      return (_ctx || window)[key];
    },
    set(key, value) {
      if (_overrides.has(key)) { _overrides.set(key, value); return; }
      (_ctx || window)[key] = value;
    },

    rescan() {
      const prev = _ctx;
      _ctx = _scan();
      return _ctx !== prev;
    },

    inspect() {
      const ctx = _ctx || window;
      // Only list keys that should actually exist after game export
      const ALL_KEYS = ['Game','Player','BulletAffixCatalog','EnemyTraitCatalog',
        'EmitterCatalog','CompositeWrappers','MoveCatalog','Fortress',
        'enemies','bulletsP','bulletsE','beams','step','spawnBullet',
        'spawnForgeEnemy','spawnShockwave','spawnBeam','textPop','sparks',
        'baseEnemy','findNearestEnemy','applyEnemyTraits','WaveDirector',
        'EnemyFactory','drawEnemyGenericBody','ctx','W','H','BODY_KINDS',
        // Shims added by NEPForge:
        'WaveTimer','UpgradePool'];
      const found = [], missing = [];
      for (const k of ALL_KEYS) {
        try { (ctx[k] != null ? found : missing).push(k); } catch(_) { missing.push(k); }
      }
      return { context: ctx === window ? 'window' : 'iframe/other', found, missing };
    },
  };
})();

const _g    = (key)        => GlobalResolver.get(key);
const _gset = (key, value) => GlobalResolver.set(key, value);

/* ═══════════════════════════════════════════════════════════════════════
   2. BOOT
   ═══════════════════════════════════════════════════════════════════════ */
let _bootResult = GlobalResolver.init();

if (_bootResult === 'not_found') {
  let _retries = 0;
  const _retryBoot = () => {
    if (GlobalResolver.rescan() || _g('Game') || _g('Player')) {
      _bootResult = 'found';
      _info(`Game found after ${_retries} retries.`);
      _createShims();
      return;
    }
    _retries++;
    if (_retries < 10) setTimeout(_retryBoot, 500 * Math.min(_retries, 4));
    else console.error('[NEPForge] Game not detected. Call NEPForge.rescan() manually.');
  };
  setTimeout(_retryBoot, 300);
}

/* ═══════════════════════════════════════════════════════════════════════
   3. LOG (With Aggressive Anti-Spam for DevTools Protection)
   ═══════════════════════════════════════════════════════════════════════ */
const _FORGE_LOG =[];
const MAX_LOG = 400;
const _spamCache = new Map();
let _consoleCaptureInstalled = false;

function _pushLog(lvl, msg) {
  const t = Date.now();
  
  // ── 核心防护：阻止相同日志在 3 秒内疯狂刷屏，防止撑爆 DevTools Quota ──
  const lastT = _spamCache.get(msg) || 0;
  if (t - lastT < 3000) return;
  _spamCache.set(msg, t);
  
  // 定期清理过期防抖缓存
  if (_spamCache.size > 1000) _spamCache.clear();

  const entry = { t, lvl, msg };
  _FORGE_LOG.push(entry);
  if (_FORGE_LOG.length > MAX_LOG) _FORGE_LOG.shift();
  
  const style = lvl === 'error' ? 'color:#FF2F57'
              : lvl === 'warn'  ? 'color:#FFB020'
              : 'color:#52E6FF';
              
  console[lvl === 'error' ? 'error' : lvl === 'warn' ? 'warn' : 'log'](
    `%c[NEPForge] ${msg}`, style);
    
  if (typeof EventBus !== 'undefined') EventBus.emit('forge:log', entry);
}

const _info  = msg => _pushLog('info',  msg);
const _warn  = msg => _pushLog('warn',  msg);
const _error = msg => _pushLog('error', msg);

function _stringifyConsoleArgs(args = []) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message || String(a);
    try { return JSON.stringify(a); } catch(_) { return String(a); }
  }).join(' ');
}

function _captureExternalLog(level, args) {
  const msg = _stringifyConsoleArgs(args).trim();
  if (!msg) return;
  // Skip logs already emitted via _pushLog to avoid duplicate lines.
  if (msg.includes('[NEPForge]')) return;
  const lvl = level === 'error' ? 'error' : (level === 'warn' ? 'warn' : 'info');
  const t = Date.now();
  _FORGE_LOG.push({ t, lvl, msg });
  if (_FORGE_LOG.length > MAX_LOG) _FORGE_LOG.shift();
  if (typeof EventBus !== 'undefined') EventBus.emit('forge:log', { t, lvl, msg });
}

function _installConsoleCapture() {
  if (_consoleCaptureInstalled) return;
  _consoleCaptureInstalled = true;
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  for (const method of methods) {
    const orig = console[method];
    if (typeof orig !== 'function' || orig.__nepCaptured__) continue;
    const wrapped = function(...args) {
      _captureExternalLog(method, args);
      return orig.apply(this, args);
    };
    wrapped.__nepCaptured__ = true;
    try { console[method] = wrapped; } catch(_) {}
  }

  window.addEventListener('error', (ev) => {
    const src = ev.filename ? `${ev.filename}:${ev.lineno || 0}:${ev.colno || 0}` : 'unknown';
    const msg = ev.error?.stack || ev.message || 'Unknown runtime error';
    _captureExternalLog('error', [`[window.onerror] ${src} ${msg}`]);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason?.stack || ev.reason?.message || String(ev.reason);
    _captureExternalLog('error', [`[unhandledrejection] ${reason}`]);
  });
}


/* ═══════════════════════════════════════════════════════════════════════
   4. EVENT BUS  (priority, once, wildcard, cancellable)
   ═══════════════════════════════════════════════════════════════════════ */
const EventBus = (() => {
  const handlers = {};

  function _sortedInsert(arr, h) {
    arr.push(h);
    arr.sort((a,b) => b.priority - a.priority);
  }

  return {
    on(evt, fn, modId = '_system', opts = {}) {
      const h = { fn, modId, id: uid(),
                  priority: opts.priority ?? 0,
                  once:     opts.once     ?? false };
      (handlers[evt] = handlers[evt] || []);
      _sortedInsert(handlers[evt], h);
      return h.id;
    },
    once(evt, fn, modId = '_system', opts = {}) {
      return this.on(evt, fn, modId, { ...opts, once: true });
    },
    offById(handlerId) {
      for (const arr of Object.values(handlers)) {
        const i = arr.findIndex(h => h.id === handlerId);
        if (i >= 0) { arr.splice(i, 1); return; }
      }
    },
    off(evt, fn) {
      if (handlers[evt]) handlers[evt] = handlers[evt].filter(h => h.fn !== fn);
    },
    offByMod(modId) {
      for (const evt of Object.keys(handlers))
        handlers[evt] = (handlers[evt] || []).filter(h => h.modId !== modId);
    },
    emit(evt, ...args) {
      let cancelled = false;
      const cancel  = () => { cancelled = true; };
      const list    = [...(handlers[evt] || [])];
      const toRemove = [];
      for (const h of list) {
        if (cancelled) break;
        try { h.fn(...args, cancel); }
        catch(e) { _pushLog('error', `[${h.modId}] "${evt}": ${e.message}`); }
        if (h.once) toRemove.push(h.id);
      }
      if (!evt.startsWith('*')) this.emit('*', evt, ...args);
      if (toRemove.length && handlers[evt])
        handlers[evt] = handlers[evt].filter(h => !toRemove.includes(h.id));
      return !cancelled;
    },
    list() { return Object.keys(handlers); },
    listHandlers(evt) { return (handlers[evt] || []).map(h => ({ id: h.id, modId: h.modId, priority: h.priority })); },
  };
})();
_installConsoleCapture();

/* ═══════════════════════════════════════════════════════════════════════
   5. CONFLICT GUARD
   ═══════════════════════════════════════════════════════════════════════ */
const ConflictGuard = (() => {
  const ownership = new Map();
  return {
    claim(targetKey, modId) {
      const owner = ownership.get(targetKey);
      if (owner && owner !== modId)
        _warn(`CONFLICT: "${targetKey}" patched by "${owner}", now also by "${modId}".`);
      if (!ownership.has(targetKey)) ownership.set(targetKey, []);
      ownership.get(targetKey).push(modId);
      return true;
    },
    release(targetKey, modId) {
      const arr = ownership.get(targetKey);
      if (!arr) return;
      const idx = arr.lastIndexOf(modId);
      if (idx >= 0) arr.splice(idx, 1);
      if (!arr.length) ownership.delete(targetKey);
    },
    releaseAll(modId) {
      for (const [key, arr] of ownership) {
        const filtered = arr.filter(id => id !== modId);
        if (filtered.length) ownership.set(key, filtered);
        else ownership.delete(key);
      }
    },
    owners(targetKey) { return ownership.get(targetKey) || []; },
    report() {
      const conflicts = [];
      for (const [k, arr] of ownership)
        if (arr.length > 1) conflicts.push({ key: k, mods: [...arr] });
      return conflicts;
    },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   6. PRIORITY PATCH MANAGER  (Hyper-Architectural Dispatcher)
   ═══════════════════════════════════════════════════════════════════════
   - 函数多重拦截：支持 before/around/after/replace 链式调用。
   - 属性多重监控：支持 getter/setter 链式篡改、条件中断 (cancel)。
   - 系统底层渗透：基于原型链安全劫持 Timers, DOM Mutations, EventListeners。
   ═══════════════════════════════════════════════════════════════════════ */
const PatchMgr = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════
  //  § 0  内部工具层
  // ═══════════════════════════════════════════════════

  const _patches   = {};          // modId → PatchRecord[]
  const _propDisp  = new WeakMap(); // obj → { prop → PropDispatcher }
  const _auditLog  = [];          // 全局操作审计日志（环形缓冲区）
  const _AUDIT_CAP = 2000;
  const _shared    = new Map();   // 跨 mod 共享存储
  const _signals   = new Map();   // 跨 mod 信号总线
  const _caps      = new Map();   // 能力注册表  modId → Set<string>
  const _depends   = new Map();   // mod 依赖图   modId → Set<modId>
  const _breakers  = new Map();   // key → CircuitBreakerState
  const _replayBuf = new Map();   // key → Call[]

  let _uid = 0;
  const uid  = () => `np_${(++_uid).toString(36)}`;
  const now  = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const isObj  = v => v !== null && typeof v === 'object';
  const isFunc = v => typeof v === 'function';
  const noop   = () => {};

  // 安全调用，含错误捕获
  function _tryCall(fn, ctx, args, label) {
    try { return { ok: true, val: fn.apply(ctx, args) }; }
    catch(e) {
      _audit('error', { label, message: e.message, stack: e.stack });
      _error(`${label}: ${e.message}`);
      return { ok: false, val: undefined, error: e };
    }
  }

  function _audit(type, data) {
    const entry = { t: now(), type, ...data };
    _auditLog.push(entry);
    if (_auditLog.length > _AUDIT_CAP) _auditLog.shift();
    return entry;
  }

  function _error(msg) { console.error(`[PatchMgr] ${msg}`); }
  function _warn(msg)  { console.warn(`[PatchMgr] ${msg}`); }
  function _log(msg)   { console.log(`[PatchMgr] ${msg}`); }

  // 获取宿主上下文（兼容 window / globalThis / self）
  function _ctx() {
    try { return GlobalResolver.getContext(); }
    catch(_) { return typeof globalThis !== 'undefined' ? globalThis
                    : typeof window     !== 'undefined' ? window : self; }
  }

  function _slotKey(obj, key) {
    return obj === _ctx() ? `window.${String(key)}` : `obj(${_objTag(obj)}).${String(key)}`;
  }

  function _objTag(obj) {
    if (!obj) return 'null';
    if (obj === _ctx()) return 'global';
    return obj[Symbol.toStringTag] || obj.constructor?.name || 'Object';
  }

  // 注册补丁记录
  function _addRecord(modId, record) {
    (_patches[modId] = _patches[modId] || []).push(record);
  }

  // ═══════════════════════════════════════════════════
  //  § 1  熔断器（Circuit Breaker）
  // ═══════════════════════════════════════════════════

  const CB_STATES = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF: 'HALF' };

  function _getBreaker(key, opts = {}) {
    if (!_breakers.has(key)) {
      _breakers.set(key, {
        state: CB_STATES.CLOSED,
        failures: 0,
        lastFail: 0,
        threshold: opts.threshold || 5,
        resetMs:   opts.resetMs   || 10000,
        key
      });
    }
    return _breakers.get(key);
  }

  function _breakerAllow(key) {
    const b = _getBreaker(key);
    if (b.state === CB_STATES.CLOSED) return true;
    if (b.state === CB_STATES.OPEN) {
      if (now() - b.lastFail > b.resetMs) { b.state = CB_STATES.HALF; return true; }
      return false;
    }
    return true; // HALF → allow one probe
  }

  function _breakerSuccess(key) {
    const b = _breakers.get(key);
    if (b) { b.failures = 0; b.state = CB_STATES.CLOSED; }
  }

  function _breakerFail(key) {
    const b = _breakers.get(key);
    if (!b) return;
    b.failures++;
    b.lastFail = now();
    if (b.failures >= b.threshold) { b.state = CB_STATES.OPEN; }
  }

  // ═══════════════════════════════════════════════════
  //  § 2  函数 Dispatcher（函数中央调度器 v2）
  // ═══════════════════════════════════════════════════

  function _getDispatcher(target, key) {
    let fn = target[key];
    if (fn && fn.__nepDispatcher) return fn;

    const original = fn;
    const bKey = _slotKey(target, key);

    const dispatcher = function (...args) {
      const ctx  = this;
      const hooks = dispatcher.hooks;
      const byType = dispatcher._getByType();
      let currentArgs = [...args];
      let cancelled   = false;
      const callId    = uid();

      _audit('call', { key: String(key), callId, modCount: hooks.length });

      // ── 重放缓冲记录（若开启）
      if (dispatcher.__replayCapture) {
        const buf = _replayBuf.get(bKey) || [];
        buf.push({ ts: now(), args: currentArgs, callId });
        if (buf.length > (dispatcher.__replayCap || 50)) buf.shift();
        _replayBuf.set(bKey, buf);
      }

      // ─── BEFORE ──────────────────────────────────────────────────
      for (const h of byType.before) {
        if (!_breakerAllow(h.id)) continue;
        if (cancelled) break;
        let skip = false;
        const cancel = () => { skip = true; cancelled = true; };
        const r = _tryCall(h.fn, ctx, [currentArgs, cancel], `[${h.modId}] BEFORE ${String(key)}`);
        if (r.ok) { _breakerSuccess(h.id); if (Array.isArray(r.val)) currentArgs = r.val; }
        else _breakerFail(h.id);
        if (skip) break;
      }

      // ─── TAP（只读观察，不能取消/改参，无副作用承诺）──────────────
      for (const h of byType.tap) {
        _tryCall(h.fn, ctx, [[...currentArgs]], `[${h.modId}] TAP ${String(key)}`);
      }

      // ─── REPLACE / AROUND / ORIGINAL ─────────────────────────────
      let result;
      if (!cancelled) {
        const replacer = byType.replace[0];
        if (replacer && _breakerAllow(replacer.id)) {
          const r = _tryCall(replacer.fn, ctx, currentArgs, `[${replacer.modId}] REPLACE ${String(key)}`);
          if (r.ok) { _breakerSuccess(replacer.id); result = r.val; }
          else { _breakerFail(replacer.id); }
        } else {
          const arounds = byType.around;
          let execChain = original ? (...a) => original.apply(ctx, a) : () => {};
          for (let i = arounds.length - 1; i >= 0; i--) {
            const nxt    = execChain;
            const wrapFn = arounds[i].fn;
            const wId    = arounds[i].id;
            execChain = (...a) => {
              if (!_breakerAllow(wId)) return nxt(...a);
              const r = _tryCall(wrapFn, ctx, [nxt, ...a], `[${arounds[i].modId}] AROUND ${String(key)}`);
              if (r.ok) { _breakerSuccess(wId); return r.val; }
              _breakerFail(wId);
              return nxt(...a); // 降级走原始链
            };
          }
          const r = _tryCall(execChain, ctx, currentArgs, `CHAIN ${String(key)}`);
          if (r.ok) result = r.val;
        }
      }

      // ─── AFTER ───────────────────────────────────────────────────
      for (const h of byType.after) {
        if (!_breakerAllow(h.id)) continue;
        const r = _tryCall(h.fn, ctx, [result, currentArgs], `[${h.modId}] AFTER ${String(key)}`);
        if (r.ok) { _breakerSuccess(h.id); if (r.val !== undefined) result = r.val; }
        else _breakerFail(h.id);
      }

      _audit('callDone', { key: String(key), callId });
      return result;
    };

    dispatcher.__nepDispatcher = true;
    dispatcher.original        = original;
    dispatcher.hooks           = [];
    dispatcher.__typeCache     = null;
    dispatcher.__typeCacheAt   = -1;
    dispatcher.__hooksVer      = 0;
    dispatcher._markDirty      = function() { this.__hooksVer++; };
    dispatcher._getByType      = function() {
      if (this.__typeCache && this.__typeCacheAt === this.__hooksVer) return this.__typeCache;
      const out = { before: [], tap: [], replace: [], around: [], after: [] };
      for (const h of this.hooks) {
        if (out[h.type]) out[h.type].push(h);
      }
      this.__typeCache = out;
      this.__typeCacheAt = this.__hooksVer;
      return out;
    };
    dispatcher.__replayCapture = false;
    dispatcher.__replayCap     = 50;

    // 尝试保留函数名（有助于堆栈可读性）
    try { Object.defineProperty(dispatcher, 'name', { value: `[patched:${String(key)}]` }); } catch(_) {}

    try { target[key] = dispatcher; }
    catch(_) {
      Object.defineProperty(target, key, { value: dispatcher, writable: true, configurable: true });
    }
    return dispatcher;
  }

  // 注册钩子（核心，带频率限制、条件开关支持）
  function _doWrap(target, key, type, fn, modId, priority, opts = {}) {
    if (!isObj(target) && !isFunc(target)) return false;
    const sk = _slotKey(target, key);

    // 条件 enabled 支持（动态开关）
    const enabledFn = isFunc(opts.enabled) ? opts.enabled : () => opts.enabled !== false;

    // throttle / debounce 包装
    let wrappedFn = fn;
    if (opts.throttle > 0)  wrappedFn = _throttle(fn, opts.throttle);
    if (opts.debounce > 0)  wrappedFn = _debounce(fn, opts.debounce);
    if (opts.once)          wrappedFn = _once(fn);

    // 条件包装
    const finalFn = enabledFn === (() => true)
      ? wrappedFn
      : function (...a) { return enabledFn() ? wrappedFn.apply(this, a) : undefined; };

    const dispatcher = _getDispatcher(target, key);
    const hookId = uid();

    // tag 支持（便于按 tag 批量操作）
    dispatcher.hooks.push({
      id:       hookId,
      type,
      fn:       finalFn,
      rawFn:    fn,
      modId,
      priority,
      tag:      opts.tag || null,
      meta:     opts.meta || null,
      createdAt: now()
    });
    dispatcher.hooks.sort((a, b) => b.priority - a.priority);
    dispatcher._markDirty();

    _getBreaker(hookId, opts.breaker || {});

    _audit('hookAdd', { sk, type, modId, hookId, priority });
    _addRecord(modId, { target, key, id: hookId, slotKey: sk, isFunc: true });
    return hookId; // 返回 hookId 以便精准 revert
  }

  // ── 辅助：限频 / 防抖 / 单次 ──
  function _throttle(fn, ms) {
    let last = 0;
    return function (...a) {
      const t = now();
      if (t - last < ms) return;
      last = t;
      return fn.apply(this, a);
    };
  }

  function _debounce(fn, ms) {
    let timer;
    return function (...a) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, a), ms);
    };
  }

  function _once(fn) {
    let called = false, cached;
    return function (...a) {
      if (called) return cached;
      called = true;
      return (cached = fn.apply(this, a));
    };
  }

  // ═══════════════════════════════════════════════════
  //  § 3  属性 Dispatcher v2
  // ═══════════════════════════════════════════════════

  function _getPropDispatcher(obj, prop) {
    if (!_propDisp.has(obj)) _propDisp.set(obj, {});
    const map = _propDisp.get(obj);
    if (map[prop]) return map[prop];

    // 向上追溯真实描述符
    let proto = obj, desc = null;
    while (proto) {
      desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (desc) break;
      proto = Object.getPrototypeOf(proto);
    }

    let underlying = desc ? undefined : obj[prop];
    const origGet  = desc?.get ? desc.get.bind(obj)  : null;
    const origSet  = desc?.set ? desc.set.bind(obj)  : null;

    const dispatcher = {
      hooks: [],
      originalDesc: desc,
      schema: null,   // JSON-Schema-like 约束（可选）
      frozen: false,  // 冻结后拒绝所有写入

      get() {
        let val = origGet ? origGet() : underlying;
        for (const h of dispatcher.hooks.filter(h => h.cb.get)) {
          const r = _tryCall(h.cb.get, this, [val], `[${h.modId}] GET ${prop}`);
          if (r.ok && r.val !== undefined) val = r.val;
        }
        return val;
      },

      set(newVal) {
        if (dispatcher.frozen) {
          _warn(`Property "${prop}" is frozen. Write blocked.`);
          return;
        }

        // Schema 校验（轻量）
        if (dispatcher.schema) {
          const err = _validateSchema(newVal, dispatcher.schema);
          if (err) {
            _warn(`Property "${prop}" schema violation: ${err}. Write blocked.`);
            _audit('schemaBreach', { prop, newVal, err });
            return;
          }
        }

        let oldVal   = origGet ? origGet() : underlying;
        let finalVal = newVal;
        let cancelled = false;
        const cancel  = () => { cancelled = true; };

        for (const h of dispatcher.hooks.filter(h => h.cb.set)) {
          const r = _tryCall(h.cb.set, this, [finalVal, oldVal, cancel], `[${h.modId}] SET ${prop}`);
          if (r.ok && r.val !== undefined) finalVal = r.val;
          if (cancelled) {
            _audit('setPropCancelled', { prop, modId: h.modId });
            return;
          }
        }

        if (origSet) origSet(finalVal);
        else underlying = finalVal;

        // 变更通知（订阅者）
        const subs = dispatcher._changeSubs || [];
        for (const sub of subs) {
          _tryCall(sub.fn, null, [finalVal, oldVal], `changeSub ${prop}`);
        }
      }
    };

    map[prop] = dispatcher;

    try {
      Object.defineProperty(obj, prop, {
        get()      { return dispatcher.get.call(this); },
        set(v)     { return dispatcher.set.call(this, v); },
        configurable: true,
        enumerable: desc ? desc.enumerable : true
      });
    } catch(e) { _warn(`Cannot redefine "${prop}": ${e.message}`); }

    return dispatcher;
  }

  // 简易 Schema 校验（type / min / max / pattern / enum / custom）
  function _validateSchema(val, schema) {
    if (schema.type && typeof val !== schema.type) return `expected type ${schema.type}, got ${typeof val}`;
    if (schema.min  !== undefined && val < schema.min)    return `${val} < min(${schema.min})`;
    if (schema.max  !== undefined && val > schema.max)    return `${val} > max(${schema.max})`;
    if (schema.pattern && !schema.pattern.test(String(val))) return `"${val}" fails pattern`;
    if (schema.enum && !schema.enum.includes(val)) return `"${val}" not in enum`;
    if (isFunc(schema.custom)) {
      const msg = schema.custom(val);
      if (msg) return msg;
    }
    return null;
  }

  // ═══════════════════════════════════════════════════
  //  § 4  计算属性（依赖追踪）
  // ═══════════════════════════════════════════════════

  function _computed(obj, prop, computeFn, depProps, modId) {
    // depProps: [{ obj, key }]
    let cached, dirty = true;

    const recompute = () => {
      const next = computeFn();
      if (next !== cached) { cached = next; _audit('computed', { prop, val: next }); }
      dirty = false;
    };

    for (const dep of depProps) {
      const disp = _getPropDispatcher(dep.obj, dep.key);
      (disp._changeSubs = disp._changeSubs || []).push({
        fn: () => { dirty = true; }
      });
    }

    try {
      Object.defineProperty(obj, prop, {
        get() { if (dirty) recompute(); return cached; },
        configurable: true, enumerable: true
      });
    } catch(e) { _warn(`computed defineProperty failed for ${prop}: ${e.message}`); }

    _addRecord(modId, { target: obj, key: prop, isComputed: true, slotKey: `computed:${prop}` });
  }

  // ═══════════════════════════════════════════════════
  //  § 5  跨 Mod 互操作总线
  // ═══════════════════════════════════════════════════

  // 信号（事件总线）
  function _emit(signalName, data, sourceModId) {
    const subs = _signals.get(signalName) || [];
    _audit('signal', { signalName, sourceModId, subCount: subs.length });
    for (const sub of subs) {
      _tryCall(sub.handler, null, [data, sourceModId], `signal[${signalName}] → ${sub.modId}`);
    }
  }

  function _on(signalName, handler, modId, once = false) {
    const subs = _signals.get(signalName) || [];
    const id = uid();
    const entry = {
      id, modId, once,
      handler: once
        ? function (...a) {
            _off(signalName, id);
            return handler.apply(this, a);
          }
        : handler
    };
    subs.push(entry);
    _signals.set(signalName, subs);
    _addRecord(modId, { isSignal: true, signalName, id, slotKey: `signal:${signalName}` });
    return id;
  }

  function _off(signalName, id) {
    const subs = _signals.get(signalName);
    if (subs) _signals.set(signalName, subs.filter(s => s.id !== id));
  }

  // 共享存储（带命名空间，读写审计）
  const _store = {
    get(ns, key, def) {
      const full = `${ns}::${key}`;
      return _shared.has(full) ? _shared.get(full) : def;
    },
    set(ns, key, val, modId) {
      const full = `${ns}::${key}`;
      const old  = _shared.get(full);
      _shared.set(full, val);
      _audit('storeSet', { ns, key, modId, old, val });
      // 通知变更（信号）
      _emit(`store:${full}`, { key, val, old }, modId);
    },
    delete(ns, key, modId) {
      _shared.delete(`${ns}::${key}`);
      _audit('storeDel', { ns, key, modId });
    },
    watch(ns, key, handler, modId) {
      return _on(`store:${ns}::${key}`, handler, modId);
    },
    snapshot(ns) {
      const out = {};
      const prefix = `${ns}::`;
      _shared.forEach((v, k) => { if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v; });
      return out;
    }
  };

  // 能力注册与查询（Capability Negotiation）
  function _registerCap(modId, ...caps) {
    let set = _caps.get(modId);
    if (!set) { set = new Set(); _caps.set(modId, set); }
    caps.forEach(c => set.add(c));
  }

  function _hasCap(modId, cap) {
    return _caps.get(modId)?.has(cap) || false;
  }

  function _allModsWith(cap) {
    const result = [];
    _caps.forEach((set, modId) => { if (set.has(cap)) result.push(modId); });
    return result;
  }

  // 依赖关系声明（用于加载顺序校验）
  function _declareDep(modId, ...deps) {
    let set = _depends.get(modId);
    if (!set) { set = new Set(); _depends.set(modId, set); }
    deps.forEach(d => set.add(d));
    _audit('dep', { modId, deps });
  }

  function _depsReady(modId) {
    const deps = _depends.get(modId);
    if (!deps) return true;
    for (const d of deps) {
      if (!_patches[d] && !_caps.has(d)) {
        _warn(`[${modId}] depends on "${d}" which is not yet registered.`);
        return false;
      }
    }
    return true;
  }

  // ═══════════════════════════════════════════════════
  //  § 6  MutationObserver 系统拦截
  // ═══════════════════════════════════════════════════

  const _domWatchers = [];

  function _setupMutObs() {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(records => {
      for (const rec of records) {
        for (const w of _domWatchers) {
          _tryCall(w.fn, null, [rec], `MutObs[${w.modId}]`);
        }
      }
    });
    mo.observe(document.documentElement || document, {
      childList: true, subtree: true, attributes: true,
      characterData: false, attributeOldValue: true
    });
    return mo;
  }

  let _mutObs = null;
  function _ensureMutObs() {
    if (!_mutObs && typeof document !== 'undefined') _mutObs = _setupMutObs();
  }

  // ═══════════════════════════════════════════════════
  //  § 7  Fetch / XHR 拦截
  // ═══════════════════════════════════════════════════

  function _interceptFetch(modId) {
    const ctx = _ctx();
    if (!isFunc(ctx.fetch)) return false;
    return _doWrap(ctx, 'fetch', 'around',
      async function (originalFetch, input, init) {
        _audit('fetch', { url: String(input), modId });
        return originalFetch(input, init);
      },
      modId, 0
    );
  }

  function _interceptXHR(modId) {
    const proto = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype : null;
    if (!proto) return false;
    ['open', 'send', 'setRequestHeader'].forEach(m => {
      _doWrap(proto, m, 'around', function (orig, ...a) { return orig(...a); }, modId, 0);
    });
    return true;
  }

  // ═══════════════════════════════════════════════════
  //  § 8  Storage 拦截（localStorage / sessionStorage）
  // ═══════════════════════════════════════════════════

  function _interceptStorage(storageObj, modId) {
    if (!isObj(storageObj)) return false;
    ['setItem', 'getItem', 'removeItem', 'clear'].forEach(m => {
      if (isFunc(storageObj[m])) {
        _doWrap(storageObj, m, 'around', function (orig, ...a) {
          _audit(`storage.${m}`, { key: a[0], modId });
          return orig(...a);
        }, modId, 0);
      }
    });
    return true;
  }

  // ═══════════════════════════════════════════════════
  //  § 9  精准 Revert（单钩子 / 全量 / 按 tag）
  // ═══════════════════════════════════════════════════

  function _revertHook(hookId) {
    for (const modId of Object.keys(_patches)) {
      const list = _patches[modId];
      for (const p of list) {
        if (!p.isFunc) continue;
        const disp = p.target[p.key];
        if (disp && disp.__nepDispatcher) {
          const before = disp.hooks.length;
          disp.hooks = disp.hooks.filter(h => h.id !== hookId);
          if (disp.hooks.length < before) {
            disp._markDirty?.();
            if (disp.hooks.length === 0 && disp.original) p.target[p.key] = disp.original;
            _patches[modId] = list.filter(r => r.id !== hookId);
            _audit('revertHook', { hookId, modId });
            return true;
          }
        }
      }
    }
    return false;
  }

  function _revertByTag(modId, tag) {
    const list = _patches[modId] || [];
    for (const p of list) {
      if (!p.isFunc) continue;
      const disp = p.target?.[p.key];
      if (disp && disp.__nepDispatcher) {
        disp.hooks = disp.hooks.filter(h => !(h.modId === modId && h.tag === tag));
        disp._markDirty?.();
        if (disp.hooks.length === 0 && disp.original) p.target[p.key] = disp.original;
      }
    }
    _audit('revertByTag', { modId, tag });
  }

  function _revertAll(modId) {
    const list = _patches[modId] || [];
    for (const p of list) {
      if (p.isSignal) { _off(p.signalName, p.id); continue; }
      if (p.isComputed) {
        try { Object.defineProperty(p.target, p.key, { value: undefined, writable: true, configurable: true }); } catch(_) {}
        continue;
      }
      if (!p.isFunc) {
        // prop dispatcher
        const map = _propDisp.get(p.target);
        const disp = map?.[p.key];
        if (disp) {
          disp.hooks = disp.hooks.filter(h => h.id !== p.id);
          if (disp.hooks.length === 0) {
            const cur = p.target[p.key];
            if (disp.originalDesc && !('value' in disp.originalDesc)) {
              try { Object.defineProperty(p.target, p.key, disp.originalDesc); } catch(_) {}
            } else {
              try { Object.defineProperty(p.target, p.key, { value: cur, writable: true, configurable: true, enumerable: true }); } catch(_) {}
            }
            delete map[p.key];
          }
        }
      } else {
        const disp = p.target[p.key];
        if (disp && disp.__nepDispatcher) {
          disp.hooks = disp.hooks.filter(h => h.id !== p.id);
          disp._markDirty?.();
          if (disp.hooks.length === 0 && disp.original) p.target[p.key] = disp.original;
        }
      }
    }

    // 解除 cap / signal 登记
    _caps.delete(modId);
    _signals.forEach((subs, name) => {
      _signals.set(name, subs.filter(s => s.modId !== modId));
    });
    _domWatchers.splice(0, _domWatchers.length,
      ..._domWatchers.filter(w => w.modId !== modId));

    delete _patches[modId];
    _audit('revertAll', { modId });
  }

  // ═══════════════════════════════════════════════════
  //  § 10  诊断与调试工具
  // ═══════════════════════════════════════════════════

  const Diagnostics = {
    auditLog(filter) {
      if (!filter) return [..._auditLog];
      return _auditLog.filter(e => Object.keys(filter).every(k => e[k] === filter[k]));
    },
    hookTree() {
      const out = {};
      for (const modId of Object.keys(_patches)) {
        out[modId] = _patches[modId].map(p => ({
          key:      p.key,
          slotKey:  p.slotKey,
          isFunc:   p.isFunc !== false,
          hooks: p.isFunc && p.target?.[p.key]?.__nepDispatcher
            ? p.target[p.key].hooks.map(h => ({ type: h.type, priority: h.priority, tag: h.tag }))
            : []
        }));
      }
      return out;
    },
    breakerStatus() {
      const out = {};
      _breakers.forEach((b, k) => { out[k] = { state: b.state, failures: b.failures }; });
      return out;
    },
    sharedStore() { return Object.fromEntries(_shared); },
    signalBus()   {
      const out = {};
      _signals.forEach((subs, name) => { out[name] = subs.map(s => ({ modId: s.modId, once: s.once })); });
      return out;
    },
    deps()        { return Object.fromEntries([..._depends.entries()].map(([k,v]) => [k,[...v]])); },
    caps()        { return Object.fromEntries([..._caps.entries()].map(([k,v]) => [k,[...v]])); },
    layerReport(fnName) {
      const disp = _ctx()?.[fnName];
      if (!disp?.__nepDispatcher) return [];
      return disp.hooks.map(h => ({ modId: h.modId, type: h.type, priority: h.priority, tag: h.tag, id: h.id }));
    },
    replayBuffer(fnName) {
      const disp = _ctx()?.[fnName];
      if (!disp) return [];
      return _replayBuf.get(_slotKey(_ctx(), fnName)) || [];
    },
    enableReplay(fnName, cap = 50) {
      const disp = _getDispatcher(_ctx(), fnName);
      disp.__replayCapture = true;
      disp.__replayCap     = cap;
    },
    modList()     { return Object.keys(_patches); },
    propWatchers(obj) {
      const map = _propDisp.get(obj);
      if (!map) return {};
      const out = {};
      for (const [prop, disp] of Object.entries(map)) {
        out[prop] = disp.hooks.map(h => ({ modId: h.modId, priority: h.priority }));
      }
      return out;
    }
  };

  // ═══════════════════════════════════════════════════
  //  § 11  Public API 聚合
  // ═══════════════════════════════════════════════════

  const api = {
    // ── 函数钩子（全局） ──
    wrap:    (n, w, modId, pri=0, opts)  => _doWrap(_ctx(), n, 'around',  w, modId, pri, opts),
    around:  (n, w, modId, pri=0, opts)  => _doWrap(_ctx(), n, 'around',  w, modId, pri, opts),
    before:  (n, fn,modId, pri=0, opts)  => _doWrap(_ctx(), n, 'before', fn, modId, pri, opts),
    after:   (n, fn,modId, pri=0, opts)  => _doWrap(_ctx(), n, 'after',  fn, modId, pri, opts),
    replace: (n, fn,modId, pri=0, opts)  => _doWrap(_ctx(), n, 'replace',fn, modId, pri, opts),
    tap:     (n, fn,modId, pri=0, opts)  => _doWrap(_ctx(), n, 'tap',    fn, modId, pri, opts),

    // ── 函数钩子（方法） ──
    wrapMethod:    (o,k,w, modId,pri=0,opts) => _doWrap(o, k, 'around',  w, modId, pri, opts),
    beforeMethod:  (o,k,fn,modId,pri=0,opts) => _doWrap(o, k, 'before', fn, modId, pri, opts),
    afterMethod:   (o,k,fn,modId,pri=0,opts) => _doWrap(o, k, 'after',  fn, modId, pri, opts),
    replaceMethod: (o,k,fn,modId,pri=0,opts) => _doWrap(o, k, 'replace',fn, modId, pri, opts),
    tapMethod:     (o,k,fn,modId,pri=0,opts) => _doWrap(o, k, 'tap',    fn, modId, pri, opts),

    // 精准 revert（单个钩子）
    revertHook:   _revertHook,
    revertByTag:  _revertByTag,
    revertAll:    _revertAll,
    list: (modId) => (_patches[modId] || []).map(p => p.key),

    // ── 属性监控 ──
    watch(obj, prop, callbacks, modId, priority = 0) {
      if (!isObj(obj) && !isFunc(obj)) { _warn(`watch: target not object`); return false; }
      const sk = _slotKey(obj, prop) + '(prop)';
      const disp = _getPropDispatcher(obj, prop);
      const hookId = uid();
      disp.hooks.push({ id: hookId, cb: callbacks, modId, priority });
      disp.hooks.sort((a, b) => b.priority - a.priority);
      _audit('watchAdd', { sk, modId, hookId });
      _addRecord(modId, { target: obj, key: prop, id: hookId, slotKey: sk, isFunc: false });
      return hookId;
    },

    // 属性 Schema 约束
    schema(obj, prop, schemaObj, modId) {
      const disp = _getPropDispatcher(obj, prop);
      disp.schema = schemaObj;
      _addRecord(modId, { target: obj, key: prop, id: uid(), slotKey: _slotKey(obj, prop), isFunc: false });
      _audit('schemaSet', { prop, modId });
    },

    // 属性冻结（禁写）
    freeze(obj, prop, modId) {
      const disp = _getPropDispatcher(obj, prop);
      disp.frozen = true;
      _audit('freeze', { prop, modId });
    },
    unfreeze(obj, prop) {
      const map = _propDisp.get(obj);
      if (map?.[prop]) map[prop].frozen = false;
    },

    // 属性变更订阅（无需注册 watch，轻量监听）
    onChange(obj, prop, handler, modId) {
      const disp = _getPropDispatcher(obj, prop);
      (disp._changeSubs = disp._changeSubs || []).push({ fn: handler, modId });
      _addRecord(modId, { target: obj, key: prop, id: uid(), slotKey: _slotKey(obj, prop), isFunc: false });
    },

    // 计算属性
    computed(obj, prop, computeFn, depProps, modId) {
      _computed(obj, prop, computeFn, depProps, modId);
    },

    // 属性镜像（单向同步 src.key → dst.key）
    mirror(srcObj, srcKey, dstObj, dstKey, modId) {
      return api.onChange(srcObj, srcKey, (val) => {
        try { dstObj[dstKey] = val; } catch(_) {}
      }, modId);
    },

    // ── 跨 Mod 互操作 ──
    signal: {
      emit: (name, data, modId)           => _emit(name, data, modId),
      on:   (name, handler, modId)        => _on(name, handler, modId, false),
      once: (name, handler, modId)        => _on(name, handler, modId, true),
      off:  (name, id)                    => _off(name, id),
    },
    store: {
      get:      (ns, key, def)        => _store.get(ns, key, def),
      set:      (ns, key, val, modId) => _store.set(ns, key, val, modId),
      delete:   (ns, key, modId)      => _store.delete(ns, key, modId),
      watch:    (ns, key, fn, modId)  => _store.watch(ns, key, fn, modId),
      snapshot: (ns)                  => _store.snapshot(ns),
    },
    negotiate: {
      declare:    (modId, ...caps)    => _registerCap(modId, ...caps),
      has:        (modId, cap)        => _hasCap(modId, cap),
      allWith:    (cap)               => _allModsWith(cap),
      depends:    (modId, ...deps)    => _declareDep(modId, ...deps),
      depsReady:  (modId)             => _depsReady(modId),
    },

    // ── 调试 / 诊断 ──
    diagnostics: Diagnostics,
    layers: (fn) => Diagnostics.layerReport(fn),

    // ── 系统级渗透 ──
    sys: {
      timer: {
        before: (m, fn, modId, pri=0, opts) => api.beforeMethod(_ctx(),                m, fn, modId, pri, opts),
        after:  (m, fn, modId, pri=0, opts) => api.afterMethod(_ctx(),                 m, fn, modId, pri, opts),
        wrap:   (m, fn, modId, pri=0, opts) => api.wrapMethod(_ctx(),                  m, fn, modId, pri, opts),
        tap:    (m, fn, modId, pri=0, opts) => api.tapMethod(_ctx(),                   m, fn, modId, pri, opts),
      },
      event: {
        before: (m, fn, modId, pri=0, opts) => api.beforeMethod(EventTarget.prototype, m, fn, modId, pri, opts),
        after:  (m, fn, modId, pri=0, opts) => api.afterMethod(EventTarget.prototype,  m, fn, modId, pri, opts),
        wrap:   (m, fn, modId, pri=0, opts) => api.wrapMethod(EventTarget.prototype,   m, fn, modId, pri, opts),
        tap:    (m, fn, modId, pri=0, opts) => api.tapMethod(EventTarget.prototype,    m, fn, modId, pri, opts),
      },
      dom: {
        _t: m => (['createElement','getElementById','querySelector','querySelectorAll','createElementNS']
          .includes(m) ? Document.prototype : Node.prototype),
        before: (m, fn, modId, pri=0, opts) => api.beforeMethod(api.sys.dom._t(m),    m, fn, modId, pri, opts),
        after:  (m, fn, modId, pri=0, opts) => api.afterMethod(api.sys.dom._t(m),     m, fn, modId, pri, opts),
        wrap:   (m, fn, modId, pri=0, opts) => api.wrapMethod(api.sys.dom._t(m),      m, fn, modId, pri, opts),
        tap:    (m, fn, modId, pri=0, opts) => api.tapMethod(api.sys.dom._t(m),       m, fn, modId, pri, opts),
      },
      fetch: {
        wrap:   (fn, modId, pri=0, opts) => api.wrapMethod(_ctx(),   'fetch',    fn, modId, pri, opts),
        before: (fn, modId, pri=0, opts) => api.beforeMethod(_ctx(), 'fetch',    fn, modId, pri, opts),
        after:  (fn, modId, pri=0, opts) => api.afterMethod(_ctx(),  'fetch',    fn, modId, pri, opts),
      },
      xhr: {
        wrap:   (method, fn, modId, pri=0, opts) => api.wrapMethod(XMLHttpRequest.prototype,   method, fn, modId, pri, opts),
        before: (method, fn, modId, pri=0, opts) => api.beforeMethod(XMLHttpRequest.prototype, method, fn, modId, pri, opts),
        after:  (method, fn, modId, pri=0, opts) => api.afterMethod(XMLHttpRequest.prototype,  method, fn, modId, pri, opts),
      },
      storage: {
        wrap:   (method, fn, modId, pri=0, opts) => api.wrapMethod(localStorage,   method, fn, modId, pri, opts),
        before: (method, fn, modId, pri=0, opts) => api.beforeMethod(localStorage, method, fn, modId, pri, opts),
        after:  (method, fn, modId, pri=0, opts) => api.afterMethod(localStorage,  method, fn, modId, pri, opts),
      },
      mutation: {
        observe(fn, modId) {
          _ensureMutObs();
          const id = uid();
          _domWatchers.push({ id, fn, modId });
          _addRecord(modId, { isMutation: true, id, slotKey: 'mutation' });
          return id;
        },
        unobserve(id) {
          const i = _domWatchers.findIndex(w => w.id === id);
          if (i >= 0) _domWatchers.splice(i, 1);
        }
      },
      // 控制台拦截（反调试、日志审计）
      console: {
        wrap:   (method, fn, modId, pri=0) => api.wrapMethod(console,   method, fn, modId, pri),
        before: (method, fn, modId, pri=0) => api.beforeMethod(console, method, fn, modId, pri),
        after:  (method, fn, modId, pri=0) => api.afterMethod(console,  method, fn, modId, pri),
      }
    }
  };

  return api;
})();

/* ═══════════════════════════════════════════════════════════════════════
   7. SHARED STORE
   ═══════════════════════════════════════════════════════════════════════ */
const SharedStore = (() => {
  const _data  = {};
  const _watch = {};
  function _fqk(ns, key) { return `${ns}:${key}`; }
  return {
    set(namespace, key, value) {
      const fqk = _fqk(namespace, key);
      const old = _data[fqk];
      _data[fqk] = value;
      for (const w of (_watch[fqk] || []))
        try { w.fn(value, old, key, namespace); } catch(_) {}
    },
    get(namespace, key)          { return _data[_fqk(namespace, key)]; },
    getOr(namespace, key, def)   { const v = this.get(namespace, key); return v !== undefined ? v : def; },
    update(namespace, key, fn, defaultVal = undefined) {
      this.set(namespace, key, fn(this.getOr(namespace, key, defaultVal)));
    },
    watch(namespace, key, fn, modId = '_system') {
      const fqk = _fqk(namespace, key);
      (_watch[fqk] = _watch[fqk] || []).push({ fn, modId });
    },
    unwatchAll(modId) {
      for (const arr of Object.values(_watch))
        arr.splice(0, arr.length, ...arr.filter(w => w.modId !== modId));
    },
    keys(namespace) {
      const prefix = namespace + ':';
      return Object.keys(_data).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    },
    dump() { return { ..._data }; },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   8. SERVICE REGISTRY
   ═══════════════════════════════════════════════════════════════════════ */
const ServiceRegistry = (() => {
  const _services = new Map();
  return {
    provide(name, impl, modId, version = '1.0') {
      if (_services.has(name)) {
        const e = _services.get(name);
        if (e.modId !== modId) _warn(`ServiceRegistry: "${name}" overriding provider "${e.modId}".`);
      }
      _services.set(name, { modId, impl, version });
      EventBus.emit('forge:serviceRegistered', name, modId);
    },
    lookup(name) { const s = _services.get(name); return s ? s.impl : null; },
    require(name, requirer = '?') {
      const impl = this.lookup(name);
      if (impl == null) throw new Error(`[${requirer}] Required service "${name}" not available.`);
      return impl;
    },
    revokeAll(modId) {
      for (const [name, svc] of _services)
        if (svc.modId === modId) _services.delete(name);
    },
    list() {
      return [..._services.entries()].map(([name, s]) => ({ name, modId: s.modId, version: s.version }));
    },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   9. MIDDLEWARE PIPELINE
   ═══════════════════════════════════════════════════════════════════════ */
const Pipelines = (() => {
  const _pipes = new Map();
  class Pipeline {
    constructor(name) { this.name = name; this._stack = []; }
    use(fn, modId = '_system', priority = 0) {
      this._stack.push({ fn, modId, priority });
      this._stack.sort((a,b) => b.priority - a.priority);
      return this;
    }
    removeByMod(modId) { this._stack = this._stack.filter(m => m.modId !== modId); }
    run(ctx = {}) {
      let i = 0;
      const stack = this._stack;
      function next() {
        if (i >= stack.length) return;
        const m = stack[i++];
        try { m.fn(ctx, next); }
        catch(e) { _pushLog('error', `Pipeline "${stack.name ?? '?'}": ${e.message}`); next(); }
      }
      next();
      return ctx;
    }
  }
  return {
    get(name) { if (!_pipes.has(name)) _pipes.set(name, new Pipeline(name)); return _pipes.get(name); },
    list() { return [..._pipes.keys()]; },
    removeModFromAll(modId) { for (const p of _pipes.values()) p.removeByMod(modId); },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   10. RENDER PIPELINE  (canvas pre/post draw hooks, merged with step hook)
   ═══════════════════════════════════════════════════════════════════════ */
const RenderPipeline = (() => {
  const _hooks = { pre: [], post: [] };
  const _canGuardCtx = (ctx) => !!(ctx && typeof ctx.save === 'function' && typeof ctx.restore === 'function');

  function _addHook(phase, fn, modId, priority = 0) {
    if (!_hooks[phase]) { _warn(`RenderPipeline: unknown phase "${phase}".`); return; }
    _hooks[phase].push({ fn, modId, priority });
    _hooks[phase].sort((a,b) => b.priority - a.priority);
  }

  return {
    pre  (fn, modId, priority = 0)  { _addHook('pre',  fn, modId, priority); },
    post (fn, modId, priority = 0)  { _addHook('post', fn, modId, priority); },
    hud  (fn, modId, priority = 0)  { _addHook('post', fn, modId, priority); },
    _firePre()  { this._fire('pre');  },
    _firePost() { this._fire('post'); },
    _fire(phase) {
      const gc = _g('ctx');
      if (!gc) return;
      const W  = _g('W') || 0;
      const H  = _g('H') || 0;
      const game = _g('Game');
      const payload = { ctx: gc, g: gc, W, H, game, time: game?.time || 0 };
      for (const h of _hooks[phase]) {
        const guarded = _canGuardCtx(gc);
        if (guarded) { try { gc.save(); } catch(_) {} }
        try {
          h.fn(payload);
        } catch(e1) {
          const msg = String(e1?.message || e1 || '');
          if (/is not a function/.test(msg)) {
            try { h.fn(gc, payload); }
            catch(e2) { _pushLog('error', `RenderPipeline[${phase}] ${h.modId}: ${e2.message}`); }
          } else {
            _pushLog('error', `RenderPipeline[${phase}] ${h.modId}: ${msg}`);
          }
        } finally {
          if (guarded) { try { gc.restore(); } catch(_) {} }
        }
      }
    },
    removeByMod(modId) {
      for (const arr of Object.values(_hooks))
        arr.splice(0, arr.length, ...arr.filter(h => h.modId !== modId));
    },
    status() { return { pre: _hooks.pre.length, post: _hooks.post.length }; },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   11. INPUT ROUTER
   ═══════════════════════════════════════════════════════════════════════ */
const InputRouter = (() => {
  const _binds = new Map();
  let _attached = false;
  function _onKey(e) {
    const k = e.code || e.key;
    const list = _binds.get(k) || [];
    const toRemove = [];
    for (const b of list) {
      try { b.fn(e); } catch(err) { _pushLog('error', `InputRouter [${b.modId}]: ${err.message}`); }
      if (b.once) toRemove.push(b);
    }
    if (toRemove.length) _binds.set(k, list.filter(b => !toRemove.includes(b)));
  }
  function _ensureAttached() {
    if (_attached) return;
    const doc = GlobalResolver.getContext().document || document;
    doc.addEventListener('keydown', _onKey, false);
    _attached = true;
  }
  return {
    bind(key, fn, modId = '_system', once = false) {
      _ensureAttached();
      const list = _binds.get(key) || [];
      list.push({ fn, modId, once });
      _binds.set(key, list);
    },
    bindOnce(key, fn, modId = '_system') { this.bind(key, fn, modId, true); },
    unbind(key, fn) {
      const list = _binds.get(key);
      if (list) _binds.set(key, list.filter(b => b.fn !== fn));
    },
    unbindAll(modId) {
      for (const [k, arr] of _binds) _binds.set(k, arr.filter(b => b.modId !== modId));
    },
    list() { const out = {}; for (const [k, arr] of _binds) out[k] = arr.map(b => b.modId); return out; },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   12. SCHEDULER
   ═══════════════════════════════════════════════════════════════════════ */
const Scheduler = (() => {
  const _jobs = [];
  EventBus.on('forge:tick', (dt) => {
    const wave = _g('Game')?.wave || 0;
    const toRemove = [];
    for (const job of _jobs) {
      try {
        if (job.type === 'delay') {
          job._acc = (job._acc || 0) + dt;
          if (job._acc >= job.delay) {
            job.fn();
            if (!job.repeat) toRemove.push(job.id);
            else job._acc = 0;
          }
        } else if (job.type === 'wave') {
          if (wave >= job.wave && !job._fired) { job.fn(); job._fired = true; toRemove.push(job.id); }
        }
      } catch(e) { _pushLog('error', `Scheduler[${job.id}]: ${e.message}`); toRemove.push(job.id); }
    }
    for (const id of toRemove) {
      const i = _jobs.findIndex(j => j.id === id);
      if (i >= 0) _jobs.splice(i, 1);
    }
  }, '_scheduler');
  return {
    after(fn, seconds, modId = '_system') {
      const id = uid();
      _jobs.push({ id, modId, type: 'delay', fn, delay: seconds, repeat: false, _acc: 0 });
      return id;
    },
    every(fn, seconds, modId = '_system') {
      const id = uid();
      _jobs.push({ id, modId, type: 'delay', fn, delay: seconds, repeat: true, _acc: 0 });
      return id;
    },
    onWave(fn, wave, modId = '_system') {
      const id = uid();
      _jobs.push({ id, modId, type: 'wave', fn, wave, _fired: false });
      return id;
    },
    cancel(id) { const i = _jobs.findIndex(j => j.id === id); if (i >= 0) _jobs.splice(i, 1); },
    cancelAll(modId) { _jobs.splice(0, _jobs.length, ..._jobs.filter(j => j.modId !== modId)); },
    list(modId) { return _jobs.filter(j => !modId || j.modId === modId).map(j => ({ id: j.id, type: j.type, modId: j.modId })); },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   13. REGISTRY (Hyper-Resilient Pipeline Edition)
   ═══════════════════════════════════════════════════════════════════════ */
const Registry = (() => {
  const owned = {};
  let _uiRefreshers = null;

  // Edit Pipeline 状态存储
  const _baseValues = new Map(); // key: "Catalog::Key" -> 原始值的深拷贝
  const _editChains = new Map(); // key: "Catalog::Key" -> [{ id, modId, fn, priority }]

  const _fqk = (cat, key) => `${cat}::${key}`;

  // 深度克隆（支持普通对象/数组，函数保持引用）
  function _cloneDeep(item) {
    if (typeof item === 'function') return item;
    if (Array.isArray(item)) return item.map(_cloneDeep);
    if (item !== null && typeof item === 'object') {
      const res = {};
      for (const k in item) res[k] = _cloneDeep(item[k]);
      return res;
    }
    return item;
  }

  function track(modId, undoFn) {
    (owned[modId] = owned[modId] ||[]).push(undoFn);
  }

  // ─── 动态重建 Edited Item ───
  function _rebuildEditedItem(catalogName, entryKey) {
    const catalog = _g(catalogName);
    if (!catalog) return;
    
    const fqk = _fqk(catalogName, entryKey);
    const baseVal = _baseValues.get(fqk);
    const chain = _editChains.get(fqk) ||[];

    // 如果基准值不存在（可能是该项目被原 Mod 卸载了），则挂起等待
    if (baseVal === undefined) return;

    if (chain.length === 0) {
      // 没有任何 Edit 挂载，直接还原为基准值
      catalog[entryKey] = _cloneDeep(baseVal);
      _baseValues.delete(fqk);
      _editChains.delete(fqk);
    } else {
      // 穿过修改管线 (按优先级从高到低)
      let currentVal = _cloneDeep(baseVal);
      for (const edit of chain) {
        try {
          const res = edit.fn(currentVal);
          // 如果修改器没有返回值，假定它在原地修改了 currentVal (如直接 push 数组)
          if (res !== undefined) currentVal = res;
        } catch (e) {
          _error(`Registry edit error [${edit.modId}] on ${fqk}: ${e.message}`);
        }
      }
      catalog[entryKey] = currentVal;
    }
    _notify(catalogName, entryKey);
  }

  function _removeEdit(catalogName, entryKey, editId) {
    const fqk = _fqk(catalogName, entryKey);
    const chain = _editChains.get(fqk);
    if (chain) {
      const newChain = chain.filter(e => e.id !== editId);
      _editChains.set(fqk, newChain);
      _rebuildEditedItem(catalogName, entryKey);
    }
  }

  function _notify(catalogType, key) {
    EventBus.emit('registry:updated', { catalog: catalogType, key });
    if (_uiRefreshers && typeof _uiRefreshers.refreshAll === 'function') {
      _uiRefreshers.refreshAll(catalogType, key);
    }
  }

  // ─── 基础写入 (Add / Overwrite) ───
  function put(catalogKey, entryKey, def, modId, catalogName = '') {
    const catalog = isStr(catalogKey) ? _g(catalogKey) : catalogKey;
    const cName = catalogName || (isStr(catalogKey) ? catalogKey : 'custom');
    if (!catalog) { _warn(`Registry: catalog "${cName}" unavailable`); return null; }

    const fqk = _fqk(cName, entryKey);
    const hasOrig = (entryKey in catalog);
    const orig = catalog[entryKey];

    // 写入新值
    catalog[entryKey] = def;

    // 如果此项正在被 Edit 管线接管，更新其基准值并立即触发重建
    if (_editChains.has(fqk)) {
      _baseValues.set(fqk, _cloneDeep(def));
      _rebuildEditedItem(cName, entryKey);
    }

    if (modId) {
      track(modId, () => {
        if (hasOrig) {
          catalog[entryKey] = orig;
          if (_editChains.has(fqk)) {
            _baseValues.set(fqk, _cloneDeep(orig));
            _rebuildEditedItem(cName, entryKey);
          }
        } else {
          delete catalog[entryKey];
          _baseValues.delete(fqk);
          // 保留 _editChains！这样如果依赖 Mod 重载，Edit 还能自动接驳上
        }
        _notify(cName, entryKey);
      });
    }

    if (!_editChains.has(fqk)) _notify(cName, entryKey);
    return entryKey;
  }

  return {
    setUIRefreshers(refreshers) { _uiRefreshers = refreshers; },

    // ── 核心暴露 ──
    affix(k,d,mid)   { return put('BulletAffixCatalog', k,d,mid,'BulletAffixCatalog'); },
    trait(k,d,mid)   { return put('EnemyTraitCatalog',  k,d,mid,'EnemyTraitCatalog'); },
    
    move(k,f,mid)    { return put('MoveCatalog',        k,f,mid,'MoveCatalog'); },
    upgrade(k,d,mid) { return put('UpgradePool',        k,d,mid,'UpgradePool'); },

    // 扩展 wrapper: 直接支持携带 UI fields
    wrapper(k, f, fields, mid) {
      if (fields && _g('WrapperFieldDefs')) {
        const defs = _g('WrapperFieldDefs');
        const orig = defs[k];
        defs[k] = fields;
        if (mid) track(mid, () => {
          if (orig) defs[k] = orig; else delete defs[k];
        });
        _notify('WrapperFieldDefs', k);
      }
      return put('CompositeWrappers', k, f, mid, 'CompositeWrappers');
    },


    emitter(k, f, mid) {
      // 1. 自动给 Player 阵营（Workshop Tab）也注册一份
      put('PlayerEmitterCatalog', k, f, mid, 'PlayerEmitterCatalog');
      // 2. 给敌方/Forge 阵营注册
      return put('EmitterCatalog', k, f, mid, 'EmitterCatalog');
    },

    // ✨ 核心扩展：多Mod协同编辑管线 ✨
    edit(catalogKey, entryKey, modifierFn, modId, priority = 0) {

      if (catalogKey === 'EmitterCatalog' && _g('PlayerEmitterCatalog')) {
        this.edit('PlayerEmitterCatalog', entryKey, modifierFn, modId, priority);
      }

      const catalog = isStr(catalogKey) ? _g(catalogKey) : catalogKey;
      const cName = isStr(catalogKey) ? catalogKey : 'custom';
      
      if (!catalog || !(entryKey in catalog)) {
        _warn(`Registry.edit: [${cName}] "${entryKey}" not found. Ensure dependencies are loaded.`);
        return null;
      }

      const fqk = _fqk(cName, entryKey);

      // 初次 Edit 封存基准值
      if (!_baseValues.has(fqk)) {
        _baseValues.set(fqk, _cloneDeep(catalog[entryKey]));
      }

      if (!_editChains.has(fqk)) _editChains.set(fqk,[]);
      const chain = _editChains.get(fqk);
      const editId = uid();
      
      chain.push({ id: editId, modId, fn: modifierFn, priority });
      chain.sort((a, b) => b.priority - a.priority); // 优先级高的在前

      // 立刻重建
      _rebuildEditedItem(cName, entryKey);

      // 注册卸载回滚
      if (modId) {
        track(modId, () => _removeEdit(cName, entryKey, editId));
      }
      return editId;
    },

bodyKind(key, drawFn, modId) {
      if (!GlobalResolver.getContext()._NEP_CUSTOM_BODY_KINDS)
        GlobalResolver.getContext()._NEP_CUSTOM_BODY_KINDS = {};
      _g('_NEP_CUSTOM_BODY_KINDS')[key] = drawFn;
      const bk = _g('BODY_KINDS');
      if (Array.isArray(bk) && !bk.includes(key)) bk.push(key);
      if (modId) track(modId, null, key, () => {
        delete (_g('_NEP_CUSTOM_BODY_KINDS') || {})[key];
        const i = (_g('BODY_KINDS') || []).indexOf(key);
        if (i >= 0) _g('BODY_KINDS').splice(i, 1);
      });
      _notify('BODY_KINDS', key);
    },
    
    structure(key, def, modId) {
      const cat = _g('Fortress')?.catalog;
      if (!cat) { _warn('Registry: Fortress.catalog unavailable'); return; }
      cat[key] = def;
      if (def.behavior && _g('Fortress')?.behaviors)
        _g('Fortress').behaviors[key] = def.behavior;
      if (modId) track(modId, cat, key, () => {
        delete cat[key];
        const beh = _g('Fortress')?.behaviors;
        if (beh) delete beh[key];
      });
      _notify('FortressCatalog', key);
      // 动态添加建造按钮
      _addFortressBuildButton(key, def);
    },
    
    wavePattern(key, def, modId) {
      if (!GlobalResolver.getContext()._NEP_WAVE_PATTERNS)
        GlobalResolver.getContext()._NEP_WAVE_PATTERNS = {};
      _g('_NEP_WAVE_PATTERNS')[key] = def;
      if (modId) track(modId, null, key, () => { delete (_g('_NEP_WAVE_PATTERNS') || {})[key]; });
      _notify('WavePattern', key);
    },

    /**
     * 注册自定义敌人外观。
     * @param {string}   key    外观唯一 ID（会出现在 Forge bodyKind 下拉框）
     * @param {object}   config
     *   {function} draw(ctx, e, body, col, R0, rot, time) – 绘制函数（必须）
     *   {string}   label   – 可读名称（可选）
     *   {string[]} tags    – 分类标签（可选）
     *   {function} preview(ctx, size) – 缩略图绘制（可选）
     * @param {string}   modId
     */
    appearance(key, config, modId) {
      if (typeof key !== 'string' || !key)
        return _warn('Registry.appearance: key (string) required');
      if (!isFunc(config?.draw))
        return _warn(`Registry.appearance: config.draw (function) required for "${key}"`);

      // 初始化 AppearanceCatalog
      const ctx = GlobalResolver.getContext();
      if (!ctx._NEP_APPEARANCE_CATALOG) ctx._NEP_APPEARANCE_CATALOG = {};
      ctx._NEP_APPEARANCE_CATALOG[key] = config;

      // 挂载到 _NEP_CUSTOM_BODY_KINDS（供 drawEnemyGenericBody patch 调用）
      if (!ctx._NEP_CUSTOM_BODY_KINDS) ctx._NEP_CUSTOM_BODY_KINDS = {};
      ctx._NEP_CUSTOM_BODY_KINDS[key] = (args) => {
        try { config.draw(args.g, args.e, args.b, args.col, args.R0, args.rot, args.time); }
        catch(e) { /* 单次绘制失败不应崩溃 */ }
      };

      // 添加到 BODY_KINDS 数组（用于随机化 & forge 下拉）
      const bk = _g('BODY_KINDS');
      if (Array.isArray(bk) && !bk.includes(key)) bk.push(key);

      if (modId) track(modId, null, key, () => {
        delete (GlobalResolver.getContext()._NEP_APPEARANCE_CATALOG || {})[key];
        delete (GlobalResolver.getContext()._NEP_CUSTOM_BODY_KINDS  || {})[key];
        const arr = _g('BODY_KINDS');
        if (Array.isArray(arr)) {
          const i = arr.indexOf(key);
          if (i >= 0) arr.splice(i, 1);
        }
      });

      _notify('AppearanceCatalog', key);
      return key;
    },

    
    into(catalog, key, def, modId) { return put(catalog, key, def, modId, '(custom)'); },

    unregisterAll(modId) {
      for (const undoFn of (owned[modId] ||[])) {
        try { undoFn(); } catch(e) { _warn(`Registry undo error: ${e.message}`); }
      }
      delete owned[modId];
    },

    snapshot() {
      return {
        affixes:     Object.keys(_g('BulletAffixCatalog') || {}),
        traits:      Object.keys(_g('EnemyTraitCatalog') || {}),
        emitters:    Object.keys(_g('EmitterCatalog') || {}),
        wrappers:    Object.keys(_g('CompositeWrappers') || {}),
        fields:      Object.keys(_g('WrapperFieldDefs') || {}),
        moves:       Object.keys(_g('MoveCatalog') || {}),
        bodies:      _g('BODY_KINDS') ||[],
        structures:  Object.keys(_g('Fortress')?.catalog || {}),
        waves:       Object.keys(_g('_NEP_WAVE_PATTERNS') || {}),
        upgrades:    Object.keys(_g('UpgradePool') || {}),
      };
    },
  };
})();

// 辅助：向 Fortress 建造滚动条添加按钮
function _addFortressBuildButton(key, def) {
  const scroller = document.getElementById('fortressBuildScroller');
  if (!scroller) return;
  // 避免重复添加
  if (scroller.querySelector(`[data-item="${key}"]`)) return;
  
  const btn = document.createElement('button');
  btn.id = `btnFort${key.charAt(0).toUpperCase() + key.slice(1)}`;
  btn.dataset.item = key;
  btn.className = 'mini-btn';
  btn.textContent = `${def.name || key} ${def.cost || ''}`;
  btn.style.borderColor = def.color || '#aaa';
  btn.style.color = def.color || '#fff';
  
  btn.addEventListener('click', () => {
    if (typeof Fortress !== 'undefined' && Fortress.select) {
      Fortress.select(key);
    }
  });
  
  scroller.appendChild(btn);
}

/* ═══════════════════════════════════════════════════════════════════════
   14. GAME API
   ═══════════════════════════════════════════════════════════════════════ */
const GameAPI = {
  get state()      { return _g('Game')?.state; },
  get wave()       { return _g('Game')?.wave; },
  get time()       { return _g('Game')?.time; },
  get mode()       { return _g('Game')?.mode; },
  get difficulty() { return _g('Game')?.difficulty; },
  get W()          { return _g('W') || GlobalResolver.getContext().innerWidth  || 400; },
  get H()          { return _g('H') || GlobalResolver.getContext().innerHeight || 600; },
  get ctx()        { return _g('ctx'); },
  get score()      { return _g('Game')?.score; },

  get enemies()  { return _g('enemies')  || []; },
  get bulletsP() { return _g('bulletsP') || []; },
  get bulletsE() { return _g('bulletsE') || []; },
  get beams()    { return _g('beams')    || []; },

  spawnBullet:    (...a) => safeCall(_g('spawnBullet'),    a,  'spawnBullet'),
  spawnEnemy:     (spec) => safeCall(_g('spawnForgeEnemy'),[spec],'spawnForgeEnemy'),
  spawnShockwave: (...a) => safeCall(_g('spawnShockwave'), a,  'spawnShockwave'),
  spawnBeam:      (...a) => safeCall(_g('spawnBeam'),      a,  'spawnBeam'),
  textPop:        (...a) => safeCall(_g('textPop'),        a,  'textPop'),
  sparks:         (...a) => safeCall(_g('sparks'),         a,  'sparks'),

  baseEnemy:        (...a) => safeCall(_g('baseEnemy'),        a, 'baseEnemy'),
  findNearestEnemy: (...a) => safeCall(_g('findNearestEnemy'), a, 'findNearestEnemy'),
  applyTraits:      (e,k,d)=> safeCall(_g('applyEnemyTraits'),[e,k,d], 'applyEnemyTraits'),

  /**
   * nextWave / beginFortify – mapped to Fortress (WaveTimer does not exist;
   * WaveTimer is now a transparent shim over Fortress).
   */
  nextWave()     { return safeCall(_g('Fortress')?.beginAssault?.bind(_g('Fortress')), [], 'Fortress.beginAssault'); },
  beginFortify() { return safeCall(_g('Fortress')?.beginFortify?.bind(_g('Fortress')), [], 'Fortress.beginFortify'); },

  spawnWavePattern(key, opts = {}) {
    const pat = _g('_NEP_WAVE_PATTERNS')?.[key];
    if (!pat) { _warn(`Wave pattern "${key}" not registered`); return; }
    safeCall(pat.spawn, [{ ...opts, game: GameAPI, wave: _g('Game')?.wave || 1 }], `wavePattern.${key}`);
  },

  setPaused(v) { const g = _g('Game'); if (g) g.state = v ? 'paused' : 'playing'; },
  get _context() { return GlobalResolver.getContext(); },
};

/* ═══════════════════════════════════════════════════════════════════════
   15. PLAYER API
   ═══════════════════════════════════════════════════════════════════════ */
const PlayerAPI = {
  get alive()    { return _g('Player')?.alive; },
  get hp()       { return _g('Player')?.hp; },
  get maxHp()    { return _g('Player')?.maxHp; },
  get shield()   { return _g('Player')?.shield; },
  get lv()       { return _g('Player')?.lv; },
  get score()    { return _g('Player')?.score; },
  get gunMods()  { return _g('Player')?.gunMods  || []; },
  get emitters() { return _g('Player')?.emitters || []; },
  get x()        { return _g('Player')?.x; },
  get y()        { return _g('Player')?.y; },

  getStat: key => _g('Player')?.[key],
  setStat: (key,val) => { const p = _g('Player'); if (p) p[key] = val; },
  modStat: (key,fn)  => { const p = _g('Player'); if (p && key in p) p[key] = fn(p[key]); },

  addGunMod(key) {
    const p = _g('Player');
    if (!p || !Array.isArray(p.gunMods)) return;
    if (!p.gunMods.includes(key) && p.gunMods.length < (p.gunModsMax || 6)) p.gunMods.push(key);
  },
  removeGunMod(key) { const p = _g('Player'); if (p?.gunMods) p.gunMods = p.gunMods.filter(k => k !== key); },

  addEmitter(inst) {
    const p = _g('Player');
    if (p?.emitters && p.emitters.length < (p.emittersMax || 3)) p.emitters.push(inst);
  },
  removeEmitter(idx) { _g('Player')?.emitters?.splice(idx, 1); },

  heal(amount)   { const p = _g('Player'); if (p) p.hp = Math.min(p.maxHp, p.hp + amount); },
  damage(amount) { safeCall(_g('Player')?.onHit?.bind(_g('Player')), [amount], 'Player.onHit'); },
  invuln(t)      { const p = _g('Player'); if (p) p.invuln = Math.max(p.invuln || 0, t); },

  snapshot() {
    const p = _g('Player');
    return !p ? null : { hp:p.hp, maxHp:p.maxHp, shield:p.shield, lv:p.lv, score:p.score,
      gunMods:[...(p.gunMods||[])], emitters:(p.emitters||[]).length, x:p.x, y:p.y };
  },
};

/* ═══════════════════════════════════════════════════════════════════════
   16. FORTRESS API
   ═══════════════════════════════════════════════════════════════════════ */
const FortressAPI = {
  get structures() { return _g('Fortress')?.structures || []; },
  get stock()      { return _g('Fortress')?.stock; },
  get flagHp()     { return _g('Fortress')?.flagHp; },
  /** phase is on Fortress directly (WaveTimer was a misnomer in v3) */
  get phase()      { return _g('Fortress')?.phase; },

  addStock(n)  { const f = _g('Fortress'); if (f) f.stock = (f.stock||0)+n; },
  healFlag(n)  { const f = _g('Fortress'); if (f) f.flagHp = Math.min(f.flagMaxHp||3000,(f.flagHp||0)+n); },

  place(type, x, y, rot = 0) {
    const f = _g('Fortress');
    if (!f) return null;
    const cfg = f.catalog?.[type];
    if (!cfg) { _warn(`FortressAPI: unknown type "${type}"`); return null; }
    const id = (f.sid = (f.sid||0)+1);
    const st = { id, x, y, w:cfg.w||40, h:cfg.h||20, hp:cfg.hp||200, maxHp:cfg.hp||200,
                 col:cfg.col||'#52E6FF', type, rot, cd:cfg.cd||0, cost:cfg.cost||0 };
    safeCall(f.getBehavior?.(type)?.onCreate, [st,{fortress:f}], `structure.${type}.onCreate`);
    f.structures.push(st);
    return st;
  },

  removeByType(type) {
    const f = _g('Fortress');
    if (f) f.structures = f.structures.filter(s => s.type !== type);
  },

  registerStructure(key, def, modId) { Registry.structure(key, def, modId); },
  listCatalog() { return Object.keys(_g('Fortress')?.catalog || {}); },

  snapshot() {
    return { stock: _g('Fortress')?.stock, flagHp: _g('Fortress')?.flagHp,
      structures: (_g('Fortress')?.structures||[]).map(s=>({type:s.type,x:s.x,y:s.y,hp:s.hp})) };
  },
};

/* ═══════════════════════════════════════════════════════════════════════
   17. METAMOD SUPPORT
   ═══════════════════════════════════════════════════════════════════════ */
const MetaModRegistry = {
  _metas: [],
  register(modId, fn) { this._metas.push({ modId, fn }); },
  runAll(allModsMap) {
    for (const { modId, fn } of this._metas) {
      safeCall(fn, [{ mods: allModsMap, registry: Registry, game: GameAPI,
                      player: PlayerAPI, store: SharedStore, services: ServiceRegistry }],
               `MetaMod.${modId}`);
      _info(`MetaMod "${modId}" ran`);
    }
  },
  removeByMod(modId) { this._metas = this._metas.filter(m => m.modId !== modId); },
};



/* ═══════════════════════════════════════════════════════════════════════
   18. SHIMS  (compatibility layer for missing game vars)
   ═══════════════════════════════════════════════════════════════════════
   WaveTimer: the game does not have a WaveTimer object; phase management
   lives on Fortress.  We expose window.WaveTimer as a transparent Proxy
   to Fortress so that old mod code referencing WaveTimer continues to work.

   UpgradePool: the game has no built-in UpgradePool; we create an empty
   plain object at window.UpgradePool so Registry.upgrade() and mods that
   write into it have a valid target.
   ═══════════════════════════════════════════════════════════════════════ */
function _createShims() {
  // ── WaveTimer shim ──────────────────────────────────────────────────
  if (!window.WaveTimer) {
    try {
      window.WaveTimer = new Proxy({}, {
        get(_t, prop) {
          const f = _g('Fortress');
          if (!f) return undefined;
          // Method bindings
          if (prop === 'beginAssault') return f.beginAssault?.bind(f);
          if (prop === 'beginFortify') return f.beginFortify?.bind(f);
          // Passthrough all other properties
          const v = f[prop];
          return typeof v === 'function' ? v.bind(f) : v;
        },
        set(_t, prop, value) {
          const f = _g('Fortress');
          if (f) f[prop] = value;
          return true;
        },
        has(_t, prop) { return prop in (_g('Fortress') || {}); },
      });
      _info('WaveTimer shim created (→ Fortress).');
    } catch(e) {
      // Proxy not available – fallback to plain object updated on each wave
      window.WaveTimer = {};
      EventBus.on('wave', () => {
        const f = _g('Fortress');
        if (f) Object.assign(window.WaveTimer, {
          phase:        f.phase,
          beginAssault: f.beginAssault?.bind(f),
          beginFortify: f.beginFortify?.bind(f),
        });
      }, '_shim');
      _warn('WaveTimer shim: Proxy unavailable, using plain-object fallback.');
    }
  }

  // ── UpgradePool shim ─────────────────────────────────────────────────
  if (!window.UpgradePool) {
    window.UpgradePool = {};
    _info('UpgradePool shim created (empty object).');
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   19. GAME LOOP HOOKS (System Layer)
   ═══════════════════════════════════════════════════════════════════════ */
let _hookInjected = false;

function _injectGameHooks() {
  if (_hookInjected) return;
  const ctx = GlobalResolver.getContext();

  function _try(fnName, cb) {
     if (ctx[fnName] != null) cb();
     else setTimeout(() => _try(fnName, cb), 400);
  }

  // 1. QuotaExceeded 崩溃保护：强行兜底 LocalStorage
  PatchMgr.sys.storage.wrap('setItem', (orig, key, val) => {
    try { return orig(key, val); }
    catch(e) {
      if (e.name === 'QuotaExceededError' || e.message.toLowerCase().includes('quota')) {
        _warn(`QuotaExceeded swallowed for key "${key}". Game crash prevented.`);
        return undefined;
      }
      throw e;
    }
  }, '_system', 9999, { breaker: { threshold: Infinity } });

  // 2. 主循环 Hook
  let _lastTs = 0;
  _try('step', () => {
    PatchMgr.wrap('step', (orig, ts) => {
      const dt = clamp((ts - _lastTs) / 1000, 0, 0.1);
      _lastTs = ts;
      RenderPipeline._firePre();
      if (_g('Game')?.state === 'playing') {
        EventBus.emit('forge:tick', dt, ts);
        EventBus.emit('tick', dt, ts);
      }
      EventBus.emit('forge:frame', dt, ts);
      const result = orig(ts);
      RenderPipeline._firePost();
      return result;
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  });

  // 3. 事件派发 Hooks
  _try('spawnBullet', () => {
    PatchMgr.after('spawnBullet', (res, args) => {
      if (res) EventBus.emit('bulletSpawn', res, args[0]);
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  });

  _try('spawnForgeEnemy', () => {
    PatchMgr.after('spawnForgeEnemy', (res, args) => {
      if (res) EventBus.emit('enemySpawn', res, args[0]);
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  });

  const ef = _g('EnemyFactory');
  if (ef && isFunc(ef.spawnFromProto)) {
    PatchMgr.afterMethod(ef, 'spawnFromProto', (res, args) => {
      if (res) EventBus.emit('enemySpawn', res, args[0]);
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  }

  const wd = _g('WaveDirector');
  if (wd && isFunc(wd.onWave)) {
    PatchMgr.afterMethod(wd, 'onWave', (res, args) => {
      const wave = args[0];
      EventBus.emit('wave', wave);
      const pats = _g('_NEP_WAVE_PATTERNS');
      if (pats) {
        for (const pat of Object.values(pats)) {
          if (pat.onWave) safeCall(pat.onWave, [wave, GameAPI], 'wavePattern.onWave');
        }
      }
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  }

  _try('onPlayerHit', () => {
    PatchMgr.wrap('onPlayerHit', (orig, dmg, slow) => {
      const pctx = Pipelines.get('playerDamage').run({ dmg, cancelled: false });
      if (!pctx.cancelled) {
        EventBus.emit('playerHit', pctx.dmg);
        return orig(pctx.dmg, slow);
      }
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  });

  _try('drawEnemyGenericBody', () => {
    PatchMgr.wrap('drawEnemyGenericBody', (orig, g, e, b, col, R0, rot, time) => {
      const customDraw = _g('_NEP_CUSTOM_BODY_KINDS')?.[b?.kind];
      if (customDraw) {
        try { customDraw({ g, e, b, col, R0, rot, time }); return; } catch(_) {}
      }
      return orig(g, e, b, col, R0, rot, time);
    }, '_system', 1000, { breaker: { threshold: Infinity } });
  });

  // 4. UpgradePool 自动挂载 Hook (Player.lv 监控)
  _try('Player', () => {
    const p = _g('Player');
    if (p && !p.__nepLvHooked__) {
      PatchMgr.watch(p, 'lv', {
        set(newLv, oldLv) {
           if (newLv > oldLv) {
             const pool = window.UpgradePool || {};
             const keys = Object.keys(pool);
             if (keys.length > 0) {
                const available = keys.filter(k => {
                   const u = pool[k];
                   return u && typeof u.apply === 'function' && (!u.maxLevel || (u.level || 0) < u.maxLevel);
                });
                if (available.length > 0) {
                   const k = available[Math.floor(Math.random() * available.length)];
                   pool[k].apply(p);
                   if (pool[k].level !== undefined) pool[k].level++;
                   EventBus.emit('upgradeApplied', k, p);
                   _info(`Triggered upgrade [${k}] on Level ${newLv}.`);
                }
             }
           }
           return newLv;
        }
      }, '_system', 1000);
      p.__nepLvHooked__ = true;
    }
  });

  _hookInjected = true;
  _info('System hooks securely injected.');
}

/* ═══════════════════════════════════════════════════════════════════════
   20. WATCHDOG
   ═══════════════════════════════════════════════════════════════════════ */
const Watchdog = (() => {
  let _timer = null, _ticks = 0, _lastTick = Date.now();
  EventBus.on('forge:tick', () => { _ticks++; _lastTick = Date.now(); }, '_watchdog');
  return {
    start(intervalMs = 5000) {
      if (_timer) return;
      _timer = setInterval(() => {
        const dt = Date.now() - _lastTick;
        if (!_g('Game') && !_g('Player')) {
          _warn('Watchdog: game globals missing, rescanning…');
          GlobalResolver.rescan();
        }
        EventBus.emit('forge:watchdog', { ticks: _ticks, dt });
      }, intervalMs);
      _info('Watchdog started.');
    },
    stop()   { if (_timer) { clearInterval(_timer); _timer = null; } },
    status() { return { running: !!_timer, ticks: _ticks, msSinceLastTick: Date.now() - _lastTick }; },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   21. MOD LOADER
   ═══════════════════════════════════════════════════════════════════════ */
const _mods = new Map();

function _buildAPI(modId) {
  return {
    id: modId,

    registry: {
      affix:       (k,d) => Registry.affix(k,d,modId),
      trait:       (k,d) => Registry.trait(k,d,modId),
      emitter:     (k,f) => Registry.emitter(k,f,modId),
      wrapper:     (k,f,fields) => Registry.wrapper(k,f,fields,modId),
      // 暴露高健壮的 edit 方法 (包含优先级)
      edit:        (cat, k, fn, pri=0) => Registry.edit(cat, k, fn, modId, pri),

      move:        (k,f) => Registry.move(k,f,modId),
      bodyKind:    (k,f) => Registry.bodyKind(k,f,modId),
      structure:   (k,d) => Registry.structure(k,d,modId),
      upgrade:     (k,d) => Registry.upgrade(k,d,modId),
      wavePattern: (k,d) => Registry.wavePattern(k,d,modId),
      into:        (cat,k,d) => Registry.into(cat,k,d,modId),
      snapshot:    () => Registry.snapshot(),
      appearance:  (k,c) => Registry.appearance(k,c,modId),
    },

    events: {
      on:      (evt,fn,opts)  => EventBus.on(evt,fn,modId,opts),
      once:    (evt,fn,opts)  => EventBus.once(evt,fn,modId,opts),
      off:     (evt,fn)       => EventBus.off(evt,fn),
      offById: (id)           => EventBus.offById(id),
      emit:    (evt,...args)  => EventBus.emit(evt,...args),
    },


    patch: {
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  函数钩子 — 全局作用域
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      wrap:    (fn, w,  pri=0, opts={}) => PatchMgr.wrap(fn, w, modId, pri, opts),
      around:  (fn, w,  pri=0, opts={}) => PatchMgr.around(fn, w, modId, pri, opts),
      before:  (fn, cb, pri=0, opts={}) => PatchMgr.before(fn, cb, modId, pri, opts),
      after:   (fn, cb, pri=0, opts={}) => PatchMgr.after(fn, cb, modId, pri, opts),
      replace: (fn, nf, pri=0, opts={}) => PatchMgr.replace(fn, nf, modId, pri, opts),
      tap:     (fn, cb, pri=0, opts={}) => PatchMgr.tap(fn, cb, modId, pri, opts),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  函数钩子 — 任意对象方法
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      wrapMethod:    (obj, key, w,  pri=0, opts={}) => PatchMgr.wrapMethod(obj, key, w, modId, pri, opts),
      beforeMethod:  (obj, key, cb, pri=0, opts={}) => PatchMgr.beforeMethod(obj, key, cb, modId, pri, opts),
      afterMethod:   (obj, key, cb, pri=0, opts={}) => PatchMgr.afterMethod(obj, key, cb, modId, pri, opts),
      replaceMethod: (obj, key, fn, pri=0, opts={}) => PatchMgr.replaceMethod(obj, key, fn, modId, pri, opts),
      tapMethod:     (obj, key, cb, pri=0, opts={}) => PatchMgr.tapMethod(obj, key, cb, modId, pri, opts),

      // ── 精准回滚 ──
      revertHook:    (hookId) => PatchMgr.revertHook(hookId),
      revertByTag:   (tag)    => PatchMgr.revertByTag(modId, tag),
      revertAll:     ()       => PatchMgr.revertAll(modId),
      list:          ()       => PatchMgr.list(modId),
      layers:        (fn)     => PatchMgr.layers(fn),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  属性控制 (watch / schema / freeze)
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      watch:    (obj, key, cbs, pri=0) => PatchMgr.watch(obj, key, cbs, modId, pri),
      schema:   (obj, key, schemaObj)  => PatchMgr.schema(obj, key, schemaObj, modId),
      freeze:   (obj, key)             => PatchMgr.freeze(obj, key, modId),
      unfreeze: (obj, key)             => PatchMgr.unfreeze(obj, key),
      onChange: (obj, key, handler)    => PatchMgr.onChange(obj, key, handler, modId),
      computed: (obj, key, fn, deps)   => PatchMgr.computed(obj, key, fn, deps, modId),
      mirror:   (src, sKey, dst, dKey) => PatchMgr.mirror(src, sKey, dst, dKey, modId),

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  跨 Mod 互操作
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      signal: {
        emit:  (name, data)    => PatchMgr.signal.emit(name, data, modId),
        on:    (name, handler) => PatchMgr.signal.on(name, handler, modId),
        once:  (name, handler) => PatchMgr.signal.once(name, handler, modId),
        off:   (name, id)      => PatchMgr.signal.off(name, id),
      },
      store: {
        get:      (ns, key, def) => PatchMgr.store.get(ns, key, def),
        set:      (ns, key, val) => PatchMgr.store.set(ns, key, val, modId),
        delete:   (ns, key)      => PatchMgr.store.delete(ns, key, modId),
        watch:    (ns, key, fn)  => PatchMgr.store.watch(ns, key, fn, modId),
        snapshot: (ns)           => PatchMgr.store.snapshot(ns),
      },
      negotiate: {
        declare:   (...caps)       => PatchMgr.negotiate.declare(modId, ...caps),
        has:       (targetId, cap) => PatchMgr.negotiate.has(targetId, cap),
        allWith:   (cap)           => PatchMgr.negotiate.allWith(cap),
        depends:   (...deps)       => PatchMgr.negotiate.depends(modId, ...deps),
        depsReady: ()              => PatchMgr.negotiate.depsReady(modId),
      },

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  诊断
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      diagnostics: {
        auditLog:      (filter)  => PatchMgr.diagnostics.auditLog(filter),
        hookTree:      ()        => PatchMgr.diagnostics.hookTree(),
        breakerStatus: ()        => PatchMgr.diagnostics.breakerStatus(),
        sharedStore:   ()        => PatchMgr.diagnostics.sharedStore(),
        signalBus:     ()        => PatchMgr.diagnostics.signalBus(),
        deps:          ()        => PatchMgr.diagnostics.deps(),
        caps:          ()        => PatchMgr.diagnostics.caps(),
        layerReport:   (fn)      => PatchMgr.diagnostics.layerReport(fn),
        replayBuffer:  (fn)      => PatchMgr.diagnostics.replayBuffer(fn),
        enableReplay:  (fn, cap) => PatchMgr.diagnostics.enableReplay(fn, cap),
        modList:       ()        => PatchMgr.diagnostics.modList(),
        propWatchers:  (obj)     => PatchMgr.diagnostics.propWatchers(obj),
      },

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      //  系统级渗透
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      sys: {
        timer: {
          before: (m, cb, pri=0, opts={}) => PatchMgr.sys.timer.before(m, cb, modId, pri, opts),
          after:  (m, cb, pri=0, opts={}) => PatchMgr.sys.timer.after(m, cb, modId, pri, opts),
          wrap:   (m, cb, pri=0, opts={}) => PatchMgr.sys.timer.wrap(m, cb, modId, pri, opts),
          tap:    (m, cb, pri=0, opts={}) => PatchMgr.sys.timer.tap(m, cb, modId, pri, opts),
        },
        event: {
          before: (m, cb, pri=0, opts={}) => PatchMgr.sys.event.before(m, cb, modId, pri, opts),
          after:  (m, cb, pri=0, opts={}) => PatchMgr.sys.event.after(m, cb, modId, pri, opts),
          wrap:   (m, cb, pri=0, opts={}) => PatchMgr.sys.event.wrap(m, cb, modId, pri, opts),
          tap:    (m, cb, pri=0, opts={}) => PatchMgr.sys.event.tap(m, cb, modId, pri, opts),
        },
        dom: {
          before: (m, cb, pri=0, opts={}) => PatchMgr.sys.dom.before(m, cb, modId, pri, opts),
          after:  (m, cb, pri=0, opts={}) => PatchMgr.sys.dom.after(m, cb, modId, pri, opts),
          wrap:   (m, cb, pri=0, opts={}) => PatchMgr.sys.dom.wrap(m, cb, modId, pri, opts),
          tap:    (m, cb, pri=0, opts={}) => PatchMgr.sys.dom.tap(m, cb, modId, pri, opts),
        },
        fetch: {
          wrap:   (fn, pri=0, opts={}) => PatchMgr.sys.fetch.wrap(fn, modId, pri, opts),
          before: (fn, pri=0, opts={}) => PatchMgr.sys.fetch.before(fn, modId, pri, opts),
          after:  (fn, pri=0, opts={}) => PatchMgr.sys.fetch.after(fn, modId, pri, opts),
        },
        xhr: {
          wrap:   (m, fn, pri=0, opts={}) => PatchMgr.sys.xhr.wrap(m, fn, modId, pri, opts),
          before: (m, fn, pri=0, opts={}) => PatchMgr.sys.xhr.before(m, fn, modId, pri, opts),
          after:  (m, fn, pri=0, opts={}) => PatchMgr.sys.xhr.after(m, fn, modId, pri, opts),
        },
        storage: {
          wrap:   (m, fn, pri=0, opts={}) => PatchMgr.sys.storage.wrap(m, fn, modId, pri, opts),
          before: (m, fn, pri=0, opts={}) => PatchMgr.sys.storage.before(m, fn, modId, pri, opts),
          after:  (m, fn, pri=0, opts={}) => PatchMgr.sys.storage.after(m, fn, modId, pri, opts),
        },
        mutation: {
          observe:   (fn) => PatchMgr.sys.mutation.observe(fn, modId),
          unobserve: (id) => PatchMgr.sys.mutation.unobserve(id),
        },
        console: {
          wrap:   (m, fn, pri=0) => PatchMgr.sys.console.wrap(m, fn, modId, pri),
          before: (m, fn, pri=0) => PatchMgr.sys.console.before(m, fn, modId, pri),
          after:  (m, fn, pri=0) => PatchMgr.sys.console.after(m, fn, modId, pri),
        }
      }
    },

    store: {
      set:      (key,val)     => SharedStore.set(modId,key,val),
      get:      (key)         => SharedStore.get(modId,key),
      getOr:    (key,def)     => SharedStore.getOr(modId,key,def),
      update:   (key,fn,def)  => SharedStore.update(modId,key,fn,def),
      watch:    (key,fn)      => SharedStore.watch(modId,key,fn,modId),
      readFrom: (ns,key)      => SharedStore.get(ns,key),
    },

    services: {
      provide: (name,impl,ver) => ServiceRegistry.provide(name,impl,modId,ver),
      lookup:  (name)          => ServiceRegistry.lookup(name),
      require: (name)          => ServiceRegistry.require(name,modId),
    },

    pipelines: {
      get:  (name)        => Pipelines.get(name),
      use:  (name,fn,pri) => Pipelines.get(name).use(fn,modId,pri),
    },

    render: {
      pre:  (fn,pri) => RenderPipeline.pre(fn,modId,pri),
      post: (fn,pri) => RenderPipeline.post(fn,modId,pri),
      hud:  (fn,pri) => RenderPipeline.hud(fn,modId,pri),
    },

    input: {
      bind:     (key,fn)  => InputRouter.bind(key,fn,modId),
      bindOnce: (key,fn)  => InputRouter.bindOnce(key,fn,modId),
      unbind:   (key,fn)  => InputRouter.unbind(key,fn),
    },

    schedule: {
      after:  (fn,sec)  => Scheduler.after(fn,sec,modId),
      every:  (fn,sec)  => Scheduler.every(fn,sec,modId),
      onWave: (fn,wave) => Scheduler.onWave(fn,wave,modId),
      cancel: (id)      => Scheduler.cancel(id),
    },

    meta: {
      register: (fn) => MetaModRegistry.register(modId, fn),
    },

    ui: {
      // ── 基础 ──
      toast:   (msg, color, dur) => UIManager.toast(msg, color, dur),
      build:   (schema)          => UIFramework.build(schema, modId),
      inject:  (sel, schema, opts) => UIFramework.inject(sel, schema, modId, opts),
      floating:(schema)          => UIFramework.floatingPanel(schema, modId),

      // ── Tab / 菜单页 ──
      injectMenuTab(label, key, renderFn) {
        UIManager.registerCustomTab(label, key, renderFn);
        return () => UIManager.openTab(key);
      },
      openForge:   () => UIManager.openTab('nepforge'),
      setMenuPage: (key) => { if (isFunc(window.setMenuPage)) window.setMenuPage(key); },

      // ── 预设组件（全部透传 modId，自动资源追踪，并修复生命周期绑定） ──
      components: new Proxy(UIFramework.components, {
        get(target, key) {
          // 放行内部属性或非函数
          if (key === '_css' || !isFunc(target[key])) return target[key];
          
          return (opts = {}) => {
            // 1. 调用原始组件工厂生成 DOM 元素
            const el = target[key](opts);
            
            // 2. ✨核心修复：拦截返回值，强行应用被组件漏掉的通用 Schema 属性
            if (el && el instanceof Node) {
              // 自动补齐 ID (带 modId 前缀避免冲突)
              if (opts.id) el.id = modId ? `${modId}_${opts.id}` : opts.id;
              
              // 自动追加 class
              if (opts.class) {
                opts.class.split(' ').forEach(c => { if(c) el.classList.add(c); });
              }
              
              // 自动映射 dataset 与 attributes
              if (isObj(opts.data)) {
                for (const [k, v] of Object.entries(opts.data)) el.dataset[k] = v;
              }
              if (isObj(opts.attrs)) {
                for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
              }
              
              // ⚡ 自动执行生命周期钩子
              if (isFunc(opts.ref)) {
                opts.ref(el); // 同步执行，触发你的 state.bind
              }
              if (isFunc(opts.setup)) {
                Promise.resolve().then(() => opts.setup(el)); // 异步执行
              }
            }
            return el;
          };
        }
      }),

      // ── 响应式 ──
      reactive: {
        state:  (init, opts) => UIFramework.reactive.state(init, opts),
        get:    (id)         => UIFramework.reactive.get(id),
      },

      // ── 游戏 UI 集成 ──
      gameUI: {
        setPage:         (key)     => UIFramework.gameUI.setPage(key),
        getPage:         ()        => UIFramework.gameUI.getPage(),
        onPageChange:    (fn)      => UIFramework.gameUI.onPageChange(fn),
        injectIntoPage:  (page, schema, pos) => UIFramework.gameUI.injectIntoPage(page, schema, pos),
        injectIntoHUD:   (schema, pos)       => UIFramework.gameUI.injectIntoHUD(schema, pos),
        toast:           (msg, color, dur)   => UIFramework.gameUI.toast(msg, color, dur),
        textPop:         (x, y, text, col)   => UIFramework.gameUI.textPop(x, y, text, col),
      },

      // ── 跨 Mod 共享 UI 状态 ──
      shared: {
        store:          (key, init)        => UIFramework.shared.store(key, init),
        registerWidget: (key, factory)     => UIFramework.shared.registerWidget(key, factory),
        getWidget:      (key, ...args)     => UIFramework.shared.getWidget(key, ...args),
      },

      // ── 便捷方法：直接弹一个模态对话框 ──
      modal: (config) => UIFramework.components.modal(config),
      // ── 刷新所有注册表 UI（手动触发） ──
      refreshRegistry: () => UIRefresher.rebuildAll(),
    },

    // ── WaveDirector 配置接口 ──
    waveDirector: WaveDirectorCfg.forMod(modId),

    game:     GameAPI,
    player:   PlayerAPI,
    fortress: FortressAPI,
    resolver: GlobalResolver,

    log:  (msg) => _info(`[${modId}] ${msg}`),
    warn: (msg) => _warn(`[${modId}] ${msg}`),
    err:  (msg) => _error(`[${modId}] ${msg}`),
  };
}

function _topoSort(ids) {
  const visited = new Set(), order = [];
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const m = _mods.get(id);
    for (const dep of (m?.descriptor?.deps || [])) visit(dep);
    order.push(id);
  }
  for (const id of ids) visit(id);
  return order;
}

function _buildDeclarativeInit(desc) {
  return function(api) {
    for (const [key, def] of Object.entries(desc.affixes || {})) {
      const compiled = {};
      for (const hook of ['onSpawn','onUpdate','onHit','onDeath']) {
        if (isStr(def[hook])) {
          const argSets = { onSpawn:['b','ctx'], onUpdate:['b','dt','ctx'],
                            onHit:['b','target','ctx'], onDeath:['b','reason','ctx'] };
          compiled[hook] = compileJS(def[hook], argSets[hook], `affix.${key}.${hook}`) || undefined;
        }
      }
      api.registry.affix(key, { ...def, ...compiled });
    }
    for (const [key, def] of Object.entries(desc.traits || {})) {
      const applyFn = isStr(def.apply)
        ? (compileJS(def.apply, ['e','d'], `trait.${key}.apply`) || (()=>{})) : (()=>{});
      api.registry.trait(key, { minWave:1, weight:1, group:'utility', ...def, apply: applyFn });
    }
    for (const [key, def] of Object.entries(desc.moves || {})) {
      const moveFn = isStr(def.moveFn)
        ? (compileJS(def.moveFn, ['e','dt'], `move.${key}`) || (()=>{})) : (()=>{});
      api.registry.move(key, (d) => {
        const e = safeCall(_g('baseEnemy'), ['ENEMY', def.r||16, Math.round((def.hp||80)*(1+d*0.02)), def.score||100], 'baseEnemy') || {};
        e._protoMoveKey = key;
        e.x = def.startX ?? GameAPI.W * (0.2 + Math.random() * 0.6);
        e.y = def.startY ?? -60;
        e.vy = (def.vy ?? 75) + d * 2;
        e.move = (dt) => safeCall(moveFn, [e, dt], `move.${key}`);
        return e;
      });
    }
    for (const [key, def] of Object.entries(desc.emitters || {})) {
      const fireFn = isStr(def.fireFn)
        ? (compileJS(def.fireFn, ['owner','spawnBullet','W','H'], `emitter.${key}`) || (()=>{})) : (()=>{});
      api.registry.emitter(key, () => ({
        cd: def.baseCd || 1.0,
        fire(owner) { safeCall(fireFn, [owner, _g('spawnBullet'), GameAPI.W, GameAPI.H], `emitter.${key}.fire`); }
      }));
    }
    for (const [key, def] of Object.entries(desc.wavePatterns || {})) {
      const spawnFn  = isStr(def.spawnFn)  ? (compileJS(def.spawnFn,  ['ctx'],        `wavePattern.${key}`)     || (()=>{})) : (()=>{});
      const onWaveFn = isStr(def.onWaveFn) ? (compileJS(def.onWaveFn, ['wave','game'], `wavePattern.${key}.onWave`) || null)  : null;
      api.registry.wavePattern(key, {
        spawn:  (ctx)       => safeCall(spawnFn,  [ctx],        `wavePattern.${key}.spawn`),
        onWave: onWaveFn ? (wave,game) => safeCall(onWaveFn, [wave,game], `wavePattern.${key}.onWave`) : null,
      });
    }
    for (const [key, def] of Object.entries(desc.structures || {})) api.registry.structure(key, def);
    for (const [evt, code] of Object.entries(desc.hooks || {})) {
      if (!isStr(code)) continue;
      const fn = compileJS(code, ['...args'], `hook.${evt}`);
      if (fn) api.events.on(evt, (...args) => safeCall(fn, args, `hook.${evt}`));
    }
    if (desc.loadMessage)
      Scheduler.after(() => UIManager.toast(desc.loadMessage, desc.loadColor || '#52E6FF'), 0.3, '_system');
  };
}

function _semverOk(provided, required) {
  if (!provided || !required) return true;
  const [pMa, pMi = 0] = provided.split('.').map(Number);
  const [rMa, rMi = 0] = required.split('.').map(Number);
  return pMa === rMa && pMi >= rMi;
}

const ModLoader = {
  register(descriptor) {
    const { id } = descriptor;
    if (!isStr(id) || !id) return _error('register: descriptor.id required');
    if (_mods.has(id)) { _warn(`"${id}" already registered — replacing`); this.unload(id); }
    _mods.set(id, { descriptor, loaded: false, enabled: true, api: null, _err: null });
    EventBus.emit('modRegistered', id);
    _info(`Registered "${descriptor.name || id}" v${descriptor.version || '?'}`);
    UIManager._updateModList();
    return this;
  },

  load(id) {
    if (!isStr(id) || !id) {
      _warn(`load: invalid id "${id}"`);
      return;
    }
    const mod = _mods.get(id);
    if (!mod)         return _error(`load: "${id}" not registered`);
    if (mod.loaded)   return _warn(`"${id}" already loaded`);
    if (!mod.enabled) return _warn(`"${id}" is disabled`);

    for (const dep of (mod.descriptor.deps || [])) {
      const depSpec = isObj(dep) ? dep : { id: dep };
      const dm      = _mods.get(depSpec.id);
      if (!dm) { mod._err = `Missing dep: "${depSpec.id}"`; _error(`"${id}" needs "${depSpec.id}"`); UIManager._updateModList(); return; }
      if (!dm.loaded) this.load(depSpec.id);
      const dm2 = _mods.get(depSpec.id);
      if (!dm2?.loaded) { mod._err = `Dep "${depSpec.id}" failed`; UIManager._updateModList(); return; }
      if (depSpec.minVersion && !_semverOk(dm2.descriptor.version, depSpec.minVersion)) {
        mod._err = `Dep "${depSpec.id}" v${dm2.descriptor.version} < required v${depSpec.minVersion}`;
        _error(`"${id}": ${mod._err}`); UIManager._updateModList(); return;
      }
    }

    const api = _buildAPI(id);
    mod.api = api;
    try {
      const desc = mod.descriptor;
      const initFn = isFunc(desc.init) ? desc.init
        : (desc.affixes || desc.traits || desc.moves || desc.emitters ||
           desc.wavePatterns || desc.hooks || desc.structures)
          ? _buildDeclarativeInit(desc) : null;
      safeCall(initFn, [api], `mod.${id}.init`);
      mod.loaded = true;
      mod._err   = null;
      _info(`✓ Loaded "${desc.name || id}" v${desc.version || '?'}`);
      UIManager.toast(`MOD LOADED: ${desc.name || id}`, '#52E6FF');
      EventBus.emit('modLoaded', id, mod);
      if (desc.meta) MetaModRegistry.runAll(Object.fromEntries(_mods));
    } catch(e) {
      mod._err = e.message || String(e);
      _error(`"${id}" init error: ${mod._err}`);
    }
    UIManager._updateModList();
  },

  unload(id) {
    if (!isStr(id) || !id) {
      _warn(`unload: invalid id "${id}"`);
      return;
    }
    const mod = _mods.get(id);
    if (!mod || !mod.loaded) return;
    for (const [oid, om] of _mods) {
      if (oid !== id && (om.descriptor.deps || []).some(d => (isObj(d)?d.id:d) === id) && om.loaded)
        this.unload(oid);
    }
    safeCall(mod.descriptor.cleanup, [], `mod.${id}.cleanup`);
    UIFramework.cleanup(id);
    Registry.unregisterAll(id);
    PatchMgr.revertAll(id);
    EventBus.offByMod(id);
    MetaModRegistry.removeByMod(id);
    SharedStore.unwatchAll(id);
    ServiceRegistry.revokeAll(id);
    Pipelines.removeModFromAll(id);
    RenderPipeline.removeByMod(id);
    InputRouter.unbindAll(id);
    Scheduler.cancelAll(id);
    mod.loaded = false;
    mod._err   = null;
    _info(`Unloaded "${mod.descriptor.name || id}"`);
    UIManager.toast(`MOD UNLOADED: ${mod.descriptor.name || id}`, '#FFB020');
    EventBus.emit('modUnloaded', id);
    UIManager._updateModList();
  },

  reload(id)  {
    if (!isStr(id) || !id) { _warn(`reload: invalid id "${id}"`); return; }
    this.unload(id); this.load(id);
  },
  enable(id)  {
    if (!isStr(id) || !id) { _warn(`enable: invalid id "${id}"`); return; }
    const m = _mods.get(id); if (m) { m.enabled = true;  UIManager._updateModList(); }
  },
  disable(id) {
    if (!isStr(id) || !id) { _warn(`disable: invalid id "${id}"`); return; }
    const m = _mods.get(id); if (m) { m.enabled = false; if(m.loaded) this.unload(id); UIManager._updateModList(); }
  },

  loadAll() {
    const order = _topoSort([..._mods.keys()]);
    for (const id of order) { const m = _mods.get(id); if (m && !m.loaded && m.enabled) this.load(id); }
    MetaModRegistry.runAll(Object.fromEntries(_mods));
  },

  unloadAll() {
    const loaded = [..._mods.entries()].filter(([,m])=>m.loaded).map(([id])=>id).reverse();
    for (const id of loaded) this.unload(id);
  },

  list() {
    return [..._mods.values()].map(m => ({
      id:          m.descriptor.id,
      name:        m.descriptor.name    || m.descriptor.id,
      version:     m.descriptor.version || '?',
      description: m.descriptor.description || '',
      deps:        m.descriptor.deps || [],
      meta:        !!m.descriptor.meta,
      loaded:      m.loaded,
      enabled:     m.enabled,
      error:       m._err,
    }));
  },
  get(id) { return _mods.get(id); },
};

/* ═══════════════════════════════════════════════════════════════════════
   22. JSON / FILE / CODE IMPORT
   ═══════════════════════════════════════════════════════════════════════ */
function _installFromJSON(str) {
  let desc;
  try { desc = JSON.parse(str.trim()); }
  catch(e) { return _error(`JSON parse error: ${e.message}`); }
  if (!desc?.id) return _error('JSON mod must have an "id" field');
  ModLoader.register(desc);
  ModLoader.load(desc.id);
}

function _installFromCode(code) {
  try {
    const fn = new Function('NEPForge', code);
    fn(window.NEPForge);
  } catch(e) { _error(`Code execution error: ${e.message}`); }
}
/* ═══════════════════════════════════════════════════════════════════════════
   23.0  WAVE DIRECTOR CFG  –  低代码波次配置接口
   ─────────────────────────────────────────────────────────────────────────
   允许 Mod 以声明式方式配置 WaveDirector 的 deck，支持：
     · 注册自定义 proto 工厂（可带出现权重、最小/最大波数、mode 过滤）
     · 按 game-mode（game / fortress / chaos / lab / …）独立配置
     · Deck filter：任意变换已建好的 deck
     · 全局 onWave 回调（wave 开始后触发）
     · 掉落规则：敌人死亡时根据规则掉落 mods
     · 完整的 modId 归属，安全卸载
   ═══════════════════════════════════════════════════════════════════════════ */
const WaveDirectorCfg = (() => {
  /* ── 内部存储 ────────────────────────────────────── */
  const _entries    = [];   // WaveEntry[]
  const _filters    = [];   // DeckFilter[]
  const _callbacks  = [];   // WaveCb[]
  const _dropRules  = [];   // DropRule[]
  const _modeOverrides = new Map(); // mode → ModeConfig

  /* ── 工具 ────────────────────────────────────────── */
  function _getMode() {
    try {
      const Fort = _g('Fortress');
      if (Fort && (Fort.active || Fort.running || Fort.mode === 'fortress')) return 'fortress';
      const G = _g('Game');
      if (G?.mode) return String(G.mode).toLowerCase();
      if (G?.chaosMode) return 'chaos';
    } catch(_) {}
    return 'game';
  }

  function _weightOf(entry, wave, mode) {
    // mode-specific override?
    const mo = _modeOverrides.get(`${entry.key}:${mode}`);
    if (mo?.weight !== undefined) {
      return isFunc(mo.weight) ? mo.weight(wave) : mo.weight;
    }
    return isFunc(entry.weight) ? entry.weight(wave, mode) : (entry.weight ?? 1);
  }

  function _minWaveOf(entry, mode) {
    const mo = _modeOverrides.get(`${entry.key}:${mode}`);
    return mo?.minWave ?? entry.minWave ?? 1;
  }

  function _maxWaveOf(entry, mode) {
    const mo = _modeOverrides.get(`${entry.key}:${mode}`);
    return mo?.maxWave ?? entry.maxWave ?? Infinity;
  }

  function _countOf(entry, wave, deckLen) {
    return isFunc(entry.count) ? Math.round(entry.count(wave, deckLen)) : (entry.count ?? 1);
  }

  /* ── 主要钩入逻辑：在 WaveDirector.onWave 之后运行 ── */
  function _applyToDeck(wave, WD) {
    if (!WD || !Array.isArray(WD.deck)) return;
    const mode = _getMode();

    /* 1. 注入自定义 proto 条目 */
    const applicable = _entries.filter(e => {
      if (wave < _minWaveOf(e, mode)) return false;
      if (wave > _maxWaveOf(e, mode)) return false;
      if (e.modes?.length && !e.modes.includes(mode)) return false;
      const w = _weightOf(e, wave, mode);
      return (isFunc(w) ? w(wave) : w) > 0;
    });

    for (const entry of applicable) {
      const count = _countOf(entry, wave, WD.deck.length);
      for (let i = 0; i < count; i++) {
        let proto;
        try {
          if (isFunc(entry.factory)) {
            proto = entry.factory(wave, mode, WD.deck);
          } else if (isObj(entry.proto)) {
            // 简单声明式 proto：深拷贝后合并
            proto = JSON.parse(JSON.stringify(entry.proto));
          }
        } catch(e) {
          _warn(`[WaveDirectorCfg] factory error for "${entry.key}": ${e.message}`);
          continue;
        }
        if (!isObj(proto)) continue;

        // 按权重随机决定是否加入（加权采样）
        const totalWeight = WD.deck.length + (_weightOf(entry, wave, mode) || 1);
        if (WD.deck.length === 0 || Math.random() < (_weightOf(entry, wave, mode) || 1) / totalWeight) {
          WD.deck.push(proto);
        }
      }
    }

    /* 2. 执行 Deck Filters（自由变换 deck） */
    for (const { fn, modId: mid } of _filters) {
      try { fn(WD.deck, wave, mode, WD); }
      catch(e) { _warn(`[WaveDirectorCfg] filter error (${mid}): ${e.message}`); }
    }

    /* 3. 执行全局波次回调 */
    for (const { fn, modId: mid } of _callbacks) {
      try { fn(wave, WD.deck, mode, WD); }
      catch(e) { _warn(`[WaveDirectorCfg] onWave cb error (${mid}): ${e.message}`); }
    }
  }

  /* ── 掉落规则钩子（在 enemy death 时触发） ──────── */
  function _applyDrops(enemy) {
    for (const rule of _dropRules) {
      try {
        if (isFunc(rule.filter) && !rule.filter(enemy)) continue;
        if (isFunc(rule.roll) && !rule.roll(enemy)) continue;
        if (isFunc(rule.apply)) rule.apply(enemy);
      } catch(e) {
        _warn(`[WaveDirectorCfg] drop rule error: ${e.message}`);
      }
    }
  }

  /* ── 连接到 EventBus ────────────────────────────── */
  // 监听已有的 wave 事件（modloader _injectGameHooks 中已 emit）
  EventBus.on('wave', (wave, WD) => {
    _applyToDeck(wave, WD);
  }, '_waveDirectorCfg', { priority: -10 }); // 低优先级，确保在所有 mod 的 wave 钩子后运行

  // 监听敌人死亡（若有对应事件）
  EventBus.on('enemyDeath', (enemy) => {
    _applyDrops(enemy);
  }, '_waveDirectorCfg');

  /* ── forMod 工厂：为每个 modId 创建独立的绑定接口 ── */
  function forMod(modId) {
    return {
      /**
       * 注册一个自定义波次条目（可出现在 WaveDirector.deck 中）
       * @param {object} config
       *   {string}          key       唯一 ID
       *   {function|object} factory   (wave, mode, deck) => proto 或直接是 proto 对象
       *   {number|function} weight    出现权重（默认 1）；可以是函数 (wave, mode) => number
       *   {number|function} minWave   最小波数（默认 1）
       *   {number|function} maxWave   最大波数（默认 Infinity）
       *   {string[]}        modes     限定 game mode（空 = 全部）
       *   {number|function} count     每波加入几个（默认 1）
       */
      addEntry(config) {
        const { key } = config;
        if (!isStr(key)) return _warn(`WaveDirectorCfg.addEntry: key required (mod: ${modId})`);
        // 同 modId 同 key 去重
        const existing = _entries.findIndex(e => e.key === key && e.modId === modId);
        if (existing >= 0) _entries.splice(existing, 1);
        _entries.push({ ...config, modId });
        return this;
      },

      /**
       * 为特定 entry + mode 组合设置覆盖参数
       * @param {string} entryKey  addEntry 时的 key
       * @param {string} mode      'game' | 'fortress' | 'chaos' | …
       * @param {object} options   { weight, minWave, maxWave }
       */
      configure(entryKey, mode, options) {
        _modeOverrides.set(`${entryKey}:${mode}`, { ...options, modId });
        return this;
      },

      /**
       * 注册波次开始后的全局回调
       * @param {function} fn  (wave, deck, mode, WaveDirector) => void
       */
      onWave(fn) {
        if (!isFunc(fn)) return _warn(`WaveDirectorCfg.onWave: fn required (mod: ${modId})`);
        _callbacks.push({ fn, modId });
        return this;
      },

      /**
       * 注册 Deck Filter（可任意变换 deck）
       * @param {function} fn  (deck, wave, mode, WaveDirector) => void
       *   直接修改 deck 数组即可（splice/push/sort/…）
       */
      filter(fn) {
        if (!isFunc(fn)) return _warn(`WaveDirectorCfg.filter: fn required (mod: ${modId})`);
        _filters.push({ fn, modId });
        return this;
      },

      /**
       * 注册敌人掉落规则
       * @param {object} config
       *   {function} filter(enemy)  返回 true 表示此规则适用
       *   {function} roll(enemy)    返回 true 表示本次触发（可实现概率）
       *   {function} apply(enemy)   执行掉落逻辑
       */
      drop(config) {
        if (!isObj(config) || !isFunc(config.apply))
          return _warn(`WaveDirectorCfg.drop: config.apply required (mod: ${modId})`);
        _dropRules.push({ ...config, modId });
        return this;
      },

      /**
       * 卸载该 mod 注册的所有 WaveDirectorCfg 条目
       */
      unregisterAll() {
        const rm = (arr) => {
          for (let i = arr.length - 1; i >= 0; i--)
            if (arr[i].modId === modId) arr.splice(i, 1);
        };
        rm(_entries); rm(_filters); rm(_callbacks); rm(_dropRules);
        for (const k of [..._modeOverrides.keys()])
          if (_modeOverrides.get(k)?.modId === modId) _modeOverrides.delete(k);
      },
    };
  }

  /* ── 公开接口 ── */
  return {
    forMod,
    // 只读快照（用于调试）
    snapshot() {
      return {
        entries:   _entries.map(e => ({ key: e.key, modId: e.modId, modes: e.modes, weight: e.weight, minWave: e.minWave })),
        filters:   _filters.map(f => ({ modId: f.modId })),
        callbacks: _callbacks.map(c => ({ modId: c.modId })),
        drops:     _dropRules.map(d => ({ modId: d.modId })),
      };
    },
  };
})();
/* ═══════════════════════════════════════════════════════════════════════
   23. UI MANAGER  – injected into game menu as a proper tab
   ═══════════════════════════════════════════════════════════════════════
   The floating panel + toggle button from v3 are REMOVED.
   Instead we inject a "⚙ MODS" nav button into #menu .menu-nav and a
   corresponding .page div into #menu .menu-main.  The standard game
   setMenuPage() is patched (via window._nepRegisterMenuPage, set up in
   the game HTML) to activate/deactivate our page correctly.
   ═══════════════════════════════════════════════════════════════════════ */
const UIManager = (() => {
  let _currentTab = 'mods';
  let _pageEl     = null;   // the .page div injected into menu-main
  let _bodyEl     = null;   // content container inside _pageEl
  let _customTabs = {};     // key → { label, renderFn }

  /* ── CSS (scoped to nep-* classes, injected once) ─────────────────── */
  const CSS = `
    .nep-page { padding: 6px 2px; display: none; }
    .nep-inner-tabs { display:flex; gap:0; border-bottom:1px solid rgba(82,230,255,0.18); margin-bottom:8px; flex-shrink:0; }
    .nep-itab { flex:1; padding:5px 4px; font-family:"Consolas","Monaco",monospace; font-size:10px;
      font-weight:700; letter-spacing:1.5px; text-transform:uppercase; background:none; border:none;
      border-bottom:2px solid transparent; color:rgba(255,255,255,0.32); cursor:pointer; transition:all 0.13s; }
    .nep-itab:hover { color:rgba(255,255,255,0.65); }
    .nep-itab.active { color:#52E6FF; border-bottom-color:#52E6FF; }
    .nep-body { flex:1; overflow-y:auto; overflow-x:hidden; scrollbar-width:thin; scrollbar-color:rgba(82,230,255,0.22) transparent; }
    .nep-body::-webkit-scrollbar { width:4px; }
    .nep-body::-webkit-scrollbar-thumb { background:rgba(82,230,255,0.22); border-radius:2px; }
    .nep-section { font-size:9px; letter-spacing:2px; color:rgba(255,255,255,0.26); text-transform:uppercase;
      margin:10px 0 6px; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:3px; }
    .nep-mod-card { border:1px solid rgba(82,230,255,0.12); padding:8px 10px; margin-bottom:7px;
      background:rgba(0,0,0,0.18); border-radius:3px; transition:border-color 0.13s; }
    .nep-mod-card.loaded { border-color:rgba(82,230,255,0.28); }
    .nep-mod-card.error  { border-color:rgba(255,47,87,0.35); }
    .nep-mod-name { font-weight:700; font-size:12px; letter-spacing:1px; }
    .nep-mod-name.loaded  { color:#52E6FF; }
    .nep-mod-name.unloaded { color:#555; }
    .nep-mod-desc { font-size:10px; color:rgba(255,255,255,0.36); margin-top:3px; line-height:1.4; }
    .nep-mod-deps { font-size:10px; color:#FFB02077; margin-top:2px; }
    .nep-mod-err  { font-size:10px; color:#FF2F57; margin-top:3px; }
    .nep-led { width:6px; height:6px; border-radius:50%; display:inline-block; flex-shrink:0; }
    .nep-led.on  { background:#52E6FF; box-shadow:0 0 5px #52E6FF; }
    .nep-led.off { background:#2a2a2a; }
    .nep-led.err { background:#FF2F57; box-shadow:0 0 5px #FF2F57; }
    .nep-btn-row { display:flex; gap:4px; margin-top:7px; flex-wrap:wrap; }
    .nep-btn { background:rgba(0,0,0,0.32); border:1px solid rgba(255,255,255,0.16); color:#bbb;
      padding:4px 8px; font-family:inherit; font-size:10px; letter-spacing:1px; text-transform:uppercase;
      cursor:pointer; border-radius:2px; transition:all 0.12s; }
    .nep-btn:hover { background:rgba(255,255,255,0.07); color:#fff; }
    .nep-btn.cyan    { border-color:rgba(82,230,255,0.45);  color:#52E6FF; }
    .nep-btn.cyan:hover { background:rgba(82,230,255,0.1); }
    .nep-btn.magenta { border-color:rgba(179,108,255,0.45); color:#B36CFF; }
    .nep-btn.magenta:hover { background:rgba(179,108,255,0.1); }
    .nep-btn.danger  { border-color:rgba(255,47,87,0.45);   color:#FF2F57; }
    .nep-btn.danger:hover  { background:rgba(255,47,87,0.08); }
    .nep-btn.yellow  { border-color:rgba(255,176,32,0.45);  color:#FFB020; }
    .nep-btn.yellow:hover  { background:rgba(255,176,32,0.08); }
    .nep-btn.green   { border-color:rgba(80,220,100,0.45);  color:#50DC64; }
    .nep-btn.green:hover   { background:rgba(80,220,100,0.08); }
    .nep-btn:disabled { opacity:0.3; cursor:not-allowed; }
    .nep-textarea { width:100%; height:110px; background:rgba(0,0,0,0.45);
      border:1px solid rgba(82,230,255,0.22); color:#cde; font-family:inherit; font-size:10px;
      padding:7px; resize:vertical; outline:none; border-radius:2px; line-height:1.5; }
    .nep-textarea:focus { border-color:rgba(82,230,255,0.55); }
    .nep-log { height:180px; overflow-y:auto; background:rgba(0,0,0,0.38);
      border:1px solid rgba(255,255,255,0.06); padding:6px; border-radius:2px; scrollbar-width:thin; }
    .nep-log-line { font-size:10px; line-height:1.6; white-space:pre-wrap; word-break:break-all; }
    .nep-log-line.info  { color:rgba(200,232,255,0.55); }
    .nep-log-line.warn  { color:#FFB020; }
    .nep-log-line.error { color:#FF2F57; }
    .nep-chip-grid { display:flex; flex-wrap:wrap; gap:4px; max-height:100px; overflow-y:auto; }
    .nep-chip { font-size:9px; padding:2px 6px; border-radius:2px; background:rgba(82,230,255,0.06);
      border:1px solid rgba(82,230,255,0.20); color:#52E6FF77; cursor:pointer; letter-spacing:0.5px; transition:all 0.1s; }
    .nep-chip:hover { background:rgba(82,230,255,0.16); color:#52E6FF; }
    .nep-file-drop { border:1px dashed rgba(82,230,255,0.28); padding:12px; text-align:center;
      color:rgba(255,255,255,0.28); font-size:10px; border-radius:2px; cursor:pointer; transition:all 0.14s; margin-bottom:6px; }
    .nep-file-drop:hover, .nep-file-drop.drag { border-color:rgba(82,230,255,0.6); color:#52E6FF; }
    .nep-toast { position:fixed; top:18%; left:50%; transform:translateX(-50%);
      background:rgba(4,8,22,0.97); border:1px solid currentColor; padding:9px 20px;
      font-family:"Consolas",monospace; font-size:12px; font-weight:700; letter-spacing:2px;
      text-transform:uppercase; border-radius:3px; z-index:9999999; pointer-events:none;
      animation:nepFadeIn 0.2s ease; }
    @keyframes nepFadeIn { from{opacity:0;transform:translateX(-50%) translateY(-8px)} to{opacity:1;transform:translateX(-50%)} }
    .nep-status-row { display:flex; align-items:center; gap:6px; font-size:9px;
      color:rgba(255,255,255,0.28); margin-bottom:8px; background:rgba(0,0,0,0.22); padding:5px 8px; border-radius:2px; }
    .nep-conflict-banner { background:rgba(255,47,87,0.09); border:1px solid rgba(255,47,87,0.28);
      color:#FF2F57; font-size:10px; padding:6px 8px; border-radius:2px; margin-bottom:6px; }
    .nep-ref-section { margin-bottom:8px; }
    .nep-ref-title { font-size:9px; color:rgba(255,255,255,0.26); letter-spacing:2px; text-transform:uppercase; margin-bottom:5px; }
    .nep-example-row { display:flex; flex-wrap:wrap; gap:4px; }
  `;
  const styleEl = document.createElement('style');
  styleEl.id = 'nep-forge-style';
  styleEl.textContent = CSS;
  document.head.appendChild(styleEl);

  /* ── Inject MODS tab into the game menu ──────────────────────────── */
  /* ── Inject MODS tab into the game menu ──────────────────────────── */
function _injectMenuTab() {
  const menuNav  = document.querySelector('#menu .menu-nav');
  const menuMain = document.querySelector('#menu .menu-main');
  if (!menuNav || !menuMain) {
    setTimeout(_injectMenuTab, 200);
    return;
  }

  // 避免重复注入
  if (document.getElementById('nep-menu-nav-btn')) return;

  // Nav button
  const navBtn = document.createElement('button');
  navBtn.className    = 'nav-btn mini-btn';
  navBtn.dataset.page = 'nepforge';
  navBtn.id           = 'nep-menu-nav-btn';
  navBtn.textContent  = '⚙ MODS';
  navBtn.style.cssText = 'border-color:rgba(82,230,255,0.45);';
  menuNav.appendChild(navBtn);

  // 找到游戏用于存放各个页面的容器（应该是 .menu-main > div:first-child）
  let pagesContainer = menuMain.querySelector(':scope > div');
  if (!pagesContainer) {
    pagesContainer = document.createElement('div');
    menuMain.appendChild(pagesContainer);
  }

  // 创建我们的页面（带 page 类，默认隐藏）
  const page = document.createElement('div');
  page.id        = 'pageNepForge';
  page.className = 'page nep-page';      // page 类用于游戏切换，nep-page 是我们自己的样式
  page.style.cssText = 'flex-direction:column; height:100%; min-height:0; font-family:"Consolas","Monaco","Courier New",monospace; color:#c8e8ff; font-size:12px;';
  pagesContainer.appendChild(page);
  _pageEl = page;

  // 注册到游戏的扩展页面系统（如果存在）
  if (isFunc(window._nepRegisterMenuPage))
    window._nepRegisterMenuPage('nepforge', page);

  // 内部标签栏
  const tabBar = document.createElement('div');
  tabBar.className = 'nep-inner-tabs';
  tabBar.innerHTML = `
    <button class="nep-itab active" data-tab="mods">MODS</button>
    <button class="nep-itab" data-tab="install">INSTALL</button>
    <button class="nep-itab" data-tab="ref">REF</button>
    <button class="nep-itab" data-tab="diag">DIAG</button>
    <button class="nep-itab" data-tab="log">LOG</button>`;
  page.appendChild(tabBar);

  // 内容主体
  const body = document.createElement('div');
  body.className = 'nep-body';
  page.appendChild(body);
  _bodyEl = body;

  // 内部标签点击切换
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.nep-itab');
    if (!btn) return;
    _currentTab = btn.dataset.tab;
    tabBar.querySelectorAll('.nep-itab').forEach(b => b.classList.toggle('active', b === btn));
    _renderTab(_currentTab);
  });

  // 点击导航按钮时，调用游戏的 setMenuPage 来显示我们的页面
  navBtn.addEventListener('click', () => {
    if (isFunc(window.setMenuPage)) window.setMenuPage('nepforge');
    _renderTab(_currentTab);
  });

  // 初始渲染
  _renderTab(_currentTab);
  _info('NEPForge: menu tab injected.');
}
  _injectMenuTab();

  /* ── Tab renderers ──────────────────────────────────────────────── */
  function _renderTab(tab) {
    if (!_bodyEl) return;
    _bodyEl.innerHTML = '';
    // Check custom tabs first
    if (_customTabs[tab]) {
      try { _customTabs[tab].renderFn(_bodyEl); } catch(e) { _error(`Custom tab "${tab}": ${e.message}`); }
      return;
    }
    if (tab === 'mods')    _renderModList(_bodyEl);
    if (tab === 'install') _renderInstall(_bodyEl);
    if (tab === 'ref')     _renderRef(_bodyEl);
    if (tab === 'diag')    _renderDiag(_bodyEl);
    if (tab === 'log')     _renderLog(_bodyEl);
  }

  /* MODS TAB */
  function _renderModList(container) {
    const listRoot = mkEl('div');
    container.appendChild(listRoot);
    const conflicts = ConflictGuard.report();
    if (conflicts.length) {
      const b = mkEl('div');
      b.className = 'nep-conflict-banner';
      b.textContent = `⚠ ${conflicts.length} conflict(s): ` + conflicts.map(c=>`${c.key}[${c.mods.join(',')}]`).join('; ');
      listRoot.appendChild(b);
    }
    const mods = ModLoader.list();
    if (!mods.length) {
      listRoot.innerHTML = '<div style="color:rgba(255,255,255,0.26);text-align:center;padding:28px 0;font-size:11px">No mods registered.<br>Use the INSTALL tab to add mods.</div>';
    } else {
      mods.forEach(m => {
        const cls    = m.error ? 'error' : m.loaded ? 'loaded' : '';
        const ledCls = m.error ? 'err'   : m.loaded ? 'on'     : 'off';
        const card   = mkEl('div');
        card.className = `nep-mod-card ${cls}`;
        card.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span class="nep-led ${ledCls}"></span>
            <span class="nep-mod-name ${m.loaded?'loaded':'unloaded'}">${m.name}
              <span style="opacity:0.32;font-size:9px">v${m.version}</span>
              ${m.meta ? ' <span style="color:#B36CFF;font-size:9px">[META]</span>':''}</span>
          </div>
          ${m.description ? `<div class="nep-mod-desc">${m.description}</div>` : ''}
          ${m.deps?.length ? `<div class="nep-mod-deps">Deps: ${m.deps.map(d=>isObj(d)?d.id:d).join(', ')}</div>` : ''}
          ${m.error ? `<div class="nep-mod-err">⚠ ${m.error}</div>` : ''}
          <div class="nep-btn-row">
            <button class="nep-btn ${m.loaded?'yellow':'cyan'}" data-action="${m.loaded?'unload':'load'}" data-id="${m.id}">${m.loaded?'UNLOAD':'LOAD'}</button>
            <button class="nep-btn" data-action="reload" data-id="${m.id}" ${!m.loaded?'disabled':''}>↺ RELOAD</button>
            <button class="nep-btn ${m.enabled?'':'green'}" data-action="${m.enabled?'disable':'enable'}" data-id="${m.id}">${m.enabled?'DISABLE':'ENABLE'}</button>
            <button class="nep-btn danger" data-action="remove" data-id="${m.id}">✕</button>
          </div>`;
        listRoot.appendChild(card);
      });
    }
    const gr = mkEl('div','display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;');
    gr.innerHTML = `<button class="nep-btn cyan" data-action="loadAll">LOAD ALL</button>
                    <button class="nep-btn danger" data-action="unloadAll">UNLOAD ALL</button>`;
    listRoot.appendChild(gr);

    listRoot.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, id } = btn.dataset;
      if (action==='load')      ModLoader.load(id);
      if (action==='unload')    ModLoader.unload(id);
      if (action==='reload')    ModLoader.reload(id);
      if (action==='enable')    ModLoader.enable(id);
      if (action==='disable')   ModLoader.disable(id);
      if (action==='remove')    { ModLoader.unload(id); _mods.delete(id); }
      if (action==='loadAll')   ModLoader.loadAll();
      if (action==='unloadAll') ModLoader.unloadAll();
      _renderTab('mods');
    });
  }

  /* INSTALL TAB */
  function _renderInstall(container) {
    container.innerHTML = `
      <div class="nep-section">JSON FILE / JS FILE</div>
      <div class="nep-file-drop" id="nep-file-drop">
        📂 Drag &amp; drop a .json or .js mod file<br>
        <span style="font-size:9px;opacity:0.4">or click to browse</span>
        <input type="file" accept=".json,.js" style="display:none" id="nep-file-input">
      </div>
      <div class="nep-section">PASTE JSON DESCRIPTOR OR JS CODE</div>
      <textarea class="nep-textarea" id="nep-install-ta"
        placeholder='// JSON: {"id":"my-mod","name":"...","affixes":{...}}&#10;// JS:   NEPForge.install({ id: "x", init(api){ ... } })'></textarea>
      <div class="nep-btn-row">
        <button class="nep-btn cyan" id="nep-install-json">INSTALL JSON</button>
        <button class="nep-btn magenta" id="nep-install-code">RUN JS</button>
        <button class="nep-btn" id="nep-paste-btn">📋 PASTE</button>
        <button class="nep-btn" id="nep-clear-ta">CLEAR</button>
      </div>
      <div class="nep-section">QUICK EXAMPLES</div>
      <div class="nep-example-row" id="nep-examples"></div>`;

    const drop = container.querySelector('#nep-file-drop');
    const fi   = container.querySelector('#nep-file-input');
    const ta   = container.querySelector('#nep-install-ta');
    const readFile = (file) => {
      if (!file) return;
      const r = new FileReader();
      r.onload = e => file.name.endsWith('.js') ? _installFromCode(e.target.result) : _installFromJSON(e.target.result);
      r.readAsText(file);
    };
    drop.addEventListener('click', () => fi.click());
    fi.addEventListener('change', () => readFile(fi.files[0]));
    drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', ()  => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); readFile(e.dataTransfer.files[0]); });

    container.querySelector('#nep-install-json').addEventListener('click', () => _installFromJSON(ta.value));
    container.querySelector('#nep-install-code').addEventListener('click', () => _installFromCode(ta.value));
    container.querySelector('#nep-clear-ta').addEventListener('click',   () => { ta.value = ''; });
    container.querySelector('#nep-paste-btn').addEventListener('click',  async () => {
      try { const t = await navigator.clipboard?.readText?.(); if (t) ta.value = t; }
      catch(_) { ta.focus(); document.execCommand?.('paste'); }
    });

    // 自动遍历 _EXAMPLES 生成快捷示例按钮
    const er = container.querySelector('#nep-examples');
    for (const [key, code] of Object.entries(_EXAMPLES)) {
      // 默认使用 key 格式化作为标签 (e.g., 'bigBullets' -> 'BIG BULLETS')
      let label = key.replace(/([A-Z])/g, ' $1').trim().toUpperCase();
      
      // 尝试从代码中提取真实的 Mod 名称
      try {
        const parsed = JSON.parse(code);
        if (parsed.name) label = parsed.name.toUpperCase();
      } catch (_) {
        // 如果是 JS 脚本，则用正则提取 name: '...' 字段
        const match = code.match(/name\s*:\s*['"]([^'"]+)['"]/i);
        if (match && match[1]) label = match[1].toUpperCase();
      }

      const b = mkEl('button', '', label);
      b.className = 'nep-btn';
      b.addEventListener('click', () => { 
        ta.value = code; 
        // 自动格式化一下 textarea 焦点
        ta.focus(); 
      });
      er.appendChild(b);
    }
  }

  /* REF TAB */
  function _renderRef(container) {
    const snap = Registry.snapshot();
    const secs = [
      { title:'BULLET AFFIXES', keys:snap.affixes   },
      { title:'ENEMY TRAITS',   keys:snap.traits    },
      { title:'EMITTERS',       keys:snap.emitters  },
      { title:'WRAPPERS',       keys:snap.wrappers  },
      { title:'MOVE PATTERNS',  keys:snap.moves     },
      { title:'BODY KINDS',     keys:snap.bodies    },
      { title:'STRUCTURES',     keys:snap.structures},
      { title:'WAVE PATTERNS',  keys:snap.waves     },
      { title:'UPGRADES',       keys:snap.upgrades  },
      { title:'SERVICES',       keys:ServiceRegistry.list().map(s=>`${s.name}@${s.modId}`) },
    ];
    secs.forEach(({ title, keys }) => {
      const s = mkEl('div'); s.className = 'nep-ref-section';
      const g = mkEl('div'); g.className = 'nep-chip-grid';
      s.innerHTML = `<div class="nep-ref-title">${title} <span style="opacity:0.35">(${keys.length})</span></div>`;
      keys.forEach(k => {
        const c = mkEl('span','',k); c.className='nep-chip'; c.title='Click to copy';
        c.addEventListener('click', () => { navigator.clipboard?.writeText(k); toast(`Copied: ${k}`, '#52E6FF88', 900); });
        g.appendChild(c);
      });
      s.appendChild(g);
      container.appendChild(s);
    });
    const rb = mkEl('button','margin-top:8px','REFRESH'); rb.className='nep-btn';
    rb.addEventListener('click', () => _renderTab('ref'));
    container.appendChild(rb);
  }

  /* DIAG TAB */
  function _renderDiag(container) {
    const ri   = GlobalResolver.inspect();
    const wd   = Watchdog.status();
    const rp   = RenderPipeline.status();
    const conf = ConflictGuard.report();
    const svcs = ServiceRegistry.list();
    const pips = Pipelines.list();

    container.innerHTML = `
      <div class="nep-section">GAME CONTEXT</div>
      <div style="font-size:10px;line-height:1.8;color:#aaa">
        <span style="color:#52E6FF">Source:</span> ${ri.context}<br>
        <span style="color:#50DC64">Found:</span> ${ri.found.join(' · ') || '—'}<br>
        <span style="color:#FF2F57">Missing:</span> ${ri.missing.join(' · ') || '—'}
      </div>
      <div class="nep-section">WATCHDOG</div>
      <div style="font-size:10px;color:#aaa">
        Running: <span style="color:${wd.running?'#50DC64':'#FF2F57'}">${wd.running?'YES':'NO'}</span> |
        Ticks: ${wd.ticks} |
        Last tick: ${(wd.msSinceLastTick/1000).toFixed(1)}s ago
      </div>
      <div class="nep-section">RENDER PIPELINE</div>
      <div style="font-size:10px;color:#aaa">
        Pre hooks: ${rp.pre} | Post hooks: ${rp.post}
      </div>
      <div class="nep-section">PATCH CONFLICTS (${conf.length})</div>
      ${conf.length ? conf.map(c=>`<div style="font-size:10px;color:#FF2F57">⚠ ${c.key}: [${c.mods.join(', ')}]</div>`).join('') : '<div style="font-size:10px;color:#555">None</div>'}
      <div class="nep-section">SERVICES (${svcs.length})</div>
      <div style="font-size:10px;color:#aaa">${svcs.map(s=>`<span style="color:#B36CFF">${s.name}</span> by ${s.modId} v${s.version}`).join('<br>') || '—'}</div>
      <div class="nep-section">PIPELINES (${pips.length})</div>
      <div style="font-size:10px;color:#aaa">${pips.join(' · ') || '—'}</div>
      <div class="nep-btn-row" style="margin-top:10px">
        <button class="nep-btn cyan"  id="nep-rescan-btn">RESCAN</button>
        <button class="nep-btn green" id="nep-wd-btn">WATCHDOG ${wd.running?'STOP':'START'}</button>
        <button class="nep-btn" id="nep-diag-refresh">REFRESH</button>
      </div>`;

    container.querySelector('#nep-rescan-btn').addEventListener('click', () => {
      GlobalResolver.rescan(); _injectGameHooks(); _renderTab('diag'); });
    container.querySelector('#nep-wd-btn').addEventListener('click', () => {
      wd.running ? Watchdog.stop() : Watchdog.start(); _renderTab('diag'); });
    container.querySelector('#nep-diag-refresh').addEventListener('click', () => _renderTab('diag'));
  }

  /* LOG TAB */
  function _renderLog(container) {
    const body = container || _bodyEl;
    if (!body || _currentTab !== 'log') return;
    let logEl = body.querySelector('.nep-log');
    if (!logEl) {
      logEl = mkEl('div'); logEl.className = 'nep-log'; body.appendChild(logEl);
      const cb = mkEl('button','margin-top:6px','CLEAR LOG'); cb.className='nep-btn';
      cb.addEventListener('click', () => { _FORGE_LOG.length = 0; _renderTab('log'); });
      body.appendChild(cb);
    }
    logEl.innerHTML = _FORGE_LOG.slice(-100).map(e => {
      const t = new Date(e.t).toTimeString().slice(0,8);
      return `<div class="nep-log-line ${e.lvl}"><span style="opacity:0.3">${t}</span> ${e.msg}</div>`;
    }).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ── Toast ─────────────────────────────────────────────────────── */
  function toast(msg, color = '#52E6FF', duration = 2200) {
    const el = mkEl('div', `color:${color};border-color:${color};box-shadow:0 0 14px ${color}33;`, msg);
    el.className = 'nep-toast'; document.body.appendChild(el);
    setTimeout(() => { el.style.opacity='0'; el.style.transition='opacity 0.32s'; setTimeout(()=>el.remove(),380); }, duration);
  }

  /* ── Public surface ─────────────────────────────────────────────── */
  function _updateModList() {
    if (_pageEl?.classList.contains('active') && _currentTab === 'mods') _renderTab('mods');
  }

  function openTab(tab = _currentTab || 'mods') {
    _currentTab = tab || _currentTab || 'mods';
    // Navigate game menu to our page
    if (isFunc(window.setMenuPage)) window.setMenuPage('nepforge');
    // Activate tab button
    const tabBar = _pageEl?.querySelector('.nep-inner-tabs');
    if (tabBar) {
      tabBar.querySelectorAll('.nep-itab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    }
    _renderTab(tab);
  }

  function registerCustomTab(label, key, renderFn) {
    _customTabs[key] = { label, renderFn };
    // Inject tab button into inner tab bar
    const tabBar = _pageEl?.querySelector('.nep-inner-tabs');
    if (tabBar && !tabBar.querySelector(`[data-tab="${key}"]`)) {
      const btn = document.createElement('button');
      btn.className = 'nep-itab';
      btn.dataset.tab = key;
      btn.textContent = label;
      btn.addEventListener('click', () => openTab(key));
      tabBar.appendChild(btn);
    }
    _info(`Custom tab "${key}" registered.`);
  }

  EventBus.on('forge:log', () => { if (_currentTab === 'log') _renderLog(); }, '_ui');

  return { toast, _updateModList, openTab, registerCustomTab,
           _renderTab: (tab) => { _currentTab = tab; _renderTab(tab); } };
})();

/* ══════════════════════════════════════════════════════════════════════════
   UI Refresher v2 – 无条件刷新 + 防抖 + menuPage 钩子
   核心修复：之前的版本在 document.body.dataset.menupage !== 'forge/workshop'
   时完全跳过刷新，导致注册的新项目只有手动打开对应页面才能看到。
   新版本：调用方（Registry._notify）触发后立刻调度一次 microtask 刷新；
   rebuild 函数（buildForgeChips 等）本身已有 innerHTML='' 保护，
   对隐藏容器执行也是安全的。
   ══════════════════════════════════════════════════════════════════════════ */
const UIRefresher = (() => {
  // 用于防抖的待刷新集合（同类型合并成一次）
  const _pending = new Set();
  let   _rafId   = 0;

  // 核心刷新调度 – 每类 catalog 只在下一帧执行一次
  function _scheduleFlush(catalogType) {
    _pending.add(catalogType);
    if (_rafId) return;
    _rafId = requestAnimationFrame(() => {
      _rafId = 0;
      const batch = new Set(_pending);
      _pending.clear();
      for (const ct of batch) _executeRefresh(ct);
    });
  }


  function _executeRefresh(catalogType) {
    const all = (catalogType === 'ALL');
    try {
      /* ── Bullet Affix ── */
      if (all || catalogType === 'BulletAffixCatalog') {
        if (typeof window.buildForgeChips === 'function') window.buildForgeChips();
        if (typeof window.buildAffixChips === 'function') window.buildAffixChips();
        // 专门重新构建 Emitter Base Mods 面板，以同步新增词条
        _refreshEmitterBaseMods();
      }
      /* ── Enemy Trait ── */
      if (all || catalogType === 'EnemyTraitCatalog') {
        if (typeof window.buildForgeChips === 'function') window.buildForgeChips();
      }
      /* ── Move Pattern ── */
      if (all || catalogType === 'MoveCatalog') {
        if (typeof window.buildForgeMoveChips === 'function') window.buildForgeMoveChips();
      }

      /* ── Emitter & Wrapper ── */
      if (all || catalogType === 'EmitterCatalog' || catalogType === 'PlayerEmitterCatalog' || catalogType === 'CompositeWrappers' || catalogType === 'WrapperFieldDefs') {
        
        // 刷新 Forge 面板的下拉框
        if (typeof window.populateForgeSelects === 'function') window.populateForgeSelects();
        
        // 刷新 Workshop (Player) 面板的 Chip 按钮
        if (typeof window.buildPlayerEmitterChips === 'function') window.buildPlayerEmitterChips();
        
        // 刷新 Wrapper 的所有下拉菜单
        if (typeof _refreshWrapperSelects === 'function') _refreshWrapperSelects();
      }
      /* ── Body Kind / Appearance ── */
      if (all || catalogType === 'BODY_KINDS' || catalogType === 'AppearanceCatalog') {
        _refreshBodyKindSelect();
      }
      /* ── 全局回填 ── */
      if (typeof window.syncForgeUIFromState === 'function') window.syncForgeUIFromState();
      if (typeof window.syncWorkshopFromModel === 'function') window.syncWorkshopFromModel();
      
      // 同步刷新 REF TAB
      try {
        if (typeof UIManager !== 'undefined') {
          const activeTabBtn = document.querySelector('#pageNepForge .nep-inner-tabs .nep-itab.active');
          if (activeTabBtn && activeTabBtn.dataset.tab === 'ref') UIManager._renderTab('ref');
        }
      } catch(_) {}
    } catch(e) {
      try { _warn('[UIRefresher] Refresh error: ' + (e.message || e)); } catch(_) {}
    }
  }

  // 重建 Emitter Base Mods 的动态 Chips（避免在旧逻辑中遗漏）
  function _refreshEmitterBaseMods() {
    const buildPicker = (slot) => {
      const container = document.getElementById(`forgeEm${slot}ModsContainer`);
      if (!container) return;
      container.innerHTML = '';
      const Catalog = typeof _g === 'function' ? _g('BulletAffixCatalog') : window.BulletAffixCatalog;
      if (!Catalog) return;
      const allMods = Object.keys(Catalog).filter(k => !Catalog[k].tags?.includes('_internal'));
      const ForgeState = typeof _g === 'function' ? _g('ForgeState') : window.ForgeState;
      
      allMods.forEach(k => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pick-chip';
        btn.dataset.key = k;
        btn.textContent = k;
        btn.style.fontSize = '9px'; 
        btn.style.padding = '2px 6px';
        btn.addEventListener('click', () => {
          if(!ForgeState[`slot${slot}`]) ForgeState[`slot${slot}`] = {};
          if(!ForgeState[`slot${slot}`].baseMods) ForgeState[`slot${slot}`].baseMods =[];
          const list = ForgeState[`slot${slot}`].baseMods;
          const idx = list.indexOf(k);
          if (idx >= 0) {
            list.splice(idx, 1);
            btn.classList.remove('on');
          } else {
            if (list.length >= 6) return;
            list.push(k);
            btn.classList.add('on');
          }
          if (typeof window.saveForge === 'function') window.saveForge();
          if (typeof window.refreshForgePreview === 'function') window.refreshForgePreview();
        });
        container.appendChild(btn);
      });
    };
    buildPicker(1);
    buildPicker(2);
  }

  // 刷新 Wrapper 的下拉选项，防止事件被绑定多次导致错乱
  function _refreshWrapperSelects() {
    const Cat = typeof _g === 'function' ? _g('CompositeWrappers') : window.CompositeWrappers;
    if (!Cat) return;
    const wrappers = Object.keys(Cat);
    document.querySelectorAll('.comp-selector').forEach(sel => {
      const val = sel.value;
      sel.innerHTML = '<option value="">(NONE)</option>';
      wrappers.forEach(w => {
        const o = document.createElement('option'); o.value = w; o.textContent = w; sel.appendChild(o);
      });
      // 如果原选中的 Wrapper 还在，则重新选中它
      if (wrappers.includes(val)) sel.value = val;
    });
  }

  // 刷新 bodyKind 下拉菜单（增量：只添加缺失项，保留当前选中值）
  function _refreshBodyKindSelect() {
    const bodySel = document.getElementById('forgeBodyKind');
    if (!bodySel) return;
    const currentVal = bodySel.value;

    const allKinds = new Set(['AUTO']);
    const bk = typeof _g === 'function' ? _g('BODY_KINDS') : window.BODY_KINDS;
    if (Array.isArray(bk)) bk.forEach(k => allKinds.add(k));

    const customBK = typeof _g === 'function'
      ? _g('_NEP_CUSTOM_BODY_KINDS') : window._NEP_CUSTOM_BODY_KINDS;
    if (customBK) Object.keys(customBK).forEach(k => allKinds.add(k));

    const existingVals = new Set(Array.from(bodySel.options).map(o => o.value));
    for (const kind of allKinds) {
      if (!existingVals.has(kind)) {
        const opt = document.createElement('option');
        opt.value = kind;
        opt.textContent = kind;
        bodySel.appendChild(opt);
      }
    }
    // 恢复选择
    if (currentVal && bodySel.querySelector(`option[value="${CSS.escape ? CSS.escape(currentVal) : currentVal}"]`)) {
      bodySel.value = currentVal;
    }
  }

  return {
    refreshAll(catalogType /*, key */) {
      _scheduleFlush(catalogType);
    },
    rebuildAll() {
      _scheduleFlush('ALL');
    },
    _refreshBodyKindSelect,
  };
})();

// 注册到 Registry
Registry.setUIRefreshers(UIRefresher);

// 监听 registry 更新事件
EventBus.on('registry:updated', (data) => {
  UIRefresher.refreshAll(data.catalog, data.key);
}, '_ui_refresher');

// 监听 menuPage 切换 → 进入 forge/workshop 时强制全量重建
// （确保 mod 在菜单关闭时注册的项目在下次打开菜单时也能显示）
(function _patchSetMenuPageForRefresh() {
  const _trySMP = () => {
    const orig = window.setMenuPage;
    if (!isFunc(orig) || orig.__nep_uirefresh__) return;
    window.setMenuPage = function(key) {
      orig.call(this, key);
      if (key === 'forge' || key === 'workshop') UIRefresher.rebuildAll();
    };
    window.setMenuPage.__nep_uirefresh__ = true;
  };
  // 尝试立即 patch；若 setMenuPage 尚未挂载则在首次波次/初始化后重试
  _trySMP();
  EventBus.once('forge:tick', () => _trySMP(), '_ui_refresher');
})();


/* ═══════════════════════════════════════════════════════════════════════
   23.5 LOW-CODE UI FRAMEWORK (Hyper-Resilient UI Injector)
   ═══════════════════════════════════════════════════════════════════════
   - 声明式构建：通过 JSON Schema 渲染 DOM。
   - 智能挂载 (Lazy & Live)：即使目标元素当前不存在，也会等待其出现后再注入。
   - 自动清理：卸载 Mod 时不仅移除已注入的 DOM，还会清理等待队列。
   ═══════════════════════════════════════════════════════════════════════ */
const UIFramework = (() => {
  /* ─── 资源追踪 ─────────────────────────────────────── */
  const _registry  = new Map(); // modId → Set<element|handle>
  const _pending   = new Set(); // live inject tasks
  const _reactives = new Map(); // id → ReactiveState
  let   _mo        = null;      // MutationObserver for live inject

  function _track(modId, item) {
    if (!_registry.has(modId)) _registry.set(modId, new Set());
    _registry.get(modId).add(item);
    return item;
  }

  /* ─── 可拖拽 ─────────────────────────────────────── */
  function _makeDraggable(panel, handle) {
    let drag = false, sX, sY, oX, oY;
    const _clampPanelToViewport = () => {
      const vw = window.innerWidth  || document.documentElement.clientWidth  || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const rect = panel.getBoundingClientRect();
      const maxLeft = Math.max(0, vw - rect.width);
      const maxTop  = Math.max(0, vh - rect.height);
      const nextLeft = clamp(rect.left, 0, maxLeft);
      const nextTop  = clamp(rect.top,  0, maxTop);
      panel.style.left = `${nextLeft}px`;
      panel.style.top  = `${nextTop}px`;
      panel.style.transform = 'none';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
      drag = true; sX = e.clientX; sY = e.clientY;
      const r = panel.getBoundingClientRect();
      oX = r.left; oY = r.top;
      try { handle.setPointerCapture(e.pointerId); } catch(_) {}
    });
    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      panel.style.left = (oX + e.clientX - sX) + 'px';
      panel.style.top  = (oY + e.clientY - sY) + 'px';
      panel.style.transform = 'none';
      panel.style.right = panel.style.bottom = 'auto';
      _clampPanelToViewport();
    });
    const end = e => {
      if (drag) {
        drag = false;
        _clampPanelToViewport();
        try { handle.releasePointerCapture(e.pointerId); } catch(_) {}
      }
    };
    handle.addEventListener('pointerup',     end);
    handle.addEventListener('pointercancel', end);
    window.addEventListener('resize', _clampPanelToViewport);
    setTimeout(_clampPanelToViewport, 0);
  }

  /* ─── 核心 Schema Builder ──────────────────────────
     支持的 schema 字段：
       tag, id, class, style(string|object), text, html,
       attrs, data, events, onClick, onInput, onChange,
       children[], setup(el), ref(el), value, placeholder,
       type (for input), disabled, checked, min, max, step
  ─────────────────────────────────────────────────── */
  function _build(schema, modId) {
    if (schema == null)    return document.createTextNode('');
    if (!isObj(schema))    return document.createTextNode(String(schema));

    const el = document.createElement(schema.tag || 'div');

    if (schema.id)       el.id = modId ? `${modId}_${schema.id}` : schema.id;
    if (schema.class)    el.className = schema.class;
if (schema.style != null) {
  // 如果 style 是数组或类数组（例如 NodeList），转换为分号分隔的字符串
  if (Array.isArray(schema.style) || (isObj(schema.style) && typeof schema.style.length === 'number')) {
    el.style.cssText = Array.from(schema.style).join(';');
  }
  // 如果是纯对象（非数组、非函数），安全合并
  else if (isObj(schema.style) && schema.style.constructor === Object) {
    Object.assign(el.style, schema.style);
  }
  // 其他情况（字符串、数字等）作为 cssText 赋值
  else {
    el.style.cssText = String(schema.style);
  }
}
    if (schema.text !== undefined) el.textContent = schema.text;
    if (schema.html !== undefined) el.innerHTML   = schema.html;
    if (schema.value      !== undefined) el.value      = schema.value;
    if (schema.placeholder!== undefined) el.placeholder= schema.placeholder;
    if (schema.type       !== undefined) el.type       = schema.type;
    if (schema.disabled)  el.disabled  = true;
    if (schema.checked    !== undefined) el.checked    = schema.checked;
    if (schema.min        !== undefined) el.min        = schema.min;
    if (schema.max        !== undefined) el.max        = schema.max;
    if (schema.step       !== undefined) el.step       = schema.step;
    if (schema.tabIndex   !== undefined) el.tabIndex   = schema.tabIndex;

    // 事件
    if (isFunc(schema.onClick))  el.addEventListener('click',  schema.onClick);
    if (isFunc(schema.onInput))  el.addEventListener('input',  schema.onInput);
    if (isFunc(schema.onChange)) el.addEventListener('change', schema.onChange);
    if (isObj(schema.events))
      for (const [evt, fn] of Object.entries(schema.events))
        if (isFunc(fn)) el.addEventListener(evt, fn);

    // 属性 & data
    if (isObj(schema.attrs))
      for (const [k, v] of Object.entries(schema.attrs)) el.setAttribute(k, v);
    if (isObj(schema.data))
      for (const [k, v] of Object.entries(schema.data)) el.dataset[k] = v;


    if (Array.isArray(schema.children)) {
      for (const c of schema.children) {
        if (c == null) continue;
        
        // 增加对直接传入 DOM 节点的处理
        if (c instanceof Node) {
          el.appendChild(c);
        } else {
          // 递归处理 schema 对象
          el.appendChild(_build(c, modId));
        }
      }
    }

    // ref 回调（同步，构建完成后）
    if (isFunc(schema.ref)) schema.ref(el);

    // setup 回调（异步，保证 DOM 已附加）
    if (isFunc(schema.setup)) Promise.resolve().then(() => schema.setup(el));

    return el;
  }

  /* ─── Live Inject Observer ─────────────────────── */
  function _startObserver() {
    if (_mo) return;
    _mo = new MutationObserver(() => {
      if (!_pending.size) return;
      for (const task of [..._pending]) {
        for (const target of document.querySelectorAll(task.selector)) {
          const marker = `data-nep-inj-${task.modId}-${task.id}`;
          if (target.hasAttribute(marker)) continue;
          target.setAttribute(marker, '1');
          const el = _build(task.schema, task.modId);
          _track(task.modId, el);
          target.insertAdjacentElement(task.position, el);
          if (!task.live) _pending.delete(task);
        }
      }
    });
    _mo.observe(document.documentElement, { childList: true, subtree: true });
  }

/* ═══════════════════════════════════════════════
     REACTIVE STATE SYSTEM
     UIFramework.reactive.state({ x: 0 })
     → { get/set, subscribe, bind }
  ═══════════════════════════════════════════════ */
  const reactive = (() => {
    const _states = new Map();

    function state(initialData, options = {}) {
      const id  = options.id || uid();
      const subs =[];
      let   data = { ...initialData };

      const proxy = new Proxy(data, {
        get(t, k) { return t[k]; },
        set(t, k, v) {
          const old = t[k];
          t[k] = v;
          if (old !== v) subs.forEach(fn => { try { fn(t, k, v, old); } catch(_) {} });
          return true;
        }
      });

      const handle = {
        get(key)   { return data[key]; },
        set(key, v){ proxy[key] = v; return handle; },
        update(patch) { Object.assign(proxy, patch); return handle; },
        subscribe(fn) { subs.push(fn); return () => { const i = subs.indexOf(fn); if (i >= 0) subs.splice(i, 1); }; },
        
        bind(el, mapper) {
          // ✨ FIX: 增加错误日志输出，避免 mapper 出错被静默吞掉
          const apply = (d) => { 
            try { 
              mapper(d, el); 
            } catch(err) { 
              console.error('[NEPForge] Reactive mapper error:', err); 
            } 
          };
          
          apply(data); // 立即应用一次
          const unsub = handle.subscribe((d) => apply(d));
          
          // ✨ FIX: 防止 IntersectionObserver 的异步首次触发将其误杀
          if (typeof IntersectionObserver !== 'undefined') {
            let isInitialCheck = true; // 标记首次执行
            
            const io = new IntersectionObserver(entries => {
              if (isInitialCheck) {
                isInitialCheck = false;
                return; // 跳过 Observer 创建瞬间的第一次回调
              }
              // 只有当元素确实不再存在于 DOM 树中时才解除订阅
              if (!el.isConnected && !document.contains(el)) { 
                unsub(); 
                io.disconnect(); 
              }
            });
            io.observe(el);
          }
          return unsub;
        },
        snapshot() { return { ...data }; },
      };

      if (options.id) _states.set(id, handle);
      return handle;
    }

    return { state, get: (id) => _states.get(id) };
  })();

  /* ═══════════════════════════════════════════════
     SHARED CROSS-MOD UI STORE
     UIFramework.shared.store(key, initial)
     多 Mod 可读写同一状态，互操作安全
  ═══════════════════════════════════════════════ */
  const shared = (() => {
    const _stores = new Map();

    function store(key, initial = {}) {
      if (!_stores.has(key)) {
        _stores.set(key, reactive.state(initial, { id: key }));
      }
      return _stores.get(key);
    }

    const _widgets = new Map();
    function registerWidget(key, factory) { _widgets.set(key, factory); }
    function getWidget(key, ...args) {
      const f = _widgets.get(key);
      if (!f) { _warn(`UIFramework.shared: widget "${key}" not found`); return null; }
      return f(...args);
    }

    return { store, registerWidget, getWidget };
  })();

  /* ═══════════════════════════════════════════════
     GAME UI INTEGRATION
     UIFramework.gameUI.*
  ═══════════════════════════════════════════════ */
  const gameUI = {
    /** 导航到游戏菜单页（forge / workshop / home / 自定义） */
    setPage(key) {
      if (isFunc(window.setMenuPage)) window.setMenuPage(key);
    },
    /** 获取当前菜单页 */
    getPage() {
      return document.body?.dataset?.menupage || 'home';
    },
    /** 监听菜单页切换 */
    onPageChange(fn) {
      return EventBus.on('menuPage:changed', fn, '_uiFramework');
    },
    /** 向指定游戏页内部注入 schema，返回注入句柄 */
    injectIntoPage(pageKey, schema, position = 'beforeend') {
      const pageId = pageKey === 'forge'    ? '#pageForge'
                   : pageKey === 'workshop' ? '#pageWorkshop'
                   : pageKey === 'home'     ? '#pageHome'
                   : pageKey;
      return inject(pageId, schema, '_gameUI', { position, live: true });
    },
    /** 向游戏 HUD 注入元素 */
    injectIntoHUD(schema, position = 'beforeend') {
      return inject('.ui', schema, '_gameUI', { position, live: true });
    },
    /** 游戏风格 toast（透传到 UIManager） */
    toast(msg, color, duration) {
      UIManager.toast(msg, color, duration);
    },
    /** 在画面上弹出伤害数字（如游戏内 textPop） */
    textPop(x, y, text, color = '#52E6FF') {
      safeCall(_g('textPop'), [x, y, text, color], 'textPop');
    },
  };

  /* ═══════════════════════════════════════════════
     PRESET COMPONENT LIBRARY
     UIFramework.components.*
     每个函数返回 HTMLElement，同时支持传入 modId 便于追踪。
  ═══════════════════════════════════════════════ */
  const components = {

    /* ── 样式主题变量（从游戏 CSS 变量继承） ── */
    _css: {
      cyan:    'var(--c-cyan,    #52E6FF)',
      magenta: 'var(--c-magenta, #B36CFF)',
      yellow:  'var(--c-yellow,  #FFB020)',
      danger:  'var(--c-danger,  #FF2F57)',
      bg:      'var(--c-bg,      #0E1738)',
      panel:   'var(--c-panel,   rgba(14,23,56,0.85))',
      border:  'var(--c-panel-border, rgba(82,230,255,0.3))',
      mono:    '"Consolas","Monaco","Courier New",monospace',
    },

    /**
     * 标题 / 分节标头
     * @param {{text, color, size, style}} opts
     */
    heading({ text = '', color, size = 11, style = '' } = {}) {
      return _build({
        tag: 'div',
        class: 'nep-section',
        style: `font-size:${size}px;letter-spacing:1px;text-transform:uppercase;`
               + (color ? `color:${color};` : '') + style,
        text,
      }, null);
    },

    separator() {
      return _build({ tag: 'hr', style: `border:none;border-top:1px solid rgba(82,230,255,0.15);margin:8px 0;` }, null);
    },

    /**
     * 按钮
     * @param {{label, color, onClick, small, style, disabled}} opts
     */
    button({ label = 'OK', color, onClick, small = false, style = '', disabled = false } = {}) {
      return _build({
        tag: 'button',
        class: small ? 'nep-btn' : 'nep-btn',
        style: (color ? `border-color:${color};color:${color};` : '') + (small ? 'padding:2px 8px;font-size:10px;' : '') + style,
        text: label,
        disabled,
        onClick,
      }, null);
    },

    /**
     * 标签 (Badge / Chip)
     * @param {{text, color, onClick}} opts
     */
    badge({ text = '', color = '#52E6FF', onClick } = {}) {
      const el = _build({
        tag: 'span',
        class: 'nep-chip',
        style: `border-color:${color};color:${color};cursor:${onClick?'pointer':'default'}`,
        text,
        onClick,
      }, null);
      return el;
    },

    /**
     * 进度条
     * @param {{value, max, color, height, label, style}} opts
     * 返回 el，同时暴露 el.setValue(v) 方法
     */
    progress({ value = 0, max = 100, color = '#52E6FF', height = 6, label, style = '' } = {}) {
      const pct = () => clamp((value / max) * 100, 0, 100).toFixed(1);
      const valueEl = _build({
        tag: 'span',
        style: `font-family:monospace;font-size:10px;color:${color};min-width:52px;text-align:right;display:inline-block;flex:0 0 auto;`,
        text: `${pct()}%`,
      }, null);
      const bar = _build({
        tag: 'div',
        style: `height:${height}px;background:rgba(82,230,255,0.12);border-radius:${height}px;overflow:hidden;flex:1 1 auto;min-width:0;`,
        children: [{
          tag: 'div',
          style: `height:100%;width:${pct()}%;background:${color};border-radius:${height}px;transition:width 0.2s;`,
        }],
      }, null);
      const inner = bar.firstChild;
      const wrapper = _build({
        tag: 'div', style: style,
        children: [
          label ? { tag: 'div', style: 'font-size:10px;color:#aaa;margin-bottom:3px;', text: label } : null,
          { tag: 'div', style: 'display:flex;align-items:center;gap:6px;min-width:0;', children:[bar, valueEl] },
        ].filter(Boolean),
      }, null);
      wrapper.setValue = (v) => {
        value = v;
        const cur = pct();
        inner.style.width = cur + '%';
        valueEl.textContent = `${cur}%`;
      };
      return wrapper;
    },

    /**
     * 滑块（带数值标签）
     * @param {{label, min, max, step, value, color, onChange, style}} opts
     * 返回 el，el.getValue() / el.setValue(v)
     */
    slider({ label = '', min = 0, max = 100, step = 1, value = 50,
             color = '#52E6FF', onChange, style = '' } = {}) {
      let _val = value;
      const numEl = document.createElement('span');
      numEl.textContent = _val;
      numEl.style.cssText = `font-family:monospace;font-size:11px;color:${color};min-width:52px;display:inline-block;text-align:right;flex:0 0 auto;`;

      const inp = document.createElement('input');
      inp.type  = 'range';
      inp.min   = min; inp.max = max; inp.step = step; inp.value = _val;
      inp.style.cssText = `flex:1 1 auto;min-width:0;accent-color:${color};margin:0 6px;`;
      inp.addEventListener('input', () => {
        _val = Number(inp.value);
        numEl.textContent = _val;
        if (isFunc(onChange)) { try { onChange(_val, inp); } catch(_) {} }
      });

      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:4px;min-width:0;${style}`;
      if (label) {
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:10px;color:#aaa;white-space:nowrap;max-width:45%;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto;';
        row.appendChild(lbl);
      }
      row.appendChild(inp);
      row.appendChild(numEl);

      row.getValue = () => _val;
      row.setValue = (v) => {
        _val = Number(v);
        inp.value = _val;
        numEl.textContent = _val;
      };
      return row;
    },

    /**
     * 开关（Toggle Switch）
     * @param {{label, checked, color, onChange, style}} opts
     * 返回 el，el.isOn() / el.setOn(bool)
     */
    toggle({ label = '', checked = false, color = '#52E6FF', onChange, style = '' } = {}) {
      let _on = checked;
      const track = document.createElement('div');
      track.style.cssText = `display:inline-block;width:32px;height:18px;border-radius:9px;position:relative;cursor:pointer;border:1px solid ${color};background:${_on ? color : 'transparent'};transition:background 0.2s;flex-shrink:0;`;
      const thumb = document.createElement('div');
      thumb.style.cssText = `position:absolute;width:12px;height:12px;border-radius:50%;background:${_on ? '#000' : color};top:2px;left:${_on?'16px':'2px'};transition:left 0.18s,background 0.2s;`;
      track.appendChild(thumb);

      const wrapper = document.createElement('div');
      wrapper.style.cssText = `display:flex;align-items:center;gap:6px;cursor:pointer;${style}`;
      if (label) {
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:11px;color:#ccc;';
        wrapper.appendChild(lbl);
      }
      wrapper.appendChild(track);

      const _sync = () => {
        track.style.background = _on ? color : 'transparent';
        thumb.style.left       = _on ? '16px' : '2px';
        thumb.style.background = _on ? '#000' : color;
      };
      wrapper.addEventListener('click', () => {
        _on = !_on; _sync();
        if (isFunc(onChange)) { try { onChange(_on, wrapper); } catch(_) {} }
      });

      wrapper.isOn   = () => _on;
      wrapper.setOn  = (v) => { _on = !!v; _sync(); };
      return wrapper;
    },

    /**
     * 下拉选择框
     * @param {{label, options:[{value,text}], value, color, onChange, style}} opts
     * 返回 el，el.getValue() / el.setValue(v)
     */
    select({ label = '', options = [], value, color = '#52E6FF', onChange, style = '' } = {}) {
      const sel = document.createElement('select');
      sel.style.cssText = `background:#111;color:${color};border:1px solid ${color};border-radius:3px;padding:3px 6px;font-size:11px;font-family:monospace;`;
      options.forEach(o => {
        const opt = document.createElement('option');
        opt.value   = o.value ?? o;
        opt.textContent = o.text ?? o.label ?? o.value ?? o;
        sel.appendChild(opt);
      });
      if (value !== undefined) sel.value = value;
      sel.addEventListener('change', () => {
        if (isFunc(onChange)) { try { onChange(sel.value, sel); } catch(_) {} }
      });

      const wrapper = document.createElement('div');
      wrapper.style.cssText = `display:flex;align-items:center;gap:6px;${style}`;
      if (label) {
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:10px;color:#aaa;white-space:nowrap;';
        wrapper.appendChild(lbl);
      }
      wrapper.appendChild(sel);
      wrapper.getValue = () => sel.value;
      wrapper.setValue = (v) => { sel.value = v; };
      return wrapper;
    },

    /**
     * 文本输入框
     * @param {{label, value, placeholder, type, color, onInput, onChange, style}} opts
     */
    input({ label = '', value = '', placeholder = '', type = 'text',
            color = '#52E6FF', onInput, onChange, style = '' } = {}) {
      const inp = document.createElement('input');
      inp.type        = type;
      inp.value       = value;
      inp.placeholder = placeholder;
      inp.style.cssText = `background:#111;color:${color};border:1px solid ${color};border-radius:3px;padding:3px 6px;font-size:11px;font-family:monospace;flex:1;`;
      if (isFunc(onInput))  inp.addEventListener('input',  () => { try { onInput(inp.value, inp);  } catch(_) {} });
      if (isFunc(onChange)) inp.addEventListener('change', () => { try { onChange(inp.value, inp); } catch(_) {} });

      const wrapper = document.createElement('div');
      wrapper.style.cssText = `display:flex;align-items:center;gap:6px;${style}`;
      if (label) {
        const lbl = document.createElement('span');
        lbl.textContent = label;
        lbl.style.cssText = 'font-size:10px;color:#aaa;white-space:nowrap;';
        wrapper.appendChild(lbl);
      }
      wrapper.appendChild(inp);
      wrapper.getValue = () => inp.value;
      wrapper.setValue = (v) => { inp.value = v; };
      return wrapper;
    },

    /**
     * 统计值显示（label + value，响应式）
     * @param {{label, value, color, style}} opts
     * 返回 el，el.update(v) 更新显示值
     */
    stat({ label = '', value = '', color = '#52E6FF', style = '' } = {}) {
      const valEl = document.createElement('span');
      valEl.textContent = value;
      valEl.style.cssText = `color:${color};font-family:monospace;font-size:12px;font-weight:bold;`;
      const wrapper = document.createElement('div');
      wrapper.style.cssText = `display:flex;justify-content:space-between;align-items:center;padding:2px 0;${style}`;
      const lbl = document.createElement('span');
      lbl.textContent = label;
      lbl.style.cssText = 'font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;';
      wrapper.appendChild(lbl);
      wrapper.appendChild(valEl);
      wrapper.update = (v) => { valEl.textContent = v; };
      return wrapper;
    },

    /**
     * 选项卡容器
     * @param {{tabs:[{key,label,content:schema|fn}], default, style, onSwitch}} opts
     * 返回 el，el.switchTo(key) 切换 tab
     */
    tabs({ tabs = [], default: defKey, style = '', onSwitch } = {}) {
      const tabBar = document.createElement('div');
      tabBar.style.cssText = 'display:flex;gap:4px;border-bottom:1px solid rgba(82,230,255,0.2);margin-bottom:8px;';
      const body = document.createElement('div');

      const buttons = {};
      const _switch = (key) => {
        for (const [k, b] of Object.entries(buttons))
          b.classList.toggle('active', k === key);
        body.innerHTML = '';
        const tab = tabs.find(t => t.key === key);
        if (tab) {
          const content = isFunc(tab.content) ? tab.content(key) : _build(tab.content || {}, null);
          body.appendChild(content instanceof Node ? content : document.createTextNode(String(content)));
        }
        if (isFunc(onSwitch)) { try { onSwitch(key); } catch(_) {} }
      };

      tabs.forEach(tab => {
        const btn = document.createElement('button');
        btn.textContent = tab.label || tab.key;
        btn.className   = 'nep-itab';
        btn.style.cssText = 'padding:4px 10px;font-size:10px;background:none;border:none;cursor:pointer;color:#aaa;border-bottom:2px solid transparent;';
        btn.addEventListener('click', () => _switch(tab.key));
        tabBar.appendChild(btn);
        buttons[tab.key] = btn;
      });

      const wrapper = document.createElement('div');
      wrapper.style.cssText = style;
      wrapper.appendChild(tabBar);
      wrapper.appendChild(body);
      wrapper.switchTo = _switch;

      _switch(defKey || tabs[0]?.key);
      return wrapper;
    },

    /**
     * 多选 Chip Picker（游戏风格选择器）
     * @param {{items:[{key,label}], selected:Set, max, onToggle, color, style}} opts
     * 返回 el，el.getSelected() → Set；el.setSelected(Set)
     */
    chipPicker({ items = [], selected = new Set(), max = Infinity,
                 onToggle, color = '#52E6FF', style = '' } = {}) {
      const wrapper = document.createElement('div');
      wrapper.className = 'chip-pick';
      wrapper.style.cssText = style;

      const chips = {};
      const _sel = new Set(selected);

      items.forEach(item => {
        const key   = isObj(item) ? item.key : item;
        const label = isObj(item) ? (item.label || key) : key;
        const btn   = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'pick-chip';
        btn.dataset.key = key;
        btn.textContent = label;
        btn.style.cssText = _sel.has(key) ? `border-color:${color};color:${color};` : '';
        btn.classList.toggle('on', _sel.has(key));

        btn.addEventListener('click', () => {
          if (_sel.has(key)) {
            _sel.delete(key);
          } else {
            if (_sel.size >= max) return;
            _sel.add(key);
          }
          btn.classList.toggle('on', _sel.has(key));
          if (isFunc(onToggle)) { try { onToggle(key, _sel.has(key), _sel); } catch(_) {} }
        });
        chips[key] = btn;
        wrapper.appendChild(btn);
      });

      wrapper.getSelected = () => new Set(_sel);
      wrapper.setSelected = (newSel) => {
        _sel.clear();
        for (const k of newSel) _sel.add(k);
        Object.entries(chips).forEach(([k, b]) => b.classList.toggle('on', _sel.has(k)));
      };
      wrapper.addItem = (item) => {
        const key   = isObj(item) ? item.key : item;
        const label = isObj(item) ? (item.label || key) : key;
        if (chips[key]) return;
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'pick-chip';
        btn.dataset.key = key; btn.textContent = label;
        btn.classList.toggle('on', _sel.has(key));
        btn.addEventListener('click', () => {
          if (_sel.has(key)) { _sel.delete(key); }
          else { if (_sel.size >= max) return; _sel.add(key); }
          btn.classList.toggle('on', _sel.has(key));
          if (isFunc(onToggle)) { try { onToggle(key, _sel.has(key), _sel); } catch(_) {} }
        });
        chips[key] = btn;
        wrapper.appendChild(btn);
      };
      return wrapper;
    },

    /**
     * 模态对话框
     * @param {{title, content:schema|Node|string, buttons:[{label,color,onClick}],
     *          onClose, style, backdropClose}} opts
     * 返回 { el, close() }
     */
    modal({ title = '', content, buttons = [], onClose, style = '',
            backdropClose = true } = {}) {
      const backdrop = document.createElement('div');
      backdrop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:60000;display:flex;align-items:center;justify-content:center;';

      const panel = document.createElement('div');
      panel.className = 'cyber-panel';
      panel.style.cssText = `min-width:260px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;z-index:60001;overflow:hidden;${style}`;

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'padding:10px 14px;border-bottom:1px solid rgba(82,230,255,0.2);display:flex;justify-content:space-between;align-items:center;background:rgba(0,0,0,0.3);';
      const titleEl = document.createElement('span');
      titleEl.style.cssText = 'font-size:12px;letter-spacing:1px;color:#52E6FF;text-transform:uppercase;';
      titleEl.textContent = title;
      const closeBtn = document.createElement('button');
      closeBtn.className = 'mini-btn danger';
      closeBtn.textContent = '✕';
      closeBtn.style.cssText = 'padding:2px 7px;font-size:11px;';
      header.appendChild(titleEl); header.appendChild(closeBtn);

      // Body
      const bodyEl = document.createElement('div');
      bodyEl.style.cssText = 'padding:14px;overflow-y:auto;flex:1;';
      if (content) {
        if (content instanceof Node) bodyEl.appendChild(content);
        else if (isObj(content))     bodyEl.appendChild(_build(content, null));
        else                          bodyEl.innerHTML = String(content);
      }

      // Footer
      let footer = null;
      if (buttons.length) {
        footer = document.createElement('div');
        footer.style.cssText = 'padding:8px 14px;border-top:1px solid rgba(82,230,255,0.15);display:flex;gap:8px;justify-content:flex-end;';
        buttons.forEach(b => {
          const btn = document.createElement('button');
          btn.className = 'nep-btn';
          btn.textContent = b.label || 'OK';
          if (b.color) btn.style.cssText = `border-color:${b.color};color:${b.color};`;
          btn.addEventListener('click', () => {
            if (isFunc(b.onClick)) { try { b.onClick(handle); } catch(_) {} }
            if (b.close !== false) handle.close();
          });
          footer.appendChild(btn);
        });
      }

      panel.appendChild(header);
      panel.appendChild(bodyEl);
      if (footer) panel.appendChild(footer);
      backdrop.appendChild(panel);

      const handle = {
        el: backdrop,
        close() {
          backdrop.remove();
          if (isFunc(onClose)) { try { onClose(); } catch(_) {} }
        }
      };
      closeBtn.addEventListener('click', () => handle.close());
      if (backdropClose) {
        backdrop.addEventListener('click', e => {
          if (e.target === backdrop) handle.close();
        });
      }
      document.body.appendChild(backdrop);
      return handle;
    },

    /**
     * HUD 浮层元素（绑定到画布层，不受菜单遮挡）
     * @param {{schema, id, style}} opts
     * 返回 el
     */
    hud({ schema, id, style = '' } = {}) {
      const el = isObj(schema) ? _build(schema, null) : document.createElement('div');
      el.style.position   = el.style.position   || 'fixed';
      el.style.pointerEvents = el.style.pointerEvents || 'none';
      el.style.zIndex     = el.style.zIndex     || '9500';
      if (id)    el.id    = id;
      if (style) el.style.cssText += style;
      document.body.appendChild(el);
      return el;
    },

    /**
     * 折叠面板（Accordion）
     * @param {{title, content:schema|Node, open, color, style}} opts
     */
    accordion({ title = '', content, open = false, color = '#52E6FF', style = '' } = {}) {
      const details = document.createElement('details');
      details.open = open;
      details.style.cssText = `border:1px solid rgba(82,230,255,0.2);border-radius:3px;margin:4px 0;${style}`;
      const summary = document.createElement('summary');
      summary.textContent = title;
      summary.style.cssText = `padding:6px 10px;cursor:pointer;font-size:11px;color:${color};letter-spacing:0.5px;list-style:none;`;
      const body = document.createElement('div');
      body.style.cssText = 'padding:8px 10px;';
      if (content) {
        if (content instanceof Node) body.appendChild(content);
        else if (isObj(content))     body.appendChild(_build(content, null));
        else                          body.textContent = String(content);
      }
      details.appendChild(summary);
      details.appendChild(body);
      return details;
    },

    /**
     * 表格
     * @param {{columns:[{key,label,width}], rows:object[], style, color}} opts
     * 返回 el，el.setRows(rows) 更新数据
     */
    table({ columns = [], rows = [], style = '', color = '#52E6FF' } = {}) {
      const table = document.createElement('table');
      table.style.cssText = `width:100%;border-collapse:collapse;font-size:10px;font-family:monospace;${style}`;
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.label || col.key;
        th.style.cssText = `color:${color};border-bottom:1px solid ${color};padding:3px 6px;text-align:left;font-weight:600;` + (col.width ? `width:${col.width};` : '');
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      const tbody = document.createElement('tbody');
      table.appendChild(thead);
      table.appendChild(tbody);

      const _renderRows = (data) => {
        tbody.innerHTML = '';
        data.forEach((row, i) => {
          const tr = document.createElement('tr');
          tr.style.cssText = `background:${i%2 ? 'rgba(82,230,255,0.03)' : 'transparent'};`;
          columns.forEach(col => {
            const td = document.createElement('td');
            td.style.cssText = 'color:#ccc;padding:3px 6px;border-bottom:1px solid rgba(82,230,255,0.07);';
            td.textContent = row[col.key] ?? '';
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      };
      _renderRows(rows);
      table.setRows = _renderRows;
      return table;
    },
  }; // end components

  /* ─── inject（智能注入） ──────────────────────── */
  function inject(selector, schema, modId, opts = {}) {
    const position = typeof opts === 'string' ? opts : (opts.position || 'beforeend');
    const live     = typeof opts === 'object' ? !!opts.live : false;
    const taskId   = uid();
    const task     = { selector, schema, modId, position, live, id: taskId };

    let injected = false;
    for (const target of document.querySelectorAll(selector)) {
      const marker = `data-nep-inj-${modId}-${taskId}`;
      if (target.hasAttribute(marker)) continue;
      target.setAttribute(marker, '1');
      const el = _build(schema, modId);
      _track(modId, el);
      target.insertAdjacentElement(position, el);
      injected = true;
    }

    if (!injected || live) { _pending.add(task); _startObserver(); }

    const handle = { remove: () => { _pending.delete(task); } };
    _track(modId, handle);
    return handle;
  }

  /* ─── floatingPanel ────────────────────────────── */
  function floatingPanel(schema, modId) {
    const header = {
      tag: 'div', class: '_nep_drag_handle',
      style: 'padding:8px 12px;background:rgba(0,0,0,0.5);cursor:move;font-weight:bold;font-size:12px;color:#52E6FF;border-bottom:1px solid rgba(82,230,255,0.3);display:flex;justify-content:space-between;align-items:center;',
      children: [
        { tag: 'span', text: schema.title || 'MOD PANEL' },
        { tag:'div', style:'display:flex;gap:4px;',
          children: [
            schema.minimizeBtn !== false ? {
              tag: 'button', class: 'mini-btn', text: (schema.startMinimized ? '▢' : '—'),
              attrs: { title: 'Minimize panel' },
              style: 'padding:2px 6px;font-size:10px;',
              onClick: (e) => {
                const panel = e.target.closest('.cyber-panel');
                if (!panel) return;
                const body = panel.querySelector('._nep_panel_body');
                if (!body) return;
                const collapsed = body.style.display === 'none';
                body.style.display = collapsed ? '' : 'none';
                panel.dataset.minimized = collapsed ? '0' : '1';
                e.target.textContent = collapsed ? '—' : '▢';
              },
            } : null,
            schema.closeBtn !== false ? {
              tag: 'button', class: 'mini-btn danger', text: 'X',
              style: 'padding:2px 6px;font-size:10px;',
              onClick: (e) => { e.target.closest('.cyber-panel').style.display = 'none'; },
            } : null,
          ]
        },
      ],
    };
    const panelSchema = {
      tag: 'div', class: 'cyber-panel',
      style: (() => {
  const base = {
    position: 'fixed', top: '20%', left: '20%', zIndex: 65000,
    minWidth: '220px', maxWidth: 'min(94vw, 420px)', maxHeight: 'min(82vh, 760px)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'auto',
  };
  // 只有当 schema.style 是普通对象时才合并
  if (isObj(schema.style) && schema.style.constructor === Object) {
    return Object.assign(base, schema.style);
  }
  return base;
})(),
      children: [header, { tag: 'div', class: '_nep_panel_body', style: `padding:12px;overflow:auto;overflow-x:hidden;word-break:break-word;overscroll-behavior:contain;${schema.startMinimized ? 'display:none;' : ''}`, children: schema.children }],
    };
    const panel = _build(panelSchema, modId);
    _makeDraggable(panel, panel.querySelector('._nep_drag_handle'));
    _track(modId, panel);
    document.body.appendChild(panel);
    return panel;
  }

  /* ─── cleanup ─────────────────────────────────── */
  function cleanup(modId) {
    for (const item of (_registry.get(modId) || [])) {
      try { if (item?.remove && isFunc(item.remove)) item.remove(); } catch(_) {}
    }
    _registry.delete(modId);
    for (const task of _pending) {
      if (task.modId === modId) _pending.delete(task);
    }
  }

  /* ─── Public ─────────────────────────────────── */
  return {
    build:   _build,
    inject,
    floatingPanel,
    cleanup,
    reactive,
    shared,
    gameUI,
    components,
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   24. EXAMPLE MOD TEMPLATES
   展示了 v4.5 最新的 Watch 属性拦截器与系统级 DOM/Event 拦截功能。
   ═══════════════════════════════════════════════════════════════════════ */
const _EXAMPLES = {

  /* bigBullets: wave hook now runs AFTER WaveDirector.onWave */
  bigBullets: JSON.stringify({
    id:'example-big-bullets', name:'Big Bullets', version:'1.0',
    description:'Enemy bullets 1.5× larger; injected into each wave deck',
    affixes: {
      ENEMY_OVERSIZED: {
        tags:['stat'], minWave:1, weight:1.5,
        onSpawn:'if(b.team==="E"){ b.r*=1.5; b.dmg*=1.1; }'
      }
    },
    hooks: {
      wave:`if(WaveDirector?.deck){
  WaveDirector.deck.forEach(p=>{
    if(!p.waveBulletMods.includes("ENEMY_OVERSIZED"))
      p.waveBulletMods.unshift("ENEMY_OVERSIZED");
  });
}`
    }
  }, null, 2),

  speedDemon: JSON.stringify({
    id:'example-speed-demon', name:'Speed Demon', version:'1.0',
    description:'Player bullets +50% speed, -20% lifetime',
    hooks: {
      bulletSpawn:`if(b&&b.team==="P"&&!b._sdBoosted){
  const sp=Math.hypot(b.vx,b.vy);
  if(sp>0){ b.vx=b.vx/sp*(sp*1.5); b.vy=b.vy/sp*(sp*1.5); }
  b.life*=0.8; b._sdBoosted=true;
}`
    },
    loadMessage:'SPEED DEMON ACTIVE'
  }, null, 2),

  waveBomb: JSON.stringify({
    id:'example-wave-bomb', name:'Wave Bomb', version:'1.0',
    description:'Shockwave ring every 3 waves',
    hooks: {
      wave:`const cx=W*0.5||200, cy=H*0.5||300;
if((wave%3)===0 && spawnShockwave){
  for(let i=0;i<8;i++) setTimeout(()=>{
    spawnShockwave(cx,cy,'#FFB020',320,.5);
    textPop&&textPop(cx,cy,'WAVE BOMB!','#FFB020');
  }, i*120);
}`
    }
  }, null, 2),

  fortressPlus: JSON.stringify({
    id:'example-fortress-plus', name:'Fortress+', version:'1.0',
    description:'New structure: plasma cannon that locks onto nearest enemy',
    structures: {
      plasma_cannon: {
        cost:12, w:28, h:28, hp:450, col:'#B36CFF', type:'plasma_cannon',
        behavior: {
          onCreate(st) { st.cd=0; },
          onUpdate(st, dt) {
            st.cd -= dt;
            if (st.cd > 0) return;
            const t = findNearestEnemy?.(st.x, st.y, 500);
            if (!t) return;
            const a = Math.atan2(t.y-st.y, t.x-st.x);
            spawnBullet?.('P',st.x,st.y,Math.cos(a)*700,Math.sin(a)*700,
              {r:4,dmg:55+(Game?.wave||1)*2.5,col:'#B36CFF',life:1.2,pierce:2});
            st.cd = 0.6;
          }
        }
      }
    }
  }, null, 2),

  prismOverdrive: JSON.stringify({
    id:'example-prism-overdrive', name:'Prism Overdrive', version:'1.0',
    description:'Player rounds cycle spectral buffs: split, pierce, and reactive crit glow',
    hooks: {
      bulletSpawn:`if(!b || b.team!=="P") return;
const wave = Game?.wave || 1;
const mode = (wave + Math.floor((performance?.now?.()||0)/700)) % 3;
if(mode===0){
  if(!b._prismSplit){
    b._prismSplit = true;
    const a = Math.atan2(b.vy, b.vx);
    const sp = Math.hypot(b.vx, b.vy) || 520;
    const d = 0.18;
    spawnBullet?.('P', b.x, b.y, Math.cos(a+d)*sp, Math.sin(a+d)*sp,
      { r:Math.max(2,(b.r||2)-0.4), dmg:(b.dmg||8)*0.62, life:(b.life||0.7)*0.85, col:'#52E6FF' });
    spawnBullet?.('P', b.x, b.y, Math.cos(a-d)*sp, Math.sin(a-d)*sp,
      { r:Math.max(2,(b.r||2)-0.4), dmg:(b.dmg||8)*0.62, life:(b.life||0.7)*0.85, col:'#FF4FCB' });
  }
} else if(mode===1){
  b.pierce = Math.max(2, b.pierce||0);
  b.col = '#7DFFB2';
  b.life = (b.life||0.8)*1.08;
} else {
  if(Math.random() < 0.17){
    b.dmg = (b.dmg||8) * 2.2;
    b.r = (b.r||2) * 1.25;
    b.col = '#FFD15C';
    textPop?.(b.x,b.y,'CRIT','#FFD15C');
  }
}`
    },
    loadMessage:'PRISM OVERDRIVE ONLINE'
  }, null, 2),

  chronoAnchor: JSON.stringify({
    id:'example-chrono-anchor', name:'Chrono Anchor', version:'1.0',
    description:'Every 4th wave creates a temporal anchor that slows nearby enemies and beams them',
    structures: {
      chrono_anchor: {
        cost:16, w:32, h:32, hp:620, col:'#6C8CFF', type:'chrono_anchor',
        behavior: {
          onCreate(st){ st.cd=0; st.pulse=0; },
          onUpdate(st, dt){
            st.cd -= dt; st.pulse += dt;
            const es = enemies || [];
            for(const e of es){
              const dx=e.x-st.x, dy=e.y-st.y;
              const d2=dx*dx+dy*dy;
              if(d2 < 220*220){
                e.vx *= 0.985;
                e.vy *= 0.985;
                if(st.pulse > 0.4){
                  textPop?.(e.x, e.y, 'TIME LOCK', '#6C8CFF');
                }
              }
            }
            if(st.pulse > 0.4){ st.pulse = 0; }
            if(st.cd > 0) return;
            const t = findNearestEnemy?.(st.x, st.y, 380);
            if(!t) return;
            spawnBeam?.(st.x, st.y, t.x, t.y, '#6C8CFF', 1.2, 22);
            spawnBullet?.('P', st.x, st.y, 0, 0, { r:1, dmg:18+(Game?.wave||1)*1.3, life:0.01, col:'#6C8CFF' });
            st.cd = 0.5;
          }
        }
      }
    },
    hooks: {
      wave:`if((wave%4)===0 && Fortress?.structures){
  Fortress.structures.push({
    type:'chrono_anchor',
    x:(W||400)*0.5 + (Math.random()*120-60),
    y:(H||600)*0.5 + 140 + (Math.random()*40-20),
    hp:620,maxHp:620,col:'#6C8CFF',w:32,h:32,cd:0,pulse:0
  });
  textPop?.((W||400)*0.5,(H||600)*0.5+110,'CHRONO ANCHOR','#6C8CFF');
}`
    }
  }, null, 2),

  vampireHook: `// Watch API Demo: 拦截分数获取，造成伤害回血
NEPForge.install({
  id:'vampire-hook', name:'Vampire Drain & Score Double', version:'1.0',
  description:'使用 Watch API 拦截 Player 的血量与分数属性',
  init(api) {
    // 1. 拦截 Game.score，实现分数双倍获取
    api.patch.watch(window.Game, 'score', {
      set(newVal, oldVal) {
        if (newVal > oldVal) {
          const diff = newVal - oldVal;
          return oldVal + diff * 2; // 篡改赋值：获取双倍分数
        }
        return newVal;
      }
    });

    // 2. 敌人死亡时回血 (不在高频事件写 log)
    api.events.on('enemySpawn', () => {
      const p = api.player;
      if (p.alive && p.hp < p.maxHp) {
        p.setStat('hp', Math.min(p.maxHp, p.hp + 1));
      }
    });
    
    api.log('Vampire & Double Score active.');
  }
});`,

  sysDomDemo: `// System DOM Hook Demo: 拦截底层元素创建
NEPForge.install({
  id:'sys-dom-demo', name:'DOM Intercept', version:'1.0',
  description:'拦截 createElement 修改所有生成的 div',
  init(api) {
    // 拦截原生的 document.createElement
    api.patch.sys.dom.after('createElement', (el, args) => {
      const tag = args[0];
      if (typeof tag === 'string' && tag.toLowerCase() === 'div') {
         // 在底层给新创建的元素增加微弱的透明度
         el.style.opacity = '0.95'; 
      }
      return el;
    });
    api.log('DOM Interceptor active.');
  }
});`,

  tickCounter:`// Tick counter overlay using v4 render API
NEPForge.install({
  id:'tick-counter', name:'Tick Counter', version:'1.0',
  description:'FPS / tick counter via canvas overlay',
  init(api) {
    let ticks = 0, _lastDt = 0.016;
    api.events.on('tick', (dt) => { ticks++; _lastDt = dt; });
    api.render.hud(({ ctx, W, H }) => {
      if (!ctx) return;
      ctx.save();
      ctx.font = 'bold 11px Consolas,monospace';
      ctx.fillStyle = 'rgba(82,230,255,0.85)';
      ctx.shadowColor = '#52E6FF';
      ctx.shadowBlur = 6;
      ctx.fillText('TICK ' + ticks + '  FPS ' + Math.round(1/_lastDt), 12, H - 160);
      ctx.restore();
    });
    api.log('Tick counter started');
  }
});`,

  novaAegisAntiCheat:`// Nova Aegis Sentinel 已迁移为独立 Nova Mod 文件:
//   mod-nova-aegis-sentinel.js
// 这是 Nova ModLoader 专用模组，不再作为 NEPForge 示例内置。`,

  shieldPipeline:`// Pipeline mod: cancel player damage when shield > 50
NEPForge.install({
  id:'shield-pipeline', name:'Shield Pipeline Demo', version:'1.0',
  description:'Uses playerDamage pipeline to block hits when shield is high',
  init(api) {
    api.pipelines.use('playerDamage', (ctx, next) => {
      const p = api.player;
      if ((p.shield || 0) > 50) {
        ctx.cancelled = true;
        api.game.textPop?.(p.x||200, p.y||300, 'BLOCKED', '#52E6FF');
        return;
      }
      next();
    }, 5);
    api.log('Shield pipeline installed');
  }
});`,
uiInjectDemo: `// Low-Code UI: 智能延迟注入 (Lazy Inject)
NEPForge.install({
  id:'menu-extension', name:'Option Menu Cheat', version:'1.0',
  description:'向原生选项菜单注入一键清屏，支持DOM动态生成或未初始化',
  init(api) {
    // 关键点：使用 { live: true }，即使目标面板此刻不存在，也会在其被渲染时瞬间注入
    api.ui.inject('#optionPanel .actions', {
      tag: 'button',
      class: 'nep-btn danger',
      style: 'margin-top:8px; border-color:#FF2F57;',
      text: 'NUKE ENEMIES (CHEAT)',
      onClick: () => {
        // 利用引擎全局变量直接清空子弹和杀怪
        const enemies = api.resolver.get('enemies') ||[];
        enemies.forEach(e => { if(e.alive) e.onHit(9999); });
        
        api.game.spawnShockwave(200, 300, '#FF2F57', 800, 0.8);
        
        // 自动点击恢复按钮关闭面板
        const btnResume = document.getElementById('btnOptResume');
        if (btnResume) btnResume.click();
      }
    }, { live: true }); // <-- 开启 Live 存活监听
    
    api.log('Smart UI Injector active. Waiting for #optionPanel...');
  }
});`,

  uiFloatingDemo: `// Low-Code UI: 悬浮仪表盘与作控中心
NEPForge.install({
  id:'floating-ui-demo', name:'Mod Control Panel', version:'1.0',
  description:'使用 api.ui.floating 创建带状态绑定的拖拽窗口',
  init(api) {
    // 创建拖拽悬浮窗
    api.ui.floating({
      title: 'HACKER SUITE',
      style: { top: '30%', left: '70%', width: '240px' },
      children:[
        {
          tag: 'div', style: 'margin-bottom:10px; font-size:12px; color:#52E6FF;',
          text: 'PLAYER STATUS: UNKNOWN',
          // setup 回调里实现高频刷新/响应绑定
          setup: (el) => {
            api.events.on('tick', () => {
              if (api.player.alive) {
                el.textContent = \`HP: \${Math.round(api.player.hp)} / \${api.player.maxHp}\`;
                el.style.color = (api.player.hp < 30) ? '#FF2F57' : '#50DC64';
              } else {
                el.textContent = 'STATUS: DEAD';
                el.style.color = '#555';
              }
            });
          }
        },
        {
          tag: 'button', class: 'nep-btn magenta', text: 'SPAWN ALLY DRONE',
          style: 'width:100%; margin-bottom:6px;',
          onClick: () => {
             if(api.player.alive) api.player.modStat('drones', d => d + 1);
             api.ui.toast('DRONE DEPLOYED', '#B36CFF');
          }
        },
        {
          tag: 'button', class: 'nep-btn yellow', text: 'MAX SHIELD',
          style: 'width:100%;',
          onClick: () => { api.player.setStat('shield', 12); }
        }
      ]
    });
    api.log('Floating Control Panel injected.');
  }
});`,

  propWatchDemo: `// Property Watch API: 锁血锁蓝
NEPForge.install({
  id:'watch-invincible', name:'Aura of Invincibility', version:'1.0',
  description:'拦截 Player 的 HP 写入和 Overdrive 倒流',
  init(api) {
    const p = api.player.getStat('hp') ? api.resolver.get('Player') : null;
    if (!p) return api.warn('Player not found on init.');

    // 1. 锁血机制：拦截 setter，如果受击扣血则强行阻断 (cancel)
    api.patch.watch(p, 'hp', {
      set(newVal, oldVal, cancel) {
        // 如果新血量低于老血量，阻止写入
        if (newVal < oldVal) {
          api.game.textPop(p.x, p.y - 30, 'IMMUNE', '#52E6FF');
          cancel(); // 阻断原始 setter
        }
        return newVal;
      }
    });

    // 2. 永动过载：拦截 overdriveT 读取，永远返回满的
    api.patch.watch(p, 'overdriveT', {
      get(val) {
         return 10.0; // 读取时总是 10 秒
      }
    });

    api.log('Aura of Invincibility equipped.');
  }
});`,

  sysFetchDemo: `// System Interceptor: Fetch API 拦截器 (Mod 联网示例)
NEPForge.install({
  id:'sys-fetch-demo', name:'Fetch Logger', version:'1.0',
  description:'使用 sys.fetch 监听并篡改底层网络请求',
  init(api) {
    api.patch.sys.fetch.around((orig, url, opts) => {
      api.log('Game is fetching: ' + url);
      
      // 可以篡改 URL 走代理
      // const newUrl = url.replace('http://old.com', 'https://proxy.com');
      
      // 返回原始 promise
      return orig(url, opts).then(res => {
         api.log('Fetch response status: ' + res.status);
         return res;
      }).catch(e => {
         api.err('Fetch failed: ' + e.message);
         throw e;
      });
    });
  }
});`,

  metaSchemaDemo: `// Meta & Schema: 保护敏感全局变量并验证写入
NEPForge.install({
  id:'schema-protector', name:'Strict Game State', version:'1.0',
  description:'给 Game.state 加入 Schema 类型验证，保护不被乱写',
  init(api) {
    const Game = api.resolver.get('Game');
    if (!Game) return;

    // 使用 Schema 定义合法值
    api.patch.schema(Game, 'state', {
      type: 'string',
      enum:['menu', 'playing', 'paused', 'over'],
      // 也可以用 custom: (val) => val === 'crazy' ? 'Invalid state' : null
    });

    // 如果别的 Mod 写了 Game.state = 123; 
    // PatchMgr 会在控制台提示 schema violation 并阻断写入。
    api.log('Game.state strictly typed.');
  }
});`,

registryShowcase: `// Registry Showcase: 注册 Affix、Trait、Emitter、Move
NEPForge.install({
  id: 'registry-showcase',
  name: 'Catalog Extender',
  version: '1.0',
  init(api) {
    // 1. 注册一个子弹词条：使子弹带上电击效果
    api.registry.affix('ELECTRIC', {
      tags: ['hitfx'],
      minWave: 1,
      weight: 1.0,
      onHit(b, target) {
        if (target && target.alive) {
          // 对目标造成额外固定伤害
          target.onHit(5);
          // 视觉特效
          sparks(target.x, target.y, 'glowY', 6, 180);
        }
      }
    });

    // 2. 注册一个敌人特性：周期性释放震荡波
    api.registry.trait('PULSAR_AURA', {
      minWave: 5,
      weight: 0.6,
      group: 'utility',
      apply(e, d) {
        e._pulseCd = 0;
        const oldUpdate = e.update;
        e.update = function(dt) {
          oldUpdate.call(this, dt);
          this._pulseCd -= dt;
          if (this._pulseCd <= 0) {
            this._pulseCd = 2.0;
            spawnShockwave(this.x, this.y, '#B36CFF', 120, 0.3);
          }
        };
      }
    });

    // 3. 注册一个简单发射器：三向散射
    api.registry.emitter('TRIPLE_SHOT', () => ({
      cd: 0.8,
      fire(owner) {
        const baseA = Math.atan2(Player.y - owner.y, Player.x - owner.x);
        for (let i = -1; i <= 1; i++) {
          const a = baseA + i * 0.2;
          spawnBullet('E', owner.x, owner.y, Math.cos(a)*300, Math.sin(a)*300, {
            r: 3, dmg: 12, col: '#FFB020', life: 1.5
          });
        }
      }
    }));

    // 4. 注册一个新移动模式：回旋镖式左右摆动
    api.registry.move('BOOMERANG_SWAY', (d) => {
      const e = baseEnemy('ENEMY', 16, 100 + d*10, 120);
      e.x = W*0.5; e.y = -40;
      e.vy = 80 + d*5;
      e._swayT = 0;
      e.move = (dt) => {
        e.y += e.vy * dt;
        e._swayT += dt * 2.5;
        e.x = W*0.5 + Math.sin(e._swayT) * 200;
        e.x = Math.max(20, Math.min(W-20, e.x));
      };
      return e;
    });

    api.log('Registry showcase installed.');
  }
});`,
shimCoreDemo: `// Shim Mod: 直接访问 Forge 内核并注入全局钩子
NEPForge.installShim({
  id: 'shim-core-demo',
  name: 'Core Shim Example',
  init(NEP, core) {
    // core 包含了 PatchMgr, EventBus, GlobalResolver 等全部内部对象
    core._info('[ShimDemo] Injected into NEPForge kernel.');
    
    // 例如：监听所有模组的加载/卸载
    core.EventBus.on('modLoaded', (id, mod) => {
      core._info(\`[ShimDemo] Mod "\${id}" loaded\`);
    });
    
    // 或者直接扩展 PatchMgr 的功能
    const originalWrap = core.PatchMgr.wrap;
    core.PatchMgr.wrap = function(...args) {
      core._info(\`[ShimDemo] Wrapping \${args[0]}\`);
      return originalWrap.apply(this, args);
    };
  }
});`,
customappearance:`// ── Appearance 接口示例 ──
NEPForge.install({
  id: 'my-appearance-mod',
  name: 'Custom Appearances',
  init(api) {
    // 注册一个自定义外观
    api.registry.appearance('JELLYFISH', {
      label: 'Jellyfish',
      tags: ['organic', 'aquatic'],
      draw(g, e, body, col, R0, rot, time) {
        g.save();
        g.translate(e.x, e.y);
        g.rotate(rot + time * 0.5);
        // 绘制水母主体
        g.beginPath();
        g.ellipse(0, 0, R0 * 0.8, R0 * 0.5, 0, 0, Math.PI * 2);
        g.fillStyle = col + '88';
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.stroke();
        // 触须
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          g.beginPath();
          g.moveTo(Math.cos(a) * R0 * 0.7, Math.sin(a) * R0 * 0.5);
          g.lineTo(Math.cos(a) * R0 * 1.4, Math.sin(a) * R0 * 1.2 + Math.sin(time * 3 + i) * 10);
          g.strokeStyle = col + 'aa';
          g.lineWidth = 1.5;
          g.stroke();
        }
        g.restore();
      },
    });
    api.log('Jellyfish appearance registered!');
  }
});
`,

TankerWave:`// ── WaveDirectorCfg 接口示例 ──
NEPForge.install({
  id: 'wave-config-mod',
  name: 'Wave Configurator',
  deps: ['example-big-bullets'],
  init(api) {
    const wd = api.waveDirector;  // WaveDirectorCfg 绑定到当前 modId

    // 注册一个自定义 proto（使用工厂函数）
    wd.addEntry({
      key: 'MY_TANKER',
      minWave: 5,
      weight: 1.5,           // 比默认条目出现概率高 50%
      modes: ['game'],       // 只在普通模式出现
      count: 2,              // 每次加 2 个进 deck
      factory(wave, mode, deck) {
        // 返回一个符合游戏 proto 格式的对象
        return {
          isBoss: false,
          hp: 300 + wave * 30,
          moveKeys: ['SWAY_SINE'],
          traits: ['ARMORED'],
          emitters: [{ type: 'SPREAD' }],
          waveBulletMods: ['ENEMY_OVERSIZED'],
          baseCol: '#FF6600',
          bodyKind: 'gear',
        };
      },
    });

    // 为 fortress 模式单独配置不同权重
    wd.configure('MY_TANKER', 'fortress', {
      weight: 3.0,
      minWave: 2,
    });

    // deck filter：强制在 Boss 波（每10波）确保至少有 1 个 Boss
    wd.filter((deck, wave, mode) => {
      if (wave % 10 === 0) {
        const hasBoss = deck.some(p => p.isBoss);
        if (!hasBoss) deck.push({ isBoss: true, hp: 5000 + wave * 200, moveKeys: ['SMART_EVADER'] });
      }
    });

    // onWave 回调：每5波在屏幕上显示提示
    wd.onWave((wave, deck, mode) => {
      if (wave % 5 === 0) {
        api.game.textPop(api.game.W * 0.5, 60, \`WAVE \${wave} · \${deck.length} ENEMIES\`, '#FFB020');
      }
    });

    // 掉落规则：Boss 死亡时触发全屏震波
    wd.drop({
      filter: (e) => !!e.isBoss,
      roll:   ()  => Math.random() < 0.8,  // 80% 概率
      apply:  (e) => api.game.spawnShockwave(e.x, e.y, '#FFB020', 400, 0.7),
    });

    api.log('Wave config installed!');
  }
});
`,

uiPanel:`// ── UIFramework 组件示例 (功能完整修复版) ──
NEPForge.install({
  id: 'ui-demo-mod-functional',
  name: 'Functional UI Demo',
  version: '1.1',
  description: 'A floating panel with fully functional, game-integrated controls.',
  init(api) {
    const { components: C, reactive } = api.ui;

    // 创建一个响应式状态，用于驱动 UI
    const state = reactive.state({
      kills: 0,
      wave: 0,
      autoHealActive: false,
    });

    // 创建浮动面板
    api.ui.floating({
      title: 'MOD CONTROLS',
      style: { top: '30%', left: 'calc(100% - 280px)', width: '240px' }, // 靠右显示
      children: [
        C.heading({ text: 'LIVE STATISTICS' }),
        
        // ✨ FIX: This stat component is now driven by the tick event below
        C.stat({ label: 'SCORE', value: '0', color: '#50DC64', ref(el) {
          state.bind(el, (data, element) => element.update(data.kills));
        }}),
        
        // ✨ FIX: This stat component is also driven by the tick event
        C.stat({ label: 'WAVE', value: '0', color: '#52E6FF', ref(el) {
          state.bind(el, (data, element) => element.update(data.wave));
        }}),
        
        C.separator(),
        C.heading({ text: 'CHEATS' }),
        
        // ✨ FIX: The onChange now correctly calls the player API to change the game state
        C.slider({ 
          label: 'DAMAGE MUL', 
          min: 0.5, 
          max: 10, // 增加上限以便测试
          step: 0.1, 
          value: api.player.dmgMul || 1, // 读取初始值
          onChange(v) { 
            api.player.setStat('dmgMul', v);
          } 
        }),
        
        // ✨ FIX: The onChange now updates our state, which is used by the tick event
        C.toggle({ 
          label: 'AUTO-HEAL (0.5 HP/s)', 
          checked: false,
          onChange(isOn) { 
            state.set('autoHealActive', isOn); 
          } 
        }),
        
        C.separator(),
        
        { tag:'div', style:'display:flex;gap:8px;',
          ref(el) {
            el.appendChild(C.button({ label: 'TOAST',
              onClick: () => api.ui.toast('Hello from Mod!', '#B36CFF') }));
            el.appendChild(C.button({ label: 'INFO', color: '#52E6FF',
              onClick: () => api.ui.modal({ 
                title: 'MOD INFO',
                content: { tag:'p', style:'color:#ccc; font-size:12px;', text:'This is a fully interactive UI panel created by a mod.' },
                buttons: [{ label: 'AWESOME' }] 
              }) 
            }));
          }
        },
      ]
    });

    // ✨ FIX: This is the core logic that connects the game to our UI state
    api.events.on('forge:tick', (dt) => {
      // 1. 每帧同步游戏数据到我们的响应式 state
      state.update({
        wave: api.game.wave || 0,
        // 使用 score 作为 kills 的近似值
        kills: Math.floor(api.game.score || 0),
      });

      // 2. 检查 toggle 状态并执行动作
      if (state.get('autoHealActive')) {
        const p = api.player;
        if (p.alive && p.hp < p.maxHp) {
          // dt 是每帧的时间（秒），乘以 0.5 就是每秒恢复 0.5 HP
          p.heal(0.5 * dt);
        }
      }
    });

    api.log('Functional UI Demo installed!');
  }
});
`,

registryedit:`
NEPForge.install({
  id: 'registry-super-demo',
  name: 'Registry Edit & Wrapper Demo',
  version: '1.0',
  init(api) {

    api.registry.wrapper('ZIGZAG_SPLIT', (baseFactory, cfg) => {
      const splitAngle = cfg.splitAngle ?? 0.5;
      const baseEm = baseFactory(cfg.baseCfg || cfg);
      return {
        cd: baseEm.cd * 1.5,
        fire(owner) {
          const prevOffset = owner._emitAngleOffset || 0;
          owner._emitAngleOffset = prevOffset - splitAngle;
          baseEm.fire(owner);
          owner._emitAngleOffset = prevOffset + splitAngle;
          baseEm.fire(owner);
          owner._emitAngleOffset = prevOffset;
        }
      }
    }, 
    [
      { id: 'splitAngle', type: 'number', step: 0.1, def: 0.5, min: 0.1, max: 3.14 }
    ]);
    

    api.registry.edit('WrapperFieldDefs', 'SALVO', (fields) => {
      // 为原版 SALVO 追加一个 "speedBoost" 的输入框
      fields.push({ id: 'speedBoost', type: 'number', step: 0.1, def: 1.2 });
      return fields; // 将被系统记录，并在卸载该 Mod 时还原
    });

    api.registry.edit('CompositeWrappers', 'SALVO', (origFactory) => {
      // 劫持其构造，增强它
      return function(baseFactory, cfg) {
        const originalEm = origFactory(baseFactory, cfg);
        const originalFire = originalEm.fire.bind(originalEm);
        originalEm.fire = function(owner) {
           // 利用我们刚才追加进 UI 面板的 speedBoost 变量给速度翻倍
           const preSp = baseFactory().speed;
           const sB = cfg.speedBoost ?? 1.2;
           // 自定义发射魔改逻辑 ...
           originalFire(owner);
        };
        return originalEm;
      };
    });

    api.log('Wrapper added and SALVO edited securely!');
  }
});
`,

labMultiSpawner: `NEPForge.install({
  id: 'lab-multi-spawner',
  name: 'LAB Multi Spawner',
  version: '1.0',
  description: 'LAB 敌袭阶段允许玩家选择多种 Forge 敌人并同场作战（可动态调整数量上限）。',
  init(api) {
    let enabled = true;
    let cap = 4;
    let mixMode = true;
    const selectedPool = [];
    const selectedKeySet = new Set();
    const makeSpecKey = (spec) => {
      if (!spec) return '';
      try {
        return JSON.stringify({
          name: spec.name || spec.title || 'Forge Enemy',
          hp: spec.hp || 0,
          emitters: (spec.emitters || []).map(e => e?.type || 'unknown'),
          traits: spec.traits || [],
        });
      } catch (_) {
        return String(Date.now() + Math.random());
      }
    };
    const cloneSpec = (spec) => {
      try { return JSON.parse(JSON.stringify(spec || {})); }
      catch (_) { return spec ? { ...spec } : null; }
    };
    const addCurrentSpec = () => {
      const Fortress = api.resolver.get('Fortress');
      const cur = cloneSpec(Fortress?.labForgeSpec);
      if (!cur) {
        api.ui.toast('⚠ 当前没有可添加的 Forge 敌人', '#FFB020', 1300);
        return;
      }
      const key = makeSpecKey(cur);
      if (selectedKeySet.has(key)) {
        api.ui.toast('ℹ 该敌人已在 LAB 池中', '#52E6FF', 1200);
        return;
      }
      selectedKeySet.add(key);
      selectedPool.push(cur);
      api.ui.toast(\`✅ 已加入敌人池 (\${selectedPool.length})\`, '#50DC64', 1200);
    };
    const clearPool = () => {
      selectedPool.length = 0;
      selectedKeySet.clear();
      api.ui.toast('🧹 已清空敌人池', '#FFB020', 1200);
    };
    const pickSpec = () => {
      const Fortress = api.resolver.get('Fortress');
      const fallback = Fortress?.labForgeSpec ? cloneSpec(Fortress.labForgeSpec) : null;
      if (!mixMode) return fallback;
      if (!selectedPool.length) return fallback;
      const i = Math.floor(Math.random() * selectedPool.length);
      return cloneSpec(selectedPool[i]);
    };

    api.ui.floating({
      title: 'LAB MULTI',
      style: { top: '18%', left: 'calc(100% - 260px)', width: '220px' },
      children: [
        { tag: 'div', style: 'font-size:11px;color:#9deeff;margin-bottom:6px;', text: 'LAB 同场怪物上限' },
        api.ui.components.slider({ label: 'MONSTER CAP', min: 1, max: 12, step: 1, value: cap, onChange(v){ cap = Math.max(1, v|0); }}),
        api.ui.components.toggle({ label: 'ENABLED', checked: true, onChange(v){ enabled = !!v; } }),
        api.ui.components.toggle({ label: 'MIX MODE', checked: true, onChange(v){ mixMode = !!v; } }),
        api.ui.components.button({ label: 'ADD CURRENT ENEMY', onClick(){ addCurrentSpec(); } }),
        api.ui.components.button({ label: 'CLEAR ENEMY POOL', color: '#555', onClick(){ clearPool(); } }),
        { tag: 'div', style: 'font-size:10px;color:#9aa;line-height:1.35;margin-top:4px;', text: '先在 LAB 中切换想要的 Forge 敌人，再点 ADD，可组合多种敌人。' },
      ],
    });

    api.events.on('forge:tick', () => {
      if (!enabled) return;
      if (api.game.mode !== 'lab' || api.game.state !== 'playing') return;
      const Fortress = api.resolver.get('Fortress');
      if (!Fortress || Fortress.phase !== 'assault') return;

      const aliveLab = (window.enemies || []).filter(e => e?.alive && e.type === 'ENEMY').length;
      if (aliveLab >= cap) return;

      const need = cap - aliveLab;
      for (let i = 0; i < need; i++) {
        const spec = pickSpec();
        if (!spec) continue;
        const e = window.spawnForgeEnemy?.(spec);
        if (!e) continue;
        e.x = (window.W || 400) * (0.25 + Math.random() * 0.5);
        e.y = -20 - i * 28;
      }
    });

    api.log('LAB Multi Spawner installed');
  }
});`,

playerFireControl: `NEPForge.install({
  id: 'player-fire-control',
  name: 'Player Fire Control',
  version: '1.0',
  description: '游戏内动态开关玩家发射器、词条，并支持一键开火/停火。',
  init(api) {
    const state = {
      ceasefire: false,
      disabledEmitterIdx: new Set(),
      disabledAffix: new Set(),
      uiRefreshCd: 0,
      panel: null,
    };
    const isEmitterEnabled = (idx) => !state.disabledEmitterIdx.has(idx);
    const isAffixEnabled = (k) => !state.disabledAffix.has(k);

    api.patch.around('firePlayer', (orig, dt) => {
      if (!state.ceasefire) return orig(dt);
    }, 20, { tag: 'ceasefire' });

    api.patch.around('updatePlayerEmitters', (orig, dt) => {
      const p = window.Player;
      if (!p?.emitters?.length) return orig(dt);
      const backup = p.emitters;
      p.emitters = backup.filter((_, idx) => !state.disabledEmitterIdx.has(idx));
      try { return orig(dt); }
      finally { p.emitters = backup; }
    }, 20, { tag: 'emitter-filter' });

    api.patch.before('spawnBullet', ([team, x, y, vx, vy, opts], cancel) => {
      if (team !== 'P' || !opts?.mods?.length) return;
      const mods = opts.mods.filter(m => !state.disabledAffix.has(m));
      return [team, x, y, vx, vy, { ...opts, mods }];
    }, 10, { tag: 'affix-filter' });

    const renderPanel = () => {
      if (state.panel?.remove) state.panel.remove();
      const p = window.Player || {};
      const emitters = Array.isArray(p.emitters) ? p.emitters : [];
      const affixes = Array.isArray(p.gunMods) ? p.gunMods : [];
      state.panel = api.ui.floating({
        title: 'FIRE CTRL',
        style: { top: '48%', left: 'calc(100% - 280px)', width: '245px' },
        children: [
          api.ui.components.toggle({ label: 'CEASEFIRE', checked: state.ceasefire, onChange(v){ state.ceasefire = !!v; } }),
          api.ui.components.button({ label: '⏹ STOP FIRE', color: '#FF2F57', onClick(){ state.ceasefire = true; } }),
          api.ui.components.button({ label: '▶ RESUME FIRE', color: '#50DC64', onClick(){ state.ceasefire = false; } }),
          { tag: 'div', style: 'font-size:10px;color:#9deeff;margin-top:5px;', text: 'Emitters（点击开/关）' },
          ...emitters.map((em, idx) => api.ui.components.button({
            label: \`\${isEmitterEnabled(idx) ? 'ON ' : 'OFF'} #\${idx + 1} \${(em?.type || em?.id || 'EMITTER')}\`,
            color: isEmitterEnabled(idx) ? '#50DC64' : '#FFB020',
            onClick() {
              isEmitterEnabled(idx) ? state.disabledEmitterIdx.add(idx) : state.disabledEmitterIdx.delete(idx);
              renderPanel();
            }
          })),
          { tag: 'div', style: 'font-size:10px;color:#9deeff;margin-top:5px;', text: 'Affixes（点击开/关）' },
          ...affixes.map((k) => api.ui.components.button({
            label: \`\${isAffixEnabled(k) ? 'ON ' : 'OFF'} \${k}\`,
            color: isAffixEnabled(k) ? '#52E6FF' : '#FFB020',
            onClick() {
              isAffixEnabled(k) ? state.disabledAffix.add(k) : state.disabledAffix.delete(k);
              renderPanel();
            }
          })),
        ],
      });
    };
    renderPanel();
    api.events.on('forge:tick', (_, dt = 0.016) => {
      state.uiRefreshCd -= dt;
      if (state.uiRefreshCd > 0) return;
      state.uiRefreshCd = 0.6;
      renderPanel();
    });

    api.log('Player Fire Control installed');
  }
});`,

noWarpBonus: `NEPForge.install({
  id: 'no-warp-bonus',
  name: 'No Warp Bonus',
  version: '1.0',
  description: '跳关/高波开局时保留原始 Build 属性，不自动补发属性和词条。',
  init(api) {
    const pickBuildA = () => {
      const fromWorkshop = window.MenuUI?.editKey === 'B' ? window.Builds?.B : window.Builds?.A;
      return JSON.parse(JSON.stringify(fromWorkshop || window.Builds?.A || {}));
    };

    const restoreEmitterGraphState = (build) => {
      if (!build || typeof build !== 'object') return;
      if (typeof window.setupPlayerEmittersFromBuild === 'function') {
        window.setupPlayerEmittersFromBuild(build);
      }
      if (typeof window.ensureWorkshopEmitterGraphState === 'function') window.ensureWorkshopEmitterGraphState();
      if (typeof window.syncWorkshopFromModel === 'function') window.syncWorkshopFromModel();
      if (typeof window.renderWorkshopEmitterGraphUI === 'function') window.renderWorkshopEmitterGraphUI();
    };

    const restoreBuildToPlayer = (build) => {
      const p = window.Player;
      if (!p || !build) return false;
      const startLv = Math.max(1, Math.min(120, Number(build.startLv || 1) || 1));
      p.lv = startLv;
      p.xp = 0;
      if (typeof window.xpNeedFor === 'function') p.xpNeed = window.xpNeedFor(startLv);
      p.maxHp = build.maxHp ?? p.maxHp;
      p.hp = Math.max(1, build.hp ?? build.maxHp ?? p.maxHp ?? p.hp ?? 1);
      p.fireRate = build.fireRate ?? p.fireRate;
      p.dmgMul = build.dmgMul ?? p.dmgMul;
      p.crit = build.crit ?? p.crit;
      p.pierceBase = build.pierceBase ?? p.pierceBase;
      p.drones = build.drones ?? p.drones;
      p.homingAmmo = build.homingAmmo ?? p.homingAmmo;
      p.bomb = build.bomb ?? p.bomb;
      p.shield = build.shield ?? p.shield ?? 0;

      if (!Array.isArray(p.gunMods)) p.gunMods = [];
      p.gunMods.length = 0;
      for (const k of (build.gunMods || [])) p.gunMods.push(k);

      restoreEmitterGraphState(build);
      return true;
    };

    const suppressUpgradePoolDuring = (fn) => {
      const pool = window.UpgradePool || {};
      const restores = [];
      for (const [k, u] of Object.entries(pool)) {
        if (!u || typeof u.apply !== 'function') continue;
        const rawApply = u.apply;
        u.apply = function nopApply() {};
        restores.push(() => { u.apply = rawApply; });
      }
      try { return fn(); }
      finally { restores.forEach(r => { try { r(); } catch(_) {} }); }
    };

    api.patch.around('startRun', (orig, cfg = {}) => {
      const b = pickBuildA();
      const startWave = Math.max(1, Number(cfg?.wave || 1));
      const out = suppressUpgradePoolDuring(() => orig(cfg));
      if (startWave <= 1) return out;

      const reapplied = restoreBuildToPlayer(b);
      if (reapplied) api.log('No Warp Bonus reapplied workshop build and suppressed lv upgrades');
      return out;
    }, 99, { tag: 'no-warp-bonus' });
  }
});`,
};


/* ═══════════════════════════════════════════════════════════════════════
   25. PUBLIC API
   ═══════════════════════════════════════════════════════════════════════ */
window.NEPForge = {
  // Core
  install(descriptor) { ModLoader.register(descriptor); ModLoader.load(descriptor.id); return this; },
  installShim(descriptor) { ShimFramework.install(descriptor); return this; },
  loadJSON: _installFromJSON,
  runCode:  _installFromCode,

  // Sub-systems
  loader:    ModLoader,
  events:    EventBus,
  registry:  Registry,
  waveDirectorCfg: WaveDirectorCfg,
  patch:     PatchMgr,
  meta:      MetaModRegistry,
  store:     SharedStore,
  services:  ServiceRegistry,
  pipelines: Pipelines,
  render:    RenderPipeline,
  input:     InputRouter,
  schedule:  Scheduler,
  watchdog:  Watchdog,
  conflicts: ConflictGuard,

  // Game access
  game:     GameAPI,
  player:   PlayerAPI,
  fortress: FortressAPI,

  // Context management
  resolver: GlobalResolver,
  setGameContext(obj) { GlobalResolver.setContext(obj); _injectGameHooks(); },
  rescan()            { GlobalResolver.rescan(); _injectGameHooks(); return GlobalResolver.inspect(); },
  // 手动重新注入游戏钩子（高级功能）
reinjectHooks() {
  _hookInjected = false;
  _injectGameHooks();
  _info('Hooks manually reinjected.');
  return true;
},

  // UI
  ui: UIManager,

  // Direct catalog getters
  get affixes()   { return _g('BulletAffixCatalog'); },
  get traits()    { return _g('EnemyTraitCatalog'); },
  get emitters()  { return _g('EmitterCatalog'); },
  get wrappers()  { return _g('CompositeWrappers'); },
  get moves()     { return _g('MoveCatalog'); },
  get bodies()    { return _g('BODY_KINDS'); },
  get enemies()   { return _g('enemies'); },
  get bulletsP()  { return _g('bulletsP'); },
  get bulletsE()  { return _g('bulletsE'); },
  get Player()    { return _g('Player'); },
  get Game()      { return _g('Game'); },
  get Fortress()  { return _g('Fortress'); },
  get WaveDirector() { return _g('WaveDirector'); },

  version: '4.0.0',

  help() {
    console.log(`%c
╔══════════════════════════════════════════════════════════════╗
║  NEP FORGE v4.0  ·  Mod Loader                               ║
╠══════════════════════════════════════════════════════════════╣
║  CORE                                                         ║
║    NEPForge.install({...})   install + load a mod            ║
║    NEPForge.loadJSON(str)    from JSON string                 ║
║    NEPForge.runCode(str)     run JS mod code                 ║
║    NEPForge.loader.list()    list all mods                   ║
╠══════════════════════════════════════════════════════════════╣
║  PATCH HOOKS  (in init(api){ api.patch.X(...) })             ║
║    wrap / around  wrapper(origFn, ...args) => result         ║
║    before         fn(args[], cancel) – cancel() skips orig   ║
║    after          fn(result, args[]) => newResult|undefined  ║
║    replace        fn(...args) => result  (orig not called)   ║
║    *Method variants for arbitrary object methods             ║
╠══════════════════════════════════════════════════════════════╣
║  MOD APIS  (in init(api){...})                               ║
║    api.store.set/get/watch      cross-mod data               ║
║    api.services.provide/require capability sharing           ║
║    api.pipelines.use(name, fn)  damage pipelines             ║
║    api.render.pre/post/hud(fn)  canvas overlay               ║
║    api.input.bind(key, fn)      keyboard hooks               ║
║    api.schedule.after/every/onWave  deferred jobs            ║
║    api.ui.toast(msg,color,dur)  show toast                   ║
║    api.ui.injectMenuTab(...)    add custom menu tab          ║
║    api.ui.injectHUDElement(el)  attach el to HUD layer       ║
╠══════════════════════════════════════════════════════════════╣
║  UI                                                           ║
║    In game menu → ⚙ MODS tab                                 ║
║    NEPForge.ui.openTab('install')  navigate to a tab         ║
║    NEPForge.reinjectHooks()   manually re-attach game hooks  ║
╠══════════════════════════════════════════════════════════════╣
║  DIAGNOSTICS                                                  ║
║    NEPForge.conflicts.report()  patch conflicts              ║
║    NEPForge.watchdog.status()   health monitor               ║
║    NEPForge.resolver.inspect()  found/missing globals        ║
╚══════════════════════════════════════════════════════════════╝
`, 'color:#52E6FF;font-family:monospace');
  },
};
/* ═══════════════════════════════════════════════════════════════════════
   SHIM MOD FRAMEWORK (元级 Modloader 热更新)
   允许极高权限的扩展，安装时将向 Mod 注入 Forge 内部的全部调度器/缓存对象
   从而达成：重写 modloader 自身、干涉解析器、强制剔除缓存等。
   ═══════════════════════════════════════════════════════════════════════ */
const ShimFramework = (() => {
  const _shims = new Map();
  // 打包全部 Modloader 私有内核作用域对象
  const CoreInternals = {
    GlobalResolver, EventBus, ConflictGuard, PatchMgr,
    SharedStore, ServiceRegistry, Pipelines, RenderPipeline,
    InputRouter, Scheduler, Registry, GameAPI, PlayerAPI,
    FortressAPI, MetaModRegistry, UIManager, ModLoader,
    WaveDirectorCfg, UIRefresher, UIFramework,
    _info, _warn, _error
  };

  return {
    install(descriptor) {
      const { id, init } = descriptor;
      if (!isStr(id) || !isFunc(init)) return _error('ShimFramework: id and init() required');
      if (_shims.has(id)) _warn(`ShimFramework: "${id}" replacing existing core shim.`);
      
      try {
        // Init 的签名为 init(NEPForgeAPI, CoreInternals)
        init(window.NEPForge, CoreInternals);
        _shims.set(id, descriptor);
        _info(`[Shim] Core Shim "${id}" installed successfully.`);
      } catch(e) {
        _error(`[Shim] Error in "${id}": ${e.message}`);
      }
    }
  };
})();

/* ═══════════════════════════════════════════════════════════════════════
   26. BOOT
   ═══════════════════════════════════════════════════════════════════════ */
_createShims();
_injectGameHooks();
Watchdog.start(6000);
_info('NEP Forge v4.0 initialized. Open the ⚙ MODS tab in the game menu. Type NEPForge.help() for docs.');
UIManager.toast('⚙ NEP FORGE v4 LOADED', '#52E6FF', 2800);

})(); // END NEPForgeBootstrap
