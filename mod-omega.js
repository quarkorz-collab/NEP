// ═══════════════════════════════════════════════════════════════════════
//  OMEGA FRAMEWORK v1.0
//  A complete meta-modloader built on top of NEPForge
//  Features:
//    · 全新声明式语法（OMEGA DSL）
//    · 独立 UI Tab（OMEGA STUDIO）
//    · 热重载 + 沙箱隔离
//    · 类型系统 + 运行时校验
//    · 自动文档生成
//    · 内置调试器
//    · 完整生命周期钩子
// ═══════════════════════════════════════════════════════════════════════
NEPForge.install({
  id: 'omega-framework',
  name: 'OMEGA Framework',
  version: '1.0.0',
  description: 'A complete meta-modloader with its own DSL, UI studio, sandbox, and type system',
  init(api) {

// ═══════════════════════════════════════════════════════════════════════
//  §0  OMEGA 内部工具
// ═══════════════════════════════════════════════════════════════════════
const OMG = (() => {
  const _uid = () => Math.random().toString(36).slice(2, 9);
  const _isFunc = v => typeof v === 'function';
  const _isStr  = v => typeof v === 'string';
  const _isObj  = v => v !== null && typeof v === 'object';
  const _isArr  = v => Array.isArray(v);

  // 深合并
  function _merge(target, ...sources) {
    for (const src of sources) {
      if (!_isObj(src)) continue;
      for (const key of Object.keys(src)) {
        if (_isObj(src[key]) && _isObj(target[key])) {
          _merge(target[key], src[key]);
        } else {
          target[key] = src[key];
        }
      }
    }
    return target;
  }

  // 简单模板引擎：{{key}} 替换
  function _template(str, ctx) {
    return str.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? '');
  }

  // 类型检查器
  const Types = {
    Number:   (v) => typeof v === 'number' && isFinite(v),
    String:   (v) => typeof v === 'string',
    Boolean:  (v) => typeof v === 'boolean',
    Function: (v) => typeof v === 'function',
    Array:    (v) => Array.isArray(v),
    Object:   (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    Color:    (v) => typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v),
    Positive: (v) => typeof v === 'number' && v > 0,
    Range:    (min, max) => (v) => typeof v === 'number' && v >= min && v <= max,
    OneOf:    (...opts) => (v) => opts.includes(v),
    Optional: (check) => (v) => v == null || check(v),
  };

  return { uid: _uid, isFunc: _isFunc, isStr: _isStr, isObj: _isObj, isArr: _isArr,
           merge: _merge, template: _template, Types };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §1  OMEGA 类型系统 & 运行时校验
// ═══════════════════════════════════════════════════════════════════════
const TypeSystem = (() => {
  const _schemas = new Map();

  function define(name, schema) {
    _schemas.set(name, schema);
    return name;
  }

  function validate(typeName, value, path = '') {
    const schema = _schemas.get(typeName);
    if (!schema) return [`Unknown type: ${typeName}`];

    const errors = [];
    for (const [key, checker] of Object.entries(schema)) {
      const val = value[key];
      if (OMG.isFunc(checker)) {
        if (!checker(val)) {
          errors.push(`${path}.${key}: validation failed (got ${JSON.stringify(val)})`);
        }
      } else if (OMG.isStr(checker)) {
        const subErrors = validate(checker, val, `${path}.${key}`);
        errors.push(...subErrors);
      }
    }
    return errors;
  }

  // 预定义核心类型
  define('OmegaMod', {
    id:          OMG.Types.String,
    name:        OMG.Types.String,
    version:     OMG.Types.Optional(OMG.Types.String),
    description: OMG.Types.Optional(OMG.Types.String),
    define:      OMG.Types.Optional(OMG.Types.Function),
  });

  define('OmegaEffect', {
    id:       OMG.Types.String,
    duration: OMG.Types.Optional(OMG.Types.Positive),
    apply:    OMG.Types.Function,
    remove:   OMG.Types.Optional(OMG.Types.Function),
  });

  define('OmegaAbility', {
    id:       OMG.Types.String,
    cooldown: OMG.Types.Positive,
    activate: OMG.Types.Function,
  });

  return { define, validate, Types: OMG.Types };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §2  OMEGA 事件系统（独立于 NEPForge EventBus）
// ═══════════════════════════════════════════════════════════════════════
const OmegaEvents = (() => {
  const _bus = {};
  const _once = new Set();

  return {
    on(evt, fn, once = false) {
      const id = OMG.uid();
      (_bus[evt] = _bus[evt] || []).push({ id, fn });
      if (once) _once.add(id);
      return id;
    },
    once(evt, fn) { return this.on(evt, fn, true); },
    off(id) {
      for (const arr of Object.values(_bus)) {
        const i = arr.findIndex(h => h.id === id);
        if (i >= 0) { arr.splice(i, 1); return; }
      }
    },
    offAll(predicate) {
      for (const evt of Object.keys(_bus)) {
        _bus[evt] = (_bus[evt] || []).filter(h => !predicate(h));
      }
    },
    emit(evt, ...args) {
      const list = [...(_bus[evt] || [])];
      const toRemove = [];
      for (const h of list) {
        try { h.fn(...args); } catch(e) { console.error(`[OMEGA] Event error (${evt}):`, e); }
        if (_once.has(h.id)) { toRemove.push(h.id); _once.delete(h.id); }
      }
      for (const id of toRemove) this.off(id);
    },
    listEvents() { return Object.keys(_bus); },
  };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §3  OMEGA 状态机
// ═══════════════════════════════════════════════════════════════════════
class OmegaStateMachine {
  constructor(config) {
    this.id      = config.id || OMG.uid();
    this.states  = config.states || {};
    this.current = config.initial || Object.keys(this.states)[0];
    this._data   = config.data ? { ...config.data } : {};
    this._history = [this.current];
  }

  get state() { return this.current; }
  get data()  { return this._data; }

  can(toState) {
    const stateDef = this.states[this.current];
    if (!stateDef?.on) return false;
    return toState in stateDef.on;
  }

  transition(event, payload) {
    const stateDef = this.states[this.current];
    if (!stateDef?.on?.[event]) {
      return false;
    }
    const trans = stateDef.on[event];
    const nextState = OMG.isStr(trans) ? trans : trans.target;
    const guard = OMG.isObj(trans) ? trans.guard : null;

    if (guard && !guard(this._data, payload)) {
      return false;
    }

    // 执行 exit action
    if (stateDef.exit) { try { stateDef.exit(this._data, payload); } catch(_) {} }

    const prevState = this.current;
    this.current = nextState;
    this._history.push(this.current);

    // 执行 entry action
    const nextDef = this.states[nextState];
    if (nextDef?.entry) { try { nextDef.entry(this._data, payload); } catch(_) {} }
    if (nextDef?.action) { try { nextDef.action(this._data, payload); } catch(_) {} }

    OmegaEvents.emit('omega:stateChange', { machine: this.id, from: prevState, to: nextState, payload });
    return true;
  }

  setData(patch) { Object.assign(this._data, patch); return this; }

  history(n = 10) { return this._history.slice(-n); }
}

// ═══════════════════════════════════════════════════════════════════════
//  §4  OMEGA 效果系统（临时Buff/Debuff）
// ═══════════════════════════════════════════════════════════════════════
const EffectSystem = (() => {
  const _definitions = new Map();
  const _active      = new Map(); // targetId → [ActiveEffect]

  function define(id, config) {
    const errors = TypeSystem.validate('OmegaEffect', { id, ...config });
    if (errors.length) {
      api.warn(`[OMEGA:EffectSystem] Invalid effect "${id}": ${errors.join('; ')}`);
      return false;
    }
    _definitions.set(id, { id, ...config });
    OmegaEvents.emit('omega:effectDefined', id);
    return true;
  }

  function apply(effectId, target, duration, opts = {}) {
    const def = _definitions.get(effectId);
    if (!def) { api.warn(`[OMEGA] Unknown effect: ${effectId}`); return null; }

    const instanceId = OMG.uid();
    const dur = duration ?? def.duration ?? Infinity;

    const instance = {
      id: instanceId,
      effectId,
      target,
      startT: Date.now(),
      endT:   dur === Infinity ? Infinity : Date.now() + dur * 1000,
      opts,
      stacks: 1,
    };

    const targetId = target._omegaId = target._omegaId || OMG.uid();
    if (!_active.has(targetId)) _active.set(targetId, []);

    // 叠加逻辑
    const existing = _active.get(targetId).find(e => e.effectId === effectId);
    if (existing && def.stackable) {
      existing.stacks++;
      existing.endT = instance.endT;
    } else {
      try { def.apply(target, { ...opts, stacks: instance.stacks }); }
      catch(e) { api.warn(`[OMEGA] Effect apply error: ${e.message}`); }
      _active.get(targetId).push(instance);
    }

    OmegaEvents.emit('omega:effectApplied', { effectId, targetId, duration: dur });
    return instanceId;
  }

  function remove(instanceId) {
    for (const [tid, list] of _active) {
      const i = list.findIndex(e => e.id === instanceId);
      if (i >= 0) {
        const inst = list[i];
        const def = _definitions.get(inst.effectId);
        if (def?.remove) { try { def.remove(inst.target, inst.opts); } catch(_) {} }
        list.splice(i, 1);
        OmegaEvents.emit('omega:effectRemoved', { instanceId, effectId: inst.effectId });
        return true;
      }
    }
    return false;
  }

  // tick 检查过期
  api.events.on('forge:tick', (dt) => {
    const now = Date.now();
    for (const [tid, list] of _active) {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].endT !== Infinity && now >= list[i].endT) {
          remove(list[i].id);
        }
      }
    }
  });

  function getActive(target) {
    const tid = target._omegaId;
    return tid ? (_active.get(tid) || []) : [];
  }

  function has(target, effectId) {
    return getActive(target).some(e => e.effectId === effectId);
  }

  return { define, apply, remove, getActive, has, list: () => [..._definitions.keys()] };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §5  OMEGA 能力系统（主动技能 + 冷却管理）
// ═══════════════════════════════════════════════════════════════════════
const AbilitySystem = (() => {
  const _abilities = new Map();
  const _cooldowns = new Map(); // abilityId → remainingCd

  function define(id, config) {
    const errors = TypeSystem.validate('OmegaAbility', { id, ...config });
    if (errors.length) {
      api.warn(`[OMEGA:AbilitySystem] Invalid ability: ${errors.join('; ')}`);
      return false;
    }
    _abilities.set(id, { id, cooldown: 5, level: 1, maxLevel: 5, ...config });
    _cooldowns.set(id, 0);
    return true;
  }

  function activate(id, opts = {}) {
    const ab = _abilities.get(id);
    if (!ab) return { success: false, reason: 'unknown' };

    const cd = _cooldowns.get(id) || 0;
    if (cd > 0) return { success: false, reason: 'cooldown', remaining: cd };

    const level = ab.level || 1;
    let result;
    try {
      result = ab.activate({ ...opts, level, ability: ab });
    } catch(e) {
      api.warn(`[OMEGA] Ability "${id}" error: ${e.message}`);
      return { success: false, reason: 'error' };
    }

    _cooldowns.set(id, ab.cooldown * (1 - (ab.cdReduction || 0)));
    OmegaEvents.emit('omega:abilityActivated', { id, level, opts });
    return { success: true, result };
  }

  function upgrade(id) {
    const ab = _abilities.get(id);
    if (!ab) return false;
    if (ab.level >= ab.maxLevel) return false;
    ab.level++;
    if (ab.onUpgrade) { try { ab.onUpgrade(ab.level, ab); } catch(_) {} }
    OmegaEvents.emit('omega:abilityUpgraded', { id, level: ab.level });
    return true;
  }

  function getCooldown(id) { return _cooldowns.get(id) || 0; }

  api.events.on('forge:tick', (dt) => {
    for (const [id, cd] of _cooldowns) {
      if (cd > 0) _cooldowns.set(id, Math.max(0, cd - dt));
    }
  });

  function list() {
    return [..._abilities.entries()].map(([id, ab]) => ({
      id, name: ab.name || id, level: ab.level, maxLevel: ab.maxLevel,
      cooldown: ab.cooldown, currentCd: _cooldowns.get(id) || 0,
    }));
  }

  return { define, activate, upgrade, getCooldown, list };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §6  OMEGA DSL 解析器（Mod 定义语法）
// ═══════════════════════════════════════════════════════════════════════
const DSL = (() => {

  // OMEGA Mod 定义对象构建器
  class OmegaModBuilder {
    constructor(config) {
      this._config = {
        id: config.id,
        name: config.name || config.id,
        version: config.version || '1.0',
        description: config.description || '',
        tags: config.tags || [],
        deps: config.deps || [],
        _effects:   [],
        _abilities: [],
        _affixes:   [],
        _traits:    [],
        _emitters:  [],
        _hooks:     {},
        _reactions: [],
        _timers:    [],
        _bindings:  [],
        _setup:     null,
        _teardown:  null,
        _config:    {},
      };
    }

    // ── 核心 DSL 方法 ──

    /** 声明一个临时效果（Buff/Debuff） */
    effect(id, opts) {
      this._config._effects.push({ id, ...opts });
      return this;
    }

    /** 声明一个主动能力 */
    ability(id, opts) {
      this._config._abilities.push({ id, ...opts });
      return this;
    }

    /** 声明一个子弹词条 */
    affix(id, opts) {
      this._config._affixes.push({ id, ...opts });
      return this;
    }

    /** 声明一个敌人特性 */
    trait(id, opts) {
      this._config._traits.push({ id, ...opts });
      return this;
    }

    /** 声明一个发射器 */
    emitter(id, opts) {
      this._config._emitters.push({ id, ...opts });
      return this;
    }

    /** 声明一个事件响应器 */
    on(event, handler, opts = {}) {
      this._config._reactions.push({ event, handler, opts });
      return this;
    }

    /** 声明一个定时器 */
    every(seconds, fn, opts = {}) {
      this._config._timers.push({ type: 'interval', seconds, fn, opts });
      return this;
    }

    /** 声明一个延迟执行 */
    after(seconds, fn) {
      this._config._timers.push({ type: 'delay', seconds, fn });
      return this;
    }

    /** 声明一个波次触发器 */
    onWave(wave, fn) {
      this._config._timers.push({ type: 'wave', wave, fn });
      return this;
    }

    /** 声明一个按键绑定 */
    key(keyCode, fn, opts = {}) {
      this._config._bindings.push({ keyCode, fn, opts });
      return this;
    }

    /** 声明配置项（带默认值和类型） */
    config(key, defaultValue, validator) {
      this._config._config[key] = { value: defaultValue, validator };
      return this;
    }

    /** 声明一个 Canvas Hook */
    hud(fn, priority = 0) {
      this._config._hooks.hud = this._config._hooks.hud || [];
      this._config._hooks.hud.push({ fn, priority });
      return this;
    }

    /** Mod 初始化钩子 */
    setup(fn) {
      this._config._setup = fn;
      return this;
    }

    /** Mod 卸载钩子 */
    teardown(fn) {
      this._config._teardown = fn;
      return this;
    }

    /** 构建并返回最终配置 */
    build() { return { ...this._config }; }
  }

  function mod(config) {
    return new OmegaModBuilder(config);
  }

  return { mod, OmegaModBuilder };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §7  OMEGA Mod 注册表 & 加载器
// ═══════════════════════════════════════════════════════════════════════
const OmegaLoader = (() => {
  const _omegaMods = new Map();
  const _sandboxes = new Map();

  // 沙箱上下文（每个 Omega Mod 的隔离执行环境）
  function _createSandbox(omegaModId) {
    const _localStore = {};
    const _handlers   = [];

    return {
      // 受限的 OMEGA API 子集
      id: omegaModId,
      log:  (msg) => api.log(`[OMEGA:${omegaModId}] ${msg}`),
      warn: (msg) => api.warn(`[OMEGA:${omegaModId}] ${msg}`),

      effects:   EffectSystem,
      abilities: AbilitySystem,
      types:     TypeSystem,
      events:    OmegaEvents,

      // 局部存储（沙箱内隔离）
      store: {
        set: (k, v) => { _localStore[k] = v; },
        get: (k, def) => k in _localStore ? _localStore[k] : def,
        all: () => ({ ..._localStore }),
      },

      // 委托到 NEPForge API
      game:   api.game,
      player: api.player,

      // 注册事件处理器（自动追踪）
      on(evt, fn) {
        const id = OmegaEvents.on(evt, fn);
        _handlers.push(id);
        return id;
      },

      // 发送自定义事件
      emit(evt, ...args) { OmegaEvents.emit(evt, ...args); },

      // 获取已注册的 Omega Mod
      getOmegaMod: (id) => _omegaMods.get(id)?.instance,

      // 清理（卸载时调用）
      _cleanup() {
        for (const id of _handlers) OmegaEvents.off(id);
        _handlers.length = 0;
      }
    };
  }

  function _compileOmegaMod(built) {
    const { id, name } = built;
    const sandbox = _createSandbox(id);
    _sandboxes.set(id, sandbox);

    return {
      install() {
        // 注册效果
        for (const effect of built._effects) {
          EffectSystem.define(effect.id, effect);
        }

        // 注册能力
        for (const ab of built._abilities) {
          AbilitySystem.define(ab.id, ab);
        }

        // 注册词条（委托给 NEPForge）
        for (const affix of built._affixes) {
          api.registry.affix(affix.id, affix);
        }

        // 注册特性
        for (const trait of built._traits) {
          api.registry.trait(trait.id, trait);
        }

        // 注册发射器
        for (const emitter of built._emitters) {
          const { id: eid, fireFn, baseCd } = emitter;
          api.registry.emitter(eid, () => ({
            cd: baseCd || 1.0,
            fire(owner) {
              if (OMG.isFunc(fireFn)) {
                try { fireFn(owner, api.game); } catch(_) {}
              }
            }
          }));
        }

        // 注册事件响应器
        for (const reaction of built._reactions) {
          const hId = api.events.on(reaction.event, reaction.handler, reaction.opts);
          sandbox._handlers = sandbox._handlers || [];
        }

        // 注册定时器
        for (const timer of built._timers) {
          if (timer.type === 'interval') api.schedule.every(timer.fn, timer.seconds);
          else if (timer.type === 'delay') api.schedule.after(timer.fn, timer.seconds);
          else if (timer.type === 'wave')  api.schedule.onWave(timer.fn, timer.wave);
        }

        // 注册按键绑定
        for (const binding of built._bindings) {
          api.input.bind(binding.keyCode, binding.fn);
        }

        // HUD 钩子
        if (built._hooks.hud) {
          for (const h of built._hooks.hud) {
            api.render.hud(h.fn, h.priority);
          }
        }

        // 执行 setup
        if (OMG.isFunc(built._setup)) {
          try { built._setup(sandbox); } catch(e) {
            api.warn(`[OMEGA] setup error in "${id}": ${e.message}`);
          }
        }
      },

      uninstall() {
        sandbox._cleanup();
        if (OMG.isFunc(built._teardown)) {
          try { built._teardown(sandbox); } catch(_) {}
        }
        OmegaEvents.emit('omega:modUnloaded', id);
      },

      sandbox,
      built,
    };
  }

  return {
    register(builder) {
      if (!(builder instanceof DSL.OmegaModBuilder)) {
        api.warn('[OMEGA] register() expects an OmegaModBuilder instance');
        return false;
      }

      const built = builder.build();
      const errors = TypeSystem.validate('OmegaMod', built);
      if (errors.length) {
        api.warn(`[OMEGA] Invalid mod "${built.id}": ${errors.join('; ')}`);
        return false;
      }

      if (_omegaMods.has(built.id)) {
        api.warn(`[OMEGA] "${built.id}" already registered, replacing.`);
        this.unload(built.id);
      }

      const instance = _compileOmegaMod(built);
      _omegaMods.set(built.id, { built, instance, loaded: false, error: null });
      OmegaEvents.emit('omega:modRegistered', built.id);
      api.log(`[OMEGA] Registered: "${built.name}" v${built.version}`);
      _refreshUI();
      return true;
    },

    load(id) {
      const entry = _omegaMods.get(id);
      if (!entry) { api.warn(`[OMEGA] load: "${id}" not found`); return false; }
      if (entry.loaded) { api.warn(`[OMEGA] "${id}" already loaded`); return false; }

      // 检查依赖
      for (const dep of (entry.built.deps || [])) {
        const depEntry = _omegaMods.get(dep);
        if (!depEntry?.loaded) {
          this.load(dep);
          if (!_omegaMods.get(dep)?.loaded) {
            entry.error = `Dep "${dep}" failed`;
            _refreshUI();
            return false;
          }
        }
      }

      try {
        entry.instance.install();
        entry.loaded = true;
        entry.error  = null;
        api.log(`[OMEGA] ✓ Loaded: "${entry.built.name}"`);
        OmegaEvents.emit('omega:modLoaded', id);
      } catch(e) {
        entry.error  = e.message;
        entry.loaded = false;
        api.warn(`[OMEGA] Load error "${id}": ${e.message}`);
      }

      _refreshUI();
      return entry.loaded;
    },

    unload(id) {
      const entry = _omegaMods.get(id);
      if (!entry || !entry.loaded) return false;
      try { entry.instance.uninstall(); } catch(_) {}
      entry.loaded = false;
      entry.error  = null;
      api.log(`[OMEGA] Unloaded: "${entry.built.name}"`);
      OmegaEvents.emit('omega:modUnloaded', id);
      _refreshUI();
      return true;
    },

    reload(id) { this.unload(id); return this.load(id); },

    list() {
      return [..._omegaMods.entries()].map(([id, e]) => ({
        id,
        name:        e.built.name,
        version:     e.built.version,
        description: e.built.description,
        tags:        e.built.tags,
        deps:        e.built.deps,
        loaded:      e.loaded,
        error:       e.error,
      }));
    },

    getAPI() {
      return {
        mod:       (cfg) => DSL.mod(cfg),
        register:  (b)   => this.register(b),
        load:      (id)  => this.load(id),
        unload:    (id)  => this.unload(id),
        reload:    (id)  => this.reload(id),
        list:      ()    => this.list(),
        effects:   EffectSystem,
        abilities: AbilitySystem,
        types:     TypeSystem,
        events:    OmegaEvents,
        stateMachine: (cfg) => new OmegaStateMachine(cfg),
        dsl:       DSL,
      };
    },
  };
})();

// ═══════════════════════════════════════════════════════════════════════
//  §8  OMEGA STUDIO UI（完整的菜单 Tab）
// ═══════════════════════════════════════════════════════════════════════
let _studioBodyEl = null;
let _studioTab    = 'mods';
let _refreshUI    = () => {};

function _buildStudioUI() {
  const { components: C } = api.ui;

  api.ui.injectMenuTab('Ω OMEGA', 'omega-studio', (container) => {
    _studioBodyEl = container;
    container.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:"Consolas",monospace;color:#c8e8ff;font-size:11px;';

    // 顶部状态栏
    const statusBar = document.createElement('div');
    statusBar.style.cssText = 'background:rgba(179,108,255,0.1);border:1px solid rgba(179,108,255,0.25);padding:5px 10px;margin-bottom:8px;font-size:9px;display:flex;justify-content:space-between;align-items:center;border-radius:2px;';
    statusBar.innerHTML = `
      <span style="color:#B36CFF;letter-spacing:1px;">◈ OMEGA FRAMEWORK v1.0</span>
      <span id="omega-status-counts" style="color:#555;"></span>
    `;
    container.appendChild(statusBar);

    // 内部 Tab 栏
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display:flex;gap:0;border-bottom:1px solid rgba(179,108,255,0.2);margin-bottom:8px;flex-shrink:0;';

    const tabs = [
      { key: 'mods',      label: 'MODS' },
      { key: 'effects',   label: 'EFFECTS' },
      { key: 'abilities', label: 'ABILITIES' },
      { key: 'editor',    label: 'EDITOR' },
      { key: 'debug',     label: 'DEBUG' },
      { key: 'docs',      label: 'DOCS' },
    ];

    const tabBtns = {};
    const bodyEl = document.createElement('div');
    bodyEl.style.cssText = 'flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:rgba(179,108,255,0.2) transparent;';
    _studioBodyEl = bodyEl;

    tabs.forEach(({ key, label }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = `flex:1;padding:5px 2px;background:none;border:none;border-bottom:2px solid transparent;
        color:rgba(255,255,255,0.3);cursor:pointer;font-family:inherit;font-size:9px;letter-spacing:1.5px;
        font-weight:700;text-transform:uppercase;transition:all 0.13s;`;
      btn.classList.toggle('omega-tab-active', key === _studioTab);
      if (key === _studioTab) {
        btn.style.color = '#B36CFF';
        btn.style.borderBottomColor = '#B36CFF';
      }
      btn.addEventListener('click', () => {
        _studioTab = key;
        Object.entries(tabBtns).forEach(([k, b]) => {
          b.style.color = k === key ? '#B36CFF' : 'rgba(255,255,255,0.3)';
          b.style.borderBottomColor = k === key ? '#B36CFF' : 'transparent';
        });
        _renderStudioTab(bodyEl, key);
      });
      tabBtns[key] = btn;
      tabBar.appendChild(btn);
    });

    container.appendChild(tabBar);
    container.appendChild(bodyEl);

    _refreshUI = () => {
      // 更新状态栏
      const el = document.getElementById('omega-status-counts');
      if (el) {
        const list = OmegaLoader.list();
        el.textContent = `${list.filter(m => m.loaded).length}/${list.length} loaded · ${EffectSystem.list().length} effects · ${AbilitySystem.list().length} abilities`;
      }
      _renderStudioTab(bodyEl, _studioTab);
    };

    _renderStudioTab(bodyEl, _studioTab);
  });
}

function _renderStudioTab(container, tab) {
  container.innerHTML = '';
  if (tab === 'mods')      _renderOmegaMods(container);
  else if (tab === 'effects')   _renderEffects(container);
  else if (tab === 'abilities') _renderAbilities(container);
  else if (tab === 'editor')    _renderEditor(container);
  else if (tab === 'debug')     _renderDebug(container);
  else if (tab === 'docs')      _renderDocs(container);
}

// ── MODS 面板 ──
function _renderOmegaMods(c) {
  const list = OmegaLoader.list();
  const { components: C } = api.ui;

  // 标题
  const heading = document.createElement('div');
  heading.style.cssText = 'font-size:9px;letter-spacing:2px;color:rgba(255,255,255,0.26);text-transform:uppercase;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:3px;';
  heading.textContent = `OMEGA MODS (${list.length})`;
  c.appendChild(heading);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:rgba(255,255,255,0.2);text-align:center;padding:20px;font-size:10px;';
    empty.innerHTML = 'No OMEGA mods registered.<br><br>Use the EDITOR tab to create one.';
    c.appendChild(empty);
  } else {
    list.forEach(mod => {
      const card = document.createElement('div');
      card.style.cssText = `border:1px solid rgba(${mod.loaded ? '179,108,255' : '255,255,255'},${mod.loaded ? '0.25' : '0.06'});
        padding:8px 10px;margin-bottom:6px;background:rgba(0,0,0,0.18);border-radius:3px;`;

      const ledColor = mod.error ? '#FF2F57' : mod.loaded ? '#B36CFF' : '#333';
      const ledGlow  = mod.error || mod.loaded ? `box-shadow:0 0 5px ${ledColor};` : '';

      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:4px;">
          <span style="width:6px;height:6px;border-radius:50%;background:${ledColor};${ledGlow};flex-shrink:0;display:inline-block;"></span>
          <span style="font-weight:700;font-size:11px;letter-spacing:1px;color:${mod.loaded ? '#B36CFF' : '#555'};">${mod.name}</span>
          <span style="opacity:0.3;font-size:9px;">v${mod.version}</span>
          ${mod.tags.map(t => `<span style="font-size:8px;padding:1px 5px;border:1px solid rgba(179,108,255,0.3);color:#B36CFF77;border-radius:2px;">${t}</span>`).join('')}
        </div>
        ${mod.description ? `<div style="font-size:10px;color:rgba(255,255,255,0.33);margin-bottom:5px;line-height:1.4;">${mod.description}</div>` : ''}
        ${mod.deps.length ? `<div style="font-size:9px;color:#B36CFF55;margin-bottom:4px;">Deps: ${mod.deps.join(', ')}</div>` : ''}
        ${mod.error ? `<div style="font-size:10px;color:#FF2F57;margin-bottom:4px;">⚠ ${mod.error}</div>` : ''}
        <div style="display:flex;gap:4px;flex-wrap:wrap;" data-omega-id="${mod.id}"></div>
      `;

      const btnRow = card.querySelector(`[data-omega-id="${mod.id}"]`);
      const mkBtn = (label, color, onClick) => {
        const b = document.createElement('button');
        b.className = 'nep-btn';
        b.textContent = label;
        if (color) b.style.cssText = `border-color:${color};color:${color};`;
        b.addEventListener('click', onClick);
        return b;
      };

      if (!mod.loaded) {
        btnRow.appendChild(mkBtn('LOAD', '#B36CFF', () => { OmegaLoader.load(mod.id); }));
      } else {
        btnRow.appendChild(mkBtn('UNLOAD', '#FFB020', () => { OmegaLoader.unload(mod.id); }));
        btnRow.appendChild(mkBtn('↺ RELOAD', null, () => { OmegaLoader.reload(mod.id); }));
      }

      c.appendChild(card);
    });
  }

  // 全局操作
  const gr = document.createElement('div');
  gr.style.cssText = 'display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;';
  const mkGBtn = (label, color, onClick) => {
    const b = document.createElement('button');
    b.className = 'nep-btn';
    b.textContent = label;
    if (color) b.style.cssText = `border-color:${color};color:${color};`;
    b.addEventListener('click', onClick);
    return b;
  };
  gr.appendChild(mkGBtn('LOAD ALL', '#B36CFF', () => {
    OmegaLoader.list().forEach(m => { if (!m.loaded) OmegaLoader.load(m.id); });
  }));
  gr.appendChild(mkGBtn('UNLOAD ALL', '#FF2F57', () => {
    OmegaLoader.list().filter(m => m.loaded).forEach(m => OmegaLoader.unload(m.id));
  }));
  c.appendChild(gr);
}

// ── EFFECTS 面板 ──
function _renderEffects(c) {
  const effects = EffectSystem.list();

  const h = document.createElement('div');
  h.style.cssText = 'font-size:9px;letter-spacing:2px;color:rgba(255,255,255,0.26);text-transform:uppercase;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:3px;';
  h.textContent = `REGISTERED EFFECTS (${effects.length})`;
  c.appendChild(h);

  if (!effects.length) {
    const e = document.createElement('div');
    e.style.cssText = 'color:rgba(255,255,255,0.2);text-align:center;padding:16px;font-size:10px;';
    e.textContent = 'No effects defined.';
    c.appendChild(e);
    return;
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;';
  for (const id of effects) {
    const chip = document.createElement('span');
    chip.style.cssText = 'font-size:9px;padding:3px 8px;border-radius:2px;background:rgba(179,108,255,0.08);border:1px solid rgba(179,108,255,0.25);color:#B36CFF;cursor:pointer;letter-spacing:0.5px;';
    chip.textContent = id;
    chip.title = 'Click to apply to Player (test)';
    chip.addEventListener('click', () => {
      const P = api.resolver.get('Player');
      if (P) {
        EffectSystem.apply(id, P, 5);
        api.ui.toast(`Effect applied: ${id}`, '#B36CFF', 1500);
      }
    });
    grid.appendChild(chip);
  }
  c.appendChild(grid);
}

// ── ABILITIES 面板 ──
function _renderAbilities(c) {
  const abilities = AbilitySystem.list();

  const h = document.createElement('div');
  h.style.cssText = 'font-size:9px;letter-spacing:2px;color:rgba(255,255,255,0.26);text-transform:uppercase;margin-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.05);padding-bottom:3px;';
  h.textContent = `ACTIVE ABILITIES (${abilities.length})`;
  c.appendChild(h);

  if (!abilities.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:rgba(255,255,255,0.2);text-align:center;padding:16px;font-size:10px;';
    empty.textContent = 'No abilities defined.';
    c.appendChild(empty);
    return;
  }

  for (const ab of abilities) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.04);';

    const cdPct = ab.currentCd / ab.cooldown;
    const cdColor = cdPct === 0 ? '#B36CFF' : '#555';

    row.innerHTML = `
      <div style="flex:1;">
        <div style="font-size:11px;font-weight:700;color:#B36CFF;letter-spacing:0.5px;">${ab.name}</div>
        <div style="font-size:9px;color:#555;margin-top:2px;">Lv${ab.level}/${ab.maxLevel} · CD: ${ab.currentCd > 0 ? ab.currentCd.toFixed(1) + 's' : 'READY'}</div>
        <div style="height:3px;background:rgba(255,255,255,0.06);border-radius:2px;margin-top:4px;overflow:hidden;">
          <div style="height:100%;width:${(1-cdPct)*100}%;background:${cdColor};border-radius:2px;transition:width 0.3s;"></div>
        </div>
      </div>
    `;

    const activateBtn = document.createElement('button');
    activateBtn.className = 'nep-btn';
    activateBtn.textContent = 'USE';
    activateBtn.style.cssText = `border-color:${cdColor};color:${cdColor};`;
    activateBtn.disabled = ab.currentCd > 0;
    activateBtn.addEventListener('click', () => {
      const result = AbilitySystem.activate(ab.id);
      if (result.success) {
        api.ui.toast(`Ability: ${ab.name}`, '#B36CFF', 1000);
      } else if (result.reason === 'cooldown') {
        api.ui.toast(`CD: ${result.remaining?.toFixed(1)}s`, '#555', 800);
      }
      setTimeout(() => _renderStudioTab(c.parentElement, 'abilities'), 100);
    });

    const upgradeBtn = document.createElement('button');
    upgradeBtn.className = 'nep-btn';
    upgradeBtn.textContent = '↑';
    upgradeBtn.disabled = ab.level >= ab.maxLevel;
    upgradeBtn.addEventListener('click', () => {
      AbilitySystem.upgrade(ab.id);
      _refreshUI();
    });

    row.appendChild(activateBtn);
    row.appendChild(upgradeBtn);
    c.appendChild(row);
  }
}

// ── EDITOR 面板（OMEGA DSL 代码编辑器）──
function _renderEditor(c) {
  const template = `// OMEGA Framework – Mod 定义示例
// 使用 OMEGA.mod({...}).affix().ability().setup().build() 语法

const myMod = OMEGA.mod({
  id: 'my-omega-mod',
  name: 'My First Omega Mod',
  version: '1.0',
  description: '通过 OMEGA DSL 创建的 Mod',
  tags: ['demo'],
})

// 注册一个词条
.affix('OMEGA_FIRE', {
  tags: ['damage'],
  minWave: 1,
  weight: 1.5,
  onSpawn(b) { b.col = '#FF6622'; b.r *= 1.1; },
  onHit(b, target) {
    if (target) target.onHit && target.onHit(5);
  }
})

// 注册一个临时效果
.effect('OMEGA_BURN', {
  duration: 3,
  stackable: true,
  apply(target, opts) {
    target._burnDps = (target._burnDps || 0) + 5 * (opts.stacks || 1);
  },
  remove(target) { target._burnDps = 0; }
})

// 注册一个主动能力
.ability('OMEGA_NOVA', {
  name: 'Omega Nova',
  cooldown: 8,
  maxLevel: 3,
  activate({ level, ability }) {
    const power = level * 200;
    const G = NEPForge.game;
    G.spawnShockwave(G.W*0.5, G.H*0.5, '#B36CFF', power, 0.8);
    G.textPop(G.W*0.5, G.H*0.5 - 60, 'OMEGA NOVA!', '#B36CFF');
    G.enemies.forEach(e => {
      if (e.alive) e.onHit && e.onHit(50 * level);
    });
  }
})

// HUD 渲染
.hud(({ ctx, W, H }) => {
  if (!ctx) return;
  ctx.save();
  ctx.font = 'bold 10px Consolas';
  ctx.fillStyle = '#B36CFF88';
  ctx.fillText('◈ OMEGA ACTIVE', 8, 20);
  ctx.restore();
})

// 初始化
.setup((sandbox) => {
  sandbox.log('Omega mod initialized!');
})

// 构建并注册
.build();

OMEGA.register(myMod);
OMEGA.load('my-omega-mod');
`;

  const header = document.createElement('div');
  header.style.cssText = 'font-size:9px;letter-spacing:2px;color:rgba(255,255,255,0.26);text-transform:uppercase;margin-bottom:6px;';
  header.textContent = 'OMEGA DSL EDITOR';
  c.appendChild(header);

  const ta = document.createElement('textarea');
  ta.style.cssText = 'width:100%;height:200px;background:rgba(0,0,0,0.5);border:1px solid rgba(179,108,255,0.25);color:#e8d8ff;font-family:Consolas,monospace;font-size:10px;padding:8px;resize:vertical;outline:none;border-radius:2px;line-height:1.5;';
  ta.value = template;
  c.appendChild(ta);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;';

  const runBtn = document.createElement('button');
  runBtn.className = 'nep-btn';
  runBtn.textContent = 'RUN OMEGA CODE';
  runBtn.style.cssText = 'border-color:rgba(179,108,255,0.5);color:#B36CFF;';
  runBtn.addEventListener('click', () => {
    try {
      const OMEGA = OmegaLoader.getAPI();
      const fn = new Function('OMEGA', 'NEPForge', ta.value);
      fn(OMEGA, window.NEPForge);
      api.ui.toast('OMEGA code executed!', '#B36CFF', 1500);
    } catch(e) {
      api.ui.toast(`Error: ${e.message}`, '#FF2F57', 3000);
      api.warn('[OMEGA Editor] ' + e.message);
    }
  });

  const pasteBtn = document.createElement('button');
  pasteBtn.className = 'nep-btn';
  pasteBtn.textContent = '📋 PASTE';
  pasteBtn.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard?.readText?.();
      if (t) ta.value = t;
    } catch(_) { ta.focus(); document.execCommand?.('paste'); }
  });

  const clearBtn = document.createElement('button');
  clearBtn.className = 'nep-btn';
  clearBtn.textContent = 'CLEAR';
  clearBtn.addEventListener('click', () => { ta.value = ''; ta.focus(); });

  btnRow.appendChild(runBtn);
  btnRow.appendChild(pasteBtn);
  btnRow.appendChild(clearBtn);
  c.appendChild(btnRow);

  // 快捷模板按钮
  const templateHeader = document.createElement('div');
  templateHeader.style.cssText = 'font-size:9px;letter-spacing:2px;color:rgba(255,255,255,0.2);text-transform:uppercase;margin:10px 0 5px;';
  templateHeader.textContent = 'QUICK TEMPLATES';
  c.appendChild(templateHeader);

  const tplRow = document.createElement('div');
  tplRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;';

  const templates = {
    'Minimal Mod': `const m = OMEGA.mod({ id: 'omega-minimal', name: 'Minimal' })
  .setup(s => s.log('Hello from OMEGA!'))
  .build();
OMEGA.register(m);
OMEGA.load('omega-minimal');`,

    'Effect Mod': `OMEGA.effects.define('OMEGA_CHILL', {
  duration: 5,
  apply(target) {
    target._origVy = target.vy;
    target.vy *= 0.4;
  },
  remove(target) {
    target.vy = target._origVy || target.vy;
  }
});
// Apply to all current enemies:
NEPForge.game.enemies.forEach(e => {
  if (e.alive) OMEGA.effects.apply('OMEGA_CHILL', e, 3);
});`,

    'Ability Mod': `OMEGA.abilities.define('OMEGA_BLAST', {
  name: 'Omega Blast',
  cooldown: 5,
  maxLevel: 3,
  activate({ level }) {
    const G = NEPForge.game;
    G.spawnShockwave(G.W*0.5, G.H*0.5, '#B36CFF', 300 * level, 0.7);
    G.enemies.forEach(e => { if(e.alive) e.onHit && e.onHit(40 * level); });
    G.textPop(G.W*0.5, 80, 'OMEGA BLAST!', '#B36CFF');
  }
});
// Test it:
OMEGA.abilities.activate('OMEGA_BLAST');`,

    'State Machine': `const sm = OMEGA.stateMachine({
  id: 'phase-machine',
  initial: 'calm',
  data: { hp: 100 },
  states: {
    calm: {
      on: { DANGER: 'alert', CRITICAL: 'berserk' },
      entry(d) { console.log('Calm phase'); }
    },
    alert: {
      on: { RECOVER: 'calm', CRITICAL: 'berserk' },
      entry(d) { NEPForge.ui.toast('ALERT!', '#FFB020'); }
    },
    berserk: {
      on: { RECOVER: 'calm' },
      entry(d) { NEPForge.ui.toast('BERSERK!', '#FF2F57'); }
    }
  }
});
// Trigger transition:
sm.transition('DANGER');
console.log('State:', sm.state, 'History:', sm.history());`,
  };

  for (const [label, code] of Object.entries(templates)) {
    const btn = document.createElement('button');
    btn.className = 'nep-btn';
    btn.textContent = label;
    btn.style.cssText = 'font-size:9px;padding:3px 7px;';
    btn.addEventListener('click', () => { ta.value = code; ta.focus(); });
    tplRow.appendChild(btn);
  }
  c.appendChild(tplRow);
}

// ── DEBUG 面板 ──
function _renderDebug(c) {
  const h = document.createElement('div');
  h.style.cssText = 'font-size:9px;letter-spacing:2px;color:rgba(255,255,255,0.26);text-transform:uppercase;margin-bottom:8px;';
  h.textContent = 'OMEGA DEBUG CONSOLE';
  c.appendChild(h);

  // 事件总线状态
  const evtSec = document.createElement('div');
  evtSec.style.cssText = 'margin-bottom:10px;';
  evtSec.innerHTML = `<div style="font-size:9px;color:#B36CFF;margin-bottom:4px;">OMEGA EVENTS</div>`;

  const evts = OmegaEvents.listEvents();
  const evtGrid = document.createElement('div');
  evtGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;';
  evts.forEach(evt => {
    const chip = document.createElement('span');
    chip.style.cssText = 'font-size:8px;padding:2px 5px;border-radius:2px;background:rgba(179,108,255,0.08);border:1px solid rgba(179,108,255,0.2);color:#B36CFF88;cursor:pointer;';
    chip.textContent = evt;
    chip.addEventListener('click', () => {
      OmegaEvents.emit(evt);
      api.ui.toast(`Emitted: ${evt}`, '#B36CFF', 800);
    });
    evtGrid.appendChild(chip);
  });
  evtSec.appendChild(evtGrid);
  c.appendChild(evtSec);

  // 实时状态快照
  const snapBtn = document.createElement('button');
  snapBtn.className = 'nep-btn';
  snapBtn.textContent = 'SNAPSHOT TO CONSOLE';
  snapBtn.style.cssText = 'border-color:rgba(179,108,255,0.4);color:#B36CFF;margin-bottom:8px;';
  snapBtn.addEventListener('click', () => {
    const snap = {
      omegaMods:   OmegaLoader.list(),
      effects:     EffectSystem.list(),
      abilities:   AbilitySystem.list(),
      omegaEvents: OmegaEvents.listEvents(),
    };
    console.group('%c[OMEGA] Debug Snapshot', 'color:#B36CFF;font-weight:bold;');
    console.log('OMEGA Mods:',    snap.omegaMods);
    console.log('Effects:',       snap.effects);
    console.log('Abilities:',     snap.abilities);
    console.log('Omega Events:',  snap.omegaEvents);
    console.groupEnd();
    api.ui.toast('Snapshot logged to console', '#B36CFF', 1500);
  });
  c.appendChild(snapBtn);

  // NEPForge 诊断数据
  const diagBtn = document.createElement('button');
  diagBtn.className = 'nep-btn';
  diagBtn.textContent = 'NEPFORGE DIAGNOSTICS';
  diagBtn.style.cssText = 'border-color:rgba(82,230,255,0.4);color:#52E6FF;margin-bottom:8px;';
  diagBtn.addEventListener('click', () => {
    const tree = api.patch.diagnostics.hookTree();
    const breakers = api.patch.diagnostics.breakerStatus();
    console.group('%c[OMEGA→NEPForge] Diagnostics', 'color:#52E6FF;font-weight:bold;');
    console.log('Hook Tree:', tree);
    console.log('Circuit Breakers:', breakers);
    console.log('Mods:', api.patch.diagnostics.modList());
    console.groupEnd();
    api.ui.toast('NEPForge diagnostics logged', '#52E6FF', 1500);
  });
  c.appendChild(diagBtn);

  // 实时日志流
  const logH = document.createElement('div');
  logH.style.cssText = 'font-size:9px;color:#B36CFF;margin:8px 0 4px;';
  logH.textContent = 'OMEGA EVENT LOG';
  c.appendChild(logH);

  const logEl = document.createElement('div');
  logEl.style.cssText = 'height:120px;overflow-y:auto;background:rgba(0,0,0,0.4);border:1px solid rgba(179,108,255,0.12);padding:5px;border-radius:2px;font-size:9px;line-height:1.6;scrollbar-width:thin;';
  c.appendChild(logEl);

  const _logLines = [];
  const _addLogLine = (msg, color = '#B36CFF88') => {
    _logLines.push({ msg, color });
    if (_logLines.length > 50) _logLines.shift();
    logEl.innerHTML = _logLines.map(l =>
      `<div style="color:${l.color};">${new Date().toTimeString().slice(0,8)} ${l.msg}</div>`
    ).join('');
    logEl.scrollTop = logEl.scrollHeight;
  };

  // 监听 OMEGA 事件
  const evtNames = [
    'omega:modRegistered', 'omega:modLoaded', 'omega:modUnloaded',
    'omega:effectDefined', 'omega:effectApplied', 'omega:effectRemoved',
    'omega:abilityActivated', 'omega:abilityUpgraded', 'omega:stateChange'
  ];

  for (const evt of evtNames) {
    OmegaEvents.on(evt, (data) => {
      const color = evt.includes('error') ? '#FF2F57' : evt.includes('Removed') || evt.includes('Unloaded') ? '#FFB020' : '#B36CFF88';
      _addLogLine(`${evt} ${JSON.stringify(data || '').slice(0, 60)}`, color);
    });
  }
}

// ── DOCS 面板 ──
function _renderDocs(c) {
  const docs = [
    {
      title: 'OMEGA.mod(config)',
      color: '#B36CFF',
      content: `创建一个 OmegaModBuilder。
config: { id*, name*, version, description, tags[], deps[] }

链式调用示例：
OMEGA.mod({ id: 'x', name: 'X' })
  .affix(id, opts)      // 子弹词条
  .trait(id, opts)      // 敌人特性
  .emitter(id, opts)    // 发射器
  .effect(id, opts)     // 临时效果
  .ability(id, opts)    // 主动能力
  .on(event, handler)   // 事件监听
  .every(sec, fn)       // 周期任务
  .after(sec, fn)       // 延迟任务
  .onWave(wave, fn)     // 波次触发
  .key(code, fn)        // 按键绑定
  .hud(fn, priority)    // HUD渲染
  .setup(fn)            // 初始化
  .teardown(fn)         // 卸载清理
  .config(key, def)     // 配置项
  .build()              // 返回构建结果`
    },
    {
      title: 'OMEGA.effects',
      color: '#52E6FF',
      content: `临时效果系统（Buff/Debuff）

define(id, { duration, stackable, apply(target, opts), remove(target) })
apply(effectId, target, duration, opts) → instanceId
remove(instanceId)
has(target, effectId) → boolean
getActive(target) → ActiveEffect[]
list() → string[]`
    },
    {
      title: 'OMEGA.abilities',
      color: '#50DC64',
      content: `主动能力系统

define(id, { name, cooldown, maxLevel, activate({level, ability}) })
activate(id, opts) → { success, reason, result }
upgrade(id) → boolean
getCooldown(id) → seconds
list() → AbilityInfo[]`
    },
    {
      title: 'OMEGA.stateMachine(config)',
      color: '#FFB020',
      content: `有限状态机

config: {
  id, initial, data: {},
  states: {
    stateName: {
      on: { EVENT: 'nextState' | { target, guard } },
      entry(data, payload),
      exit(data, payload),
      action(data, payload)
    }
  }
}

sm.transition(event, payload)
sm.state → current state name
sm.data  → state data object
sm.can(toState) → boolean
sm.history(n) → string[]`
    },
    {
      title: 'OMEGA.types',
      color: '#FF2F57',
      content: `类型系统

TypeSystem.define(name, schema)
TypeSystem.validate(typeName, value) → errors[]

Types.Number / String / Boolean / Function / Array / Object
Types.Color    → '#RRGGBB' format check
Types.Positive → number > 0
Types.Range(min, max) → number in range
Types.OneOf(...opts)  → value in options
Types.Optional(check) → nullable checker`
    },
  ];

  for (const doc of docs) {
    const section = document.createElement('details');
    section.style.cssText = 'border:1px solid rgba(255,255,255,0.06);border-radius:2px;margin-bottom:5px;';

    const summary = document.createElement('summary');
    summary.style.cssText = `padding:7px 10px;cursor:pointer;font-size:10px;font-weight:700;color:${doc.color};letter-spacing:0.5px;list-style:none;`;
    summary.textContent = doc.title;

    const body = document.createElement('div');
    body.style.cssText = 'padding:8px 12px;font-size:9px;color:rgba(255,255,255,0.5);white-space:pre-wrap;line-height:1.7;border-top:1px solid rgba(255,255,255,0.04);';
    body.textContent = doc.content;

    section.appendChild(summary);
    section.appendChild(body);
    c.appendChild(section);
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  §9  暴露 OMEGA 全局 API
// ═══════════════════════════════════════════════════════════════════════
window.OMEGA = OmegaLoader.getAPI();
window.OMEGA._internal = {
  EffectSystem, AbilitySystem, TypeSystem, OmegaEvents,
  OmegaLoader, DSL, OmegaStateMachine
};

// ═══════════════════════════════════════════════════════════════════════
//  §10  初始化 OMEGA Studio UI
// ═══════════════════════════════════════════════════════════════════════
_buildStudioUI();

// 将 OMEGA 事件桥接到 NEPForge EventBus
api.events.on('forge:tick', (dt) => {
  OmegaEvents.emit('omega:tick', dt);
});

api.log('OMEGA Framework v1.0 initialized. window.OMEGA is ready.');
api.ui.toast('◈ OMEGA FRAMEWORK v1.0 READY', '#B36CFF', 2500);

  } // end init
});
