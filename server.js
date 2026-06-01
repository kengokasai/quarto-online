/**
 * Quarto Online Server
 * Express + Socket.io — authoritative game logic on server
 */
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// HTML は毎回必ずサーバーから取得させる（キャッシュ無効）
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname)));

// ── Room storage ─────────────────────────────────────────────
const rooms = new Map(); // code → Room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.random() * chars.length | 0]).join('');
  } while (rooms.has(code));
  return code;
}

function newRoom(code, socketId, name) {
  return {
    code,
    players  : [socketId, null],  // socket IDs [p0, p1]
    names    : [name, ''],
    specs    : new Set(),
    game     : null,
    cleanupTimer: null,
  };
}

// ── Game logic (mirrors client) ───────────────────────────────

const LINES = (() => {
  const L = [];
  for (let r = 0; r < 4; r++) L.push([[r,0],[r,1],[r,2],[r,3]]);
  for (let c = 0; c < 4; c++) L.push([[0,c],[1,c],[2,c],[3,c]]);
  L.push([[0,0],[1,1],[2,2],[3,3]], [[0,3],[1,2],[2,1],[3,0]]);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      L.push([[r,c],[r,c+1],[r+1,c],[r+1,c+1]]);
  return L;
})();

function winLines(board) {
  return LINES.filter(ln => {
    const ps = ln.map(([r,c]) => board[r][c]);
    if (ps.some(p => p === null)) return false;
    for (let b = 0; b < 4; b++) {
      const v = (ps[0] >> b) & 1;
      if (ps.every(p => ((p >> b) & 1) === v)) return true;
    }
    return false;
  });
}

function wouldWin(board, r, c, p) {
  board[r][c] = p;
  const ok = winLines(board).length > 0;
  board[r][c] = null;
  return ok;
}

function canWinWith(board, piece) {
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++)
      if (board[r][c] === null && wouldWin(board, r, c, piece)) return true;
  return false;
}

function boardThreatCount(board) {
  let n = 0;
  for (const ln of LINES) {
    const ps = ln.map(([r,c]) => board[r][c]).filter(p => p !== null);
    if (ps.length !== 3) continue;
    for (let b = 0; b < 4; b++) {
      const v = (ps[0] >> b) & 1;
      if (ps.every(p => ((p >> b) & 1) === v)) { n++; break; }
    }
  }
  return n;
}

function pieceGiveDanger(board, piece) {
  let n = 0;
  for (const ln of LINES) {
    const filled = ln.map(([r,c]) => board[r][c]).filter(p => p !== null);
    if (filled.length === 3) {
      for (let b = 0; b < 4; b++) {
        const v = (piece >> b) & 1;
        if (filled.every(p => ((p >> b) & 1) === v)) { n++; break; }
      }
    }
  }
  return n;
}

function calcGiveScore(piece, board, avail) {
  const allBad = avail.every(p => canWinWith(board, p));
  if (canWinWith(board, piece)) return allBad ? 3 : 0;
  const safe = avail.filter(p => !canWinWith(board, p));
  const myD  = pieceGiveDanger(board, piece);
  const minD = Math.min(...safe.map(p => pieceGiveDanger(board, p)));
  return myD === minD ? 15 : 10;
}

function calcPlaceScore(r, c, piece, board) {
  if (wouldWin(board, r, c, piece)) return 100;
  const before = boardThreatCount(board);
  board[r][c] = piece;
  const after  = boardThreatCount(board);
  board[r][c]  = null;
  return 3 + Math.max(0, after - before) * 15;
}

function newGame() {
  return {
    board : Array.from({ length: 4 }, () => Array(4).fill(null)),
    avail : Array.from({ length: 16 }, (_, i) => i),
    phase : 'give',
    giver : 0,
    cur   : null,
    over  : false,
    winner: null,
    draw  : false,
    wl    : [],
    scores: [0, 0],
    log   : [],
  };
}

// ── Broadcast helpers ─────────────────────────────────────────

function roomPayload(room) {
  return {
    game     : room.game,
    names    : room.names,
    specCount: room.specs.size,
  };
}

function broadcast(room) {
  io.to(room.code).emit('game_state', roomPayload(room));
}

// ── Socket.IO ─────────────────────────────────────────────────

