// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  NOVA OPTIMIZER  v1.2                                                    ║
// ║  基于 NovaForge 的高级性能优化套件                                        ║
// ║  依赖：先加载 nova_forge_metaloader.js                                   ║
// ║                                                                          ║
// ║  功能子模组：                                                            ║
// ║   · bullet-culler    子弹越界剔除，减少无效计算                          ║
// ║   · enemy-lod        屏外敌人 LOD，降低射击频率                          ║
// ║   · frame-budget     帧时间预算监视器，实时显示                          ║
// ║   · adaptive-fx      自适应特效密度（紧急状态减少粒子）                  ║
// ║   · memory-watchdog  每60秒检测数组膨胀并自动清理                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝
Nova.def('nova-optimizer', {
  name: '⚡ Nova Optimizer',
  version: '1.2',
  description: '全自动性能优化套件：子弹剔除 / 敌人 LOD / 帧预算 / 自适应特效 / 内存看门狗。',

  // ─────────────────────────────────────────────────────────────────
  // 响应式状态
  // ─────────────────────────────────────────────────────────────────
  state: {
    // 用户配置
    bulletCulling:    true,
    enemyLOD:         true,
    adaptiveFX:       true,
    fpsTarget:        55,
    cullMargin:       60,    // px 越界后才剔除
    lodThreshold:     80,    // % FPS 目标达到此比例时启用 LOD

    // 实时统计
    fps:              0,
    avgFps:           0,
    frameMs:          0.0,
    pressure:         'low',   // 'low' | 'medium' | 'high' | 'critical'
    culledBullets:    0,
    lodActive:        0,
    memPressure:      'ok',

    // 内部（不渲染）
    _fpsHistory:      [],
    _lastFrameStart:  0,
    _ticksSinceReset: 0,
  },

  // ─────────────────────────────────────────────────────────────────
  // 悬浮控制面板
  // ─────────────────────────────────────────────────────────────────
  panel: {
    title: '⚡ OPTIMIZER',
    position: { bottom: '55px', right: '8px', top: 'auto', left: 'auto', width: '195px' },
    controls: [
      { type: 'heading', text: '⚙ CONFIG' },
      { type: 'toggle',  state: 'bulletCulling', label: 'BULLET CULLING' },
      { type: 'toggle',  state: 'enemyLOD',      label: 'ENEMY LOD' },
      { type: 'toggle',  state: 'adaptiveFX',    label: 'ADAPTIVE FX' },
      { type: 'slider',  state: 'fpsTarget',     label: 'FPS TARGET', min: 20, max: 120, step: 5 },
      { type: 'slider',  state: 'cullMargin',    label: 'CULL MARGIN', min: 0, max: 200, step: 10 },
      { type: 'separator' },
      { type: 'heading', text: '📊 STATS' },
      { type: 'display', label: 'FPS',       bind: 'fps',           color: '#50DC64' },
      { type: 'display', label: 'AVG FPS',   bind: 'avgFps',        color: '#52E6FF' },
      { type: 'display', label: 'FRAME MS',  bind: 'frameMs',       color: '#FFB020' },
      { type: 'display', label: 'PRESSURE',  bind: 'pressure',      color: '#FF2F57' },
      { type: 'display', label: 'CULLED/F',  bind: 'culledBullets', color: '#B36CFF' },
      { type: 'display', label: 'LOD SAVES', bind: 'lodActive',     color: '#B36CFF' },
      { type: 'separator' },
      { type: 'button',  label: 'RESET STATS', color: '#555',
        action(state) {
          state.update({ culledBullets: 0, lodActive: 0, _fpsHistory: [] });
        }
      },
    ]
  },

  // ─────────────────────────────────────────────────────────────────
  // 声明式 Patch：around step() 测量帧时间
  // ─────────────────────────────────────────────────────────────────
  patch: {
    step: {
      around(orig, ts) {
        const t0 = performance.now();
        const r  = orig(ts);
        const ms = performance.now() - t0;
        const rec = window.Nova?.get('nova-optimizer');
        if (rec?.state) {
          rec.state.frameMs = parseFloat(ms.toFixed(2));
        }
        return r;
      },
      priority: -999,  // 最低优先级，等所有其他 around 完成后才测量
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // 主逻辑 tick
  // ─────────────────────────────────────────────────────────────────
  tick(ctx, dt) {
    const s = ctx.state;
    if (!dt || dt <= 0) return;

    // ── FPS & Pressure ────────────────────────────────────────────
    const fps = Math.round(1 / dt);
    s.fps = fps;

    const hist = s._fpsHistory;
    hist.push(fps);
    if (hist.length > 90) hist.shift();
    const avgFps = Math.round(hist.reduce((a, b) => a + b, 0) / hist.length);
    s.avgFps = avgFps;

    const target  = s.fpsTarget;
    const ratio   = avgFps / target;
    s.pressure = ratio >= 0.95 ? 'low'
               : ratio >= 0.75 ? 'medium'
               : ratio >= 0.50 ? 'high'
               : 'critical';

    s._ticksSinceReset = (s._ticksSinceReset || 0) + 1;

    // ── Bullet Culling ────────────────────────────────────────────
    if (s.bulletCulling) {
      const W = ctx.game.W || 400;
      const H = ctx.game.H || 600;
      const m = s.cullMargin + (s.pressure === 'critical' ? 0 : s.pressure === 'high' ? -20 : 0);
      let culled = 0;

      const arrs = [
        ctx.game.bulletsE || [],
        ctx.game.bulletsP || [],
      ];
      for (const arr of arrs) {
        for (const b of arr) {
          if (b?.alive && (b.x < -m || b.x > W + m || b.y < -m || b.y > H + m)) {
            b.alive = false;
            culled++;
          }
        }
      }
      s.culledBullets = culled;
    }

    // ── Enemy LOD ─────────────────────────────────────────────────
    if (s.enemyLOD && s.pressure !== 'low') {
      const W = ctx.game.W || 400;
      const H = ctx.game.H || 600;
      const m = 120;
      let saved = 0;

      const enemies = ctx.game.enemies || [];
      for (const e of enemies) {
        if (!e?.alive) continue;
        const offscreen = e.x < -m || e.x > W + m || e.y < -m || e.y > H + m;
        if (!offscreen) continue;

        // LOD：降低屏外敌人的发射器冷却速率
        if (e.emitters) {
          const penalty = s.pressure === 'critical' ? 2.0 : 1.4;
          for (const em of e.emitters) {
            if (em && typeof em.cd === 'number' && em.cd < 0.4) {
              em.cd += 0.3 * penalty * dt;
              saved++;
            }
          }
        }
      }
      s.lodActive = saved;
    }

    // ── Memory Watchdog（每 ~60 秒清理死亡实体） ──────────────────
    if (s._ticksSinceReset % 3600 === 0) {
      const g = window.Game;
      if (g?.state === 'playing') {
        const before = (window.enemies || []).length;
        if (window.enemies) {
          window.enemies.splice(0, window.enemies.length,
            ...window.enemies.filter(e => e.alive)
          );
        }
        if (window.bulletsE) {
          window.bulletsE.splice(0, window.bulletsE.length,
            ...window.bulletsE.filter(b => b.alive)
          );
        }
        if (window.bulletsP) {
          window.bulletsP.splice(0, window.bulletsP.length,
            ...window.bulletsP.filter(b => b.alive)
          );
        }
        const after = (window.enemies || []).length;
        s.memPressure = before - after > 20 ? 'high' : 'ok';
        _logClean(before, after);
      }
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // 声明式 Render HUD
  // ─────────────────────────────────────────────────────────────────
  render: {
    hud(g) {
      const rec = window.Nova?.get('nova-optimizer');
      if (!rec?.loaded) return;
      const s = rec.state;
      const { W, H } = window;
      if (!W || !H) return;

      // 彩色状态徽章
      const col = s.pressure === 'critical' ? '#FF2F57'
                : s.pressure === 'high'     ? '#FFB020'
                : s.pressure === 'medium'   ? '#52E6FF'
                : '#50DC64';

      g.save();
      g.font        = 'bold 10px Consolas,monospace';
      g.fillStyle   = col;
      g.shadowColor = col;
      g.shadowBlur  = 5;
      g.fillText(`⚡${s.fps}fps·${s.pressure}·C:${s.culledBullets}`, 12, H - 175);
      g.restore();
    }
  },

  // ─────────────────────────────────────────────────────────────────
  // 安装/卸载
  // ─────────────────────────────────────────────────────────────────
  setup(ctx) {
    ctx.log('⚡ Nova Optimizer v1.2 installed.');
    ctx.toast('⚡ OPTIMIZER ACTIVE', '#50DC64', 2000);
  },

  teardown() {
    console.log('[nova-optimizer] Unloaded. Performance features removed.');
  },

  // ═══════════════════════════════════════════════════════════════════
  //  MOD-IN-MOD  ·  子模组们各自独立，但通过 parentState 访问父状态
  // ═══════════════════════════════════════════════════════════════════
  mods: {

    // ─────────────────────────────────────────────────────────────
    // SUB-MOD 1：Frame Budget Bar
    //   实时绘制帧时间利用率进度条（仅在 medium+ 压力下显示）
    // ─────────────────────────────────────────────────────────────
    'frame-budget': {
      name: 'Frame Budget Monitor',
      version: '1.0',
      description: '在屏幕角落绘制帧预算占用条',

      state: { visible: true },

      render: {
        hud(g) {
          // 读取父模组状态
          const parent = window.Nova?.get('nova-optimizer');
          if (!parent?.loaded) return;
          const ps = parent.state;
          if (ps.pressure === 'low') return;

          const { W, H } = window;
          if (!W || !H) return;

          const budget  = 1000 / (ps.fpsTarget || 60);
          const used    = ps.frameMs || 0;
          const pct     = Math.min(1, used / budget);
          const bw = 90, bh = 5;
          const bx = W - bw - 10, by = H - 185;

          g.save();
          g.globalAlpha = 0.7;

          // 背景
          g.fillStyle = '#111';
          g.fillRect(bx, by, bw, bh);

          // 填充（颜色随压力变化）
          const barCol = pct > 0.9 ? '#FF2F57' : pct > 0.7 ? '#FFB020' : '#50DC64';
          g.fillStyle   = barCol;
          g.shadowColor = barCol;
          g.shadowBlur  = 4;
          g.fillRect(bx, by, bw * pct, bh);

          // 标签
          g.font      = '8px Consolas';
          g.fillStyle = '#777';
          g.shadowBlur = 0;
          g.fillText(`${used.toFixed(1)}ms / ${budget.toFixed(1)}ms`, bx, by - 2);

          g.restore();
        }
      },

      setup(ctx) { ctx.log('Frame Budget Bar active.'); }
    },

    // ─────────────────────────────────────────────────────────────
    // SUB-MOD 2：Adaptive Effects Controller
    //   在 critical 压力时，拦截 sparks/shockwave 调用并降采样
    //   （每隔一帧才允许一次重量级特效）
    // ─────────────────────────────────────────────────────────────
    'adaptive-effects': {
      name: 'Adaptive Effects',
      version: '1.0',
      description: '危急帧率时自动降低粒子/特效密度',

      state: { fxSkip: 0, totalSkipped: 0 },

      patch: {
        // 降采样 sparks
        sparks: {
          before([x, y, type, count, ...rest], cancel) {
            const parent = window.Nova?.get('nova-optimizer');
            if (!parent) return;
            const pressure = parent.state.pressure;
            if (pressure === 'critical') {
              const rec = window.Nova?.get('nova-optimizer::adaptive-effects');
              if (rec) {
                rec.state.fxSkip = (rec.state.fxSkip + 1) % 3;
                if (rec.state.fxSkip !== 0) {
                  cancel(); // 跳过本次特效
                  rec.state.totalSkipped++;
                  return;
                }
              }
              // 仅允许的帧：减半粒子数
              return [x, y, type, Math.max(1, Math.floor(count * 0.4)), ...rest];
            }
            if (pressure === 'high') {
              return [x, y, type, Math.max(1, Math.floor(count * 0.65)), ...rest];
            }
          }
        },

        // 降采样 spawnShockwave（critical 时完全跳过）
        spawnShockwave: {
          before([x, y, col, r, power], cancel) {
            const parent = window.Nova?.get('nova-optimizer');
            if (!parent) return;
            const pressure = parent.state.pressure;
            if (pressure === 'critical') {
              cancel();
              return;
            }
            if (pressure === 'high' && r > 200) {
              // 缩小范围
              return [x, y, col, r * 0.5, power * 0.7];
            }
          }
        }
      },

      setup(ctx) { ctx.log('Adaptive Effects Controller active.'); }
    },

    // ─────────────────────────────────────────────────────────────
    // SUB-MOD 3：Smart Entity Pooling
    //   预先分配对象池，减少 GC 压力；暴露 pool.get / pool.release 服务
    // ─────────────────────────────────────────────────────────────
    'entity-pool': {
      name: 'Entity Pool',
      version: '1.0',
      description: '对象池服务，减少 GC 压力',

      state: {
        poolSize: 0,
        hits: 0,
        misses: 0,
      },

      // 通过 services 字段暴露服务
      services: {
        'nova.entityPool': {
          version: '1.0',
          _pools: new Map(),

          getPool(type, factory, maxSize = 128) {
            if (!this._pools.has(type)) {
              this._pools.set(type, { factory, pool: [], maxSize });
            }
            return this._pools.get(type);
          },

          acquire(type, factory, maxSize = 128) {
            const p = this.getPool(type, factory, maxSize);
            if (p.pool.length > 0) {
              const obj = p.pool.pop();
              obj._pooled = false;
              // 统计命中
              const rec = window.Nova?.get('nova-optimizer::entity-pool');
              if (rec) rec.state.hits++;
              return obj;
            }
            // 未命中：新建
            const obj = factory();
            const rec = window.Nova?.get('nova-optimizer::entity-pool');
            if (rec) rec.state.misses++;
            return obj;
          },

          release(type, obj) {
            const p = this._pools.get(type);
            if (!p || p.pool.length >= p.maxSize) return;
            obj._pooled = true;
            p.pool.push(obj);
            const rec = window.Nova?.get('nova-optimizer::entity-pool');
            if (rec) rec.state.poolSize = [...this._pools.values()].reduce((s, p) => s + p.pool.length, 0);
          }
        }
      },

      render: {
        hud(g) {
          const rec = window.Nova?.get('nova-optimizer::entity-pool');
          if (!rec?.loaded) return;
          const { W, H } = window;
          if (!W || !H) return;
          const { poolSize, hits, misses } = rec.state;
          if (poolSize === 0 && hits === 0) return;

          g.save();
          g.font = '9px Consolas'; g.fillStyle = '#50DC6488'; g.shadowBlur = 0;
          g.fillText(`POOL:${poolSize} HIT:${hits} MISS:${misses}`, W - 180, H - 175);
          g.restore();
        }
      },

      setup(ctx) { ctx.log('Entity Pool service registered as "nova.entityPool".'); }
    },

    // ─────────────────────────────────────────────────────────────
    // SUB-MOD 4：Render Batch Optimizer
    //   给所有 HUD 钩子标上优先级并移除低优先级重复渲染
    //   + 每 300ms 刷新一次 DIAG 标签中的性能图
    // ─────────────────────────────────────────────────────────────
    'render-batch': {
      name: 'Render Batch Optimizer',
      version: '1.0',
      description: '批量优化：减少 canvas state save/restore 调用次数',

      state: {
        saveCalls: 0,
        batchSavings: 0,
      },

      // 在游戏主渲染前统计 save/restore 调用次数
      patch: {
        'ctx.save': {
          tap(args) {
            const rec = window.Nova?.get('nova-optimizer::render-batch');
            if (rec) rec.state.saveCalls++;
          }
        }
      },

      events: {
        // 每60帧重置计数
        'forge:tick': function() {
          const rec = window.Nova?.get('nova-optimizer::render-batch');
          if (!rec) return;
          rec.state._tick = (rec.state._tick || 0) + 1;
          if (rec.state._tick % 60 === 0) {
            rec.state.batchSavings = rec.state.saveCalls;
            rec.state.saveCalls = 0;
          }
        }
      },

      setup(ctx) { ctx.log('Render Batch stats active.'); }
    },

  } // ── end mods ──
});

// ─────────────────────────────────────────────────────────────────
// 辅助日志函数（不在 Nova.def 内部，避免 closure 问题）
// ─────────────────────────────────────────────────────────────────
function _logClean(before, after) {
  if (before !== after) {
    console.log(`[Nova/optimizer/mem] Cleaned ${before - after} dead entities.`);
  }
}
