/* Команда за $20: Dota 2 — аукцион киберспортсменов для двух игроков. */
(function () {
  'use strict';

  /* ================================================================ Конфиг */

  var POSITIONS = {
    1: { short: 'Pos 1', name: 'Керри' },
    2: { short: 'Pos 2', name: 'Мид' },
    3: { short: 'Pos 3', name: 'Оффлейн' },
    4: { short: 'Pos 4', name: 'Роумер / саппорт' },
    5: { short: 'Pos 5', name: 'Фулл-саппорт' }
  };

  // slots: позиция каждого места в составе; 0 — любая позиция. Пул = 2 × мест.
  var FORMATS = [
    { id: 'classic', name: 'Классика 5×5', budget: 20, slots: [1, 2, 3, 4, 5], note: 'Pos 1–5, по одному на позицию' },
    { id: 'lane', name: 'Лёгкая линия 2×2', budget: 10, slots: [1, 5], note: 'Керри + Фулл-саппорт' },
    { id: 'free', name: 'Свободный 5×5', budget: 20, slots: [0, 0, 0, 0, 0], note: 'Любые 5 игроков' }
  ];

  var MODES = [
    { id: 'top', name: 'Топ', tag: '90+', min: 90 },
    { id: 'strong', name: 'Сильные', tag: '80+', min: 80 },
    { id: 'solid', name: 'Крепкие', tag: '70+', min: 70 },
    { id: 'all', name: 'Все', tag: 'любой', min: 0 }
  ];

  var RARITIES = [
    { min: 90, id: 'immortal', name: 'Бессмертный' },
    { min: 85, id: 'legendary', name: 'Легендарный' },
    { min: 80, id: 'mythical', name: 'Мифический' },
    { min: 75, id: 'rare', name: 'Редкий' },
    { min: 70, id: 'uncommon', name: 'Необычный' },
    { min: -1, id: 'common', name: 'Обычный' }
  ];

  // Какие игроки участвуют: tag есть у легенд и стримеров (tools/legends.json).
  var POOLS = [
    { id: 'current', name: 'Действующие', note: 'Составы топ-20 команд сейчас', test: function (p) { return !p.tag; } },
    { id: 'legends', name: 'Легенды и стримеры', note: 'Бывшие звёзды тир-1 в прайме', test: function (p) { return !!p.tag; } },
    { id: 'all', name: 'Все вместе', note: 'Действующие + легенды', test: function () { return true; } }
  ];

  var SIDES = [
    { name: 'Radiant', side: 'Силы Света', cls: 'radiant', short: 'Rad' },
    { name: 'Dire', side: 'Силы Тьмы', cls: 'dire', short: 'Dire' }
  ];

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ================================================== Engine (без DOM) */

  var Engine = (function () {
    function shuffle(arr, rng) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(rng() * (i + 1));
        var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    // Сколько мест каждой позиции в формате: {1: 1, 5: 1} или {0: 5}.
    function needs(fmt) {
      var n = {};
      fmt.slots.forEach(function (p) { n[p] = (n[p] || 0) + 1; });
      return n;
    }

    function eligible(db, mode) {
      return db.filter(function (p) { return p.rating >= mode.min; });
    }

    // Хватает ли игроков на пул в сочетании формат + режим.
    function check(db, fmt, mode) {
      var el = eligible(db, mode), n = needs(fmt), lacks = [];
      Object.keys(n).forEach(function (k) {
        var pos = +k, want = n[k] * 2;
        var have = pos === 0 ? el.length : el.filter(function (p) { return p.role === pos; }).length;
        if (have < want) lacks.push((pos === 0 ? 'игроков' : POSITIONS[pos].short) + ': ' + have + ' из ' + want);
      });
      return { ok: lacks.length === 0, count: el.length, reason: lacks.length ? 'Не хватает — ' + lacks.join(', ') : '' };
    }

    function Game(db, formatId, modeId, rng) {
      this.rng = rng || Math.random;
      this.fmt = byId(FORMATS, formatId);
      this.mode = byId(MODES, modeId);
      if (!this.fmt || !this.mode) throw new Error('Неизвестный формат или режим');
      var c = check(db, this.fmt, this.mode);
      if (!c.ok) throw new Error(c.reason);
      this.elig = eligible(db, this.mode);

      var n = needs(this.fmt), pool = [], self = this;
      Object.keys(n).forEach(function (k) {
        var pos = +k;
        var src = pos === 0 ? self.elig.slice() : self.elig.filter(function (p) { return p.role === pos; });
        pool = pool.concat(shuffle(src, self.rng).slice(0, n[k] * 2));
      });
      this.pool = shuffle(pool, this.rng);
      this.used = {};
      this.pool.forEach(function (p) { self.used[p.id] = true; });
      this.poolSize = this.pool.length;

      this.players = [0, 1].map(function () {
        return {
          money: self.fmt.budget,
          slots: self.fmt.slots.map(function (pos) { return { pos: pos, player: null, price: 0 }; })
        };
      });
      this.lot = 0;
      this.opener = this.rng() < 0.5 ? 0 : 1;
      this.lotSerial = 0;   // растёт при каждой смене игрока на лоте
      this._start();
    }

    Game.prototype = {
      get current() { return this.pool[this.lot] || null; },

      freeSlots: function (i) {
        return this.players[i].slots.filter(function (s) { return !s.player; }).length;
      },
      // Резерв $1 на каждое свободное место, кроме того, за которое торгуемся.
      maxBid: function (i) {
        var free = this.freeSlots(i);
        return free ? this.players[i].money - (free - 1) : 0;
      },
      slotFor: function (i, pl) {
        var sl = this.players[i].slots;
        for (var k = 0; k < sl.length; k++) {
          if (!sl[k].player && (sl[k].pos === 0 || sl[k].pos === pl.role)) return k;
        }
        return -1;
      },
      canTake: function (i, pl) { return this.slotFor(i, pl || this.current) >= 0; },

      replacements: function (pl) {
        var self = this;
        pl = pl || this.current;
        return this.elig.filter(function (p) { return p.role === pl.role && !self.used[p.id]; });
      },
      canSkip: function () {
        return this.phase === 'open' && this.replacements().length > 0;
      },

      _start: function () {
        this.bid = 0;
        this.leader = null;
        this.history = [];
        this.result = null;
        this.skipper = null;
        if (this.lot >= this.pool.length) {
          this.phase = 'over';
          this.turn = null;
          return;
        }
        var pl = this.current, a = this.canTake(0, pl), b = this.canTake(1, pl);
        if (!a && !b) throw new Error('Лот никому не подходит: ' + pl.nickname);
        if (!a || !b) {
          var to = a ? 0 : 1;
          this._assign(to, pl, 1);
          this.result = { type: 'auto', player: pl, to: to, price: 1 };
          this.phase = 'result';
          this.turn = to;
          return;
        }
        this.phase = 'open';
        this.turn = this.opener;
      },

      _assign: function (i, pl, price) {
        var k = this.slotFor(i, pl);
        if (k < 0) throw new Error('Нет места для ' + pl.nickname);
        if (price < 1 || price > this.maxBid(i)) throw new Error('Недопустимая цена ' + price);
        this.players[i].slots[k].player = pl;
        this.players[i].slots[k].price = price;
        this.players[i].money -= price;
      },

      _sell: function (to, price, how) {
        this._assign(to, this.current, price);
        this.result = { type: how, player: this.current, to: to, price: price };
        this.phase = 'result';
        this.turn = to;
      },

      minBid: function () { return this.phase === 'bid' ? this.bid + 1 : 1; },

      placeBid: function (amount) {
        amount = Math.floor(amount);
        if (this.phase !== 'open' && this.phase !== 'bid') throw new Error('Сейчас нельзя ставить');
        var who = this.turn;
        if (!(amount >= this.minBid() && amount <= this.maxBid(who))) throw new Error('Ставка вне диапазона');
        this.bid = amount;
        this.leader = who;
        this.history.push({ who: who, amount: amount });
        var other = 1 - who;
        if (this.maxBid(other) <= amount) {
          this._sell(who, amount, 'nomoney');   // сопернику нечем перебить
        } else {
          this.phase = 'bid';
          this.turn = other;
        }
      },

      pass: function () {
        if (this.phase !== 'bid') throw new Error('Пас возможен только после ставки');
        this.history.push({ who: this.turn, pass: true });
        this._sell(this.leader, this.bid, 'sold');
      },

      skip: function () {
        if (!this.canSkip()) throw new Error('Скип недоступен');
        this.skipper = this.turn;
        this.phase = 'skip';
        this.turn = 1 - this.turn;
      },

      takeSkipped: function () {
        if (this.phase !== 'skip') throw new Error('Нечего забирать');
        this._sell(this.turn, 1, 'take');
      },

      skipToo: function () {
        if (this.phase !== 'skip') throw new Error('Скип недоступен');
        var removed = this.current, cand = this.replacements(removed);
        if (!cand.length) throw new Error('Некем заменить');
        var rep = cand[Math.floor(this.rng() * cand.length)];
        this.pool.splice(this.lot, 1);
        var at = this.lot + Math.floor(this.rng() * (this.pool.length - this.lot + 1));
        this.pool.splice(at, 0, rep);
        this.used[rep.id] = true;
        this.result = { type: 'double', player: removed, replacement: rep, to: null, price: 0 };
        this.phase = 'result';
        this.turn = null;
      },

      next: function () {
        if (this.phase !== 'result') throw new Error('Лот ещё не разыгран');
        if (this.result.type !== 'double') this.lot++;
        this.opener = 1 - this.opener;
        this.lotSerial++;
        this._start();
      },

      totals: function () {
        return this.players.map(function (p) {
          var rating = 0, spent = 0;
          p.slots.forEach(function (s) { if (s.player) { rating += s.player.rating; spent += s.price; } });
          return { rating: rating, spent: spent, money: p.money };
        });
      },

      winner: function () {
        var t = this.totals();
        if (t[0].rating !== t[1].rating) return t[0].rating > t[1].rating ? 0 : 1;
        if (t[0].money !== t[1].money) return t[0].money > t[1].money ? 0 : 1;
        return null;
      }
    };

    // Прогон случайных партий с проверкой инвариантов (для автотестов в браузере).
    function simulate(db, games, opts) {
      opts = opts || {};
      var errors = [], stats = { games: 0, lots: 0, skips: 0, doubleSkips: 0, takes: 0, autos: 0, nomoney: 0 };
      function fail(msg) { errors.push(msg); }
      FORMATS.forEach(function (fmt) {
        MODES.forEach(function (mode) {
          if (!check(db, fmt, mode).ok) return;
          for (var g = 0; g < games; g++) {
            var G = new Game(db, fmt.id, mode.id), guard = 0, tag = fmt.id + '/' + mode.id + '#' + g;
            stats.games++;
            while (G.phase !== 'over' && guard++ < 1000) {
              if (G.pool.length !== G.poolSize) fail(tag + ': размер пула изменился');
              var ids = G.pool.map(function (p) { return p.id; });
              if (new Set(ids).size !== ids.length) fail(tag + ': повтор в пуле');
              G.pool.forEach(function (p) { if (p.rating < mode.min) fail(tag + ': ниже порога ' + p.nickname); });
              [0, 1].forEach(function (i) {
                if (G.players[i].money < 0) fail(tag + ': бюджет < 0');
                if (G.players[i].money < G.freeSlots(i)) fail(tag + ': нет резерва $1 на место');
              });
              var r = G.rng();
              if (G.phase === 'open') {
                if (G.canSkip() && r < 0.35) { G.skip(); stats.skips++; }
                else G.placeBid(1 + Math.floor(G.rng() * Math.min(G.maxBid(G.turn), 6)));
              } else if (G.phase === 'bid') {
                var mx = G.maxBid(G.turn);
                if (r < 0.5 || mx <= G.bid) G.pass();
                else G.placeBid(G.bid + 1 + Math.floor(G.rng() * Math.min(mx - G.bid, 3)));
              } else if (G.phase === 'skip') {
                if (r < 0.5) { G.takeSkipped(); stats.takes++; } else { G.skipToo(); stats.doubleSkips++; }
              } else if (G.phase === 'result') {
                stats.lots++;
                if (G.result.type === 'auto') stats.autos++;
                if (G.result.type === 'nomoney') stats.nomoney++;
                if (G.result.type === 'double' && G.result.replacement.role !== G.result.player.role) fail(tag + ': замена другой позиции');
                G.next();
              }
            }
            if (G.phase !== 'over') { fail(tag + ': партия не завершилась'); continue; }
            var seen = {};
            G.players.forEach(function (p, i) {
              if (p.money < 0) fail(tag + ': итоговый бюджет < 0');
              p.slots.forEach(function (s) {
                if (!s.player) fail(tag + ': пустое место у игрока ' + (i + 1));
                else {
                  if (s.pos && s.player.role !== s.pos) fail(tag + ': не та позиция');
                  if (seen[s.player.id]) fail(tag + ': игрок куплен дважды');
                  seen[s.player.id] = true;
                  if (s.player.rating < mode.min) fail(tag + ': куплен игрок ниже порога');
                }
              });
              var spent = p.slots.reduce(function (a, s) { return a + s.price; }, 0);
              if (spent + p.money !== fmt.budget) fail(tag + ': деньги не сходятся');
            });
            if (Object.keys(G.used).length > G.elig.length) fail(tag + ': used больше базы');
          }
        });
      });
      return { ok: errors.length === 0, errors: errors.slice(0, 20), errorCount: errors.length, stats: stats };
    }

    return {
      FORMATS: FORMATS, MODES: MODES, POSITIONS: POSITIONS,
      check: check, eligible: eligible, create: function (db, f, m, rng) { return new Game(db, f, m, rng); },
      simulate: simulate
    };
  })();

  window.Engine = Engine;

  /* ============================================================ Утилиты */

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function $(id) { return document.getElementById(id); }

  var store = {
    get: function (k) { try { return localStorage.getItem('t20d.' + k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem('t20d.' + k, v); } catch (e) { /* приватный режим */ } }
  };

  function rarity(r) {
    for (var i = 0; i < RARITIES.length; i++) if (r >= RARITIES[i].min) return RARITIES[i];
    return RARITIES[RARITIES.length - 1];
  }
  function posLabel(pos) { return POSITIONS[pos].short + ' · ' + POSITIONS[pos].name; }
  function money(n) { return '$' + n; }
  function plural(n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  var VERSION = (function () {
    var s = document.currentScript && document.currentScript.src;
    var m = s && s.match(/[?&]v=([^&]+)/);
    return m ? m[1] : '1';
  })();

  /* ================================================================= UI */

  var db = [], dbMeta = {}, game = null, preloaded = [];
  var ui = { pool: 'all', format: 'classic', mode: 'strong', amount: 1, cardSerial: -1, amountKey: '' };

  function poolDb() {
    var pool = byId(POOLS, ui.pool) || POOLS[0];
    return db.filter(pool.test);
  }

  function show(screen) {
    ['menu', 'game', 'final'].forEach(function (id) { $(id).hidden = id !== screen; });
    $('exitBtn').hidden = screen === 'menu';
    document.body.setAttribute('data-screen', screen);
    window.scrollTo(0, 0);
  }

  /* ---------- Тема */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    $('themeBtn').setAttribute('aria-label', t === 'dark' ? 'Светлая тема' : 'Тёмная тема');
    $('themeBtn').title = t === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  }
  $('themeBtn').addEventListener('click', function () {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    store.set('theme', t);
    applyTheme(t);
  });
  applyTheme(document.documentElement.getAttribute('data-theme') || 'dark');

  /* ---------- Меню */
  function renderMenu() {
    var fmt = byId(FORMATS, ui.format);
    $('poolList').innerHTML = POOLS.map(function (pl) {
      var sel = pl.id === ui.pool, n = db.filter(pl.test).length;
      return '<button type="button" class="choice' + (sel ? ' selected' : '') + '" data-pool="' + pl.id + '" aria-pressed="' + sel + '">' +
        '<span class="choice-name">' + esc(pl.name) + '</span>' +
        '<span class="choice-sub">' + esc(pl.note) + '</span>' +
        '<span class="choice-meta">' + n + ' ' + plural(n, 'игрок', 'игрока', 'игроков') + '</span>' +
        '</button>';
    }).join('');
    $('formatList').innerHTML = FORMATS.map(function (f) {
      var sel = f.id === ui.format;
      return '<button type="button" class="choice' + (sel ? ' selected' : '') + '" data-format="' + f.id + '" aria-pressed="' + sel + '">' +
        '<span class="choice-name">' + esc(f.name) + '</span>' +
        '<span class="choice-sub">' + esc(f.note) + '</span>' +
        '<span class="choice-meta"><b class="gold">' + money(f.budget) + '</b> бюджет · пул ' + f.slots.length * 2 + '</span>' +
        '</button>';
    }).join('');

    var hint = '';
    $('modeList').innerHTML = MODES.map(function (m) {
      var c = Engine.check(poolDb(), fmt, m), sel = m.id === ui.mode;
      if (sel && !c.ok) hint = c.reason;
      return '<button type="button" class="choice mode' + (sel ? ' selected' : '') + '" data-mode="' + m.id + '"' +
        (c.ok ? '' : ' disabled title="' + esc(c.reason) + '"') + ' aria-pressed="' + sel + '">' +
        '<span class="choice-name">' + esc(m.name) + ' <em>(' + esc(m.tag) + ')</em></span>' +
        '<span class="choice-meta">' + c.count + ' ' + plural(c.count, 'игрок', 'игрока', 'игроков') + '</span>' +
        (c.ok ? '' : '<span class="choice-warn">' + esc(c.reason) + '</span>') +
        '</button>';
    }).join('');
    $('modeHint').textContent = hint;
    $('playBtn').disabled = !Engine.check(poolDb(), fmt, byId(MODES, ui.mode)).ok;
  }

  // Если выбранный режим недоступен в формате — берём первый доступный.
  function fixMode() {
    var fmt = byId(FORMATS, ui.format);
    if (!byId(MODES, ui.mode) || !Engine.check(poolDb(), fmt, byId(MODES, ui.mode)).ok) {
      var ok = MODES.filter(function (m) { return Engine.check(poolDb(), fmt, m).ok; });
      if (ok.length) ui.mode = ok[0].id;
    }
  }

  $('formatList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-format]');
    if (!b) return;
    ui.format = b.getAttribute('data-format');
    store.set('format', ui.format);
    fixMode();
    renderMenu();
  });
  $('poolList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pool]');
    if (!b) return;
    ui.pool = b.getAttribute('data-pool');
    store.set('pool', ui.pool);
    fixMode();
    renderMenu();
  });
  $('modeList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mode]');
    if (!b || b.disabled) return;
    ui.mode = b.getAttribute('data-mode');
    store.set('mode', ui.mode);
    renderMenu();
  });

  /* ---------- Старт */
  function preload(players) {
    players.forEach(function (p) {
      if (!p || !p.photo) return;
      var im = new Image();
      im.src = p.photo;
      preloaded.push(im);
    });
  }

  function startGame() {
    game = Engine.create(poolDb(), ui.format, ui.mode);
    preloaded = [];
    preload(game.pool);
    ui.cardSerial = -1;
    ui.amountKey = '';
    show('game');
    render();
  }
  $('playBtn').addEventListener('click', startGame);
  $('againBtn').addEventListener('click', startGame);
  $('menuBtn').addEventListener('click', function () { game = null; renderMenu(); show('menu'); });

  /* ---------- Выход */
  function openExit() {
    if (!game || game.phase === 'over') { game = null; renderMenu(); show('menu'); return; }
    $('exitModal').hidden = false;
    $('stayBtn').focus();
  }
  function closeExit() { $('exitModal').hidden = true; }
  $('exitBtn').addEventListener('click', openExit);
  $('brand').addEventListener('click', function (e) { e.preventDefault(); if (!$('menu').hidden) return; openExit(); });
  $('stayBtn').addEventListener('click', closeExit);
  $('leaveBtn').addEventListener('click', function () { closeExit(); game = null; renderMenu(); show('menu'); });
  $('exitModal').addEventListener('click', function (e) { if (e.target === this) closeExit(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('exitModal').hidden) closeExit(); });

  /* ---------- Карточка */
  // Стилизованный аватар для игроков без свободного фото: силуэт героя в цвете редкости
  // и знак позиции на груди. Вариант силуэта зависит от id, чтобы карточки различались.
  var GLYPHS = {
    1: 'M12 1.5 14.2 4v11h-4.4V4zM6.5 15h11v2.2h-11zM10.9 17.2h2.2V22h-2.2z',
    2: 'M13.5 1.5 5 13.2h6L9.8 22.5 19 10h-6z',
    3: 'M12 1.8 20 5v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z',
    4: 'M3.5 20.5C5.5 10.5 11.5 4 20.5 3c-1 8.6-7.4 15-17 17.5zM6 18l9-9',
    5: 'M9.8 3h4.4v6.8H21v4.4h-6.8V21H9.8v-6.8H3V9.8h6.8z'
  };
  var HEADS = [
    // капюшон
    'M100 10C86 26 59 38 59 68c0 12 3 22 8 30h66c5-8 8-18 8-30 0-30-27-42-41-58z',
    // шлем с рогами
    'M72 34 52 8l10 38c-2 6-3 12-3 18 0 14 5 26 13 34h56c8-8 13-20 13-34 0-6-1-12-3-18l10-38-20 26c-8-8-17-12-28-12s-20 4-28 12z',
    // растрёпанные волосы
    'M64 44l-12-8 14-2-6-14 16 8 4-16 10 14 10-14 4 16 16-8-6 14 14 2-12 8c4 7 6 15 6 24 0 12-4 22-10 30H68c-6-8-10-18-10-30 0-9 2-17 6-24z'
  ];
  var avatarSeq = 0;
  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  function avatarSvg(p) {
    var id = 'av' + (++avatarSeq), h = hash(p.id), head = HEADS[h % HEADS.length];
    var rot = (h >> 3) % 30;
    return '<svg class="avatar" viewBox="0 0 200 170" preserveAspectRatio="xMidYMax slice" role="img" aria-label="' + esc(p.nickname) + '">' +
      '<defs>' +
        '<radialGradient id="' + id + 'b" cx="50%" cy="42%" r="65%"><stop offset="0" stop-color="currentColor" stop-opacity=".38"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></radialGradient>' +
        '<linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2d33"/><stop offset="1" stop-color="#0c0d10"/></linearGradient>' +
      '</defs>' +
      '<rect width="200" height="170" fill="url(#' + id + 'b)"/>' +
      '<g transform="rotate(' + rot + ' 100 80)" fill="none" stroke="currentColor" stroke-opacity=".22">' +
        '<path d="M100 8 172 80 100 152 28 80z"/><path d="M100 26 154 80 100 134 46 80z"/>' +
      '</g>' +
      '<g class="avatar-bust" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="url(#' + id + 's)">' +
        '<path d="M84 88h32v24H84z"/>' +
        '<path d="M26 172c2-34 22-58 52-66h44c30 8 50 32 52 66z"/>' +
        '<path d="' + head + '"/>' +
        '<g id="' + id + 'p"><path d="M30 156c-4-26 10-46 40-50l10 18c-22 2-38 14-50 32z"/><path d="M46 114 28 94l28 12z"/></g>' +
        '<use href="#' + id + 'p" transform="translate(200 0) scale(-1 1)"/>' +
      '</g>' +
      '<path d="M78 70h16M106 70h16" stroke="currentColor" stroke-width="4" stroke-linecap="round" opacity=".9"/>' +
      '<circle cx="100" cy="136" r="17" fill="#0c0d10" stroke="currentColor" stroke-width="2"/>' +
      '<g transform="translate(88 124)"><path d="' + GLYPHS[p.role] + '" fill="currentColor" stroke="currentColor" stroke-width="' + (p.role === 4 ? 1.6 : 0) + '" stroke-linecap="round"/></g>' +
    '</svg>';
  }

  function photoHtml(p, cls) {
    if (p.photo) {
      return '<div class="' + cls + '"><img src="' + esc(p.photo) + '" alt="' + esc(p.nickname) + '" decoding="async"></div>';
    }
    return '<div class="' + cls + ' no-photo">' + avatarSvg(p) + '</div>';
  }

  function cardHtml(p) {
    var r = rarity(p.rating);
    return '<article class="card rarity-' + r.id + '">' +
      '<div class="card-rays" aria-hidden="true"></div>' +
      '<div class="card-inner">' +
        '<div class="card-top"><span class="card-pos">' + esc(posLabel(p.role)) + '</span>' +
          '<span class="card-rating" title="Рейтинг">' + p.rating + '</span></div>' +
        photoHtml(p, 'card-photo') +
        '<h3 class="card-nick">' + esc(p.nickname) + '</h3>' +
        '<p class="card-name">' + esc(p.name || '—') +
          (p.tag ? ' <span class="card-tag">' + esc(p.tag) + '</span>' : '') + '</p>' +
        '<dl class="card-meta">' +
          '<div><dt>Команда</dt><dd>' + esc(p.team) + '</dd></div>' +
          '<div><dt>Страна</dt><dd>' + esc(p.country) + '</dd></div>' +
        '</dl>' +
        '<p class="card-rarity">' + esc(r.name) + '</p>' +
      '</div>' +
    '</article>';
  }

  /* ---------- Панели */
  function panelHtml(i) {
    var P = game.players[i], S = SIDES[i], t = game.totals()[i], free = game.freeSlots(i);
    var slots = P.slots.map(function (s) {
      var label = s.pos ? POSITIONS[s.pos].short : 'Слот';
      var sub = s.pos ? POSITIONS[s.pos].name : (s.player ? POSITIONS[s.player.role].short : 'любая позиция');
      if (!s.player) {
        return '<li class="slot empty"><span class="slot-pos">' + esc(label) + '</span>' +
          '<span class="slot-body"><span class="slot-nick">—</span><span class="slot-sub">' + esc(sub) + '</span></span></li>';
      }
      var r = rarity(s.player.rating);
      return '<li class="slot rarity-' + r.id + '"><span class="slot-pos">' + esc(label) + '</span>' +
        '<span class="slot-body"><span class="slot-nick">' + esc(s.player.nickname) + '</span>' +
        '<span class="slot-sub">' + esc(s.pos ? s.player.team : sub + ' · ' + s.player.team) + '</span></span>' +
        '<span class="slot-rt">' + s.player.rating + '</span><span class="slot-price">' + money(s.price) + '</span></li>';
    }).join('');
    return '<header class="panel-head"><span class="panel-side">' + esc(S.side) + '</span>' +
      '<h2 class="panel-name">' + esc(S.name) + '</h2></header>' +
      '<div class="stats">' +
        '<div class="stat"><span class="stat-l">Бюджет</span><b class="stat-v gold">' + money(P.money) + '</b></div>' +
        '<div class="stat"><span class="stat-l">Макс. ставка</span><b class="stat-v">' + (free ? money(game.maxBid(i)) : '—') + '</b></div>' +
        '<div class="stat"><span class="stat-l">Рейтинг</span><b class="stat-v">' + t.rating + '</b></div>' +
      '</div>' +
      '<ul class="slots">' + slots + '</ul>';
  }

  /* ---------- Пульт */
  function who(i) { return '<b class="who ' + SIDES[i].cls + '">' + esc(SIDES[i].name) + '</b>'; }

  function stepperHtml(min, max, label) {
    var a = ui.amount;
    return '<div class="bidbox">' +
      '<div class="stepper">' +
        '<button type="button" class="btn btn-step" data-act="dec" aria-label="Меньше"' + (a <= min ? ' disabled' : '') + '>−</button>' +
        '<output class="amount gold" id="amount">' + money(a) + '</output>' +
        '<button type="button" class="btn btn-step" data-act="inc" aria-label="Больше"' + (a >= max ? ' disabled' : '') + '>+</button>' +
        '<button type="button" class="btn btn-mini" data-act="max"' + (a >= max ? ' disabled' : '') + '>Макс ' + money(max) + '</button>' +
      '</div>' +
      '<button type="button" class="btn btn-primary" data-act="bid">' + label + ' ' + money(a) + '</button>' +
    '</div>';
  }

  function renderControls() {
    var g = game, st = $('status'), c = $('controls'), log = $('bidlog');
    var key = g.lotSerial + ':' + g.phase + ':' + g.turn + ':' + g.bid;
    if (ui.amountKey !== key && (g.phase === 'open' || g.phase === 'bid')) {
      ui.amountKey = key;
      ui.amount = g.minBid();
    }
    log.innerHTML = g.history.map(function (h) {
      return '<span class="' + SIDES[h.who].cls + '">' + SIDES[h.who].short + ' ' + (h.pass ? 'пас' : money(h.amount)) + '</span>';
    }).join('<i>›</i>');

    var o = 1 - (g.turn == null ? 0 : g.turn);
    if (g.phase === 'open') {
      var max = g.maxBid(g.turn), can = g.canSkip();
      st.innerHTML = 'Торги открывает ' + who(g.turn) + '. Ставка от $1 или скип.';
      c.innerHTML = stepperHtml(1, max, 'Ставка') +
        '<button type="button" class="btn btn-ghost btn-skip" data-act="skip"' + (can ? '' : ' disabled') +
        ' title="' + (can ? 'Отказаться от игрока — сопернику решать' : 'Скип недоступен: в базе нет замены этой позиции') + '">Скип</button>' +
        (can ? '' : '<p class="note">Скип недоступен: заменить этого игрока некем.</p>');
    } else if (g.phase === 'bid') {
      st.innerHTML = 'Ставка ' + who(g.leader) + ': <b class="gold">' + money(g.bid) + '</b>. ' + who(g.turn) + ' — поднять или пас?';
      c.innerHTML = stepperHtml(g.bid + 1, g.maxBid(g.turn), 'Поднять до') +
        '<button type="button" class="btn btn-ghost" data-act="pass">Пас</button>';
    } else if (g.phase === 'skip') {
      st.innerHTML = who(g.skipper) + ' скипнул. ' + who(g.turn) + ': забрать за $1 или тоже скип?';
      c.innerHTML = '<div class="btn-row">' +
        '<button type="button" class="btn btn-primary" data-act="take">Забрать за $1</button>' +
        '<button type="button" class="btn btn-ghost" data-act="skip2">Тоже скип</button></div>';
    } else if (g.phase === 'result') {
      var r = g.result, p = r.player, last = g.lot === g.pool.length - 1 && r.type !== 'double';
      var nextBtn = '<div class="btn-row"><button type="button" class="btn btn-primary" data-act="next">' +
        (last ? 'К итогам' : 'Следующий лот') + '</button></div>';
      if (r.type === 'double') {
        st.innerHTML = '<span class="tag tag-skip">Двойной скип</span> ' + esc(p.nickname) +
          ' уходит из пула. Вместо него в оставшиеся лоты тайно добавлен другой игрок той же позиции.';
      } else if (r.type === 'auto') {
        st.innerHTML = '<span class="tag tag-auto">Автолот</span> У ' + who(1 - r.to) +
          ' позиция уже закрыта — ' + esc(p.nickname) + ' уходит к ' + who(r.to) + ' за <b class="gold">$1</b>.';
      } else {
        var why = r.type === 'take' ? ' (забрал после скипа)' : r.type === 'nomoney' ? ' — сопернику нечем перебить' : '';
        st.innerHTML = '<span class="tag tag-sold">Продано</span> ' + esc(p.nickname) + ' → ' + who(r.to) +
          ' за <b class="gold">' + money(r.price) + '</b>' + why + '.';
      }
      c.innerHTML = nextBtn;
    }
  }

  function render() {
    var g = game;
    if (g.phase === 'over') { renderFinal(); return; }
    // Карточка перерисовывается только при смене игрока на лоте.
    if (ui.cardSerial !== g.lotSerial) {
      ui.cardSerial = g.lotSerial;
      $('cardWrap').innerHTML = cardHtml(g.current);
    }
    var wrap = $('cardWrap');
    wrap.classList.toggle('is-sold', g.phase === 'result' && g.result.type !== 'double');
    wrap.classList.toggle('is-gone', g.phase === 'result' && g.result.type === 'double');
    var stamp = wrap.querySelector('.stamp');
    if (g.phase === 'result') {
      if (!stamp) {
        stamp = document.createElement('div');
        wrap.appendChild(stamp);
      }
      var r = g.result;
      stamp.className = 'stamp ' + (r.type === 'double' ? 'stamp-skip' : SIDES[r.to].cls);
      stamp.textContent = r.type === 'double' ? 'Скип' : r.type === 'auto' ? 'Автолот' : 'Продано';
    } else if (stamp) {
      stamp.remove();
    }

    $('lotNo').textContent = 'Лот ' + (g.lot + 1) + ' из ' + g.pool.length;
    $('lotFmt').textContent = g.fmt.name + ' · ' + g.mode.name + ' (' + g.mode.tag + ')';
    [0, 1].forEach(function (i) {
      var el = $('panel' + i);
      el.innerHTML = panelHtml(i);
      el.classList.toggle('active', (g.phase === 'open' || g.phase === 'bid' || g.phase === 'skip') && g.turn === i);
      el.classList.toggle('got', g.phase === 'result' && g.result.to === i);
    });
    renderControls();
  }

  $('controls').addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]');
    if (!b || b.disabled || !game) return;
    var g = game, act = b.getAttribute('data-act'), max = g.phase === 'open' || g.phase === 'bid' ? g.maxBid(g.turn) : 0;
    switch (act) {
      case 'dec': ui.amount = Math.max(g.minBid(), ui.amount - 1); break;
      case 'inc': ui.amount = Math.min(max, ui.amount + 1); break;
      case 'max': ui.amount = max; break;
      case 'bid': g.placeBid(ui.amount); break;
      case 'pass': g.pass(); break;
      case 'skip': g.skip(); break;
      case 'take': g.takeSkipped(); break;
      case 'skip2':
        g.skipToo();
        preload([g.result.replacement]);
        break;
      case 'next': g.next(); break;
    }
    render();
    var focus = $('controls').querySelector('[data-act="' + (act === 'dec' || act === 'inc' || act === 'max' ? act : 'next') + '"]:not([disabled])') ||
      $('controls').querySelector('.btn-primary');
    if (focus && e.detail === 0) focus.focus();
  });

  /* ---------- Финал */
  function renderFinal() {
    var g = game, t = g.totals(), w = g.winner();
    $('winner').innerHTML = w == null ? 'Ничья' : 'Победа <span class="' + SIDES[w].cls + '">' + esc(SIDES[w].name) + '</span>';
    var note;
    if (w == null) note = 'Рейтинг ' + t[0].rating + ' : ' + t[1].rating + ', денег осталось поровну.';
    else if (t[0].rating === t[1].rating) note = 'Рейтинг равный (' + t[0].rating + '), решили оставшиеся деньги: ' + money(t[w].money) + ' против ' + money(t[1 - w].money) + '.';
    else note = 'Суммарный рейтинг ' + t[w].rating + ' против ' + t[1 - w].rating + '.';
    $('winnerNote').textContent = note;
    $('finalGrid').innerHTML = [0, 1].map(function (i) {
      var cards = g.players[i].slots.map(function (s) {
        var p = s.player, r = rarity(p.rating);
        return '<div class="mini rarity-' + r.id + '">' + photoHtml(p, 'mini-photo') +
          '<div class="mini-body"><span class="mini-pos">' + esc(POSITIONS[p.role].short) + '</span>' +
          '<b class="mini-nick">' + esc(p.nickname) + '</b><span class="mini-team">' + esc(p.team) + '</span></div>' +
          '<div class="mini-nums"><b class="mini-rt">' + p.rating + '</b><span class="mini-price gold">' + money(s.price) + '</span></div></div>';
      }).join('');
      return '<section class="final-col ' + SIDES[i].cls + (w === i ? ' winner' : '') + '">' +
        '<header class="panel-head"><span class="panel-side">' + esc(SIDES[i].side) + '</span><h2 class="panel-name">' + esc(SIDES[i].name) +
        (w === i ? ' <span class="crown">★</span>' : '') + '</h2></header>' +
        '<div class="stats">' +
          '<div class="stat"><span class="stat-l">Рейтинг</span><b class="stat-v">' + t[i].rating + '</b></div>' +
          '<div class="stat"><span class="stat-l">Потрачено</span><b class="stat-v">' + money(t[i].spent) + '</b></div>' +
          '<div class="stat"><span class="stat-l">Осталось</span><b class="stat-v gold">' + money(t[i].money) + '</b></div>' +
        '</div><div class="minis">' + cards + '</div></section>';
    }).join('');
    show('final');
  }

  /* ---------- Загрузка */
  fetch('data/players.json?v=' + encodeURIComponent(VERSION))
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (data) {
      db = (data.players || []).filter(function (p) { return p && p.id && POSITIONS[p.role]; });
      dbMeta = data;
      var f = store.get('format'), m = store.get('mode'), pl = store.get('pool');
      if (byId(POOLS, pl)) ui.pool = pl;
      if (byId(FORMATS, f)) ui.format = f;
      if (byId(MODES, m)) ui.mode = m;
      fixMode();
      $('loading').hidden = true;
      $('dbNote').innerHTML = 'База: ' + db.length + ' ' + plural(db.length, 'игрок', 'игрока', 'игроков') +
        ' · составы с <a href="https://liquipedia.net/dota2/Portal:Rankings" target="_blank" rel="noopener">Liquipedia</a>' +
        (dbMeta.updated ? ' на ' + esc(dbMeta.updated) : '') +
        ' · <a href="img/players/CREDITS.md" target="_blank" rel="noopener">фото</a>';
      renderMenu();
      show('menu');
    })
    .catch(function (err) {
      $('loading').textContent = 'Не удалось загрузить базу игроков (' + err.message + ').';
    });
})();
