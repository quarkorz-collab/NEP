// Nova Aegis Sentinel (standalone Nova ModLoader mod)
// 从 NEPForge 示例中拆分；仅通过 Nova.def 注册。
Nova.def('nova-aegis-sentinel', {
  name: 'Nova Aegis Sentinel',
  version: '3.5.0',
  description: 'Anti-tamper runtime defense for Nova with startup-safe interception.',
  state: {
    enabled: true,
    strictMode: false,
    paranoia: 3,
    blocked: 0,
    healed: 0,
    alerts: 0,
    tamperTouches: 0,
    lastReason: 'boot'
  },
  panel: {
    title: 'Aegis Sentinel',
    position: { top:'84px', right:'20px', width:'320px' },
    controls: [
      { type:'heading', text:'RUNTIME DEFENSE' },
      { type:'toggle', label:'Enable defense', state:'enabled' },
      { type:'toggle', label:'Strict mode', state:'strictMode' },
      { type:'slider', label:'Paranoia', state:'paranoia', min:1, max:5, step:1 },
      { type:'separator' },
      { type:'display', label:'Blocked', bind:'blocked' },
      { type:'display', label:'Healed', bind:'healed' },
      { type:'display', label:'Alerts', bind:'alerts' },
      { type:'display', label:'Tamper touches', bind:'tamperTouches' },
      { type:'display', label:'Last reason', bind:'lastReason' }
    ]
  },
  setup(ctx) {
    const S = ctx.state;
    const allowMods = new Set(['nova-aegis-sentinel', 'nova-forge']);
    const hardenBag = {};
    const base = {
      playerProto: Object.getOwnPropertyNames(Object.getPrototypeOf(window.Player || {})).sort().join('|'),
      gameKeys: Object.keys(window.Game || {}).sort().join('|'),
      stepLen: String(window.step || '').length,
      spawnLen: String(window.spawnBullet || '').length
    };
    const ring = [];

    const isBooting = () => {
      const g = window.Game;
      return !g || (!g.running && !g.started && !g.inRun);
    };

    const stackLooksSuspicious = (stack) => {
      if (!stack) return false;
      return /(eval at|<anonymous>|chrome-extension:|moz-extension:|userscript|tampermonkey|violentmonkey)/i.test(stack);
    };

    const ringPush = (lvl, msg) => {
      ring.push({ t: Date.now(), lvl, msg });
      if (ring.length > 140) ring.shift();
      if (lvl !== 'log') {
        S.alerts = (S.alerts || 0) + 1;
        S.lastReason = msg;
      }
      ctx.toast('Aegis: ' + msg, lvl === 'error' ? '#FF2F57' : lvl === 'warn' ? '#FFB020' : '#52E6FF', 1400);
    };

    const guardGlobal = (key) => {
      try {
        const d = Object.getOwnPropertyDescriptor(window, key);
        if (d && !d.configurable) return;
        let shadow = window[key];
        hardenBag[key] = d;
        Object.defineProperty(window, key, {
          configurable: true,
          enumerable: true,
          get(){ return shadow; },
          set(v){
            if (!S.enabled || isBooting()) { shadow = v; return; }
            const stack = (new Error()).stack || '';
            if (stack.includes('nova-aegis-sentinel')) { shadow = v; return; }
            const suspicious = stackLooksSuspicious(stack);
            if (!S.strictMode && !suspicious) { shadow = v; return; }
            S.blocked = (S.blocked || 0) + 1;
            ringPush('warn', 'blocked overwrite ' + key);
          }
        });
      } catch(_) {}
    };

    ['Game','Player','WaveDirector','EnemyFactory','spawnBullet','step'].forEach(guardGlobal);

    if (window.console && typeof window.console.clear === 'function') {
      const rawClear = window.console.clear.bind(window.console);
      hardenBag.consoleClear = rawClear;
      window.console.clear = function() {
        if (!S.enabled || S.paranoia <= 1) return rawClear();
        S.blocked += 1;
        ringPush('warn', 'console.clear blocked');
      };
    }

    const baitToken = Math.random().toString(36).slice(2);
    Object.defineProperty(window, '__NOVA_AEGIS_BAIT__', {
      configurable: true,
      enumerable: false,
      get(){ return baitToken; },
      set(){
        S.tamperTouches = (S.tamperTouches || 0) + 1;
        S.blocked = (S.blocked || 0) + 1;
        ringPush('warn', 'tamper bait touched');
      }
    });
    hardenBag.bait = true;

    const driftCheck = () => {
      if (!S.enabled || isBooting()) return;
      const nowPlayerProto = Object.getOwnPropertyNames(Object.getPrototypeOf(window.Player || {})).sort().join('|');
      const nowGameKeys = Object.keys(window.Game || {}).sort().join('|');
      const nowStepLen = String(window.step || '').length;
      const nowSpawnLen = String(window.spawnBullet || '').length;
      const drifted = nowPlayerProto !== base.playerProto || nowGameKeys !== base.gameKeys
        || Math.abs(nowStepLen - base.stepLen) > 40 || Math.abs(nowSpawnLen - base.spawnLen) > 40;
      if (!drifted) return;
      S.healed = (S.healed || 0) + 1;
      ringPush('warn', 'integrity drift detected');
      const p = window.Player;
      if (p && typeof p === 'object') {
        if (!Number.isFinite(p.hp) || p.hp <= 0) p.hp = Math.max(1, p.maxHp || 100);
        if (!Number.isFinite(p.energy)) p.energy = 0;
        if (!Number.isFinite(p.shield)) p.shield = 0;
      }
    };

    const conflicts = () => {
      const report = ctx.nep?.diagnostics?.conflicts?.() || [];
      for (const c of report) {
        const unknown = (c.mods || []).filter(m => !allowMods.has(m));
        if (!unknown.length) continue;
        ringPush('warn', 'suspicious patch ' + c.key);
        if (S.strictMode) unknown.forEach(mid => { try { window.Nova?.unload?.(mid); } catch(_) {} });
      }
    };

    const step = Math.max(40, 92 - (S.paranoia || 3) * 12);
    window.__NOVA_AEGIS_RUNTIME__ = hardenBag;
    window.__NOVA_AEGIS_LAST_BOOT__ = Date.now();
    ctx.log('Aegis sentinel online (startup-safe mode)');

    hardenBag.tickFn = function(dt) {
      if (!S.enabled || isBooting()) return;
      if ((Game?.tick || 0) % step === 0) { driftCheck(); conflicts(); }
      if (dt > 0.18) ringPush('log', 'frame spike');
      if ((S.alerts || 0) > 24 && !S.strictMode) {
        S.strictMode = true;
        ringPush('warn', 'strict mode auto-enabled');
      }
    };

    hardenBag.waveFn = function(wave) {
      if (!S.enabled || isBooting()) return;
      if (wave % 5 === 0) textPop?.((W||400)*0.5, (H||600)-80, 'AEGIS '+wave+' B'+(S.blocked||0)+' H'+(S.healed||0), '#52E6FF');
    };
  },
  events: {
    'forge:tick': (dt) => {
      const local = window.__NOVA_AEGIS_RUNTIME__ || null;
      if (local && typeof local.tickFn === 'function') local.tickFn(dt);
    },
    'wave:start': (wave) => {
      const local = window.__NOVA_AEGIS_RUNTIME__ || null;
      if (local && typeof local.waveFn === 'function') local.waveFn(wave);
    }
  },
  teardown() {
    const local = window.__NOVA_AEGIS_RUNTIME__ || null;
    try {
      if (local?.consoleClear && window.console) window.console.clear = local.consoleClear;
      if (local?.bait) delete window.__NOVA_AEGIS_BAIT__;
    } catch(_) {}
    ['Game','Player','WaveDirector','EnemyFactory','spawnBullet','step'].forEach(k => {
      if (local && Object.prototype.hasOwnProperty.call(local, k)) {
        try {
          const d = local[k];
          if (d) Object.defineProperty(window, k, d);
        } catch(_) {}
      }
    });
    window.__NOVA_AEGIS_RUNTIME__ = null;
  }
});
