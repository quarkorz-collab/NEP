
// NX META LOADER (mod-in-mod) for NEPForge v4
// Paste into NEPForge INSTALL → RUN JS
NEPForge.install({
  id: 'nx-metaloader',
  name: 'NX MetaLoader',
  version: '1.0.0',
  description: 'A meta-mod that adds a new main menu page and provides an elegant micro-mod DSL + examples suite on top of NEPForge.',
  init(api) {
    'use strict';

    const NEP = window.NEPForge;
    const MOD_ID = api.id;
    const PREFIX = 'nx.';
    const LS_KEY = '__NX_SOURCES_V1__';

    const isObj  = v => v && typeof v === 'object';
    const isFunc = v => typeof v === 'function';
    const isStr  = v => typeof v === 'string';

    const toast = (m, c = '#52E6FF', d = 1800) => api.ui.toast(m, c, d);

    // ────────────────────────────────────────────────────────────────
    // NX core (new "modloader" facade built on NEPForge)
    // ────────────────────────────────────────────────────────────────
    function _normId(id) {
      id = String(id || '').trim();
      if (!id) throw new Error('NX: id required');
      return id.startsWith(PREFIX) ? id : (PREFIX + id);
    }

    function _loadSources() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return isObj(parsed) ? parsed : {};
      } catch (_) { return {}; }
    }

    function _saveSources(obj) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch (_) {}
    }

    const _sources = _loadSources();

    function _runUserCode(code, contextLabel = 'NX.run') {
      if (!isStr(code) || !code.trim()) return;
      // Provide both NX and NEPForge; allow top-level "return" by wrapping.
      const fn = new Function('NX', 'NEPForge', '"use strict";\n' + code + '\n');
      return fn(window.NX, window.NEPForge);
    }

    function _builder(id, name) {
      const desc = {
        id: _normId(id),
        name: name || String(id),
        version: '0.1.0',
        description: '',
        deps: [],
      };

      const ops = [];
      let userInit = null;
      let userCleanup = null;
      let lastApi = null;

      const b = {
        // ── meta ──
        id: desc.id,
        name(v) { desc.name = String(v ?? desc.name); return b; },
        v(v)    { desc.version = String(v ?? desc.version); return b; },
        ver(v)  { return b.v(v); },
        desc(v) { desc.description = String(v ?? ''); return b; },
        deps(...arr) {
          const flat = arr.flat().filter(Boolean);
          desc.deps = flat;
          return b;
        },

        // ── composition ──
        op(fn) { if (isFunc(fn)) ops.push(fn); return b; },
        init(fn) { if (isFunc(fn)) userInit = fn; return b; },
        cleanup(fn) { if (isFunc(fn)) userCleanup = fn; return b; },

        // ── high-level namespaces (all fluent; each returns builder) ──
        events: {
          on(evt, fn, opts)  { return b.op(a => a.events.on(evt, fn, opts)); },
          once(evt, fn, opts){ return b.op(a => a.events.once(evt, fn, opts)); },
          emit(evt, ...args) { return b.op(a => a.events.emit(evt, ...args)); },
        },

        patch: {
          wrap(fnName, w, pri=0, opts={})    { return b.op(a => a.patch.wrap(fnName, w, pri, opts)); },
          around(fnName, w, pri=0, opts={})  { return b.op(a => a.patch.around(fnName, w, pri, opts)); },
          before(fnName, cb, pri=0, opts={}) { return b.op(a => a.patch.before(fnName, cb, pri, opts)); },
          after(fnName, cb, pri=0, opts={})  { return b.op(a => a.patch.after(fnName, cb, pri, opts)); },
          replace(fnName, fn, pri=0, opts={}){ return b.op(a => a.patch.replace(fnName, fn, pri, opts)); },
          tap(fnName, cb, pri=0, opts={})    { return b.op(a => a.patch.tap(fnName, cb, pri, opts)); },

          watch(resolverKeyOrObj, prop, cbs, pri=0) {
            return b.op(a => {
              const target = isStr(resolverKeyOrObj) ? a.resolver.get(resolverKeyOrObj) : resolverKeyOrObj;
              if (!target) return a.warn(`NX.watch: target "${resolverKeyOrObj}" missing`);
              a.patch.watch(target, prop, cbs, pri);
            });
          },

          sys: {
            event_before(m, cb, pri=0, opts={}) { return b.op(a => a.patch.sys.event.before(m, cb, pri, opts)); },
            event_after (m, cb, pri=0, opts={}) { return b.op(a => a.patch.sys.event.after (m, cb, pri, opts)); },
            event_wrap  (m, cb, pri=0, opts={}) { return b.op(a => a.patch.sys.event.wrap  (m, cb, pri, opts)); },

            dom_after(m, cb, pri=0, opts={})    { return b.op(a => a.patch.sys.dom.after(m, cb, pri, opts)); },
            fetch_wrap(fn, pri=0, opts={})      { return b.op(a => a.patch.sys.fetch.wrap(fn, pri, opts)); },
          },
        },

        registry: {
          affix(k,d)      { return b.op(a => a.registry.affix(k,d)); },
          trait(k,d)      { return b.op(a => a.registry.trait(k,d)); },
          emitter(k,f)    { return b.op(a => a.registry.emitter(k,f)); },
          wrapper(k,f,fields){ return b.op(a => a.registry.wrapper(k,f,fields)); },
          edit(cat,k,fn,pri=0){ return b.op(a => a.registry.edit(cat,k,fn,pri)); },
          move(k,f)       { return b.op(a => a.registry.move(k,f)); },
          upgrade(k,d)    { return b.op(a => a.registry.upgrade(k,d)); },
          structure(k,d)  { return b.op(a => a.registry.structure(k,d)); },
          appearance(k,c) { return b.op(a => a.registry.appearance(k,c)); },
          wavePattern(k,d){ return b.op(a => a.registry.wavePattern(k,d)); },
        },

        pipelines: {
          use(name, fn, pri=0) { return b.op(a => a.pipelines.use(name, fn, pri)); },
        },

        render: {
          hud(fn, pri=0)  { return b.op(a => a.render.hud(fn, pri)); },
          pre(fn, pri=0)  { return b.op(a => a.render.pre(fn, pri)); },
          post(fn, pri=0) { return b.op(a => a.render.post(fn, pri)); },
        },

        input: {
          bind(key, fn)     { return b.op(a => a.input.bind(key, fn)); },
          bindOnce(key, fn) { return b.op(a => a.input.bindOnce(key, fn)); },
        },

        schedule: {
          after(fn, sec)    { return b.op(a => a.schedule.after(fn, sec)); },
          every(fn, sec)    { return b.op(a => a.schedule.every(fn, sec)); },
          onWave(fn, wave)  { return b.op(a => a.schedule.onWave(fn, wave)); },
        },

        services: {
          provide(name, impl, ver) { return b.op(a => a.services.provide(name, impl, ver)); },
          require(name, varName = null) {
            return b.op(a => {
              const svc = a.services.require(name);
              if (varName) a.store.set(`svc:${varName}`, svc);
            });
          },
        },

        ui: {
          inject(sel, schema, opts) { return b.op(a => a.ui.inject(sel, schema, opts)); },
          floating(schema)          { return b.op(a => a.ui.floating(schema)); },
          toast(msg, color, dur)    { return b.op(a => a.ui.toast(msg, color, dur)); },
          modal(cfg)                { return b.op(a => a.ui.modal(cfg)); },
          menuTab(label, key, renderFn) { return b.op(a => a.ui.injectMenuTab(label, key, renderFn)); },
        },

        wave: {
          addEntry(cfg)    { return b.op(a => a.waveDirector.addEntry(cfg)); },
          configure(k,mode,opt){ return b.op(a => a.waveDirector.configure(k,mode,opt)); },
          filter(fn)       { return b.op(a => a.waveDirector.filter(fn)); },
          onWave(fn)       { return b.op(a => a.waveDirector.onWave(fn)); },
          drop(cfg)        { return b.op(a => a.waveDirector.drop(cfg)); },
        },

        // ── compile & install ──
        build() {
          const out = {
            ...desc,
            init(a) {
              lastApi = a;
              for (const op of ops) { try { op(a); } catch(e) { a.err(`NX op failed: ${e.message}`); } }
              if (userInit) { try { userInit(a); } catch(e) { a.err(`NX init failed: ${e.message}`); } }
            },
            cleanup() {
              if (userCleanup) { try { userCleanup(lastApi); } catch(_) {} }
            }
          };
          return out;
        },

        install(opts = {}) {
          const d = b.build();
          const autoLoad = opts.autoLoad !== false;
          const saveSrc  = opts.saveSource;
          if (saveSrc && isStr(saveSrc)) {
            _sources[d.id] = saveSrc;
            _saveSources(_sources);
          }
          if (autoLoad) NEP.install(d);
          else { NEP.loader.register(d); }
          return d.id;
        },
      };

      return b;
    }

    function _installAny(input, opts = {}) {
      if (input == null) throw new Error('NX.install: missing input');
      // builder
      if (isObj(input) && isFunc(input.build) && isFunc(input.install)) return input.install(opts);
      // NEPForge descriptor
      if (isObj(input) && isStr(input.id)) {
        const d = { ...input, id: _normId(input.id) };
        if (opts.saveSource && isStr(opts.saveSource)) {
          _sources[d.id] = opts.saveSource;
          _saveSources(_sources);
        }
        if (opts.autoLoad !== false) NEP.install(d);
        else NEP.loader.register(d);
        return d.id;
      }
      // string: JSON / JS
      if (isStr(input)) {
        const s = input.trim();
        if (!s) return null;
        // JSON descriptor
        if (s.startsWith('{') || s.startsWith('[')) {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) {
            const ids = [];
            for (const item of parsed) ids.push(_installAny(item, opts));
            return ids;
          }
          if (!parsed.id) throw new Error('JSON mod missing id');
          parsed.id = _normId(parsed.id);
          if (opts.saveSource) {
            _sources[parsed.id] = input;
            _saveSources(_sources);
          }
          if (opts.autoLoad !== false) NEP.install(parsed);
          else NEP.loader.register(parsed);
          return parsed.id;
        }
        // JS script (usually NX.mod(...).install() or NEPForge.install(...))
        _runUserCode(input, 'NX.install(script)');
        return null;
      }
      throw new Error('NX.install: unsupported input type');
    }

    const NX = {
      version: '0.2.0',
      prefix: PREFIX,

      // Elegant DSL
      mod: (id, name) => _builder(id, name),

      // Universal installer (builder / descriptor / JSON / JS)
      install: (input, opts) => _installAny(input, opts),
      run: (code) => _runUserCode(code, 'NX.run'),

      // Helper: normalized ids
      id: _normId,

      // Persistence (scripts authored in NX editor)
      sources: _sources,
      saveSource(id, code) {
        const nid = _normId(id);
        _sources[nid] = String(code ?? '');
        _saveSources(_sources);
        return nid;
      },
      deleteSource(id) {
        const nid = _normId(id);
        delete _sources[nid];
        _saveSources(_sources);
        return true;
      },

      // Introspection
      listInstalled() {
        return (NEP.loader.list() || []).filter(m => (m.id || '').startsWith(PREFIX));
      },
      get(id) { return NEP.loader.get(_normId(id)); },
      load(id) { NEP.loader.load(_normId(id)); },
      unload(id){ NEP.loader.unload(_normId(id)); },
      reload(id){ NEP.loader.reload(_normId(id)); },
      enable(id){ NEP.loader.enable(_normId(id)); },
      disable(id){ NEP.loader.disable(_normId(id)); },

      // Bundles
      bundle(items = [], opts = {}) {
        const ids = [];
        for (const it of items) ids.push(_installAny(it, opts));
        return ids;
      },

      // Place to attach examples
      examples: {},
      installExample(key, opts = {}) {
        const f = NX.examples[key];
        if (!f) throw new Error(`NX example not found: ${key}`);
        const out = isFunc(f) ? f() : f;
        return _installAny(out, opts);
      },
    };

    window.NX = NX;

    // ────────────────────────────────────────────────────────────────
    // EXAMPLES: rewritten suite (showcasing NEPForge freedom)
    // Each entry is a factory returning either a builder or a descriptor.
    // ────────────────────────────────────────────────────────────────
    NX.examples = {

      // 1) Registry Affix + event hook
      'AFFIX · Electric Rounds': () => NX.mod('ex-electric-rounds', 'Electric Rounds')
        .v('1.0.0')
        .desc('Adds an ELECTRIC affix with extra hit damage + sparks.')
        .registry.affix('ELECTRIC', {
          tags: ['hitfx', 'stat'],
          minWave: 1, weight: 1.2,
          onHit(b, target) {
            try {
              if (target && target.alive) target.onHit?.(5);
              sparks?.(target.x, target.y, 'glowY', 6, 180);
            } catch(_) {}
          }
        })
        .events.on('wave', (wave) => {
          if (wave % 5 === 0) textPop?.(W*0.5, 70, 'ELECTRIC ROUNDS ONLINE', '#52E6FF');
        })
        .ui.toast('ELECTRIC AFFIX READY', '#52E6FF', 1600),

      // 2) Trait that patches enemy update (demonstrates higher-order behavior injection)
      'TRAIT · Pulsar Aura': () => NX.mod('ex-pulsar-aura', 'Pulsar Aura')
        .v('1.0.0')
        .desc('Enemy trait that emits shockwaves every 2s.')
        .registry.trait('PULSAR_AURA', {
          minWave: 5, weight: 0.6, group: 'utility',
          apply(e, d) {
            e._nxPulseCd = 0;
            const old = e.update;
            e.update = function(dt) {
              old?.call(this, dt);
              this._nxPulseCd -= dt;
              if (this._nxPulseCd <= 0) {
                this._nxPulseCd = 2.0;
                spawnShockwave?.(this.x, this.y, '#B36CFF', 120, 0.35);
              }
            };
          }
        }),

      // 3) Emitter factory
      'EMITTER · Triple Shot': () => NX.mod('ex-triple-shot', 'Triple Shot Emitter')
        .v('1.0.0')
        .desc('Registers TRIPLE_SHOT emitter (three-way spray).')
        .registry.emitter('TRIPLE_SHOT', () => ({
          cd: 0.85,
          fire(owner) {
            try {
              const px = Player?.x ?? W*0.5, py = Player?.y ?? H*0.65;
              const baseA = Math.atan2(py - owner.y, px - owner.x);
              for (let i = -1; i <= 1; i++) {
                const a = baseA + i * 0.22;
                spawnBullet?.('E', owner.x, owner.y, Math.cos(a)*320, Math.sin(a)*320, {
                  r: 3, dmg: 12, col: '#FFB020', life: 1.6
                });
              }
            } catch(_) {}
          }
        })),

      // 4) Wrapper + wrapper fields + edit pipeline
      'WRAPPER · Zigzag Split (+Fields/Edit)': () => NX.mod('ex-zigzag-split', 'Zigzag Split Wrapper')
        .v('1.0.0')
        .desc('Adds ZIGZAG_SPLIT wrapper and extends SALVO wrapper fields via Registry.edit.')
        .registry.wrapper('ZIGZAG_SPLIT', (baseFactory, cfg) => {
          const splitAngle = cfg.splitAngle ?? 0.5;
          const baseEm = baseFactory(cfg.baseCfg || cfg);
          return {
            cd: (baseEm.cd || 1) * 1.4,
            fire(owner) {
              const prev = owner._emitAngleOffset || 0;
              owner._emitAngleOffset = prev - splitAngle; baseEm.fire(owner);
              owner._emitAngleOffset = prev + splitAngle; baseEm.fire(owner);
              owner._emitAngleOffset = prev;
            }
          };
        }, [
          { id: 'splitAngle', type: 'number', step: 0.1, def: 0.5, min: 0.1, max: 3.14 }
        ])
        .registry.edit('WrapperFieldDefs', 'SALVO', (fields) => {
          fields.push({ id: 'speedBoost', type: 'number', step: 0.1, def: 1.2, min: 0.2, max: 4 });
          return fields;
        }, 5),

      // 5) Watch API (property interceptor)
      'WATCH · Double Score + Vamp Heal': () => NX.mod('ex-watch-vamp', 'Watch: Double Score + Vamp')
        .v('1.0.0')
        .desc('Watch Game.score setter and heal on enemy spawn.')
        .patch.watch('Game', 'score', {
          set(newVal, oldVal) {
            if (newVal > oldVal) return oldVal + (newVal - oldVal) * 2;
            return newVal;
          }
        }, 50)
        .events.on('enemySpawn', () => {
          const p = Player;
          if (p?.alive && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 1);
        }),

      // 6) Pipeline middleware (cancel player damage when shield high)
      'PIPELINE · Shield Blocks Damage': () => NX.mod('ex-pipe-shield', 'Pipeline: Shield Block')
        .v('1.0.0')
        .desc('Uses playerDamage pipeline to cancel hits when shield > 50.')
        .pipelines.use('playerDamage', (ctx, next) => {
          const p = Player;
          if ((p?.shield || 0) > 50) {
            ctx.cancelled = true;
            textPop?.(p.x || W*0.5, (p.y || H*0.6) - 40, 'BLOCKED', '#52E6FF');
            return;
          }
          next();
        }, 10),

      // 7) Render pipeline HUD overlay
      'RENDER · Perf HUD (FPS/Ticks)': () => NX.mod('ex-perf-hud', 'Perf HUD')
        .v('1.0.0')
        .desc('Canvas HUD overlay showing wave/score/FPS-ish.')
        .init((a) => {
          let dtLast = 0.016;
          a.events.on('forge:tick', (dt) => { dtLast = dt || dtLast; });
          a.render.hud(({ ctx, W, H, game }) => {
            if (!ctx) return;
            ctx.save();
            ctx.font = 'bold 11px Consolas,monospace';
            ctx.fillStyle = 'rgba(82,230,255,0.85)';
            ctx.shadowColor = '#52E6FF';
            ctx.shadowBlur = 6;
            const fps = Math.round(1 / Math.max(0.001, dtLast));
            ctx.fillText(`NX HUD  WAVE ${game?.wave||0}  SCORE ${game?.score||0}  FPS ${fps}`, 12, H - 160);
            ctx.restore();
          }, 0);
        }),

      // 8) UI: Live inject into options panel (lazy)
      'UI · Live Inject (Options NUKE)': () => NX.mod('ex-ui-live-inject', 'UI Live Inject')
        .v('1.0.0')
        .desc('Injects a cheat button into #optionPanel .actions using live injection.')
        .ui.inject('#optionPanel .actions', {
          tag: 'button',
          class: 'nep-btn danger',
          style: 'margin-top:8px;border-color:#FF2F57;',
          text: 'NX: NUKE ENEMIES',
          onClick: () => {
            try {
              const es = (enemies || []);
              es.forEach(e => { try { if (e?.alive) e.onHit?.(99999); } catch(_) {} });
              spawnShockwave?.(W*0.5, H*0.55, '#FF2F57', 850, 0.85);
              const resume = document.getElementById('btnOptResume');
              resume?.click?.();
            } catch(_) {}
          }
        }, { live: true }),

      // 9) UI: Floating control panel using UIFramework
      'UI · Floating Control Panel': () => NX.mod('ex-ui-floating', 'Floating Control Panel')
        .v('1.1.0')
        .desc('Draggable control center with live state + cheats.')
        .init((a) => {
          const { components: C, reactive } = a.ui;
          const state = reactive.state({ wave: 0, score: 0, autoHeal: false });

          a.ui.floating({
            title: 'NX CONTROL',
            style: { top: '28%', left: 'calc(100% - 290px)', width: '250px' },
            children: [
              C.heading({ text: 'LIVE' }),
              C.stat({ label: 'WAVE', value: '0', color: '#52E6FF', ref(el){
                state.bind(el, (d, el2) => el2.update(String(d.wave)));
              }}),
              C.stat({ label: 'SCORE', value: '0', color: '#50DC64', ref(el){
                state.bind(el, (d, el2) => el2.update(String(d.score)));
              }}),
              C.separator(),
              C.heading({ text: 'CHEATS' }),
              C.toggle({
                label: 'AUTO-HEAL (0.8 HP/s)',
                checked: false,
                onChange(on){ state.set('autoHeal', on); }
              }),
              C.slider({
                label: 'DMG MUL',
                min: 0.5, max: 8, step: 0.1,
                value: (Player?.dmgMul ?? 1),
                onChange(v) { try { if (Player) Player.dmgMul = v; } catch(_) {} }
              }),
              { tag:'div', style:'display:flex;gap:8px;margin-top:8px;',
                ref(row){
                  row.appendChild(C.button({ label:'TOAST', onClick:()=>a.ui.toast('NX ONLINE', '#B36CFF') }));
                  row.appendChild(C.button({ label:'INFO', color:'#52E6FF', onClick:()=>{
                    a.ui.modal({ title:'NX', content:{ tag:'div', style:'color:#ccc;font-size:12px;', text:'Floating UI powered by UIFramework components.' },
                      buttons:[{ label:'OK' }] });
                  }}));
                }
              },
            ]
          });

          a.events.on('forge:tick', (dt) => {
            try {
              state.update({
                wave: a.game.wave || 0,
                score: Math.floor(a.game.score || 0),
              });
              if (state.get('autoHeal')) {
                const p = Player;
                if (p?.alive && p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + 0.8 * (dt||0));
              }
            } catch(_) {}
          });
        }),

      // 10) Sys DOM interception demo
      'SYS · DOM Intercept (dim div)': () => NX.mod('ex-sys-dom', 'Sys: DOM Intercept')
        .v('1.0.0')
        .desc('Intercept document.createElement and dim created divs.')
        .patch.sys.dom_after('createElement', (el, args) => {
          try {
            const tag = args?.[0];
            if (typeof tag === 'string' && tag.toLowerCase() === 'div') {
              el.style.opacity = '0.96';
            }
          } catch(_) {}
          return el;
        }, 0, { breaker: { threshold: Infinity } }),

      // 11) Sys fetch interception demo
      'SYS · Fetch Logger': () => NX.mod('ex-sys-fetch', 'Sys: Fetch Logger')
        .v('1.0.0')
        .desc('Wrap fetch and log status codes.')
        .patch.sys.fetch_wrap(async (orig, url, opts) => {
          try { console.log('[NX] fetch:', url); } catch(_) {}
          const res = await orig(url, opts);
          try { console.log('[NX] fetch status:', res.status); } catch(_) {}
          return res;
        }),

      // 12) WaveDirectorCfg advanced: addEntry + configure + filter + onWave + drop
      'WAVE · Configurator (Proto/Filter/Drop)': () => NX.mod('ex-wave-cfg', 'Wave Configurator')
        .v('1.0.0')
        .desc('Adds a custom proto entry, mode override, deck filter, onWave callback, and boss drop.')
        .wave.addEntry({
          key: 'NX_TANKER',
          minWave: 5,
          weight: 1.6,
          modes: ['game', 'fortress'],
          count: 2,
          factory(wave, mode, deck) {
            return {
              isBoss: false,
              hp: 280 + wave * 28,
              moveKeys: ['SWAY_SINE'],
              traits: ['ARMORED', 'PULSAR_AURA'],
              emitters: [{ type: 'TRIPLE_SHOT' }],
              waveBulletMods: ['ELECTRIC'],
              baseCol: '#FF6600',
              bodyKind: 'gear',
            };
          }
        })
        .wave.configure('NX_TANKER', 'fortress', { weight: 3.2, minWave: 2 })
        .wave.filter((deck, wave) => {
          if (wave % 10 === 0 && !deck.some(p => p.isBoss)) {
            deck.push({ isBoss: true, hp: 5200 + wave * 220, moveKeys: ['SMART_EVADER'] });
          }
        })
        .wave.onWave((wave, deck, mode) => {
          if (wave % 5 === 0) textPop?.(W*0.5, 60, `NX WAVE ${wave} · ${deck.length} ENEMIES`, '#FFB020');
        })
        .wave.drop({
          filter: (e) => !!e?.isBoss,
          roll:   ()  => Math.random() < 0.75,
          apply:  (e) => spawnShockwave?.(e.x, e.y, '#FFB020', 420, 0.75),
        }),

      // 13) Services showcase (provide + require)
      'SERVICES · Provider (AmmoMath@1.0)': () => NX.mod('ex-svc-provider', 'Service Provider: AmmoMath')
        .v('1.0.0')
        .desc('Provides a shared service named AmmoMath.')
        .services.provide('AmmoMath', {
          mulDamage(b, mul=1.2) {
            if (!b) return;
            b.dmg = (b.dmg || 1) * mul;
          }
        }, '1.0'),

      'SERVICES · Client (uses AmmoMath)': () => NX.mod('ex-svc-client', 'Service Client: AmmoMath Demo')
        .v('1.0.0')
        .desc('Requires AmmoMath and boosts player bullet damage on spawn.')
        .deps('nx.ex-svc-provider')
        .init((a) => {
          let svc = null;
          try { svc = a.services.require('AmmoMath'); } catch(e) { return a.warn(e.message); }
          a.events.on('bulletSpawn', (b) => {
            if (b && b.team === 'P') svc.mulDamage(b, 1.35);
          });
          a.log('AmmoMath client active');
        }),

      // 14) Cross-mod store + signal
      'CROSS · Signal Broadcaster': () => NX.mod('ex-signal-host', 'Signal Host')
        .v('1.0.0')
        .desc('Broadcasts a signal every 3 waves.')
        .init((a) => {
          a.events.on('wave', (wave) => {
            if (wave % 3 === 0) a.patch.signal.emit('nx:ping', { wave, t: Date.now() });
          });
        }),

      'CROSS · Signal Listener': () => NX.mod('ex-signal-client', 'Signal Client')
        .v('1.0.0')
        .desc('Listens to nx:ping and pops text.')
        .deps('nx.ex-signal-host')
        .init((a) => {
          a.patch.signal.on('nx:ping', (data) => {
            textPop?.(W*0.5, 110, `PING @ WAVE ${data?.wave ?? '?'}`, '#52E6FF');
          });
        }),
    };

    // ────────────────────────────────────────────────────────────────
    // NX Optimizer (installed automatically): fixes a common UI issue by
    // preventing duplicate mods-tab click delegation listeners from stacking.
    // Uses sys.event.before on addEventListener and stack sniffing.
    // ────────────────────────────────────────────────────────────────
    const optimizer = NX.mod('optimizer', 'NX Optimizer')
      .v('1.0.0')
      .desc('Guards against accidental duplicate event bindings in some UIs; also adds small safety rails.')
      .patch.sys.event_before('addEventListener', function(args, cancel) {
        try {
          const [type] = args || [];
          if (type !== 'click') return;

          // Only guard NEPForge mods body delegation; allow other listeners.
          const el = this;
          if (!el || !el.classList || !el.classList.contains('nep-body')) return;

          const st = String((new Error()).stack || '');
          // Heuristic: only block when coming from renderModList path
          if (!/renderModList|_renderModList/i.test(st)) return;

          if (el.__nx_modsClickDelegationBound) return cancel();
          el.__nx_modsClickDelegationBound = true;
        } catch(_) {}
      }, 9999, { breaker: { threshold: Infinity } })
      .init((a) => {
        a.log('Optimizer active');
      });

    try {
      if (!NEP.loader.get('nx.optimizer')) optimizer.install({ autoLoad: true });
    } catch (_) {}

    // ────────────────────────────────────────────────────────────────
    // UI: create a new MAIN MENU PAGE "NX" (not just NEPForge inner tabs)
    // ────────────────────────────────────────────────────────────────
    api.ui.inject('head', {
      tag: 'style',
      id: 'nx-metaloader-style',
      text: `
        .nx-nav-btn{ border-color: rgba(179,108,255,0.55) !important; }
        .nx-page{ display:none; flex-direction:column; height:100%; min-height:0;
                  font-family:"Consolas","Monaco","Courier New",monospace; color:#c8e8ff; }
        .nx-page.active{ display:flex; }
        .nx-top{ padding:8px 10px; border-bottom:1px solid rgba(179,108,255,0.25); background:rgba(0,0,0,0.18); }
        .nx-title{ font-weight:800; letter-spacing:2px; color:#B36CFF; font-size:12px; text-transform:uppercase; }
        .nx-sub{ font-size:10px; color:rgba(255,255,255,0.35); margin-top:3px; }
        .nx-tabs{ display:flex; gap:0; border-bottom:1px solid rgba(179,108,255,0.20); }
        .nx-tab{ flex:1; padding:6px 6px; font-size:10px; letter-spacing:1.4px; text-transform:uppercase;
                 background:none; border:none; cursor:pointer; color:rgba(255,255,255,0.35);
                 border-bottom:2px solid transparent; }
        .nx-tab.active{ color:#B36CFF; border-bottom-color:#B36CFF; }
        .nx-body{ flex:1; overflow:auto; padding:10px; }
        .nx-card{ border:1px solid rgba(179,108,255,0.18); border-radius:3px;
                  background:rgba(0,0,0,0.18); padding:8px 10px; margin-bottom:8px; }
        .nx-row{ display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
        .nx-small{ font-size:10px; color:rgba(255,255,255,0.35); }
        .nx-code{ width:100%; height:160px; background:rgba(0,0,0,0.45);
                  border:1px solid rgba(179,108,255,0.25); color:#cde; font-size:10px;
                  padding:8px; border-radius:2px; resize:vertical; outline:none; line-height:1.5; }
        .nx-code:focus{ border-color: rgba(179,108,255,0.55); }
        .nx-btn{ background:rgba(0,0,0,0.32); border:1px solid rgba(255,255,255,0.16); color:#bbb;
                 padding:4px 8px; font-size:10px; letter-spacing:1px; text-transform:uppercase;
                 cursor:pointer; border-radius:2px; transition:all 0.12s; }
        .nx-btn:hover{ background:rgba(255,255,255,0.07); color:#fff; }
        .nx-btn.p{ border-color:rgba(179,108,255,0.55); color:#B36CFF; }
        .nx-btn.c{ border-color:rgba(82,230,255,0.45); color:#52E6FF; }
        .nx-btn.y{ border-color:rgba(255,176,32,0.45); color:#FFB020; }
        .nx-btn.d{ border-color:rgba(255,47,87,0.45); color:#FF2F57; }
        .nx-chip{ font-size:9px; padding:2px 6px; border-radius:2px;
                  background:rgba(179,108,255,0.08); border:1px solid rgba(179,108,255,0.20);
                  color:rgba(179,108,255,0.75); cursor:pointer; }
        .nx-chip:hover{ background:rgba(179,108,255,0.16); color:#B36CFF; }
      `
    }, { live: true });

    // Inject nav button
    api.ui.inject('#menu .menu-nav', {
      tag: 'button',
      class: 'nav-btn mini-btn nx-nav-btn',
      attrs: { type: 'button' },
      text: 'NX',
      setup(el) {
        el.addEventListener('click', () => {
          try { window.setMenuPage?.('nx'); } catch(_) {}
        });
      }
    }, { live: true });

    // Inject NX page container into menu main
    api.ui.inject('#menu .menu-main', {
      tag: 'div',
      id: 'pageNX',
      class: 'page nx-page',
      children: [
        {
          tag: 'div', class: 'nx-top',
          children: [
            { tag: 'div', class: 'nx-title', text: 'NX META LOADER' },
            { tag: 'div', class: 'nx-sub', text: `v${NX.version} · runs on NEPForge · micro-mod DSL + examples` },
          ]
        },
        {
          tag: 'div', class: 'nx-tabs',
          children: [
            { tag:'button', class:'nx-tab active', data:{ tab:'mods' }, text:'Mods' },
            { tag:'button', class:'nx-tab', data:{ tab:'editor' }, text:'Editor' },
            { tag:'button', class:'nx-tab', data:{ tab:'examples' }, text:'Examples' },
            { tag:'button', class:'nx-tab', data:{ tab:'tools' }, text:'Tools' },
          ]
        },
        { tag: 'div', id: 'nx_body', class: 'nx-body' }
      ],
      setup(pageEl) {
        // Register as extra page for setMenuPage patch (if available)
        try { window._nepRegisterMenuPage?.('nx', pageEl); } catch(_) {}

        const body = pageEl.querySelector('#nx_body');
        const tabs = pageEl.querySelectorAll('.nx-tab');

        const ui = {
          tab: 'mods',
          editorText: _sources['nx.my-mod'] || `// NX DSL quickstart:
NX.mod('hello', 'Hello NX')
  .v('1.0.0')
  .desc('Demo mod created from NX editor')
  .events.on('wave', (wave)=>{ if(wave%3===0) textPop?.(W*0.5, 90, 'HELLO NX @ '+wave, '#B36CFF'); })
  .install({ saveSource: __CODE__ }); // keep a copy in NX storage
`,
        };

        function esc(s) {
          return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
        }

        function renderMods() {
          const list = NX.listInstalled();
          body.innerHTML = `
            <div class="nx-card">
              <div class="nx-row">
                <span class="nx-small">Installed NX mods:</span>
                <span class="nx-chip" data-act="refresh">REFRESH</span>
                <span class="nx-chip" data-act="open-nep">OPEN NEPFORGE MODS</span>
              </div>
            </div>
            ${list.map(m => `
              <div class="nx-card">
                <div class="nx-row" style="justify-content:space-between;">
                  <div>
                    <div style="font-weight:800; letter-spacing:1px; color:${m.loaded ? '#52E6FF' : '#555'}">${esc(m.name)} <span class="nx-small">(${esc(m.id)})</span></div>
                    <div class="nx-small">${esc(m.description || '')}</div>
                    ${m.error ? `<div class="nx-small" style="color:#FF2F57">⚠ ${esc(m.error)}</div>` : ''}
                  </div>
                  <div class="nx-row" style="justify-content:flex-end;">
                    <button class="nx-btn ${m.loaded?'y':'c'}" data-act="${m.loaded?'unload':'load'}" data-id="${esc(m.id)}">${m.loaded?'UNLOAD':'LOAD'}</button>
                    <button class="nx-btn p" data-act="reload" data-id="${esc(m.id)}" ${m.loaded?'':'disabled'}>RELOAD</button>
                    <button class="nx-btn" data-act="${m.enabled?'disable':'enable'}" data-id="${esc(m.id)}">${m.enabled?'DISABLE':'ENABLE'}</button>
                  </div>
                </div>
              </div>
            `).join('') || `<div class="nx-card"><div class="nx-small">No NX mods installed yet. Go to EXAMPLES.</div></div>`}
          `;

          body.onclick = (e) => {
            const el = e.target.closest('[data-act]');
            if (!el) return;
            const act = el.dataset.act;
            const id  = el.dataset.id;

            try {
              if (act === 'refresh') renderMods();
              if (act === 'open-nep') { try { NEP.ui.openTab('mods'); window.setMenuPage?.('nepforge'); } catch(_) {} }
              if (act === 'load') NX.load(id);
              if (act === 'unload') NX.unload(id);
              if (act === 'reload') NX.reload(id);
              if (act === 'enable') NX.enable(id);
              if (act === 'disable') NX.disable(id);
            } catch (err) { toast(err.message, '#FF2F57', 2200); }
            if (act !== 'refresh' && act !== 'open-nep') setTimeout(renderMods, 60);
          };
        }

        function renderEditor() {
          body.innerHTML = `
            <div class="nx-card">
              <div class="nx-row" style="justify-content:space-between;">
                <div class="nx-small">Editor accepts: NX DSL scripts / NEPForge.install(...) scripts / JSON descriptors.</div>
                <div class="nx-row">
                  <button class="nx-btn c" data-act="run">RUN</button>
                  <button class="nx-btn p" data-act="install">INSTALL</button>
                  <button class="nx-btn y" data-act="save">SAVE AS nx.my-mod</button>
                  <button class="nx-btn d" data-act="clear">CLEAR</button>
                </div>
              </div>
              <textarea class="nx-code" id="nx_ta" spellcheck="false"></textarea>
              <div class="nx-row" style="margin-top:8px;">
                <span class="nx-small">Saved:</span>
                ${Object.keys(_sources).slice(0, 18).map(k => `<span class="nx-chip" data-act="loadsrc" data-id="${esc(k)}">${esc(k)}</span>`).join('')}
              </div>
            </div>
          `;

          const ta = body.querySelector('#nx_ta');
          ta.value = ui.editorText;

          body.onclick = async (e) => {
            const el = e.target.closest('[data-act]');
            if (!el) return;
            const act = el.dataset.act;

            if (act === 'clear') { ta.value = ''; ta.focus(); return; }

            if (act === 'loadsrc') {
              const id = el.dataset.id;
              ta.value = _sources[id] || '';
              ta.focus();
              return;
            }

            if (act === 'save') {
              ui.editorText = ta.value;
              NX.saveSource('my-mod', ta.value);
              toast('Saved as nx.my-mod', '#B36CFF', 1500);
              renderEditor();
              return;
            }

            if (act === 'run') {
              ui.editorText = ta.value;
              try {
                // Provide a placeholder variable to allow "saveSource: __CODE__"
                const code = ta.value.replaceAll('__CODE__', JSON.stringify(ta.value));
                NX.run(code);
                toast('Script executed', '#52E6FF', 1200);
              } catch (err) {
                toast(err.message, '#FF2F57', 2600);
              }
              return;
            }

            if (act === 'install') {
              ui.editorText = ta.value;
              try {
                // Heuristic:
                // - If JSON → install as nx.<id> (auto)
                // - Otherwise run as script (expected to call NX.mod(...).install() or NEPForge.install())
                const s = ta.value.trim();
                if (s.startsWith('{') || s.startsWith('[')) {
                  NX.install(s, { saveSource: ta.value });
                  toast('Installed JSON', '#52E6FF', 1400);
                } else {
                  const code = ta.value.replaceAll('__CODE__', JSON.stringify(ta.value));
                  NX.run(code);
                  toast('Installed via script', '#52E6FF', 1400);
                }
              } catch (err) {
                toast(err.message, '#FF2F57', 2600);
              }
              return;
            }
          };
        }

        function renderExamples() {
          const keys = Object.keys(NX.examples);
          body.innerHTML = `
            <div class="nx-card">
              <div class="nx-row" style="justify-content:space-between;">
                <div class="nx-small">One-click installs. These are rewritten to demonstrate NEPForge capabilities.</div>
                <div class="nx-row">
                  <button class="nx-btn c" data-act="install-all">INSTALL ALL</button>
                  <button class="nx-btn y" data-act="load-all">LOAD ALL</button>
                  <button class="nx-btn d" data-act="unload-all">UNLOAD ALL</button>
                </div>
              </div>
            </div>
            ${keys.map(k => `
              <div class="nx-card">
                <div class="nx-row" style="justify-content:space-between;">
                  <div style="font-weight:800; letter-spacing:1px; color:#B36CFF">${esc(k)}</div>
                  <div class="nx-row">
                    <button class="nx-btn p" data-act="install-ex" data-key="${esc(k)}">INSTALL</button>
                  </div>
                </div>
              </div>
            `).join('')}
          `;

          body.onclick = (e) => {
            const el = e.target.closest('[data-act]');
            if (!el) return;
            const act = el.dataset.act;

            try {
              if (act === 'install-ex') {
                const key = el.dataset.key;
                NX.installExample(key, { autoLoad: true });
                toast(`Installed: ${key}`, '#52E6FF', 1400);
              }
              if (act === 'install-all') {
                for (const k of Object.keys(NX.examples)) NX.installExample(k, { autoLoad: false });
                toast('All installed (not loaded)', '#FFB020', 1700);
              }
              if (act === 'load-all') {
                NX.listInstalled().forEach(m => { try { NEP.loader.load(m.id); } catch(_) {} });
                toast('All loaded', '#52E6FF', 1300);
              }
              if (act === 'unload-all') {
                NX.listInstalled().forEach(m => { try { NEP.loader.unload(m.id); } catch(_) {} });
                toast('All unloaded', '#FFB020', 1300);
              }
            } catch (err) { toast(err.message, '#FF2F57', 2600); }
          };
        }

        function renderTools() {
          body.innerHTML = `
            <div class="nx-card">
              <div class="nx-row" style="justify-content:space-between;">
                <div>
                  <div style="font-weight:800;letter-spacing:1px;color:#B36CFF">TOOLS</div>
                  <div class="nx-small">Export sources, open pages, rescan, quick actions.</div>
                </div>
                <div class="nx-row">
                  <button class="nx-btn c" data-act="rescan">RESCAN</button>
                  <button class="nx-btn p" data-act="open-nx">OPEN NX</button>
                  <button class="nx-btn y" data-act="open-nep">OPEN NEPFORGE</button>
                </div>
              </div>
            </div>

            <div class="nx-card">
              <div style="font-weight:800;letter-spacing:1px;color:#B36CFF;margin-bottom:6px;">EXPORT</div>
              <div class="nx-row">
                <button class="nx-btn p" data-act="copy-sources">COPY NX SOURCES</button>
                <button class="nx-btn p" data-act="copy-list">COPY NX MOD LIST</button>
                <button class="nx-btn d" data-act="wipe-sources">WIPE SAVED SOURCES</button>
              </div>
              <div class="nx-small" style="margin-top:6px;">Saved scripts: ${Object.keys(_sources).length}</div>
            </div>

            <div class="nx-card">
              <div style="font-weight:800;letter-spacing:1px;color:#B36CFF;margin-bottom:6px;">OPTIMIZER</div>
              <div class="nx-small">nx.optimizer is auto-installed to guard against accidental duplicate event bindings.</div>
              <div class="nx-row" style="margin-top:6px;">
                <button class="nx-btn c" data-act="load-opt">LOAD</button>
                <button class="nx-btn y" data-act="unload-opt">UNLOAD</button>
                <button class="nx-btn" data-act="status-opt">STATUS</button>
              </div>
            </div>
          `;

          async function copyText(txt) {
            try { await navigator.clipboard?.writeText?.(txt); toast('Copied', '#52E6FF', 900); }
            catch(_) { toast('Clipboard blocked', '#FFB020', 1400); }
          }

          body.onclick = (e) => {
            const el = e.target.closest('[data-act]');
            if (!el) return;
            const act = el.dataset.act;

            try {
              if (act === 'rescan') { NEP.rescan(); toast('Rescanned', '#52E6FF', 1200); }
              if (act === 'open-nx') { window.setMenuPage?.('nx'); }
              if (act === 'open-nep') { window.setMenuPage?.('nepforge'); }

              if (act === 'copy-sources') copyText(JSON.stringify(_sources, null, 2));
              if (act === 'copy-list') copyText(JSON.stringify(NX.listInstalled(), null, 2));

              if (act === 'wipe-sources') {
                for (const k of Object.keys(_sources)) delete _sources[k];
                _saveSources(_sources);
                toast('Wiped', '#FFB020', 1200);
                renderTools();
              }

              if (act === 'load-opt') NEP.loader.load('nx.optimizer');
              if (act === 'unload-opt') NEP.loader.unload('nx.optimizer');
              if (act === 'status-opt') {
                const m = NEP.loader.get('nx.optimizer');
                toast(`optimizer: ${m?.loaded ? 'LOADED' : 'OFF'}`, m?.loaded ? '#52E6FF' : '#FFB020', 1400);
              }
            } catch (err) { toast(err.message, '#FF2F57', 2400); }
          };
        }

        function render() {
          if (ui.tab === 'mods') return renderMods();
          if (ui.tab === 'editor') return renderEditor();
          if (ui.tab === 'examples') return renderExamples();
          if (ui.tab === 'tools') return renderTools();
        }

        // Tab switching
        pageEl.querySelector('.nx-tabs').addEventListener('click', (e) => {
          const btn = e.target.closest('.nx-tab');
          if (!btn) return;
          const t = btn.dataset.tab;
          ui.tab = t;
          tabs.forEach(b => b.classList.toggle('active', b === btn));
          render();
        });

        render();
      }
    }, { live: true });

    toast('NX MetaLoader loaded (menu: NX)', '#B36CFF', 2200);
  },

  cleanup() {
    try {
      // Unregister menu page if present
      if (window.__NEP_EXTRA_PAGES__) delete window.__NEP_EXTRA_PAGES__.nx;
    } catch(_) {}
    try {
      // Optional: keep NX global if you want persistence across reloads.
      // delete window.NX;
    } catch(_) {}
  }
});
