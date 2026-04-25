// ─────────────────────────────────────────────────────────────────
// #1  PLASMA CHAIN   ·   子弹词条 + Registry.edit 协同增强
//     展示：registry.affix / registry.edit / PatchMgr.after / EventBus
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'plasma-chain',
  name: 'Plasma Chain',
  version: '1.0',
  description: '链式电浆词条：击中敌人后向最近三个敌人放电，并用 Registry.edit 给原版 HEAVY 词条叠加减速效果。',

  init(api) {
    // ── 1. 注册全新词条 PLASMA_CHAIN ──────────────────────────────
    api.registry.affix('PLASMA_CHAIN', {
      tags: ['hitfx', 'chain', 'area'],
      minWave: 3,
      weight: 0.9,
      color: '#52E6FF',

      onHit(b, target) {
        if (!target?.alive) return;
        const enemies = window.enemies || [];
        // 找到最近三个活着的敌人（排除被击中目标本身）
        const nearby = enemies
          .filter(e => e !== target && e.alive)
          .map(e => {
            const dx = e.x - target.x, dy = e.y - target.y;
            return { e, dist2: dx * dx + dy * dy };
          })
          .sort((a, b) => a.dist2 - b.dist2)
          .slice(0, 3);

        nearby.forEach(({ e, dist2 }) => {
          if (dist2 < 200 * 200) {
            e.onHit?.(b.dmg * 0.35);
            // 绘制电弧（生成从 target 飞向 e 的瞬时子弹模拟弧线）
            window.spawnBullet?.('E', target.x, target.y,
              (e.x - target.x) * 3, (e.y - target.y) * 3,
              { r: 2, dmg: 0, col: '#52E6FF', life: 0.08, tags: ['_noHit'] }
            );
            window.sparks?.(e.x, e.y, 'glowB', 5, 200);
          }
        });
        window.spawnShockwave?.(target.x, target.y, '#52E6FF', 60, 0.18);
      }
    });

    // ── 2. 用 Registry.edit 给原版 HEAVY 词条叠加减速效果 ──────────
    // edit 不覆盖，而是「叠加」——把已有词条 clone 后再改
    api.registry.edit('BulletAffixCatalog', 'HEAVY', (original) => {
      const oldOnHit = original.onHit;
      return {
        ...original,
        _plasmaChainEnhanced: true,
        onHit(b, target) {
          if (oldOnHit) oldOnHit.call(this, b, target);
          // 叠加 0.6 秒减速
          if (target?.alive) {
            target._slowT = (target._slowT || 0) + 0.6;
          }
        }
      };
    }, /* priority = */ 1);

    // ── 3. 用 EventBus 订阅击杀事件，统计链式击杀数 ──────────────
    let chainKills = 0;
    api.events.on('enemySpawn', () => {}); // 确保事件总线在线
    // 利用 bulletSpawn 事件统计我们产生的 _noHit 弧线子弹数
    api.events.on('bulletSpawn', (bullet) => {
      if (bullet?.tags?.includes('_noHit')) chainKills++;
    });

    // ── 4. Render HUD：显示链式计数 ──────────────────────────────
    api.render.hud((g) => {
      if (!window.Game || Game.state !== 'playing') return;
      const W = window.W || 400, H = window.H || 600;
      g.save();
      g.font = 'bold 11px Consolas,monospace';
      g.fillStyle = '#52E6FF';
      g.shadowColor = '#52E6FF'; g.shadowBlur = 8;
      g.fillText(`⚡ CHAIN ARCS: ${chainKills}`, 12, H - 160);
      g.restore();
    });

    api.log('Plasma Chain + HEAVY enhancement installed.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #2  HIVEMIND COLLECTIVE  ·  Trait + 跨敌人协调 + WaveDirectorCfg
//     展示：registry.trait / waveDirector.filter / EventBus / PatchMgr.after
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'hivemind-collective',
  name: 'Hivemind Collective',
  version: '1.0',
  description: '群心特性：同屏拥有群心词条的敌人会共享伤害并协同攻击；波次过滤器确保每5波出现精英群。',

  init(api) {
    const HIVE_TAG = '_hivemind';

    // ── 1. 注册 HIVEMIND 特性 ────────────────────────────────────
    api.registry.trait('HIVEMIND', {
      minWave: 4,
      weight: 0.7,
      group: 'coordination',
      apply(e) {
        e[HIVE_TAG] = true;
        e._hiveSharedDmg = 0;

        const origOnHit = e.onHit?.bind(e);
        e.onHit = function(dmg, source) {
          // 将 30% 伤害分摊到其他群心成员
          const members = (window.enemies || []).filter(m => m !== e && m.alive && m[HIVE_TAG]);
          const share = dmg * 0.3;
          const actual = dmg - share;

          if (members.length > 0) {
            const perMember = share / members.length;
            members.forEach(m => {
              m._hiveSharedDmg += perMember;
              if (m._hiveSharedDmg > 1) {
                origOnHit?.call(m, Math.floor(m._hiveSharedDmg));
                m._hiveSharedDmg -= Math.floor(m._hiveSharedDmg);
              }
            });
            window.sparks?.(e.x, e.y, 'glowM', 3, 140);
          }
          origOnHit?.call(this, actual, source);
        };

        // 每 3 秒：若屏幕上群心数 ≥ 3，加速攻击
        const origUpdate = e.update?.bind(e);
        let synergyCd = 0;
        e.update = function(dt) {
          origUpdate?.call(this, dt);
          synergyCd -= dt;
          if (synergyCd <= 0) {
            synergyCd = 3.0;
            const count = (window.enemies || []).filter(m => m.alive && m[HIVE_TAG]).length;
            if (count >= 3 && this.emitters) {
              this.emitters.forEach(em => {
                if (em && em.cd !== undefined) em.cd = Math.max(em.cd - 0.2, 0.05);
              });
            }
          }
        };
      }
    });

    // ── 2. WaveDirectorCfg：每5波注入3个群心精英 ────────────────
    const wd = api.waveDirector;
    wd.addEntry({
      key: 'HIVEMIND_ELITE',
      minWave: 5,
      weight: (wave) => (wave % 5 === 0) ? 999 : 0, // 只在第5、10、15…波出现
      count: 3,
      factory(wave) {
        return {
          hp: 200 + wave * 25,
          moveKeys: ['SWAY_SINE'],
          traits: ['HIVEMIND', 'ARMORED'],
          emitters: [{ type: 'SPREAD' }],
          baseCol: '#B36CFF',
          bodyKind: 'gear',
        };
      }
    });

    // deck filter：精英波强制移除杂兵（只留精英）
    wd.filter((deck, wave) => {
      if (wave % 5 === 0) {
        const elites = deck.filter(p => p.traits?.includes('HIVEMIND'));
        if (elites.length >= 3) {
          deck.splice(0, deck.length, ...elites);
        }
      }
    });

    wd.onWave((wave) => {
      if (wave % 5 === 0) {
        api.game.textPop?.(api.game.W * 0.5, 60, `HIVEMIND ELITE WAVE ${wave}`, '#B36CFF');
      }
    });

    api.log('Hivemind Collective installed.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #3  ORBITAL CANNON  ·  自定义 Emitter + Wrapper + 自定义 UI Fields
//     展示：registry.emitter / registry.wrapper / WrapperFieldDefs
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'orbital-cannon',
  name: 'Orbital Cannon',
  version: '1.0',
  description: '轨道炮发射器：子弹在固定轨道绕行再飞向玩家；ORB_BURST 包装器用自定义 UI 字段控制爆炸半径。',

  init(api) {
    // ── 1. 发射器：ORBITAL_SHOT ──────────────────────────────────
    api.registry.emitter('ORBITAL_SHOT', (cfg) => {
      const orbitRadius = cfg.orbitRadius ?? 80;
      const orbitSpeed  = cfg.orbitSpeed  ?? 3.0;
      return {
        cd: cfg.baseCd ?? 2.0,
        _angle: 0,
        fire(owner) {
          // 子弹出现在轨道圆上
          const spawnX = owner.x + Math.cos(this._angle) * orbitRadius;
          const spawnY = owner.y + Math.sin(this._angle) * orbitRadius;
          this._angle += 0.7;

          const P = window.Player;
          if (!P) return;
          const dx = P.x - spawnX, dy = P.y - spawnY;
          const dist = Math.hypot(dx, dy) || 1;
          const speed = 320 + orbitSpeed * 30;
          window.spawnBullet?.('E', spawnX, spawnY,
            dx / dist * speed, dy / dist * speed,
            { r: 5, dmg: 18, col: '#FFB020', life: 2.0, trail: true }
          );
        }
      };
    });

    // ── 2. Wrapper：ORB_BURST（带自定义 UI 字段）───────────────────
    // 自定义字段：burstCount（数量）和 burstRadius（半径）
    // 这些字段会出现在 Forge 面板的 Wrapper 配置区
    api.registry.wrapper('ORB_BURST',
      (baseFactory, cfg) => {
        const burstCount  = cfg.burstCount  ?? 6;
        const burstRadius = cfg.burstRadius ?? 40;
        const base = baseFactory(cfg.baseCfg || cfg);
        const origFire = base.fire.bind(base);
        return {
          cd: base.cd * 1.8,
          fire(owner) {
            origFire(owner);
            // 在 owner 周围爆炸式额外子弹
            for (let i = 0; i < burstCount; i++) {
              const a = (i / burstCount) * Math.PI * 2;
              const ox = owner.x + Math.cos(a) * burstRadius;
              const oy = owner.y + Math.sin(a) * burstRadius;
              window.spawnBullet?.('E', ox, oy,
                Math.cos(a) * 200, Math.sin(a) * 200,
                { r: 3, dmg: 8, col: '#FF6600', life: 1.2 }
              );
            }
            window.spawnShockwave?.(owner.x, owner.y, '#FFB020', burstRadius * 2, 0.3);
          }
        };
      },
      // WrapperFieldDefs for Forge UI
      [
        { id: 'burstCount',  type: 'number', step: 1,   def: 6,  min: 2, max: 24,  label: 'Burst Count'  },
        { id: 'burstRadius', type: 'number', step: 5,   def: 40, min: 10, max: 200, label: 'Burst Radius' },
      ]
    );

    api.log('Orbital Cannon + ORB_BURST wrapper installed.');
    api.ui.toast('⚙ ORBITAL CANNON READY', '#FFB020', 1800);
  }
});


// ─────────────────────────────────────────────────────────────────
// #4  CHRONO SPLIT  ·  around/before/after/tap 全钩子 + Replay Buffer
//     展示：patch.around / before / after / tap / diagnostics.enableReplay
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'chrono-split',
  name: 'Chrono Split',
  version: '1.0',
  description: '时间分裂：每隔10次 spawnBullet 触发一次时间分裂，短暂减速所有子弹，并演示 before/around/after/tap 四种钩子。',

  init(api) {
    let spawnCount = 0;
    let splitActive = false;
    let splitTimer  = 0;
    const SPLIT_INTERVAL = 10;
    const SPLIT_DURATION = 1.2;

    // ── TAP：只读观察，不影响调用链 ─────────────────────────────
    api.patch.tap('spawnBullet', ([side]) => {
      if (side === 'E') spawnCount++;
    }, 0, { tag: 'chrono-tap' });

    // ── BEFORE：在子弹生成前修改参数（分裂激活时增大子弹） ────────
    api.patch.before('spawnBullet', ([side, x, y, vx, vy, opts], cancel) => {
      if (splitActive && side === 'E' && opts) {
        return [side, x, y, vx, vy, { ...opts, r: (opts.r || 4) * 1.5, col: '#B36CFF' }];
      }
    }, 1, { tag: 'chrono-before' });

    // ── AROUND：包装调用，子弹速度减半 ───────────────────────────
    api.patch.around('spawnBullet', (orig, side, x, y, vx, vy, opts) => {
      if (splitActive && side === 'E') {
        return orig(side, x, y, vx * 0.4, vy * 0.4, opts); // 速度大幅降低
      }
      return orig(side, x, y, vx, vy, opts);
    }, 2, { tag: 'chrono-around' });

    // ── AFTER：在子弹生成后追加辉光特效 ─────────────────────────
    api.patch.after('spawnBullet', (bullet, [side]) => {
      if (splitActive && side === 'E' && bullet) {
        bullet._splitGlow = true;
      }
    }, 0, { tag: 'chrono-after' });

    // ── 开启 Replay Buffer，记录最近 20 次 spawnBullet 调用 ─────
    api.patch.diagnostics.enableReplay('spawnBullet', 20);

    // ── 主循环：管理分裂计时器 ────────────────────────────────────
    api.events.on('forge:tick', (dt) => {
      if (splitActive) {
        splitTimer -= dt;
        if (splitTimer <= 0) {
          splitActive = false;
          api.game.textPop?.(api.game.W * 0.5, api.game.H * 0.4, 'TIME RESTORED', '#52E6FF');
        }
      } else if (spawnCount >= SPLIT_INTERVAL) {
        spawnCount  = 0;
        splitActive = true;
        splitTimer  = SPLIT_DURATION;
        api.game.textPop?.(api.game.W * 0.5, api.game.H * 0.4, '⧗ CHRONO SPLIT', '#B36CFF');
        api.game.spawnShockwave?.(api.game.W * 0.5, api.game.H * 0.5, '#B36CFF', 300, 0.5);
      }
    });

    // ── HUD：显示分裂状态 ──────────────────────────────────────
    api.render.hud((g) => {
      if (!splitActive) return;
      const W = window.W || 400, H = window.H || 600;
      const t = splitTimer / SPLIT_DURATION;
      g.save();
      g.globalAlpha = 0.35 * t;
      g.fillStyle   = '#B36CFF';
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
      g.font  = 'bold 18px Consolas';
      g.fillStyle = '#B36CFF';
      g.shadowColor = '#B36CFF'; g.shadowBlur = 20;
      g.textAlign = 'center';
      g.fillText(`⧗ CHRONO SPLIT  ${splitTimer.toFixed(1)}s`, W * 0.5, H * 0.35);
      g.textAlign = 'left';
      g.restore();
    });

    api.log('Chrono Split: before/around/after/tap all hooked on spawnBullet.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #5  IRON TITAN  ·  Custom bodyKind + Fortress Structure + Appearance
//     展示：registry.bodyKind / registry.appearance / registry.structure
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'iron-titan',
  name: 'Iron Titan',
  version: '1.0',
  description: '铁巨人：注册自定义 bodyKind 绘制函数、appearance 外观定义，以及钢铁防线要塞建筑。',

  init(api) {
    // ── 1. 注册 TITAN_BODY（bodyKind 绘制函数）─────────────────────
    api.registry.bodyKind('TITAN_BODY', ({ g, e, b, col, R0, rot, time }) => {
      g.save();
      g.translate(e.x, e.y);
      g.rotate(rot);

      // 主体方形
      g.fillStyle = col;
      g.shadowColor = col; g.shadowBlur = 12;
      g.fillRect(-R0 * 0.8, -R0 * 0.8, R0 * 1.6, R0 * 1.6);

      // 内层装甲板
      g.fillStyle = 'rgba(0,0,0,0.4)';
      g.fillRect(-R0 * 0.5, -R0 * 0.5, R0, R0);

      // 四角铆钉
      const ri = R0 * 0.65;
      [[ri, ri], [ri, -ri], [-ri, ri], [-ri, -ri]].forEach(([cx, cy]) => {
        g.beginPath();
        g.arc(cx, cy, R0 * 0.12, 0, Math.PI * 2);
        g.fillStyle = col;
        g.fill();
      });

      // 中心核心：脉冲光
      const pulse = 0.6 + 0.4 * Math.sin(time * 4);
      g.beginPath();
      g.arc(0, 0, R0 * 0.22 * pulse, 0, Math.PI * 2);
      g.fillStyle = '#fff';
      g.shadowColor = '#fff'; g.shadowBlur = 20 * pulse;
      g.globalAlpha = pulse;
      g.fill();
      g.globalAlpha = 1;

      g.restore();
    });

    // ── 2. 注册 JELLYFISH_MECH Appearance（新语法，带 label + tags）
    api.registry.appearance('JELLYFISH_MECH', {
      label: 'Jellyfish Mech',
      tags: ['organic', 'mechanical'],
      draw(g, e, body, col, R0, rot, time) {
        g.save();
        g.translate(e.x, e.y);
        g.rotate(rot + time * 0.4);

        // 钟形外壳
        g.beginPath();
        g.ellipse(0, 0, R0, R0 * 0.65, 0, Math.PI, 0);
        g.fillStyle = col + 'AA';
        g.fill();
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.stroke();

        // 触须（受时间驱动的摆动）
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          const wave = Math.sin(time * 2.5 + i * 0.8) * 14;
          g.beginPath();
          g.moveTo(Math.cos(a) * R0 * 0.7, Math.sin(a) * R0 * 0.4);
          g.bezierCurveTo(
            Math.cos(a) * R0 * 1.1, Math.sin(a) * R0 * 0.9 + wave * 0.3,
            Math.cos(a) * R0 * 1.3, Math.sin(a) * R0 * 1.3 + wave,
            Math.cos(a) * R0 * 1.5, Math.sin(a) * R0 * 1.6 + wave * 1.5
          );
          g.strokeStyle = col + '88';
          g.lineWidth = 1.5;
          g.stroke();
        }

        g.restore();
      },
      preview(g, size) {
        // 缩略图用于 Forge 预览
        g.beginPath();
        g.ellipse(size / 2, size / 2, size * 0.35, size * 0.25, 0, Math.PI, 0);
        g.fillStyle = '#B36CFF88';
        g.fill();
        g.strokeStyle = '#B36CFF';
        g.lineWidth = 1.5;
        g.stroke();
      }
    });

    // ── 3. 注册 IRON_BASTION 要塞建筑 ────────────────────────────
    api.registry.structure('IRON_BASTION', {
      name: 'Iron Bastion',
      cost: 6,
      hp: 600,
      w: 50, h: 28,
      col: '#888',
      build: '⬛',
      description: '铁堡：高血量建筑，定期对附近敌人释放震波',

      behavior: {
        onCreate(s) { s._pulseCd = 4.0; },
        onUpdate(s, dt) {
          s._pulseCd -= dt;
          if (s._pulseCd <= 0) {
            s._pulseCd = 4.0;
            window.spawnShockwave?.(s.x, s.y, '#888', 120, 0.4);
          }
        },
        onDraw(g, s) {
          const { x, y, w, h, hp, maxHp, col } = s;
          // 主体
          g.fillStyle = col;
          g.fillRect(x - w / 2, y - h / 2, w, h);
          // 城垛
          const merlons = 5;
          const mW = w / (merlons * 2);
          for (let i = 0; i < merlons; i++) {
            g.fillRect(x - w / 2 + i * mW * 2, y - h / 2 - 6, mW, 6);
          }
          // 血条
          g.fillStyle = '#333';
          g.fillRect(x - w / 2, y + h / 2 + 2, w, 3);
          g.fillStyle = hp / maxHp > 0.5 ? '#52E6FF' : '#FF2F57';
          g.fillRect(x - w / 2, y + h / 2 + 2, w * (hp / maxHp), 3);
        }
      }
    });

    api.log('Iron Titan: TITAN_BODY + JELLYFISH_MECH + IRON_BASTION registered.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #6  MERCHANT SERVICE  ·  跨 Mod 服务 + SharedStore + UpgradePool
//     展示：services.provide / services.require / store.set/get / registry.upgrade
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'merchant-service',
  name: 'Merchant Service',
  version: '1.0',
  description: '跨 Mod 服务：注册 "economy" 服务供其他 Mod 读写金币；用 UpgradePool 注册可购买升级；SharedStore 存储持久状态。',

  init(api) {
    // ── 1. SharedStore：持久化金币 ──────────────────────────────
    const STORE_NS = 'merchant';
    api.store.set('gold', 100);    // 初始金币
    api.store.set('trades', 0);

    // ── 2. 注册 Economy 服务 ─────────────────────────────────────
    api.services.provide('economy', {
      version: '1.0',
      getGold: ()    => api.store.get('gold') ?? 0,
      addGold: (n)   => api.store.set('gold', (api.store.get('gold') || 0) + n),
      spendGold: (n) => {
        const cur = api.store.get('gold') || 0;
        if (cur < n) return false;
        api.store.set('gold', cur - n);
        api.store.set('trades', (api.store.get('trades') || 0) + 1);
        return true;
      },
      price: (item) => ({ shield: 30, speed: 20, bomb: 50 }[item] || 10),
    }, '1.0');

    // ── 3. UpgradePool：可购买的升级 ─────────────────────────────
    api.registry.upgrade('MERCHANT_SHIELD_PLUS', {
      name: 'Shield Plus',
      description: '+3 Shield (costs 30 gold)',
      maxLevel: 3,
      level: 0,
      apply(player) {
        const eco = NEPForge.services.lookup('economy');
        if (!eco) return;
        if (eco.spendGold(30)) {
          player.shield = (player.shield || 0) + 3;
          api.ui.toast('🛡 SHIELD +3 (-30 gold)', '#52E6FF', 1800);
        } else {
          api.ui.toast('❌ NOT ENOUGH GOLD', '#FF2F57', 1500);
        }
      }
    });

    api.registry.upgrade('MERCHANT_SPEED_PLUS', {
      name: 'Speed Boost',
      description: '+15% speed (costs 20 gold)',
      maxLevel: 5,
      level: 0,
      apply(player) {
        const eco = NEPForge.services.lookup('economy');
        if (!eco) return;
        if (eco.spendGold(20)) {
          player.speed = (player.speed || 200) * 1.15;
          api.ui.toast('🚀 SPEED +15% (-20 gold)', '#FFB020', 1800);
        } else {
          api.ui.toast('❌ NOT ENOUGH GOLD', '#FF2F57', 1500);
        }
      }
    });

    // ── 4. 敌人死亡时获得金币 ────────────────────────────────────
    api.events.on('enemySpawn', (enemy) => {
      if (!enemy) return;
      const origOnHit = enemy.onHit?.bind(enemy);
      enemy.onHit = function(dmg, src) {
        const result = origOnHit?.call(this, dmg, src);
        if (!this.alive) {
          const earned = Math.ceil((this.maxHp || 100) / 50);
          api.store.set('gold', (api.store.get('gold') || 0) + earned);
        }
        return result;
      };
    });

    // ── 5. 悬浮 HUD ──────────────────────────────────────────────
    api.render.hud((g) => {
      if (!window.Game || Game.state !== 'playing') return;
      const gold = api.store.get('gold') || 0;
      const W = window.W || 400, H = window.H || 600;
      g.save();
      g.font = 'bold 11px Consolas'; g.fillStyle = '#FFB020';
      g.shadowColor = '#FFB020'; g.shadowBlur = 6;
      g.fillText(`💰 GOLD: ${gold}`, 12, H - 175);
      g.restore();
    });

    api.log('Merchant Service: economy service + upgrades registered.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #7  PHASE RESONANCE  ·  Pipeline + Render Pipeline 全屏特效
//     展示：pipelines.use / render.pre/post/hud / RenderPipeline 层次
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'phase-resonance',
  name: 'Phase Resonance',
  version: '1.0',
  description: '相位共鸣：玩家血量越低，全屏色差扭曲越强；伤害管线根据"共鸣频率"决定反弹伤害。',

  init(api) {
    let resonance = 0;  // 0-1：共鸣强度（hp 越低越高）
    let reflectCooldown = 0;

    // ── 1. playerDamage 管线：高共鸣时反弹 30% 伤害给最近敌人 ────
    api.pipelines.use('playerDamage', (ctx, next) => {
      if (resonance > 0.6 && reflectCooldown <= 0) {
        const nearest = window.findNearestEnemy?.(
          window.Player?.x || 200, window.Player?.y || 300
        );
        if (nearest?.alive) {
          nearest.onHit?.(ctx.dmg * 0.3);
          window.sparks?.(nearest.x, nearest.y, 'glowR', 8, 200);
          api.game.textPop?.(nearest.x, nearest.y - 20, 'REFLECT!', '#FF2F57');
          reflectCooldown = 2.0;
        }
      }
      next();
    }, /* priority = */ 3);

    // ── 2. forge:tick 更新共鸣值 ────────────────────────────────
    api.events.on('forge:tick', (dt) => {
      reflectCooldown -= dt;
      const p = window.Player;
      if (!p?.alive) { resonance = 0; return; }
      const hpPct = p.hp / (p.maxHp || 100);
      // 低血量 → 高共鸣（反向关系，有滞后平滑）
      const target = Math.max(0, 1 - hpPct * 1.5);
      resonance += (target - resonance) * dt * 2.0;
    });

    // ── 3. render.pre：在游戏绘制前，给 canvas 加全屏色差偏移 ────
    api.render.pre((g) => {
      if (resonance < 0.15) return;
      const W = window.W || 400, H = window.H || 600;
      // 轻微的红色 overlay（共鸣越高越红）
      g.save();
      g.globalAlpha = resonance * 0.12;
      g.fillStyle   = '#FF0000';
      g.fillRect(0, 0, W, H);
      g.restore();
    });

    // ── 4. render.post：在游戏绘制后，叠加扭曲边框效果 ──────────
    api.render.post((g) => {
      if (resonance < 0.3) return;
      const W = window.W || 400, H = window.H || 600;
      const t = performance.now() * 0.001;
      const amp = resonance * 18;

      g.save();
      g.strokeStyle = `rgba(255,47,87,${resonance * 0.6})`;
      g.lineWidth   = resonance * 4;
      g.shadowColor = '#FF2F57'; g.shadowBlur = 20 * resonance;

      // 抖动边框
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const px = (i / 60) * W;
        const noise = amp * Math.sin(i * 0.5 + t * 8);
        if (i === 0) g.moveTo(px, noise);
        else         g.lineTo(px, noise);
      }
      g.stroke();

      // 底边
      g.beginPath();
      for (let i = 0; i <= 60; i++) {
        const px = (i / 60) * W;
        const noise = H + amp * Math.sin(i * 0.5 + t * 8 + Math.PI);
        if (i === 0) g.moveTo(px, noise);
        else         g.lineTo(px, noise);
      }
      g.stroke();
      g.restore();
    });

    // ── 5. render.hud：显示共鸣强度条 ────────────────────────────
    api.render.hud((g) => {
      if (!window.Game || Game.state !== 'playing') return;
      const W = window.W || 400, H = window.H || 600;
      const bw = 80, bh = 5;
      g.save();
      g.fillStyle = '#111';
      g.fillRect(W - bw - 10, H - 195, bw, bh);
      const col = resonance > 0.7 ? '#FF2F57' : resonance > 0.4 ? '#FFB020' : '#B36CFF';
      g.fillStyle = col;
      g.shadowColor = col; g.shadowBlur = 6;
      g.fillRect(W - bw - 10, H - 195, bw * resonance, bh);
      g.font = '9px Consolas'; g.fillStyle = col;
      g.fillText('RESONANCE', W - bw - 10, H - 198);
      g.restore();
    });

    api.log('Phase Resonance: damage pipeline + render PRE/POST/HUD installed.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #8  REACTIVE CONSOLE  ·  UIFramework 全功能响应式面板 + 模态框 + 输入注入
//     展示：ui.floating / ui.reactive.state / ui.inject / ui.modal / ui.components
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'reactive-console',
  name: 'Reactive Console',
  version: '1.0',
  description: '全功能响应式控制台：滑块/开关/下拉框/按钮/实时状态显示，演示 UIFramework 完整组件集。',

  init(api) {
    const { components: C, reactive } = api.ui;

    // ── 响应式状态 ───────────────────────────────────────────────
    const state = reactive.state({
      enemyCount: 0, bulletCount: 0, wave: 0, fps: 0,
      godMode: false, dmgMul: 1.0, theme: 'cyan',
    });

    // ── 每帧同步游戏数据 ─────────────────────────────────────────
    api.events.on('forge:tick', (dt) => {
      state.update({
        enemyCount:  (window.enemies  || []).filter(e => e.alive).length,
        bulletCount: (window.bulletsE || []).filter(b => b.alive).length +
                     (window.bulletsP || []).filter(b => b.alive).length,
        wave:        window.Game?.wave || 0,
        fps:         dt > 0 ? Math.round(1 / dt) : 0,
      });
      // 无敌模式：锁定 HP
      if (state.get('godMode') && window.Player?.alive) {
        window.Player.hp = window.Player.maxHp;
      }
    });

    // ── 构建悬浮面板 ─────────────────────────────────────────────
    api.ui.floating({
      title: '⌨ REACTIVE CONSOLE',
      modId: 'reactive-console',
      style: { top: '15%', left: 'calc(100% - 270px)', width: '245px' },
      children: [

        // 实时统计
        C.heading({ text: '📊 LIVE STATS' }),
        C.stat({ label: 'ENEMIES', value: '0', color: '#FF2F57',
          ref(el) { state.bind?.(el, (d, e) => e.update?.(d.enemyCount)); }
        }),
        C.stat({ label: 'BULLETS', value: '0', color: '#FFB020',
          ref(el) { state.bind?.(el, (d, e) => e.update?.(d.bulletCount)); }
        }),
        C.stat({ label: 'FPS',     value: '0', color: '#50DC64',
          ref(el) { state.bind?.(el, (d, e) => e.update?.(d.fps)); }
        }),
        C.stat({ label: 'WAVE',    value: '0', color: '#52E6FF',
          ref(el) { state.bind?.(el, (d, e) => e.update?.(d.wave)); }
        }),

        C.separator(),
        C.heading({ text: '🎮 CHEATS' }),

        // 无敌模式
        C.toggle({
          label:    'GOD MODE',
          checked:  false,
          onChange: (v) => {
            state.set('godMode', v);
            api.ui.toast(v ? '😇 GOD MODE ON' : '💀 GOD MODE OFF',
                         v ? '#50DC64' : '#FF2F57', 1500);
          }
        }),

        // 伤害倍率滑块
        C.slider({
          label:    'DAMAGE MUL',
          min: 0.1, max: 10, step: 0.1, value: 1.0,
          onChange: (v) => {
            state.set('dmgMul', v);
            const p = window.Player;
            if (p) p.dmgMul = v;
          }
        }),

        C.separator(),
        C.heading({ text: '⚡ ACTIONS' }),

        {
          tag: 'div', style: 'display:flex;gap:6px;flex-wrap:wrap;',
          ref(el) {
            const btns = [
              { label: 'NUKE',    col: '#FF2F57', fn: () => {
                (window.enemies || []).forEach(e => { if (e.alive) e.onHit?.(99999); });
                window.spawnShockwave?.(window.W*0.5, window.H*0.5, '#FF2F57', 600, 0.9);
              }},
              { label: 'SHIELD',  col: '#52E6FF', fn: () => {
                if (window.Player) window.Player.shield = 20;
                api.ui.toast('🛡 MAX SHIELD', '#52E6FF', 1200);
              }},
              { label: 'LEVEL UP', col: '#FFB020', fn: () => {
                if (window.Player) window.Player.lv++;
                api.ui.toast('⬆ LEVEL UP!', '#FFB020', 1200);
              }},
              { label: 'INFO',    col: '#B36CFF', fn: () => {
                api.ui.modal({
                  title: 'REACTIVE CONSOLE',
                  content: { tag: 'p', style: 'color:#ccc;font-size:12px;',
                    text: 'Full UIFramework demo: stat components, reactive state binding, slider, toggle, modal. All auto-cleaned on mod unload.' },
                  buttons: [{ label: 'AWESOME', color: '#B36CFF' }]
                });
              }},
            ];
            btns.forEach(({ label, col, fn }) => {
              el.appendChild(C.button({ label, color: col, onClick: fn }));
            });
          }
        },
      ]
    });

    // ── DOM 注入：给选项菜单追加一个快速关闭按钮 ──────────────────
    api.ui.inject('#optionPanel .actions', {
      tag: 'button',
      class: 'nep-btn',
      style: 'margin-top:6px;border-color:#B36CFF;color:#B36CFF;width:100%;',
      text: 'REACTIVE CONSOLE: TOGGLE',
      onClick: () => {
        const panel = document.querySelector('[data-mod-panel="reactive-console"]') ||
                      document.querySelector('.nep-float-panel');
        if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
      }
    }, { live: true });

    api.log('Reactive Console: full UIFramework demo installed.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #9  PROPERTY SCHEMA FORTRESS  ·  watch / schema / freeze / computed / mirror
//     展示：patch.watch / patch.schema / patch.freeze / patch.computed / patch.mirror
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'property-fortress',
  name: 'Property Schema Fortress',
  version: '1.0',
  description: '属性防护堡垒：给 Game.state 加 Schema 校验、给 Player.hp 加 getter 注入、计算属性 shieldRatio，mirror 同步到调试输出。',

  init(api) {
    const Game   = api.resolver.get('Game');
    const Player = api.resolver.get('Player');

    if (Game) {
      // ── Schema 保护 Game.state ──────────────────────────────
      api.patch.schema(Game, 'state', {
        type: 'string',
        enum: ['menu', 'playing', 'paused', 'over'],
      });

      api.log('Game.state is now strictly typed [menu|playing|paused|over].');
    }

    if (Player) {
      // ── Watch Player.hp：触发共鸣效果 ──────────────────────
      api.patch.watch(Player, 'hp', {
        set(newVal, oldVal) {
          // 血量突降超过 20 时震屏提示
          if (oldVal - newVal > 20 && window.Game?.state === 'playing') {
            window.textPop?.(Player.x || 200, (Player.y || 300) - 25,
              `-${Math.round(oldVal - newVal)} HP`, '#FF2F57');
          }
          return newVal; // 返回值将被写入
        }
      });

      // ── 计算属性 shieldRatio：依赖 shield / maxHp ──────────
      api.patch.computed(Player, 'shieldRatio',
        () => {
          const p = window.Player;
          return p ? (p.shield || 0) / (p.maxHp || 100) : 0;
        },
        [{ obj: Player, key: 'shield' }, { obj: Player, key: 'maxHp' }]
      );

      // ── Mirror Player.lv → SharedStore['player.lv'] 做全局通知 ─
      const mirrorTarget = { lv: 0 };
      api.patch.mirror(Player, 'lv', mirrorTarget, 'lv');
      api.patch.onChange(mirrorTarget, 'lv', (newLv) => {
        api.events.emit('player:levelUp', newLv);
        api.ui.toast(`LEVEL ${newLv}!`, '#50DC64', 1200);
      });

      // ── 冻结 Player.gunModsMax（防止其他 Mod 乱改上限）────────
      // api.patch.freeze(Player, 'gunModsMax');  // 解注释启用

      api.log('Property Fortress: Game.state schema + Player.hp watch + shieldRatio computed + lv mirror.');
    }
  }
});


// ─────────────────────────────────────────────────────────────────
// #10  SIGNAL WEAVER  ·  跨 Mod 信号 + Capability + Scheduler + Input
//      展示：patch.signal / patch.negotiate / schedule.after/every/onWave / input.bind
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
  id: 'signal-weaver',
  name: 'Signal Weaver',
  version: '1.0',
  description: '信号织者：声明能力、订阅跨 Mod 信号、键盘绑定（P=暂停/恢复，K=全杀）、定时任务演示。',

  init(api) {
    // ── 1. 声明能力（其他 Mod 可通过 negotiate.has 查询）──────────
    api.patch.negotiate.declare('time_control', 'player_monitor', 'mass_spawn');

    // ── 2. 发射信号：游戏开始时通知其他 Mod ─────────────────────
    api.events.on('wave', (wave) => {
      api.patch.signal.emit('weaver:newWave', { wave, time: Date.now() });
    });

    // ── 3. 订阅其他 Mod 发射的信号（例如 merchant-service 的金币变化）
    api.patch.signal.on('store:merchant::gold', (data) => {
      api.log(`[Signal] Gold changed: ${JSON.stringify(data)}`);
    });

    // ── 4. 键盘绑定 ─────────────────────────────────────────────
    // P 键：暂停/恢复
    api.input.bind('KeyP', () => {
      const g = window.Game;
      if (!g) return;
      if (g.state === 'playing') {
        g.state = 'paused';
        api.ui.toast('⏸ PAUSED (P to resume)', '#FFB020', 99999);
      } else if (g.state === 'paused') {
        g.state = 'playing';
        // 找到并关闭 toast
        document.querySelectorAll('.nep-toast').forEach(t => t.remove());
        api.ui.toast('▶ RESUMED', '#50DC64', 1000);
      }
    });

    // K 键：清屏杀敌
    api.input.bind('KeyK', () => {
      if (window.Game?.state !== 'playing') return;
      let killed = 0;
      (window.enemies || []).forEach(e => { if (e.alive) { e.onHit?.(99999); killed++; } });
      window.spawnShockwave?.(window.W * 0.5, window.H * 0.5, '#FF2F57', 500, 0.8);
      api.ui.toast(`💀 NUKED ${killed} ENEMIES`, '#FF2F57', 1800);
    });

    // ── 5. Scheduler 演示 ─────────────────────────────────────
    // 游戏开始 3 秒后一次性提示
    api.schedule.after(() => {
      api.ui.toast('⌨ P=PAUSE · K=NUKE', '#52E6FF', 3000);
    }, 3.0);

    // 每 30 秒循环：如果敌人超过 20 只，提示玩家
    api.schedule.every(() => {
      const count = (window.enemies || []).filter(e => e.alive).length;
      if (count > 20 && window.Game?.state === 'playing') {
        window.textPop?.(window.W * 0.5, 80, `⚠ ${count} ENEMIES ACTIVE`, '#FFB020');
      }
    }, 30.0);

    // 在第 5 波和第 10 波各发送特殊信号
    api.schedule.onWave(() => {
      api.patch.signal.emit('weaver:eliteWave', { wave: 5 });
    }, 5);
    api.schedule.onWave(() => {
      api.patch.signal.emit('weaver:eliteWave', { wave: 10 });
    }, 10);

    // ── 6. HUD：显示能力标签 ────────────────────────────────────
    api.render.hud((g) => {
      if (!window.Game || Game.state !== 'playing') return;
      const W = window.W || 400, H = window.H || 600;
      g.save();
      g.font = '9px Consolas'; g.fillStyle = '#B36CFF88';
      g.fillText('[P]PAUSE [K]NUKE · SIGNAL WEAVER', 12, H - 190);
      g.restore();
    });

    api.log('Signal Weaver: capabilities + signals + keyboard (P/K) + scheduler installed.');
  }
});


// ─────────────────────────────────────────────────────────────────
// #5  LAB MULTI SPAWNER · LAB 模式同时放多只 Forge 怪
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
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
      api.ui.toast(`✅ 已加入敌人池 (${selectedPool.length})`, '#50DC64', 1200);
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
});


// ─────────────────────────────────────────────────────────────────
// #6  PLAYER FIRE CONTROL · 运行时控制 Emitter/Affix/停火
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
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
            label: `${isEmitterEnabled(idx) ? 'ON ' : 'OFF'} #${idx + 1} ${(em?.type || em?.id || 'EMITTER')}`,
            color: isEmitterEnabled(idx) ? '#50DC64' : '#FFB020',
            onClick() {
              isEmitterEnabled(idx) ? state.disabledEmitterIdx.add(idx) : state.disabledEmitterIdx.delete(idx);
              renderPanel();
            }
          })),
          { tag: 'div', style: 'font-size:10px;color:#9deeff;margin-top:5px;', text: 'Affixes（点击开/关）' },
          ...affixes.map((k) => api.ui.components.button({
            label: `${isAffixEnabled(k) ? 'ON ' : 'OFF'} ${k}`,
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
});


// ─────────────────────────────────────────────────────────────────
// #7  NO WARP BONUS · 禁用跳关时强制赋予玩家加成
// ─────────────────────────────────────────────────────────────────
NEPForge.install({
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
});
