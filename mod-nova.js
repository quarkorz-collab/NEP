// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  NOVA FORGE  v1.0  ·  元级模组加载器                                    ║
// ║  Not Enough Plane  ·  依托 NEPForge ShimFramework 运行                  ║
// ║                                                                          ║
// ║  特性：                                                                  ║
// ║  · Nova.def(id, descriptor)   声明式 Mod 定义                           ║
// ║  · 响应式 state 系统          Proxy驱动，点号语法读写，watch订阅        ║
// ║  · 声明式 catalog             catalog.affix/trait/emitter/...           ║
// ║  · 声明式 patch               patch[fnName].before/after/around/tap/replace ║
// ║  · 声明式 events / render / keys                                        ║
// ║  · Auto Panel Builder         panel 字段自动生成悬浮控制面板             ║
// ║  · Mod-in-Mod                 mods: { subId: descriptor } 任意嵌套      ║
// ║  · 热重载                     Nova.reload(id)                           ║
// ║  · 插件系统                   Nova.plugin(hostId, pluginId, desc)       ║
// ║  · compose 合并               Nova.compose(id, ...descriptors)          ║
// ║  · NEPForge 菜单 Tab          在原生菜单中注入"✦ NOVA"页                ║
// ║  · 完整向后兼容               api.nep 可访问所有 NEPForge 原生 API      ║
// ╚══════════════════════════════════════════════════════════════════════════╝
NEPForge.installShim({
  id: 'nova-forge',
  name: '✦ Nova Forge v1.0',
  init(NEP, core) {
    'use strict';

    const {
      Registry, PatchMgr, EventBus, RenderPipeline, InputRouter,
      Scheduler, SharedStore, ServiceRegistry, UIManager, UIFramework,
      GameAPI, PlayerAPI, FortressAPI, GlobalResolver, WaveDirectorCfg,
      _info, _warn, _error
    } = core;

    if (window.Nova) { _warn('[NovaForge] Already installed.'); return; }

    // ═══════════════════════════════════════════════════════════════
    //  0. UTILITIES
    // ═══════════════════════════════════════════════════════════════
    const isFunc = v => typeof v === 'function';
    const isObj  = v => v !== null && typeof v === 'object';
    const isStr  = v => typeof v === 'string';
    const uid    = () => Math.random().toString(36).slice(2, 9);

    function deepGet(obj, path) {
      return path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj);
    }
    function deepSet(obj, path, val) {
      const keys = path.split('.');
      const last = keys.pop();
      const tgt  = keys.reduce((o, k) => (o[k] = isObj(o[k]) ? o[k] : {}), obj);
      tgt[last] = val;
    }
    function deepClone(v) {
      try { return JSON.parse(JSON.stringify(v)); } catch(_) { return v; }
    }

    // ═══════════════════════════════════════════════════════════════
    //  1. REACTIVE STATE SYSTEM
    //     • state.get(path)     → 值（支持 'a.b.c' 点号路径）
    //     • state.set(path, v)  → 赋值并通知 watch
    //     • state.update({...}) → 批量赋值
    //     • state.watch(path,cb)→ 订阅变化，返回取消函数
    //     • state.watchAny(cb)  → 订阅所有变化
    //     • state.snapshot()    → 深拷贝快照
    //     • Proxy 语法：state.myKey = val / state.myKey 读写
    // ═══════════════════════════════════════════════════════════════
    function createReactiveState(initial = {}) {
      const _data     = deepClone(initial);
      const _watchers = new Map();   // path → Set<cb>
      const _anyW     = new Set();   // 通配符订阅

      function _notify(path, newVal, oldVal) {
        (_watchers.get(path) || new Set()).forEach(cb => {
          try { cb(newVal, oldVal, path); } catch(e) { _warn(`[Nova/state] watcher error: ${e.message}`); }
        });
        if (!path.startsWith('*')) {
          _anyW.forEach(cb => {
            try { cb(path, newVal, oldVal); } catch(e) {}
          });
        }
      }

      const api = {
        get(path)       { return deepGet(_data, path); },
        set(path, val)  { const old = deepGet(_data, path); deepSet(_data, path, val); _notify(path, val, old); },
        update(patches) { Object.entries(patches).forEach(([k, v]) => this.set(k, v)); },
        toggle(path)    { this.set(path, !this.get(path)); },
        inc(path, n=1)  { this.set(path, (this.get(path) || 0) + n); },
        watch(path, cb) {
          if (!_watchers.has(path)) _watchers.set(path, new Set());
          _watchers.get(path).add(cb);
          return () => _watchers.get(path)?.delete(cb);
        },
        watchAny(cb)    { _anyW.add(cb); return () => _anyW.delete(cb); },
        snapshot()      { return deepClone(_data); },
        reset(data)     {
          const d = data || deepClone(initial);
          Object.keys(_data).forEach(k => delete _data[k]);
          Object.assign(_data, d);
          _notify('*', _data, null);
        },
        _raw:   _data,
      };

      return new Proxy(api, {
        get(t, k)    { return k in t ? t[k] : deepGet(_data, k); },
        set(t, k, v) {
          if (k in t) { t[k] = v; return true; }
          api.set(String(k), v);
          return true;
        },
      });
    }

    // ═══════════════════════════════════════════════════════════════
    //  2. CLEANUP TRACKER
    // ═══════════════════════════════════════════════════════════════
    function createCleanup() {
      const _fns = [];
      return {
        add(fn) { if (isFunc(fn)) _fns.push(fn); },
        addId(id, revokeFn) {
          // 包裹 id-based revocation
          _fns.push(() => { try { revokeFn(id); } catch(_) {} });
        },
        runAll() {
          const fns = _fns.splice(0);
          fns.forEach(fn => { try { fn(); } catch(e) { _warn(`[Nova/cleanup] ${e.message}`); } });
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════
    //  3. DECLARATIVE CATALOG INSTALLER
    //  descriptor.catalog:
    //    affix:     { KEY: def }
    //    trait:     { KEY: def }
    //    emitter:   { KEY: factory }
    //    wrapper:   { KEY: { factory, fields? } }
    //    move:      { KEY: factory }
    //    upgrade:   { KEY: def }
    //    structure: { KEY: def }
    //    bodyKind:  { KEY: drawFn }
    //    appearance:{ KEY: { draw, label, tags, preview? } }
    //    wave:      { KEY: def }
    // ═══════════════════════════════════════════════════════════════
    function installCatalog(cat, id, cleanup) {
      if (!isObj(cat)) return;
      const R = Registry;

      // 将注册分发到对应 Registry 方法
      const HANDLERS = {
        affix:      (k, v) => R.affix(k, v, id),
        trait:      (k, v) => R.trait(k, v, id),
        emitter:    (k, v) => R.emitter(k, v, id),
        wrapper:    (k, v) => isObj(v) && isFunc(v.factory)
                              ? R.wrapper(k, v.factory, v.fields || null, id)
                              : R.wrapper(k, v, null, id),
        move:       (k, v) => R.move(k, v, id),
        upgrade:    (k, v) => R.upgrade(k, v, id),
        structure:  (k, v) => R.structure(k, v, id),
        bodyKind:   (k, v) => R.bodyKind(k, v, id),
        appearance: (k, v) => R.appearance(k, v, id),
        wave:       (k, v) => R.wavePattern(k, v, id),
      };

      for (const [type, handler] of Object.entries(HANDLERS)) {
        if (!cat[type]) continue;
        for (const [key, val] of Object.entries(cat[type])) {
          try { handler(key, val); }
          catch(e) { _warn(`[Nova][${id}] catalog.${type}.${key} failed: ${e.message}`); }
        }
      }

      // Registry 通过 modId 追踪，unregisterAll 时统一清理
      cleanup.add(() => R.unregisterAll(id));
    }

    // ═══════════════════════════════════════════════════════════════
    //  4. DECLARATIVE PATCH INSTALLER
    //  descriptor.patch:
    //    'fnName':             { before, after, around, replace, tap, priority? }
    //    'ObjName.propName':   { get, set }          → Property Watch
    //    'ObjName.methodName': { around/before/after, via: 'ObjName' }
    // ═══════════════════════════════════════════════════════════════
    function installPatches(patchDesc, id, cleanup) {
      if (!isObj(patchDesc)) return;

      for (const [target, hooks] of Object.entries(patchDesc)) {
        if (!isObj(hooks)) continue;
        const pri  = hooks.priority || 0;
        const tag  = hooks.tag || 'nova';
        const opts = { tag };

        const dotIdx = target.indexOf('.');
        if (dotIdx !== -1) {
          // ── 属性 Watch 或 对象方法 Hook ──────────────────────
          const [objKey, memberKey] = [target.slice(0, dotIdx), target.slice(dotIdx + 1)];
          const obj = GlobalResolver.get(objKey);
          if (!obj) { _warn(`[Nova][${id}] patch target "${objKey}" not found`); continue; }

          if (hooks.get || hooks.set) {
            // Property Watch
            const hId = PatchMgr.watch(obj, memberKey, { get: hooks.get, set: hooks.set }, id, pri);
            if (hId) cleanup.add(() => PatchMgr.revertHook(hId));
          } else {
            // Method Hook（around/before/after/replace/tap）
            for (const type of ['around', 'before', 'after', 'replace', 'tap']) {
              if (!isFunc(hooks[type])) continue;
              const method = `${type}Method`;
              const hId = PatchMgr[method]?.(obj, memberKey, hooks[type], id, pri, opts);
              if (hId) cleanup.add(() => PatchMgr.revertHook(hId));
            }
          }
        } else {
          // ── 全局函数 Hook ──────────────────────────────────
          for (const type of ['before', 'after', 'around', 'replace', 'tap']) {
            if (!isFunc(hooks[type])) continue;
            const hId = PatchMgr[type]?.(target, hooks[type], id, pri, opts);
            if (hId) cleanup.add(() => PatchMgr.revertHook(hId));
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    //  5. DECLARATIVE EVENT INSTALLER
    //  descriptor.events:
    //    'eventName': handler
    //    'eventName': { handler, priority, once }
    // ═══════════════════════════════════════════════════════════════
    function installEvents(evDesc, id, cleanup) {
      if (!isObj(evDesc)) return;
      for (const [evt, binding] of Object.entries(evDesc)) {
        let fn, opts;
        if (isFunc(binding)) { fn = binding; opts = {}; }
        else if (isObj(binding) && isFunc(binding.handler)) { fn = binding.handler; opts = binding; }
        else continue;

        const hId = opts.once
          ? EventBus.once(evt, fn, id, opts)
          : EventBus.on(evt, fn, id, opts);
        cleanup.add(() => EventBus.offById(hId));
      }
      // 全量清除作为后盾
      cleanup.add(() => EventBus.offByMod(id));
    }

    // ═══════════════════════════════════════════════════════════════
    //  6. DECLARATIVE RENDER INSTALLER
    //  descriptor.render:
    //    pre:  fn(g) | { fn, priority }
    //    post: fn(g) | { fn, priority }
    //    hud:  fn(g) | { fn, priority }
    // ═══════════════════════════════════════════════════════════════
    function installRender(renderDesc, id, cleanup) {
      if (!isObj(renderDesc)) return;
      for (const layer of ['pre', 'post', 'hud']) {
        const binding = renderDesc[layer];
        if (!binding) continue;
        const fn  = isFunc(binding) ? binding : binding.fn;
        const pri = isObj(binding) ? (binding.priority || 0) : 0;
        if (!isFunc(fn)) continue;
        const compat = (payloadOrCtx, payloadMaybe) => {
          const payload = payloadMaybe || payloadOrCtx || {};
          const g = payload.ctx || payload.g || payloadOrCtx;
          return fn(g, payload);
        };
        RenderPipeline[layer]?.(compat, id, pri);
      }
      cleanup.add(() => RenderPipeline.removeByMod(id));
    }

    // ═══════════════════════════════════════════════════════════════
    //  7. DECLARATIVE KEY INSTALLER
    //  descriptor.keys:
    //    'KeyCode': handler
    //    'KeyCode': { action, mode?, label? }
    // ═══════════════════════════════════════════════════════════════
    function installKeys(keysDesc, id, cleanup) {
      if (!isObj(keysDesc)) return;
      for (const [code, binding] of Object.entries(keysDesc)) {
        const fn   = isFunc(binding) ? binding : binding?.action;
        if (!isFunc(fn)) continue;
        InputRouter.bind(code, fn, id);
      }
      cleanup.add(() => InputRouter.unbindAll(id));
    }

    // ═══════════════════════════════════════════════════════════════
    //  8. AUTO PANEL BUILDER
    //  descriptor.panel:
    //    title:    string
    //    position: { top?, left?, right?, bottom?, width? }
    //    controls: Control[]
    //  Control types:
    //    heading:   { type:'heading',  text }
    //    separator: { type:'separator' }
    //    slider:    { type:'slider',   state, label, min, max, step, onChange? }
    //    toggle:    { type:'toggle',   state, label, onChange? }
    //    select:    { type:'select',   state, label, options:[str | {value,label}], onChange? }
    //    button:    { type:'button',   label, color?, action }
    //    display:   { type:'display',  label, bind, color? }
    //    text:      { type:'text',     tag?, style?, text }
    // ═══════════════════════════════════════════════════════════════
    function buildPanel(panelDesc, state, id, cleanup) {
      if (!isObj(panelDesc)) return null;
      const { title = id, position = {}, controls = [] } = panelDesc;
      const C = UIFramework?.components;
      if (!C) { _warn('[Nova] UIFramework.components not available'); return null; }

      const children = controls.map(ctrl => {
        const type = ctrl.type || 'unknown';
        switch (type) {

          case 'heading':
            return C.heading?.({ text: ctrl.text || ctrl.label || '' })
              || { tag:'div', class:'nep-section', text: ctrl.text || ctrl.label };

          case 'separator':
            return C.separator?.()
              || { tag:'hr', style:'border:none;border-top:1px solid rgba(255,255,255,0.08);margin:6px 0;' };

          case 'slider': {
            const initVal = ctrl.state ? (state.get(ctrl.state) ?? ctrl.value ?? 0) : (ctrl.value ?? 0);
            return C.slider({
              label:    ctrl.label || ctrl.state || '?',
              min:      ctrl.min   ?? 0,
              max:      ctrl.max   ?? 100,
              step:     ctrl.step  ?? 1,
              value:    initVal,
              onChange: (v) => {
                if (ctrl.state) state.set(ctrl.state, v);
                if (isFunc(ctrl.onChange)) ctrl.onChange(v, state);
              }
            });
          }

          case 'toggle': {
            const initOn = ctrl.state ? !!state.get(ctrl.state) : !!ctrl.checked;
            return C.toggle({
              label:    ctrl.label || ctrl.state || '?',
              checked:  initOn,
              onChange: (v) => {
                if (ctrl.state) state.set(ctrl.state, v);
                if (isFunc(ctrl.onChange)) ctrl.onChange(v, state);
              }
            });
          }

          case 'select': {
            const opts = (ctrl.options || []).map(o => isStr(o) ? { value: o, label: o } : o);
            const el   = document.createElement('select');
            el.style.cssText = 'width:100%;margin-bottom:6px;padding:4px;background:#0a0a1a;color:#52E6FF;border:1px solid rgba(82,230,255,0.25);font-family:monospace;font-size:10px;';
            if (ctrl.label) {
              const lbl = document.createElement('div');
              lbl.style.cssText = 'font-size:9px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px;';
              lbl.textContent = ctrl.label;
              // We'll wrap in a div below
            }
            opts.forEach(o => {
              const opt = document.createElement('option');
              opt.value = o.value; opt.textContent = o.label;
              el.appendChild(opt);
            });
            if (ctrl.state) el.value = state.get(ctrl.state) || '';
            el.addEventListener('change', () => {
              if (ctrl.state) state.set(ctrl.state, el.value);
              if (isFunc(ctrl.onChange)) ctrl.onChange(el.value, state);
            });
            return el;
          }

          case 'button': {
            return C.button({
              label:   ctrl.label || '?',
              color:   ctrl.color,
              style:   ctrl.style,
              onClick: () => isFunc(ctrl.action) && ctrl.action(state, id),
            });
          }

          case 'display': {
            const bindKey = ctrl.bind || ctrl.state;
            const el = C.stat?.({
              label: ctrl.label || bindKey || '?',
              value: bindKey ? String(state.get(bindKey) ?? '') : '—',
              color: ctrl.color || '#52E6FF',
            });
            if (el && bindKey) {
              const unsub = state.watch(bindKey, (v) => {
                try { el.update?.(v); } catch(_) {}
              });
              cleanup.add(unsub);
            }
            return el;
          }

          case 'text':
            return { tag: ctrl.tag || 'div', style: ctrl.style || '', text: ctrl.text || '' };

          default:
            return null;
        }
      }).filter(Boolean);

      const posStyle = {
        top:   '20%', left: 'calc(100% - 280px)', width: '250px',
        ...position
      };

      const panelEl = UIFramework.floatingPanel?.({
        title,
        modId: id,
        style: posStyle,
        children,
      }, id);

      if (panelEl) cleanup.add(() => { try { panelEl.remove?.(); } catch(_) {} });
      return panelEl;
    }

    // ═══════════════════════════════════════════════════════════════
    //  9. WAVE DIRECTOR HELPER
    //  descriptor.waves:
    //    entries:  WaveEntry[]   → WaveDirectorCfg.addEntry(...)
    //    filters:  fn[]          → WaveDirectorCfg.filter(...)
    //    onWave:   fn            → WaveDirectorCfg.onWave(...)
    //    drops:    DropRule[]    → WaveDirectorCfg.drop(...)
    // ═══════════════════════════════════════════════════════════════
    function installWaves(wavesDesc, id, cleanup) {
      if (!isObj(wavesDesc)) return;
      const wd = WaveDirectorCfg.forMod?.(id);
      if (!wd) return;

      (wavesDesc.entries || []).forEach(e => wd.addEntry?.(e));
      (wavesDesc.filters || []).forEach(f => wd.filter?.(f));
      if (isFunc(wavesDesc.onWave)) wd.onWave?.(wavesDesc.onWave);
      (wavesDesc.drops || []).forEach(d => wd.drop?.(d));

      // Cleanup handled by WaveDirectorCfg internals (modId tracking)
    }

    // ═══════════════════════════════════════════════════════════════
    //  10. LIFECYCLE API (ctx 传给 setup / tick)
    // ═══════════════════════════════════════════════════════════════
    function buildCtx(record) {
      const { id, state, parentId } = record;
      return {
        id,
        state,
        game:       GameAPI,
        player:     PlayerAPI,
        fort:       FortressAPI,
        nep:        NEP,
        resolver:   GlobalResolver,
        // Parent state access (for sub-mods)
        parentState: parentId ? (_mods.get(parentId)?.state || null) : null,
        log:  msg => _info(`[Nova:${id}] ${msg}`),
        warn: msg => _warn(`[Nova:${id}] ${msg}`),
        err:  msg => _error(`[Nova:${id}] ${msg}`),
        emit: (ev, ...a) => EventBus.emit(ev, ...a),
        toast:(msg, col, dur) => UIManager.toast(msg, col, dur),
        shared: {
          get:   (k, def) => SharedStore.get('nova', k, def),
          set:   (k, v)   => SharedStore.set('nova', k, v, id),
          watch: (k, cb)  => SharedStore.watch('nova', k, cb, id),
        },
        service: {
          provide: (name, impl, ver) => ServiceRegistry.provide(name, impl, id, ver),
          lookup:  (name) => ServiceRegistry.lookup(name),
        },
      };
    }

    // ═══════════════════════════════════════════════════════════════
    //  11. CORE MOD REGISTRY
    // ═══════════════════════════════════════════════════════════════
    const _mods    = new Map(); // id → ModRecord
    const _plugins = new Map(); // hostId → Map(pluginId → desc)
    const _tickMap = new Map(); // id → { fn, ctx }

    // 挂载全局 tick 驱动
    EventBus.on('forge:tick', (dt) => {
      for (const [id, { fn, ctx }] of _tickMap) {
        try { fn(ctx, dt); } catch(e) {
          _warn(`[Nova] tick error in "${id}": ${e.message}`);
        }
      }
    }, 'nova-forge');

    function _install(desc, parentId = null) {
      const id = desc.id || uid();
      if (_mods.has(id)) {
        _warn(`[Nova] "${id}" already installed. Use Nova.reload(id) to reinstall.`);
        return id;
      }

      const cleanup = createCleanup();
      const state   = createReactiveState(desc.state || {});
      const record  = {
        id, desc, parentId, state, cleanup,
        loaded: false, enabled: true,
        _subMods: [], _err: null,
      };
      _mods.set(id, record);

      try {
        // — Catalog ——————————————————————————————————————————————
        if (desc.catalog)  installCatalog(desc.catalog,  id, cleanup);

        // — Patches ——————————————————————————————————————————————
        if (desc.patch)    installPatches(desc.patch,    id, cleanup);
        cleanup.add(() => PatchMgr.revertAll(id));

        // — Events ———————————————————————————————————————————————
        if (desc.events)   installEvents(desc.events, id, cleanup);

        // — Render ———————————————————————————————————————————————
        if (desc.render)   installRender(desc.render,  id, cleanup);

        // — Keys —————————————————————————————————————————————————
        if (desc.keys)     installKeys(desc.keys,    id, cleanup);

        // — WaveDirector ——————————————————————————————————————————
        if (desc.waves)    installWaves(desc.waves,  id, cleanup);

        // — Tick handler —————————————————————————————————————————
        if (isFunc(desc.tick)) {
          const ctx = buildCtx(record);
          _tickMap.set(id, { fn: desc.tick, ctx });
          cleanup.add(() => _tickMap.delete(id));
        }

        // — Services ————————————————————————————————————————————
        if (isObj(desc.services)) {
          for (const [name, impl] of Object.entries(desc.services)) {
            ServiceRegistry.provide(name, impl, id, impl.version);
          }
          cleanup.add(() => ServiceRegistry.revokeAll(id));
        }

        // — Setup lifecycle ——————————————————————————————————————
        const ctx = buildCtx(record);
        if (isFunc(desc.setup)) {
          desc.setup.call({ id, state, parentState: ctx.parentState }, ctx);
        }

        // — Panel (deferred, needs DOM) —————————————————————————
        if (isObj(desc.panel)) {
          requestAnimationFrame(() => {
            if (_mods.has(id) && _mods.get(id).loaded) {
              buildPanel(desc.panel, state, id, cleanup);
            }
          });
        }

        // — Sub-Mods (mod-in-mod) ————————————————————————————————
        if (isObj(desc.mods)) {
          for (const [subKey, subDesc] of Object.entries(desc.mods)) {
            const subId = `${id}::${subKey}`;
            _install({ ...subDesc, id: subId }, id);
            record._subMods.push(subId);
            cleanup.add(() => _uninstall(subId));
          }
        }

        // — Registered Plugins ———————————————————————————————————
        if (_plugins.has(id)) {
          for (const [pluginKey, pluginDesc] of _plugins.get(id)) {
            const pId = `${id}::plugin::${pluginKey}`;
            _install({ ...pluginDesc, id: pId }, id);
            record._subMods.push(pId);
            cleanup.add(() => _uninstall(pId));
          }
        }

        record.loaded = true;
        record._err   = null;
        _info(`[Nova] ✓ "${desc.name || id}" v${desc.version || '?'} installed.`);
        UIManager.toast(`✦ ${desc.name || id}`, '#B36CFF', 2000);
        EventBus.emit('nova:installed', id, record);

      } catch(e) {
        record._err   = e.message || String(e);
        record.loaded = false;
        _error(`[Nova] Failed to install "${id}": ${record._err}`);
      }

      _refreshMenuTab();
      return id;
    }

    function _uninstall(id) {
      const record = _mods.get(id);
      if (!record) return;

      // teardown lifecycle
      if (isFunc(record.desc.teardown)) {
        try { record.desc.teardown.call({ id, state: record.state }); } catch(e) {}
      }

      record.cleanup.runAll();
      record.loaded = false;
      _mods.delete(id);

      EventBus.emit('nova:uninstalled', id);
      _refreshMenuTab();
      _info(`[Nova] "${record.desc.name || id}" uninstalled.`);
    }

    function _topLevelRecords() {
      return [..._mods.values()].filter(r => !r.parentId);
    }

    function _snapshotTopLevelDescriptors() {
      return _topLevelRecords().map(r => ({
        id: r.id,
        descriptor: { ...r.desc },
      }));
    }

    function _restoreFromSnapshot(snapshot = []) {
      if (!Array.isArray(snapshot)) return { restored: 0 };
      let restored = 0;
      for (const item of snapshot) {
        const id = item?.id;
        const descriptor = item?.descriptor;
        if (!isStr(id) || !isObj(descriptor)) continue;
        _install({ ...descriptor, id });
        restored++;
      }
      return { restored };
    }

    // ═══════════════════════════════════════════════════════════════
    //  12. MENU TAB
    // ═══════════════════════════════════════════════════════════════
    let _tabContainer = null;

    function _createMenuTab() {
      UIManager.registerCustomTab('✦ NOVA', 'nova', (container) => {
        _tabContainer = container;
        _renderTab(container);
      });
    }

    function _refreshMenuTab() {
      if (_tabContainer) {
        try { _renderTab(_tabContainer); } catch(_) {}
      }
    }

    function _renderTab(container) {
      container.innerHTML = '';

      // ── Header ───────────────────────────────────────────────
      const hdr = document.createElement('div');
      hdr.style.cssText = 'padding:6px 0 10px;border-bottom:1px solid rgba(179,108,255,0.25);margin-bottom:10px;';
      hdr.innerHTML = `
        <div style="font-size:17px;font-weight:900;color:#B36CFF;letter-spacing:3px;text-shadow:0 0 14px #B36CFF55;">✦ NOVA FORGE</div>
        <div style="font-size:9px;color:#555;margin-top:2px;font-family:monospace;">META-MODLOADER v1.2 · ${[..._mods.values()].filter(m => !m.parentId).length} mods · Type Nova.help() for docs</div>
      `;
      container.appendChild(hdr);

      // ── Install Panel ─────────────────────────────────────────
      const installDiv = document.createElement('div');
      installDiv.style.cssText = 'margin-bottom:10px;';
      const ta = document.createElement('textarea');
      ta.placeholder = '// Nova.def("my-mod", { ... })';
      ta.style.cssText = 'width:100%;height:72px;background:#060614;color:#ccc;border:1px solid rgba(179,108,255,0.25);font-family:monospace;font-size:9px;padding:6px;resize:vertical;';
      const btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:5px;margin-top:5px;';

      const mkBtn = (label, col, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `flex:1;padding:5px;font-family:monospace;font-size:9px;background:rgba(${col},0.1);border:1px solid rgba(${col},0.4);color:rgb(${col});cursor:pointer;text-transform:uppercase;`;
        b.addEventListener('click', fn);
        return b;
      };

      btnRow.appendChild(mkBtn('INSTALL', '179,108,255', () => {
        const code = ta.value.trim();
        if (!code) return;
        try {
          new Function('Nova', 'NEPForge', code)(window.Nova, window.NEPForge);
          ta.value = '';
        } catch(e) {
          UIManager.toast(`Nova error: ${e.message}`, '#FF2F57', 3000);
          _error(`[Nova/tab] Install error: ${e.message}`);
        }
      }));
      btnRow.appendChild(mkBtn('CLEAR', '100,100,100', () => { ta.value = ''; }));
      btnRow.appendChild(mkBtn('HELP', '82,230,255', () => window.Nova?.help()));

      installDiv.appendChild(ta);
      installDiv.appendChild(btnRow);
      container.appendChild(installDiv);

      // ── Mods List ─────────────────────────────────────────────
      const modSection = document.createElement('div');
      const topLevelMods = [..._mods.values()].filter(r => !r.parentId);

      const sHdr = document.createElement('div');
      sHdr.style.cssText = 'font-size:9px;color:#B36CFF;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;';
      sHdr.textContent = `Active Mods (${topLevelMods.length})`;
      modSection.appendChild(sHdr);

      const toolbox = document.createElement('div');
      toolbox.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin:0 0 8px 0;';
      const toolboxBtn = (label, col, fn) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = `padding:4px 6px;font-family:monospace;font-size:9px;background:rgba(${col},0.08);border:1px solid rgba(${col},0.35);color:rgb(${col});cursor:pointer;text-transform:uppercase;`;
        b.addEventListener('click', fn);
        return b;
      };
      toolbox.appendChild(toolboxBtn('RELOAD ALL', '82,230,255', () => window.Nova?.reloadAll()));
      toolbox.appendChild(toolboxBtn('UNLOAD ALL', '255,47,87', () => window.Nova?.unloadAll()));
      toolbox.appendChild(toolboxBtn('SAVE PROFILE', '179,108,255', () => {
        const key = prompt('Profile name?', `profile-${Date.now()}`);
        if (!key) return;
        const res = window.Nova?.profile?.save(key);
        UIManager.toast(`Saved ${res?.count || 0} mods → ${key}`, '#B36CFF', 2000);
      }));
      toolbox.appendChild(toolboxBtn('LOAD PROFILE', '255,176,32', () => {
        const names = window.Nova?.profile?.list?.() || [];
        if (!names.length) { UIManager.toast('No profile found', '#FF2F57', 1800); return; }
        const key = prompt(`Load profile:\n${names.join('\n')}`, names[0]);
        if (!key) return;
        const res = window.Nova?.profile?.load(key, { clear: true });
        UIManager.toast(`Loaded ${res?.restored || 0} mods ← ${key}`, '#FFB020', 2200);
      }));
      modSection.appendChild(toolbox);

      if (topLevelMods.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#222;font-size:11px;text-align:center;padding:16px 0;';
        empty.textContent = 'No Nova mods installed';
        modSection.appendChild(empty);
      } else {
        topLevelMods.forEach(rec => modSection.appendChild(_buildCard(rec)));
      }
      container.appendChild(modSection);
    }

    function _buildCard(record) {
      const { id, desc, state, _subMods, _err, loaded } = record;
      const card = document.createElement('div');
      card.style.cssText = `
        margin-bottom:7px;padding:7px;
        background:${loaded ? 'rgba(179,108,255,0.05)' : 'rgba(255,47,87,0.04)'};
        border:1px solid ${loaded ? 'rgba(179,108,255,0.28)' : 'rgba(255,47,87,0.28)'};
        border-left:2px solid ${loaded ? '#B36CFF' : '#FF2F57'};
      `;

      // Title row
      const titleRow = document.createElement('div');
      titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:3px;';
      titleRow.innerHTML = `
        <div>
          <span style="color:#B36CFF;font-weight:bold;font-size:11px;">${desc.name || id}</span>
          <span style="color:#444;font-size:9px;margin-left:5px;font-family:monospace;">v${desc.version || '?'}</span>
          ${_subMods.length ? `<span style="color:#555;font-size:8px;margin-left:4px;">[${_subMods.length} sub]</span>` : ''}
        </div>
        <div style="display:flex;gap:3px;">
          <button data-action="reload" style="padding:1px 5px;font-size:9px;background:rgba(255,176,32,0.1);border:1px solid rgba(255,176,32,0.3);color:#FFB020;font-family:monospace;cursor:pointer;">↺</button>
          <button data-action="unload" style="padding:1px 5px;font-size:9px;background:rgba(255,47,87,0.1);border:1px solid rgba(255,47,87,0.3);color:#FF2F57;font-family:monospace;cursor:pointer;">✕</button>
        </div>
      `;
      card.appendChild(titleRow);

      if (desc.description) {
        const dsc = document.createElement('div');
        dsc.style.cssText = 'color:#555;font-size:9px;margin-bottom:3px;';
        dsc.textContent = desc.description;
        card.appendChild(dsc);
      }

      if (_err) {
        const err = document.createElement('div');
        err.style.cssText = 'color:#FF2F57;font-size:9px;font-family:monospace;';
        err.textContent = `✘ ${_err}`;
        card.appendChild(err);
      }

      // State inspector
      if (loaded) {
        const snap = state.snapshot();
        const keys = Object.keys(snap).filter(k => !k.startsWith('_'));
        if (keys.length > 0) {
          const stateDiv = document.createElement('div');
          stateDiv.style.cssText = 'margin-top:4px;padding:3px 5px;background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.04);font-family:monospace;font-size:8px;';
          keys.slice(0, 5).forEach(k => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;color:#444;margin:1px 0;';
            const v = JSON.stringify(snap[k]);
            row.innerHTML = `<span>${k}</span><span style="color:#B36CFF88;">${(v || '').slice(0, 18)}</span>`;
            stateDiv.appendChild(row);
          });
          if (keys.length > 5) {
            const more = document.createElement('div');
            more.style.cssText = 'color:#333;font-size:8px;';
            more.textContent = `…+${keys.length - 5} more keys`;
            stateDiv.appendChild(more);
          }
          card.appendChild(stateDiv);
        }
      }

      // Sub-mod list
      if (_subMods.length > 0) {
        const subList = document.createElement('div');
        subList.style.cssText = 'font-size:8px;color:#444;margin-top:3px;';
        subList.textContent = 'Sub: ' + _subMods.map(sid => {
          const sr = _mods.get(sid);
          return sr?.desc?.id?.split('::').pop() || sid.split('::').pop();
        }).join(' · ');
        card.appendChild(subList);
      }

      // Buttons
      card.querySelector('[data-action="reload"]')?.addEventListener('click', () => Nova.reload(id));
      card.querySelector('[data-action="unload"]')?.addEventListener('click', () => Nova.unload(id));

      return card;
    }

    // ═══════════════════════════════════════════════════════════════
    //  13. PUBLIC API  →  window.Nova
    // ═══════════════════════════════════════════════════════════════
    window.Nova = {

      /**
       * Nova.def(id, descriptor)
       * 声明并安装一个 Nova Mod。
       *
       * descriptor 字段（全部可选，按需填写）：
       *   id          string   Mod 唯一 ID
       *   name        string   显示名称
       *   version     string   版本号
       *   description string   说明
       *
       *   state       object   初始响应式状态 { key: defaultVal }
       *   catalog     object   声明式注册 { affix/trait/emitter/wrapper/move/upgrade/structure/bodyKind/appearance/wave }
       *   patch       object   声明式补丁 { 'fnName': { before/after/around/replace/tap }, 'Obj.prop': { get/set } }
       *   events      object   事件侦听   { 'eventName': handler }
       *   render      object   渲染钩子   { pre/post/hud: fn(g) }
       *   keys        object   键盘绑定   { 'KeyCode': handler }
       *   waves       object   波次配置   { entries/filters/onWave/drops }
       *   panel       object   自动面板   { title, position, controls:[...] }
       *   services    object   服务提供   { serviceName: { ...impl } }
       *   mods        object   子模组     { subId: descriptor }  ← Mod-in-Mod
       *
       *   setup(ctx)           安装时回调
       *   tick(ctx, dt)        每帧回调
       *   teardown()           卸载时回调
       */
      def(id, descriptor) {
        if (!isStr(id))  throw new TypeError('Nova.def: id must be a string');
        if (!isObj(descriptor)) throw new TypeError('Nova.def: descriptor must be an object');
        return _install({ id, ...descriptor });
      },

      /** 批量安装：[{id, ...descriptor}] 或 {id: descriptor} */
      defMany(entries = []) {
        const out = [];
        if (Array.isArray(entries)) {
          for (const item of entries) {
            if (!isObj(item) || !isStr(item.id)) continue;
            out.push(_install({ ...item }));
          }
        } else if (isObj(entries)) {
          for (const [id, descriptor] of Object.entries(entries)) {
            if (!isObj(descriptor)) continue;
            out.push(_install({ id, ...descriptor }));
          }
        }
        return out;
      },

      /** 卸载一个 Nova Mod（含所有子 Mod 和插件） */
      unload(id) { _uninstall(id); },

      /** 热重载（保留原始 descriptor，先卸载再重装） */
      reload(id) {
        const rec = _mods.get(id);
        if (!rec) { _warn(`Nova.reload: "${id}" not found`); return; }
        const desc = rec.desc;
        _uninstall(id);
        _install(desc);
      },

      /** 重载所有顶层 Mod（按当前加载顺序） */
      reloadAll() {
        const ids = _topLevelRecords().map(r => r.id);
        let ok = 0;
        for (const id of ids) {
          const rec = _mods.get(id);
          if (!rec) continue;
          const desc = rec.desc;
          _uninstall(id);
          _install(desc);
          ok++;
        }
        _info(`[Nova] reloadAll done (${ok}).`);
        return ok;
      },

      /** 卸载所有顶层 Mod */
      unloadAll() {
        const ids = _topLevelRecords().map(r => r.id);
        ids.forEach(id => _uninstall(id));
        _info(`[Nova] unloadAll done (${ids.length}).`);
        return ids.length;
      },

      /** 获取 Mod 记录（包含 state、desc、subMods 等） */
      get(id) { return _mods.get(id) || null; },

      /** 列出所有顶层 Nova Mod */
      list() {
        return _topLevelRecords()
          .map(r => ({
            id:      r.id,
            name:    r.desc.name || r.id,
            version: r.desc.version || '?',
            loaded:  r.loaded,
            error:   r._err,
            subMods: r._subMods,
          }));
      },

      /** 输出 Mod 拓扑图（父子/插件关系） */
      graph() {
        const nodes = [..._mods.values()].map(r => ({
          id: r.id,
          parentId: r.parentId || null,
          loaded: !!r.loaded,
          subMods: (r._subMods || []).slice(),
        }));
        const edges = [];
        for (const n of nodes) {
          for (const s of n.subMods || []) edges.push({ from: n.id, to: s, type: 'submod' });
          if (n.parentId) edges.push({ from: n.parentId, to: n.id, type: 'parent' });
        }
        return { nodes, edges };
      },

      /** 运行时健康诊断（快速查看是否有失败 mod / 未清理 tick） */
      doctor() {
        const failed = [..._mods.values()].filter(r => !!r._err).map(r => ({ id: r.id, error: r._err }));
        return {
          version: '1.2.0',
          totalMods: _mods.size,
          topLevel: _topLevelRecords().length,
          ticking: _tickMap.size,
          pluginHosts: _plugins.size,
          failed,
        };
      },

      /**
       * Nova.plugin(hostId, pluginId, descriptor)
       * 为已安装的 Nova Mod 注册插件。
       * 若宿主已加载，插件立即安装；否则等宿主安装时自动加载。
       */
      plugin(hostId, pluginId, descriptor) {
        if (!_plugins.has(hostId)) _plugins.set(hostId, new Map());
        _plugins.get(hostId).set(pluginId, descriptor);
        const host = _mods.get(hostId);
        if (host?.loaded) {
          const pId = `${hostId}::plugin::${pluginId}`;
          _install({ ...descriptor, id: pId }, hostId);
          host._subMods.push(pId);
          host.cleanup.add(() => _uninstall(pId));
        }
        _info(`[Nova] Plugin "${pluginId}" registered for "${hostId}".`);
      },

      /**
       * Nova.compose(id, ...descriptors)
       * 将多个 descriptor 合并为一个 Mod。
       * catalog/patch/events/render/keys/mods 深度合并；
       * setup/tick/teardown 按顺序串联；
       * metadata（name/version/state）最后一个赢。
       */
      compose(id, ...descriptors) {
        const merged = {
          id,
          catalog: {}, patch: {}, events: {}, render: {},
          keys: {}, mods: {}, services: {},
        };

        const mergeEvents = (existing, incoming) => {
          const out = { ...existing };
          for (const [ev, fn] of Object.entries(incoming)) {
            if (out[ev]) { const prev = out[ev]; out[ev] = (...a) => { prev(...a); fn(...a); }; }
            else out[ev] = fn;
          }
          return out;
        };

        const chainFn = (existing, incoming) => {
          if (!existing) return incoming;
          return function(...a) { existing.apply(this, a); incoming.apply(this, a); };
        };

        descriptors.forEach(desc => {
          // Metadata: last wins
          ['name','version','description','state'].forEach(k => {
            if (desc[k] !== undefined) merged[k] = desc[k];
          });
          // Deep merge catalogs
          if (desc.catalog) {
            for (const [t, entries] of Object.entries(desc.catalog)) {
              merged.catalog[t] = { ...(merged.catalog[t] || {}), ...entries };
            }
          }
          // Merge patch/render/keys/mods/services (last wins per key)
          if (desc.patch)    Object.assign(merged.patch,    desc.patch);
          if (desc.render)   Object.assign(merged.render,   desc.render);
          if (desc.keys)     Object.assign(merged.keys,     desc.keys);
          if (desc.mods)     Object.assign(merged.mods,     desc.mods);
          if (desc.services) Object.assign(merged.services, desc.services);
          // Events: fan-out (all handlers run)
          if (desc.events)   merged.events = mergeEvents(merged.events, desc.events);
          // Lifecycle: chain
          if (isFunc(desc.setup))    merged.setup    = chainFn(merged.setup,    desc.setup);
          if (isFunc(desc.tick))     merged.tick     = chainFn(merged.tick,     desc.tick);
          if (isFunc(desc.teardown)) merged.teardown = chainFn(merged.teardown, desc.teardown);
        });

        return _install(merged);
      },

      /** 打开 Nova 菜单 Tab */
      openTab() { UIManager.openTab('nova'); },

      /** 跨 Mod 共享存储 */
      shared: {
        get:   (k, def) => SharedStore.get('nova', k, def),
        set:   (k, v)   => SharedStore.set('nova', k, v, 'nova-forge'),
        watch: (k, cb)  => SharedStore.watch('nova', k, cb, 'nova-forge'),
      },

      /** 导出/导入 mod pack，便于跨设备迁移 */
      exportPack() {
        return _snapshotTopLevelDescriptors();
      },
      importPack(snapshot, { clear = false } = {}) {
        if (clear) this.unloadAll();
        return _restoreFromSnapshot(snapshot);
      },

      /** 类似 NX/OMEGA 的 profile 工作流：保存/恢复整套 mod 组合 */
      profile: {
        save(name) {
          const key = String(name || '').trim();
          if (!key) throw new Error('Nova.profile.save: name required');
          const all = SharedStore.get('nova', '__profiles__', {});
          const pack = _snapshotTopLevelDescriptors();
          all[key] = {
            savedAt: Date.now(),
            mods: pack,
          };
          SharedStore.set('nova', '__profiles__', all, 'nova-forge');
          return { key, count: pack.length };
        },
        list() {
          const all = SharedStore.get('nova', '__profiles__', {});
          return Object.keys(all);
        },
        load(name, { clear = true } = {}) {
          const key = String(name || '').trim();
          const all = SharedStore.get('nova', '__profiles__', {});
          const profile = all[key];
          if (!profile) throw new Error(`Nova.profile.load: profile "${key}" not found`);
          if (clear) window.Nova?.unloadAll?.();
          return _restoreFromSnapshot(profile.mods);
        },
        remove(name) {
          const key = String(name || '').trim();
          const all = SharedStore.get('nova', '__profiles__', {});
          if (!all[key]) return false;
          delete all[key];
          SharedStore.set('nova', '__profiles__', all, 'nova-forge');
          return true;
        }
      },

      /** 内置预设：快速切换优化策略 */
      preset: {
        performance() {
          const rec = _mods.get('nova-optimizer');
          if (!rec?.state) return false;
          rec.state.update({
            bulletCulling: true,
            enemyLOD: true,
            adaptiveFX: true,
            dynamicThrottle: true,
            fpsTarget: 60,
            cullMargin: 40,
          });
          return true;
        },
        quality() {
          const rec = _mods.get('nova-optimizer');
          if (!rec?.state) return false;
          rec.state.update({
            bulletCulling: true,
            enemyLOD: false,
            adaptiveFX: false,
            dynamicThrottle: false,
            fpsTarget: 50,
            cullMargin: 80,
          });
          return true;
        }
      },

      version: '1.2.0',

      help() {
        console.log(`%c
╔══════════════════════════════════════════════════════════════════╗
║  ✦  NOVA FORGE v1.2  ·  Elegant Meta-Loader for NEP             ║
╠══════════════════════════════════════════════════════════════════╣
║  INSTALL                                                          ║
║    Nova.def(id, descriptor)    Define + install a Nova mod       ║
║    Nova.unload(id)             Unload a mod                      ║
║    Nova.reload(id)             Hot-reload                        ║
║    Nova.reloadAll()            Reload all top-level mods          ║
║    Nova.unloadAll()            Unload all top-level mods          ║
║    Nova.compose(id, ...descs)  Merge + install multiple descs    ║
║    Nova.defMany(list|map)       Batch install many descriptors    ║
║    Nova.plugin(host, id, desc) Register a plugin sub-mod         ║
║    Nova.exportPack()/importPack(pack,{clear})                    ║
║    Nova.profile.save/load/list/remove(name)                       ║
║    Nova.graph() / Nova.doctor()  Runtime topology + diagnostics  ║
╠══════════════════════════════════════════════════════════════════╣
║  DESCRIPTOR FIELDS                                                ║
║    state       { key: defaultValue }   Reactive proxy state      ║
║    catalog     { affix/trait/emitter/wrapper/move/...  }         ║
║    patch       { 'fnName': { before/after/around/replace/tap }   ║
║                  'Obj.prop': { get, set }                        ║
║                  'Obj.method': { around/before/after } }         ║
║    events      { 'event:name': handler }                         ║
║    render      { hud/pre/post: fn(canvas2dCtx) }                 ║
║    keys        { 'KeyCode': fn | { action, mode } }              ║
║    waves       { entries, filters, onWave, drops }               ║
║    panel       { title, position, controls: [                    ║
║                    { type:'slider',  state, label, min, max }    ║
║                    { type:'toggle',  state, label }              ║
║                    { type:'button',  label, action }             ║
║                    { type:'display', label, bind }               ║
║                    { type:'select',  state, label, options }     ║
║                    { type:'heading', text }                      ║
║                    { type:'separator' }                          ║
║                 ] }                                              ║
║    mods        { subId: descriptor }   MOD-IN-MOD (recursive!)  ║
║    services    { name: implementation }                          ║
║    setup(ctx)  / tick(ctx, dt) / teardown()                      ║
╠══════════════════════════════════════════════════════════════════╣
║  ACCESS STATE (in any callback)                                   ║
║    Nova.get('my-mod').state.key        Read                      ║
║    Nova.get('my-mod').state.key = val  Write (reactive)          ║
║    Nova.get('my-mod').state.watch('key', cb)  Subscribe          ║
╠══════════════════════════════════════════════════════════════════╣
║  UI  →  Game menu · ✦ NOVA tab                                   ║
╚══════════════════════════════════════════════════════════════════╝
`, 'color:#B36CFF;font-family:monospace;font-size:11px');
      },
    };

    // Boot
    _createMenuTab();
    _info('[Nova] ✦ Nova Forge v1.2 initialized. Menu tab registered. Nova.help() for docs.');
    UIManager.toast('✦ NOVA FORGE v1.2', '#B36CFF', 3500);
  }
});
