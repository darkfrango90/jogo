import { NextRequest, NextResponse } from "next/server";
import { validateDictionary, WORDS } from "../../../lib/words";

export const dynamic = "force-dynamic";
type Stats = {
  letters: number;
  words: number;
  errors: number;
  guesses: number;
  correctGuesses: number;
};
type Player = {
  id: string;
  token: string;
  clientId: string;
  nickname: string;
  avatar: number;
  score: number;
  roundPoints: number;
  ready: boolean;
  lastSeen: number;
  stats: Stats;
};
type WrongAttempt = {
  letter?: string;
  guess?: string;
  playerId: string;
  nickname: string;
};
type State = {
  code: string;
  status: "lobby" | "playing" | "round_end" | "finished";
  hostPlayerId: string;
  players: Player[];
  round: number;
  maxRounds: number;
  usedWords: string[];
  word?: string;
  category?: string;
  hint?: string;
  difficulty?: "média" | "difícil";
  usedLetters: string[];
  wrongLetters: string[];
  wrongAttempts: WrongAttempt[];
  errors: number;
  turnIndex: number;
  deadline?: number;
  guessingPlayerId?: string;
  guessDeadline?: number;
  roundEndsAt?: number;
  message?: string;
  winnerIds?: string[];
  roundWinnerId?: string;
  roundEndReason?: "guess" | "letters" | "hangman";
};
type Row = {
  code: string;
  state: string;
  version: number;
  updated_at: number;
  expires_at: number;
};
const MAX_ROUNDS = 20,
  TURN_MS = 15_000,
  ROUND_GAP = 10_000,
  ONLINE_MS = 25_000,
  PRESENCE_WRITE_MS = 6_000,
  ROOM_TTL = 6 * 60 * 60 * 1000;
const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const clean = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
const id = () => crypto.randomUUID();
const token = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const code = () =>
  Array.from(
    { length: 6 },
    () => ABC[Math.floor(Math.random() * ABC.length)],
  ).join("");
const stats = (): Stats => ({
  letters: 0,
  words: 0,
  errors: 0,
  guesses: 0,
  correctGuesses: 0,
});
const reply = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
const fail = (message: string, status = 400) =>
  reply({ error: message }, status);