io.on('connection', socket => {
  socket.data = { room: null, slot: null, name: '' };

  // ---- Create room ----
  socket.on('create_room', ({ name }) => {
    const pName = (name || '').trim().slice(0, 12) || 'プレイヤー1';
    const code  = genCode();
    const room  = newRoom(code, socket.id, pName);
    rooms.set(code, room);
    socket.join(code);
    socket.data = { room: code, slot: 0, name: pName };
    socket.emit('room_created', { code, name: pName });
    console.log(`[Room ${code}] Created by ${pName}`);
  });

  // ---- Join room (player or spectator) ----
  socket.on('join_room', ({ code, name, asSpectator }) => {
    const c     = (code || '').toUpperCase().trim();
    const room  = rooms.get(c);
    const pName = (name || '').trim().slice(0, 12) || 'ゲスト';

    if (!room) {
      socket.emit('join_error', { msg: 'ルームが見つかりません。コードを確認してください。' });
      return;
    }

    socket.join(c);
    socket.data.room = c;
    socket.data.name = pName;

    const slot1Free = room.players[1] === null;

    if (!asSpectator && slot1Free) {
      // Join as Player 2
      room.players[1] = socket.id;
      room.names[1]   = pName;
      socket.data.slot = 1;

      room.game = newGame();

      socket.emit('room_joined', {
        slot    : 1,
        names   : room.names,
        code    : c,
      });
      io.to(room.players[0]).emit('opponent_joined', { name: pName });

      // Start game for everyone (incl. spectators)
      io.to(c).emit('game_start', { names: room.names });
      broadcast(room);
      console.log(`[Room ${c}] Game started: ${room.names[0]} vs ${room.names[1]}`);
    } else {
      // Join as Spectator
      room.specs.add(socket.id);
      socket.data.slot = -1;
      socket.emit('room_joined', {
        slot      : -1,
        names     : room.names,
        code      : c,
        game      : room.game,
        specCount : room.specs.size,
        waiting   : room.game === null,
      });
      io.to(c).emit('spec_count', { count: room.specs.size });
      if (!slot1Free && !asSpectator) {
        socket.emit('join_notice', { msg: 'ルームが満員のため観戦モードで参加しました。' });
      }
      console.log(`[Room ${c}] Spectator joined (total: ${room.specs.size})`);
    }
  });

  // ---- Move: Give piece ----
  socket.on('give_piece', ({ piece }) => {
    const { room: code, slot } = socket.data;
    const room = rooms.get(code);
    if (!room?.game) return;
    const g = room.game;
    if (g.over || g.phase !== 'give' || g.giver !== slot) return;
    if (!g.avail.includes(piece)) return;

    const pts = calcGiveScore(piece, g.board, g.avail);
    g.scores[slot] += pts;
    g.log.push({ player: slot, action: 'give', piece, pts, r: -1, c: -1, move: g.log.length + 1 });
    g.cur   = piece;
    g.avail = g.avail.filter(x => x !== piece);
    g.phase = 'place';
    broadcast(room);
  });

  // ---- Move: Place piece ----
  socket.on('put_piece', ({ r, c }) => {
    const { room: code, slot } = socket.data;
    const room = rooms.get(code);
    if (!room?.game) return;
    const g      = room.game;
    const placer = 1 - g.giver;
    if (g.over || g.phase !== 'place' || placer !== slot) return;
    if (g.board[r][c] !== null) return;

    const pts = calcPlaceScore(r, c, g.cur, g.board);
    g.scores[placer] += pts;
    g.log.push({ player: placer, action: 'place', piece: g.cur, pts, r, c, move: g.log.length + 1 });
    g.board[r][c] = g.cur;
    g.cur         = null;

    const wl = winLines(g.board);
    if (wl.length) {
      g.over = true; g.winner = placer; g.wl = wl;
    } else if (!g.avail.length) {
      g.over = true; g.draw = true;
    } else {
      g.giver = placer;
      g.phase = 'give';
    }
    broadcast(room);
  });

  // ---- Rematch request ----
  socket.on('rematch', () => {
    const { room: code, slot } = socket.data;
    const room = rooms.get(code);
    if (!room?.game?.over || slot < 0) return;
    room.game = newGame();
    // Swap who goes first
    room.game.giver = room.game.giver; // keep same first player
    io.to(code).emit('game_start', { names: room.names });
    broadcast(room);
    console.log(`[Room ${code}] Rematch started`);
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    const { room: code, slot, name } = socket.data;
    const room = rooms.get(code);
    if (!room) return;

    if (slot === -1) {
      // Spectator left
      room.specs.delete(socket.id);
      io.to(code).emit('spec_count', { count: room.specs.size });
    } else if (slot === 0 || slot === 1) {
      // Player left
      room.players[slot] = null;
      if (room.game && !room.game.over) {
        room.game.over      = true;
        room.game.abandoned = true;
        room.game.winner    = 1 - slot;
        broadcast(room);
      }
      io.to(code).emit('player_left', { slot, name });
      console.log(`[Room ${code}] Player ${name} (slot ${slot}) disconnected`);

      // Clean up room if both players gone after 5 min
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = setTimeout(() => {
        if (rooms.has(code) && !room.players[0] && !room.players[1]) {
          rooms.delete(code);
          console.log(`[Room ${code}] Cleaned up`);
        }
      }, 5 * 60 * 1000);
    }
  });
});

// ── Start ─────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[ERROR] ポート ${PORT} は既に使用中です。`);
    console.error(`  → 別のウィンドウで既にサーバーが起動していませんか？`);
    console.error(`  → タスクマネージャーで node.exe を終了してから再試行してください。\n`);
  } else {
    console.error('[ERROR]', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`🎲 Quarto server → http://localhost:${PORT}`);
});