const BUCKET = "hangman-rooms";
let bucketReady = false;
function supa() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Banco não configurado");
  return { url, key };
}
function auth(extra: Record<string, string> = {}) {
  const { key } = supa();
  return { apikey: key, Authorization: `Bearer ${key}`, ...extra };
}
async function ensureBucket() {
  if (bucketReady) return;
  validateDictionary();
  const { url } = supa();
  const r = await fetch(`${url}/storage/v1/bucket`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: false,
      file_size_limit: 1048576,
    }),
  });
  if (!r.ok && r.status !== 409) {
    const t = await r.text();
    if (!t.toLowerCase().includes("already"))
      throw new Error("Falha ao preparar o banco");
  }
  bucketReady = true;
  const existing = await readObject("dictionary/words.json");
  let valid = false;
  try {
    valid = !!existing && JSON.parse(existing).length === 500;
  } catch {}
  if (!valid)
    await writeObject(
      "dictionary/words.json",
      JSON.stringify(WORDS),
      !!existing,
    );
}
async function readObject(path: string) {
  await ensureBucket();
  const { url } = supa();
  const r = await fetch(
    `${url}/storage/v1/object/authenticated/${BUCKET}/${path}`,
    { headers: auth(), cache: "no-store" },
  );
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new Error("Falha ao ler o banco");
  return await r.text();
}
async function writeObject(path: string, content: string, upsert: boolean) {
  await ensureBucket();
  const { url } = supa();
  return fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: auth({
      "content-type": "application/json",
      "x-upsert": String(upsert),
    }),
    body: content,
  });
}
async function removeObject(path: string) {
  const { url } = supa();
  await fetch(`${url}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ prefixes: [path] }),
  });
}
const roomQueues = new Map<string, Promise<void>>();
async function withLock<T>(roomCode: string, fn: () => Promise<T>): Promise<T> {
  const previous = roomQueues.get(roomCode) || Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  roomQueues.set(roomCode, current);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (roomQueues.get(roomCode) === current) roomQueues.delete(roomCode);
  }
}

function findPlayer(s: State, t: string, c: string) {
  const p = s.players.find((x) => x.token === t);
  if (!p || p.clientId !== c) throw new Error("Sessão inválida");
  return p;
}
function masked(s: State) {
  const word = s.word || "";
  return [...word]
    .map((ch) => {
      const n = clean(ch);
      if (!/[A-Z]/.test(n)) return ch;
      if (s.status === "round_end" || s.status === "finished")
        return ch.toUpperCase();
      return s.usedLetters.includes(n) ? ch.toUpperCase() : "_";
    })
    .join("");
}
function rank(s: State) {
  return [...s.players].sort(
    (a, b) =>
      b.score - a.score ||
      b.stats.words - a.stats.words ||
      b.stats.letters - a.stats.letters ||
      a.stats.errors - b.stats.errors,
  );
}
function publicState(s: State, version: number) {
  const now = Date.now();
  return {
    code: s.code,
    status: s.status,
    players: s.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      avatar: p.avatar,
      score: p.score,
      roundPoints: p.roundPoints,
      ready: p.ready,
      connected: now - p.lastSeen < ONLINE_MS,
      isHost: p.id === s.hostPlayerId,
      stats: p.stats,
    })),
    round: s.round,
    maxRounds: s.maxRounds,
    category: s.category,
    hint: s.hint,
    difficulty: s.difficulty,
    masked: masked(s),
    usedLetters: s.usedLetters,
    wrongLetters: s.wrongLetters,
    wrongAttempts: s.wrongAttempts,
    errors: s.errors,
    activePlayerId: s.players[s.turnIndex]?.id,
    deadline: s.deadline,
    guessingPlayerId: s.guessingPlayerId,
    roundEndsAt: s.roundEndsAt,
    message: s.message,
    winnerIds: s.winnerIds,
    roundWinnerId: s.roundWinnerId,
    roundEndReason: s.roundEndReason,
    version,
  };
}
function chooseWord(s: State) {
  const desired = s.round % 2 === 1 ? "média" : "difícil";
  const available = WORDS.filter(
    (w) => w.difficulty === desired && !s.usedWords.includes(clean(w.word)),
  );
  const chosen = available[Math.floor(Math.random() * available.length)];
  s.word = chosen.word;
  s.category = chosen.category;
  s.hint = chosen.hint;
  s.difficulty = chosen.difficulty;
  s.usedWords.push(clean(chosen.word));
}
function nextConnected(s: State) {
  for (let step = 1; step <= s.players.length; step++) {
    const ix = (s.turnIndex + step) % s.players.length;
    if (Date.now() - s.players[ix].lastSeen < ONLINE_MS) {
      s.turnIndex = ix;
      return;
    }
  }
  s.turnIndex = (s.turnIndex + 1) % s.players.length;
}
function startRound(s: State) {
  s.status = "playing";
  s.round++;
  s.usedLetters = [];
  s.wrongLetters = [];
  s.wrongAttempts = [];
  s.errors = 0;
  s.message = undefined;
  s.roundWinnerId = undefined;
  s.roundEndReason = undefined;
  s.roundEndsAt = undefined;
  s.players.forEach((p) => (p.roundPoints = 0));
  s.turnIndex = (s.round - 1) % s.players.length;
  chooseWord(s);
  s.deadline = Date.now() + TURN_MS;
  s.guessingPlayerId = undefined;
  s.guessDeadline = undefined;
}
function finishRound(
  s: State,
  message: string,
  winnerId?: string,
  reason: "guess" | "letters" | "hangman" = "hangman",
) {
  s.status = "round_end";
  s.message = message;
  s.roundWinnerId = winnerId;
  s.roundEndReason = reason;
  s.deadline = undefined;
  s.guessingPlayerId = undefined;
  s.guessDeadline = undefined;
  s.roundEndsAt = Date.now() + ROUND_GAP;
}
function finishGame(s: State) {
  s.status = "finished";
  s.roundEndsAt = undefined;
  const r = rank(s),
    top = r[0];
  s.winnerIds = r
    .filter(
      (p) =>
        p.score === top.score &&
        p.stats.words === top.stats.words &&
        p.stats.letters === top.stats.letters &&
        p.stats.errors === top.stats.errors,
    )
    .map((p) => p.id);
  s.message =
    s.winnerIds.length > 1
      ? "Empate na arena!"
      : `${top.nickname} venceu a partida!`;
}
function advance(s: State) {
  const now = Date.now();
  if (
    s.players.length &&
    (!s.players.some((p) => p.id === s.hostPlayerId) ||
      now - (s.players.find((p) => p.id === s.hostPlayerId)?.lastSeen || 0) >
        ONLINE_MS * 2)
  ) {
    const replacement =
      s.players.find((p) => now - p.lastSeen < ONLINE_MS) || s.players[0];
    s.hostPlayerId = replacement.id;
  }
  if (
    s.status === "playing" &&
    s.guessingPlayerId &&
    s.guessDeadline &&
    now >= s.guessDeadline
  ) {
    const p = s.players.find((item) => item.id === s.guessingPlayerId);
    s.message = `Tempo de resposta esgotado para ${p?.nickname || "o jogador"}`;
    s.guessingPlayerId = undefined;
    s.guessDeadline = undefined;
    nextConnected(s);
    s.deadline = now + TURN_MS;
  } else if (s.status === "playing" && s.deadline && now >= s.deadline) {
    const p = s.players[s.turnIndex];
    s.message = `Tempo esgotado para ${p.nickname}`;
    nextConnected(s);
    s.deadline = now + TURN_MS;
  }
  if (s.status === "round_end" && s.roundEndsAt && now >= s.roundEndsAt) {
    if (s.round >= s.maxRounds) finishGame(s);
    else startRound(s);
  }
}
async function getRoom(roomCode: string) {
  const raw = await readObject(`rooms/${roomCode}.json`);
  if (!raw) return null;
  const row = JSON.parse(raw) as Row;
  if (row.expires_at < Date.now()) {
    await removeObject(`rooms/${roomCode}.json`);
    return null;
  }
  return row;
}
async function mutate(roomCode: string, fn: (s: State) => void) {
  return withLock(roomCode, async () => {
    const row = await getRoom(roomCode);
    if (!row) throw new Error("Sala não encontrada");
    const s = JSON.parse(row.state) as State;
    s.wrongAttempts ??= [];
    advance(s);
    fn(s);
    const now = Date.now(),
      next = {
        code: roomCode,
        state: JSON.stringify(s),
        version: row.version + 1,
        updated_at: now,
        expires_at: now + ROOM_TTL,
      };
    const r = await writeObject(
      `rooms/${roomCode}.json`,
      JSON.stringify(next),
      true,
    );
    if (!r.ok) throw new Error("Falha ao salvar a partida");
    return { state: s, version: next.version };
  });
}

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams,
      roomCode = (q.get("code") || "").toUpperCase(),
      t = q.get("token") || "",
      c = q.get("clientId") || "";
    const row = await getRoom(roomCode);
    if (!row) throw new Error("Sala não encontrada");
    const snapshot = JSON.parse(row.state) as State;
    snapshot.wrongAttempts ??= [];
    const player = findPlayer(snapshot, t, c);
    const now = Date.now();
    const deadlineReached =
      (snapshot.status === "playing" &&
        ((!!snapshot.deadline && now >= snapshot.deadline) ||
          (!!snapshot.guessDeadline && now >= snapshot.guessDeadline))) ||
      (snapshot.status === "round_end" &&
        !!snapshot.roundEndsAt &&
        now >= snapshot.roundEndsAt);
    const hostMissing =
      !snapshot.players.some((item) => item.id === snapshot.hostPlayerId) ||
      now -
          (snapshot.players.find((item) => item.id === snapshot.hostPlayerId)
            ?.lastSeen || 0) >
        ONLINE_MS * 2;
    if (
      !deadlineReached &&
      !hostMissing &&
      now - player.lastSeen < PRESENCE_WRITE_MS
    )
      return reply(publicState(snapshot, row.version));
    const out = await mutate(roomCode, (s) => {
      const p = findPlayer(s, t, c);
      p.lastSeen = Date.now();
    });
    return reply(publicState(out.state, out.version));
  } catch (e) {
    const m = e instanceof Error ? e.message : "Erro";
    return fail(
      m,
      m.includes("não encontrada") ? 404 : m.includes("Sessão") ? 401 : 400,
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, string>;
    const type = b.type,
      clientId = (b.clientId || "").slice(0, 80);
    if (!clientId) return fail("Identificador do dispositivo ausente");
    if (type === "create") {
      const nickname = validNickname(b.nickname);
      const chosenAvatar = Math.max(0, Math.min(3, Number(b.avatar) || 0));
      for (let i = 0; i < 8; i++) {
        const roomCode = code(),
          pid = id(),
          ptoken = token(),
          now = Date.now();
        const p: Player = {
          id: pid,
          token: ptoken,
          clientId,
          nickname,
          avatar: chosenAvatar,
          score: 0,
          roundPoints: 0,
          ready: true,
          lastSeen: now,
          stats: stats(),
        };
        const s: State = {
          code: roomCode,
          status: "lobby",
          hostPlayerId: pid,
          players: [p],
          round: 0,
          maxRounds: MAX_ROUNDS,
          usedWords: [],
          usedLetters: [],
          wrongLetters: [],
          wrongAttempts: [],
          errors: 0,
          turnIndex: 0,
        };
        const row: Row = {
          code: roomCode,
          state: JSON.stringify(s),
          version: 1,
          updated_at: now,
          expires_at: now + ROOM_TTL,
        };
        const r = await writeObject(
          `rooms/${roomCode}.json`,
          JSON.stringify(row),
          false,
        );
        if (r.ok)
          return reply({
            code: roomCode,
            token: ptoken,
            playerId: pid,
            state: publicState(s, 1),
          });
      }
      throw new Error("Não foi possível gerar a sala");
    }
    const roomCode = (b.code || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) return fail("Código de sala inválido");
    if (type === "join") {
      const nickname = validNickname(b.nickname);
      const chosenAvatar = Math.max(0, Math.min(3, Number(b.avatar) || 0));
      let newPlayer: Player | undefined;
      const out = await mutate(roomCode, (s) => {
        if (s.status !== "lobby") throw new Error("A partida já começou");
        if (s.players.length >= 4) throw new Error("A sala está cheia");
        if (s.players.some((p) => clean(p.nickname) === clean(nickname)))
          throw new Error("Este apelido já está em uso");
        newPlayer = {
          id: id(),
          token: token(),
          clientId,
          nickname,
          avatar: chosenAvatar,
          score: 0,
          roundPoints: 0,
          ready: false,
          lastSeen: Date.now(),
          stats: stats(),
        };
        s.players.push(newPlayer);
      });
      return reply({
        code: roomCode,
        token: newPlayer!.token,
        playerId: newPlayer!.id,
        state: publicState(out.state, out.version),
      });
    }
    const t = b.token || "";
    const out = await mutate(roomCode, (s) => {
      const p = findPlayer(s, t, clientId);
      p.lastSeen = Date.now();
      if (type === "ready") {
        if (s.status !== "lobby") throw new Error("A partida já começou");
        p.ready = !p.ready;
      } else if (type === "start") {
        if (p.id !== s.hostPlayerId)
          throw new Error("Somente o host pode iniciar");
        if (s.status !== "lobby") throw new Error("Partida já iniciada");
        if (s.players.length < 2)
          throw new Error("São necessários pelo menos 2 jogadores");
        s.players.forEach((x) => {
          x.score = 0;
          x.roundPoints = 0;
          x.stats = stats();
          x.ready = true;
        });
        s.round = 0;
        s.usedWords = [];
        startRound(s);
      } else if (type === "letter") {
        ensureTurn(s, p);
        const letter = clean((b.letter || "").slice(0, 1));
        if (!/^[A-Z]$/.test(letter)) throw new Error("Letra inválida");
        if (s.usedLetters.includes(letter))
          throw new Error("Esta letra já foi descoberta");
        const hits = [...(s.word || "")].filter(
          (ch) => clean(ch) === letter,
        ).length;
        if (hits) {
          s.usedLetters.push(letter);
          p.score += hits;
          p.roundPoints += hits;
          p.stats.letters += hits;
          s.message = `${p.nickname} acertou ${hits} ${hits === 1 ? "letra" : "letras"}`;
          s.deadline = Date.now() + TURN_MS;
          if (!masked(s).includes("_"))
            finishRound(
              s,
              `${p.nickname} completou a palavra: ${(s.word || "").toUpperCase()}`,
              p.id,
              "letters",
            );
        } else {
          s.wrongLetters.push(letter);
          s.wrongAttempts.push({
            letter,
            playerId: p.id,
            nickname: p.nickname,
          });
          s.errors++;
          p.stats.errors++;
          s.message = `${p.nickname} errou a letra ${letter}`;
          nextConnected(s);
          s.deadline = Date.now() + TURN_MS;
        }
      } else if (type === "begin_guess") {
        ensureTurn(s, p);
        s.guessingPlayerId = p.id;
        s.guessDeadline = Date.now() + TURN_MS;
        s.deadline = undefined;
        s.message = `${p.nickname} está preparando um palpite`;
      } else if (type === "cancel_guess") {
        if (s.status !== "playing" || s.guessingPlayerId !== p.id)
          throw new Error("Não há palpite aguardando resposta");
        s.guessingPlayerId = undefined;
        s.guessDeadline = undefined;
        s.deadline = Date.now() + TURN_MS;
        s.message = `${p.nickname} cancelou o palpite`;
      } else if (type === "guess") {
        if (s.guessingPlayerId) {
          if (s.status !== "playing" || s.guessingPlayerId !== p.id)
            throw new Error("Aguarde a sua vez");
          if (!s.guessDeadline || Date.now() >= s.guessDeadline) {
            advance(s);
            throw new Error("Seu tempo de resposta terminou");
          }
          s.guessingPlayerId = undefined;
          s.guessDeadline = undefined;
        } else ensureTurn(s, p);
        const guess = (b.guess || "").trim();
        if (!guess) throw new Error("Digite uma palavra");
        p.stats.guesses++;
        if (clean(guess) === clean(s.word || "")) {
          p.score += 20;
          p.roundPoints += 20;
          p.stats.words++;
          p.stats.correctGuesses++;
          finishRound(
            s,
            `${p.nickname} descobriu: ${(s.word || "").toUpperCase()}`,
            p.id,
            "guess",
          );
        } else {
          s.wrongAttempts.push({ guess, playerId: p.id, nickname: p.nickname });
          s.errors++;
          p.stats.errors++;
          s.message = `Palpite incorreto de ${p.nickname}`;
          nextConnected(s);
          s.deadline = Date.now() + TURN_MS;
        }
      } else if (type === "rematch") {
        if (s.status !== "finished" || p.id !== s.hostPlayerId)
          throw new Error("Somente o host pode reiniciar");
        s.players.forEach((x) => {
          x.score = 0;
          x.roundPoints = 0;
          x.stats = stats();
        });
        s.round = 0;
        s.usedWords = [];
        s.winnerIds = undefined;
        startRound(s);
      } else if (type === "lobby") {
        if (s.status !== "finished" || p.id !== s.hostPlayerId)
          throw new Error("Somente o host pode voltar para a sala");
        s.status = "lobby";
        s.round = 0;
        s.usedWords = [];
        s.word = undefined;
        s.category = undefined;
        s.hint = undefined;
        s.difficulty = undefined;
        s.wrongAttempts = [];
        s.deadline = undefined;
        s.guessingPlayerId = undefined;
        s.guessDeadline = undefined;
        s.winnerIds = undefined;
        s.message = undefined;
        s.players.forEach((x) => {
          x.score = 0;
          x.roundPoints = 0;
          x.ready = x.id === s.hostPlayerId;
          x.stats = stats();
        });
      } else throw new Error("Ação desconhecida");
    });
    return reply(publicState(out.state, out.version));
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Erro inesperado");
  }
}

function validNickname(raw?: string) {
  const n = (raw || "").trim().replace(/\s+/g, " ");
  if (n.length < 2 || n.length > 16)
    throw new Error("O apelido deve ter de 2 a 16 caracteres");
  if (!/^[\p{L}\p{N} _-]+$/u.test(n))
    throw new Error("Use apenas letras e números no apelido");
  return n;
}
function ensureTurn(s: State, p: Player) {
  advance(s);
  if (s.status !== "playing") throw new Error("A rodada não está ativa");
  if (s.guessingPlayerId) throw new Error("Um palpite está em andamento");
  if (s.players[s.turnIndex]?.id !== p.id) throw new Error("Aguarde a sua vez");
  if (!s.deadline || Date.now() >= s.deadline)
    throw new Error("Seu tempo terminou");
}
