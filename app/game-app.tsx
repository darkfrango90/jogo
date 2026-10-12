"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Copy,
  Crown,
  DoorOpen,
  Download,
  Link2,
  LogOut,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  Zap,
} from "lucide-react";

type Player = {
  id: string;
  nickname: string;
  avatar: number;
  score: number;
  roundPoints: number;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  stats: {
    letters: number;
    words: number;
    errors: number;
    guesses: number;
    correctGuesses: number;
  };
};
type WrongAttempt = {
  letter?: string;
  guess?: string;
  playerId: string;
  nickname: string;
};
type GameState = {
  code: string;
  status: "lobby" | "playing" | "round_end" | "finished";
  players: Player[];
  round: number;
  maxRounds: number;
  category?: string;
  hint?: string;
  difficulty?: "média" | "difícil";
  masked?: string;
  usedLetters?: string[];
  wrongLetters?: string[];
  wrongAttempts?: WrongAttempt[];
  errors?: number;
  activePlayerId?: string;
  deadline?: number;
  roundEndsAt?: number;
  message?: string;
  winnerIds?: string[];
  version: number;
};
type Session = {
  code: string;
  token: string;
  playerId: string;
  clientId: string;
};
type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};

const API = "/api/game";
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const AVATARS = ["🦊", "🐼", "🐯", "🐸"];
function getClientId() {
  let id = localStorage.getItem("hangman-client");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("hangman-client", id);
  }
  return id;
}
function initials(name: string) {
  return name.trim().slice(0, 2).toUpperCase();
}

export default function GameApp() {
  const [screen, setScreen] = useState<"home" | "form" | "room">("home");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [game, setGame] = useState<GameState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [guessing, setGuessing] = useState(false);
  const [guess, setGuess] = useState("");
  const [sound, setSound] = useState(true);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(
    null,
  );
  const lastStatus = useRef<string>("");
  const tone = useCallback(
    (kind: "ok" | "bad" | "tick" | "win") => {
      if (!sound) return;
      try {
        const C =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new C();
        const o = ctx.createOscillator(),
          g = ctx.createGain();
        o.connect(g);
        g.connect(ctx.destination);
        o.frequency.value =
          kind === "ok"
            ? 620
            : kind === "bad"
              ? 170
              : kind === "win"
                ? 880
                : 360;
        g.gain.setValueAtTime(0.05, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + (kind === "win" ? 0.5 : 0.16),
        );
        o.start();
        o.stop(ctx.currentTime + (kind === "win" ? 0.5 : 0.16));
      } catch {}
    },
    [sound],
  );

  useEffect(() => {
    const invite = new URLSearchParams(location.search).get("sala");
    if (invite) {
      setCode(invite.toUpperCase());
      setMode("join");
      setScreen("form");
    }
    const raw = localStorage.getItem("hangman-session");
    if (raw)
      try {
        const s = JSON.parse(raw);
        setSession(s);
        setScreen("room");
      } catch {}
  }, []);
  useEffect(() => {
    if ("serviceWorker" in navigator)
      navigator.serviceWorker.register("/sw.js");
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as InstallPrompt);
    };
    addEventListener("beforeinstallprompt", handler);
    return () => removeEventListener("beforeinstallprompt", handler);
  }, []);
  const fetchState = useCallback(async (s: Session, quiet = true) => {
    try {
      const r = await fetch(
        `${API}?code=${encodeURIComponent(s.code)}&token=${encodeURIComponent(s.token)}&clientId=${encodeURIComponent(s.clientId)}`,
        { cache: "no-store" },
      );
      if (r.status === 401 || r.status === 404) {
        localStorage.removeItem("hangman-session");
        setSession(null);
        setGame(null);
        setScreen("home");
        return;
      }
      const d = (await r.json()) as GameState & { error?: string };
      if (!r.ok) throw new Error(d.error || "Falha ao sincronizar");
      setGame(d);
      if (!quiet) setError("");
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "Erro de conexão");
    }
  }, []);
  useEffect(() => {
    if (!session) return;
    fetchState(session, false);
    const poll = setInterval(() => fetchState(session), 700);
    return () => clearInterval(poll);
  }, [session, fetchState]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!game) return;
    if (lastStatus.current && lastStatus.current !== game.status)
      tone(
        game.status === "finished"
          ? "win"
          : game.status === "round_end"
            ? "ok"
            : "tick",
      );
    lastStatus.current = game.status;
  }, [game, tone]);
  const action = useCallback(
    async (type: string, payload: Record<string, unknown> = {}) => {
      if (!session) return;
      setError("");
      try {
        const r = await fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type,
            code: session.code,
            token: session.token,
            clientId: session.clientId,
            ...payload,
          }),
        });
        const d = (await r.json()) as GameState & { error?: string };
        if (!r.ok) throw new Error(d.error || "Ação recusada");
        setGame(d);
        return d;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Erro de conexão");
        tone("bad");
      }
    },
    [session, tone],
  );
  const enter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nickname.trim().length < 2) {
      setError("Use um apelido com pelo menos 2 caracteres.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const clientId = getClientId();
      const r = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: mode,
          nickname: nickname.trim(),
          code: code.trim().toUpperCase(),
          clientId,
        }),
      });
      const d = (await r.json()) as {
        code: string;
        token: string;
        playerId: string;
        state: GameState;
        error?: string;
      };
      if (!r.ok) throw new Error(d.error || "Não foi possível entrar");
      const s = {
        code: d.code,
        token: d.token,
        playerId: d.playerId,
        clientId,
      };
      localStorage.setItem("hangman-session", JSON.stringify(s));
      setSession(s);
      setGame(d.state);
      setScreen("room");
      history.replaceState({}, "", `?sala=${d.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro ao entrar");
    } finally {
      setLoading(false);
    }
  };
  const leave = () => {
    localStorage.removeItem("hangman-session");
    setSession(null);
    setGame(null);
    setScreen("home");
    history.replaceState({}, "", location.pathname);
  };
  const me = game?.players.find((p) => p.id === session?.playerId);
  const active = game?.players.find((p) => p.id === game.activePlayerId);
  const isMyTurn =
    !!me && game?.status === "playing" && game.activePlayerId === me.id;
  const seconds = Math.max(0, Math.ceil(((game?.deadline || 0) - now) / 1000));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isMyTurn || guessing || e.repeat) return;
      const l = e.key.toUpperCase();
      if (LETTERS.includes(l) && !game?.usedLetters?.includes(l))
        action("letter", { letter: l });
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [isMyTurn, guessing, game?.usedLetters, action]);
  useEffect(() => {
    if (seconds <= 3 && seconds > 0 && isMyTurn) tone("tick");
  }, [seconds, isMyTurn, tone]);

  if (screen === "home")
    return (
      <Home
        onPick={(m) => {
          setMode(m);
          setScreen("form");
          setError("");
        }}
        sound={sound}
        setSound={setSound}
        onInstall={
          installPrompt
            ? async () => {
                await installPrompt.prompt();
                await installPrompt.userChoice;
                setInstallPrompt(null);
              }
            : undefined
        }
      />
    );
  if (screen === "form")
    return (
      <Entry
        mode={mode}
        nickname={nickname}
        setNickname={setNickname}
        code={code}
        setCode={setCode}
        error={error}
        loading={loading}
        onSubmit={enter}
        onBack={() => setScreen("home")}
      />
    );
  if (!game || !session)
    return <Loading message={error || "Sincronizando arena…"} />;
  if (game.status === "lobby")
    return (
      <Lobby
        game={game}
        me={me}
        onAction={action}
        onLeave={leave}
        error={error}
      />
    );
  if (game.status === "finished")
    return <Results game={game} me={me} onAction={action} onLeave={leave} />;
  return (
    <Arena
      game={game}
      me={me}
      active={active}
      isMyTurn={isMyTurn}
      seconds={seconds}
      error={error}
      sound={sound}
      toggleSound={() => setSound((x) => !x)}
      guessing={guessing}
      setGuessing={setGuessing}
      guess={guess}
      setGuess={setGuess}
      action={action}
    />
  );
}

function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <Zap size={18} fill="currentColor" />
      </div>
      <div>
        <strong>HANGMAN</strong>
        <span>ARENA</span>
      </div>
    </div>
  );
}
function Home({
  onPick,
  sound,
  setSound,
  onInstall,
}: {
  onPick: (m: "create" | "join") => void;
  sound: boolean;
  setSound: (x: boolean) => void;
  onInstall?: () => void;
}) {
  return (
    <main className="home-shell">
      <nav>
        <Brand />
        <div className="nav-actions">
          {onInstall && (
            <button className="install" onClick={onInstall}>
              <Download /> INSTALAR APP
            </button>
          )}
          <button
            className="icon-btn"
            onClick={() => setSound(!sound)}
            aria-label="Alternar som"
          >
            {sound ? <Volume2 /> : <VolumeX />}
          </button>
        </div>
      </nav>
      <section className="hero">
        <div className="eyebrow">
          <span /> MULTIPLAYER EM TEMPO REAL
        </div>
        <h1>
          ADIVINHE.
          <br />
          <em>DOMINE.</em> VENÇA.
        </h1>
        <p>
          O clássico jogo da forca elevado a uma arena competitiva. Reúna a
          galera, descubra as palavras e chegue ao topo.
        </p>
        <div className="hero-actions">
          <button className="primary huge" onClick={() => onPick("create")}>
            <Play fill="currentColor" /> CRIAR SALA
          </button>
          <button className="secondary huge" onClick={() => onPick("join")}>
            <DoorOpen /> ENTRAR EM SALA
          </button>
        </div>
        <div className="proof">
          <span>
            <Users /> 2–4 jogadores
          </span>
          <span>
            <Zap /> 20 rodadas
          </span>
          <span>
            <ShieldCheck /> servidor seguro
          </span>
        </div>
      </section>
      <section className="feature-row">
        <article>
          <span>01</span>
          <div>
            <b>SALA PRIVADA</b>
            <small>Crie, compartilhe o código e jogue.</small>
          </div>
        </article>
        <article>
          <span>02</span>
          <div>
            <b>10 SEGUNDOS</b>
            <small>Decisões rápidas. Pontos valiosos.</small>
          </div>
        </article>
        <article>
          <span>03</span>
          <div>
            <b>SUBA NO RANKING</b>
            <small>Letras valem pontos. Palavras, glória.</small>
          </div>
        </article>
      </section>
      <footer className="creator">
        DESENVOLVIDO POR <strong>RODRIGO RODRIGUES</strong>
      </footer>
    </main>
  );
}
function Entry({
  mode,
  nickname,
  setNickname,
  code,
  setCode,
  error,
  loading,
  onSubmit,
  onBack,
}: {
  mode: "create" | "join";
  nickname: string;
  setNickname: (v: string) => void;
  code: string;
  setCode: (v: string) => void;
  error: string;
  loading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onBack: () => void;
}) {
  return (
    <main className="center-shell">
      <div className="entry-card">
        <button className="back" onClick={onBack}>
          ← Voltar
        </button>
        <Brand />
        <div className="entry-icon">
          {mode === "create" ? <Sparkles /> : <DoorOpen />}
        </div>
        <h1>{mode === "create" ? "Crie sua arena" : "Entre na arena"}</h1>
        <p>
          {mode === "create"
            ? "Sua sala privada ficará pronta em segundos."
            : "Use o código enviado pelo anfitrião."}
        </p>
        <form onSubmit={onSubmit}>
          <label>
            SEU APELIDO
            <input
              autoFocus
              maxLength={16}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Como vamos te chamar?"
            />
          </label>
          {mode === "join" && (
            <label>
              CÓDIGO DA SALA
              <input
                className="code-input"
                maxLength={6}
                value={code}
                onChange={(e) =>
                  setCode(
                    e.target.value.replace(/[^a-z0-9]/gi, "").toUpperCase(),
                  )
                }
                placeholder="ABC123"
              />
            </label>
          )}
          {error && <div className="error">{error}</div>}
          <button className="primary wide" disabled={loading}>
            {loading
              ? "PREPARANDO…"
              : mode === "create"
                ? "CRIAR SALA"
                : "ENTRAR AGORA"}
          </button>
        </form>
      </div>
    </main>
  );
}
function Lobby({
  game,
  me,
  onAction,
  onLeave,
  error,
}: {
  game: GameState;
  me?: Player;
  onAction: (t: string, p?: Record<string, unknown>) => void;
  onLeave: () => void;
  error: string;
}) {
  const invite = () => {
    navigator.clipboard.writeText(
      `${location.origin}${location.pathname}?sala=${game.code}`,
    );
  };
  return (
    <main className="lobby-shell">
      <header>
        <Brand />
        <button className="ghost" onClick={onLeave}>
          <LogOut /> Sair
        </button>
      </header>
      <section className="lobby-card">
        <div className="lobby-top">
          <div>
            <span className="kicker">SALA DE ESPERA</span>
            <h1>Monte seu esquadrão</h1>
            <p>A partida começa com 2 jogadores. Até 4 pessoas podem entrar.</p>
          </div>
          <div className="room-code">
            <small>CÓDIGO DA SALA</small>
            <strong>{game.code}</strong>
            <button onClick={() => navigator.clipboard.writeText(game.code)}>
              <Copy /> copiar
            </button>
          </div>
        </div>
        <div className="players-grid">
          {[0, 1, 2, 3].map((i) => {
            const p = game.players[i];
            return p ? (
              <article className="player-slot filled" key={p.id}>
                <div className={`avatar av${p.avatar}`}>
                  {AVATARS[p.avatar] || initials(p.nickname)}
                </div>
                <div>
                  <b>{p.nickname}</b>
                  <small>
                    {p.isHost ? (
                      <>
                        <Crown /> HOST
                      </>
                    ) : p.ready ? (
                      "PRONTO"
                    ) : (
                      "PREPARANDO"
                    )}
                  </small>
                </div>
                <span className={`presence ${p.connected ? "online" : ""}`} />
              </article>
            ) : (
              <article className="player-slot" key={i}>
                <div className="avatar empty">+</div>
                <div>
                  <b>Vaga disponível</b>
                  <small>AGUARDANDO JOGADOR</small>
                </div>
              </article>
            );
          })}
        </div>
        <div className="lobby-actions">
          <button className="secondary" onClick={invite}>
            <Link2 /> COMPARTILHAR CONVITE
          </button>
          {!me?.isHost && (
            <button
              className={me?.ready ? "ready active" : "ready"}
              onClick={() => onAction("ready")}
            >
              {me?.ready ? "✓ PRONTO" : "ESTOU PRONTO"}
            </button>
          )}
          {me?.isHost && (
            <button
              className="primary"
              disabled={game.players.length < 2}
              onClick={() => onAction("start")}
            >
              <Play fill="currentColor" /> INICIAR PARTIDA
            </button>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        <p className="secure">
          <ShieldCheck /> O estado da partida é validado no servidor
        </p>
      </section>
    </main>
  );
}

function Arena({
  game,
  me,
  active,
  isMyTurn,
  seconds,
  error,
  sound,
  toggleSound,
  guessing,
  setGuessing,
  guess,
  setGuess,
  action,
}: {
  game: GameState;
  me?: Player;
  active?: Player;
  isMyTurn: boolean;
  seconds: number;
  error: string;
  sound: boolean;
  toggleSound: () => void;
  guessing: boolean;
  setGuessing: (v: boolean) => void;
  guess: string;
  setGuess: (v: string) => void;
  action: (t: string, p?: Record<string, unknown>) => Promise<unknown>;
}) {
  const ranking = [...game.players].sort((a, b) => b.score - a.score);
  const ended = game.status === "round_end";
  return (
    <main className="game-shell">
      <header className="game-header">
        <Brand />
        <div className="round">
          <small>RODADA</small>
          <b>
            {String(game.round).padStart(2, "0")}{" "}
            <span>/ {game.maxRounds}</span>
          </b>
        </div>
        <div className="header-right">
          <div className="mini-code">
            <small>SALA</small>
            <b>{game.code}</b>
          </div>
          <button className="icon-btn" onClick={toggleSound}>
            {sound ? <Volume2 /> : <VolumeX />}
          </button>
        </div>
      </header>
      <div className="game-layout">
        <aside className="scoreboard panel">
          <div className="panel-title">
            <span>RANKING</span>
            <small>AO VIVO</small>
          </div>
          {ranking.map((p, i) => (
            <article
              className={`${p.id === game.activePlayerId ? "active" : ""} ${p.id === me?.id ? "me" : ""}`}
              key={p.id}
            >
              <span className="position">{i + 1}</span>
              <div className={`avatar av${p.avatar}`}>{AVATARS[p.avatar]}</div>
              <div className="pname">
                <b>
                  {p.nickname}
                  {p.id === me?.id ? " (você)" : ""}
                </b>
                <small>
                  {ended
                    ? `+${p.roundPoints} NESTA RODADA`
                    : p.id === game.activePlayerId
                    ? "JOGANDO AGORA"
                    : p.connected
                      ? "ONLINE"
                      : "RECONECTANDO"}
                </small>
              </div>
              <strong>
                {p.score}
                <small> pts</small>
              </strong>
            </article>
          ))}
        </aside>
        <section className="play-area panel">
          <div className="turn-banner">
            <div className={`avatar av${active?.avatar || 0}`}>
              {active ? AVATARS[active.avatar] : "?"}
            </div>
            <div>
              <small>{isMyTurn ? "É A SUA VEZ!" : "JOGANDO AGORA"}</small>
              <b>{active?.nickname || "Aguardando…"}</b>
            </div>
            <div className={`timer ${seconds <= 3 ? "danger" : ""}`}>
              <svg viewBox="0 0 44 44">
                <circle cx="22" cy="22" r="19" />
                <circle
                  className="progress"
                  cx="22"
                  cy="22"
                  r="19"
                  style={{
                    strokeDashoffset: 119 - (119 * Math.min(seconds, 10)) / 10,
                  }}
                />
              </svg>
              <strong>{ended ? "·" : seconds}</strong>
            </div>
          </div>
          <div className="gallows-wrap">
            <Gallows errors={game.errors || 0} />
            <div className="word-zone">
              <span className="category">
                {game.category} • {game.difficulty?.toUpperCase()}
              </span>
              <div className="hint">DICA: {game.hint}</div>
              <div className="masked">
                {game.masked?.split("").map((c, i) => (
                  <span
                    className={
                      c === " " ? "space" : c === "-" ? "dash" : "letter"
                    }
                    key={i}
                  >
                    {c === "_" ? "" : c}
                  </span>
                ))}
              </div>
              <p>
                {ended
                  ? game.message
                  : isMyTurn
                    ? "Escolha uma letra ou arrisque a palavra"
                    : "Acompanhe a jogada do adversário"}
              </p>
            </div>
          </div>
          {ended ? (
            <div className="round-over">
              <Sparkles />
              <div>
                <b>{game.message}</b>
                <span>
                  Próxima rodada em{" "}
                  {Math.max(
                    0,
                    Math.ceil(((game.roundEndsAt || 0) - Date.now()) / 1000),
                  )}
                  s
                </span>
              </div>
            </div>
          ) : (
            <>
            <div className="used">
              LETRAS DESCOBERTAS{" "}
                <span>{game.usedLetters?.join(" · ") || "NENHUMA AINDA"}</span>
              </div>
            {!!game.wrongAttempts?.length && (
              <div className="error-history">
                <b>HISTÓRICO DE ERROS</b>
                <div>
                  {game.wrongAttempts.map((attempt, index) => (
                    <span key={index}>
                      <strong>{attempt.letter || `“${attempt.guess}”`}</strong>{" "}
                      {attempt.nickname}
                    </span>
                  ))}
                </div>
              </div>
            )}
              <div className="keyboard">
                {LETTERS.map((l) => (
                  <button
                    key={l}
                    disabled={!isMyTurn || game.usedLetters?.includes(l)}
                    className={
                      game.wrongLetters?.includes(l)
                        ? "wrong"
                        : game.usedLetters?.includes(l)
                          ? "correct"
                          : ""
                    }
                    onClick={() => action("letter", { letter: l })}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <button
                className="know"
                disabled={!isMyTurn}
                onClick={() => setGuessing(true)}
              >
                <Zap fill="currentColor" /> EU SEI A PALAVRA!{" "}
                <span>+20 PTS</span>
              </button>
            </>
          )}
          {error && <div className="error floating">{error}</div>}
        </section>
      </div>
      {guessing && (
        <div className="modal-back">
          <form
            className="guess-modal"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!guess.trim()) return;
              await action("guess", { guess });
              setGuess("");
              setGuessing(false);
            }}
          >
            <button
              type="button"
              className="close"
              onClick={() => setGuessing(false)}
            >
              ×
            </button>
            <div className="entry-icon">
              <Zap />
            </div>
            <small>VALE +20 PONTOS</small>
            <h2>Qual é a palavra?</h2>
            <p>O cronômetro continua correndo. Pense rápido!</p>
            <input
              autoFocus
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="Digite seu palpite"
            />
            <button className="primary wide">CONFIRMAR RESPOSTA</button>
          </form>
        </div>
      )}
    </main>
  );
}
function Gallows({ errors }: { errors: number }) {
  return (
    <svg
      className="gallows"
      viewBox="0 0 240 250"
      aria-label={`${errors} de 6 erros`}
    >
      <path
        className="wood"
        d="M26 228h150M60 228V25h112M61 55l31-30M171 25v32"
      />
      {errors > 0 && <circle className="bodypart" cx="171" cy="76" r="19" />}
      {errors > 1 && <path className="bodypart" d="M171 95v62" />}
      {errors > 2 && <path className="bodypart" d="M171 112l-30 28" />}
      {errors > 3 && <path className="bodypart" d="M171 112l30 28" />}
      {errors > 4 && <path className="bodypart" d="M171 157l-27 39" />}
      {errors > 5 && <path className="bodypart" d="M171 157l27 39" />}
      <circle className="base-glow" cx="60" cy="228" r="7" />
    </svg>
  );
}
function Results({
  game,
  me,
  onAction,
  onLeave,
}: {
  game: GameState;
  me?: Player;
  onAction: (t: string) => void;
  onLeave: () => void;
}) {
  const rank = [...game.players].sort(
    (a, b) =>
      b.score - a.score ||
      b.stats.words - a.stats.words ||
      b.stats.letters - a.stats.letters ||
      a.stats.errors - b.stats.errors,
  );
  const winner = rank[0];
  return (
    <main className="results-shell">
      <div className="confetti">
        {Array.from({ length: 24 }, (_, i) => (
          <i
            key={i}
            style={{
              left: `${(i * 37) % 100}%`,
              animationDelay: `${(i % 7) * 0.18}s`,
            }}
          />
        ))}
      </div>
      <header>
        <Brand />
      </header>
      <section className="results">
        <span className="kicker">PARTIDA ENCERRADA</span>
        <div className="trophy">
          <Trophy />
        </div>
        <h1>
          {game.winnerIds?.length === 1
            ? "TEMOS UM CAMPEÃO!"
            : "EMPATE NA ARENA!"}
        </h1>
        <p>
          <b>{winner.nickname}</b> dominou a arena com{" "}
          <strong>{winner.score} pontos</strong>
        </p>
        <div className="podium">
          {rank.map((p, i) => (
            <article key={p.id} className={i === 0 ? "champion" : ""}>
              <span className="place">{i === 0 ? <Crown /> : `#${i + 1}`}</span>
              <div className={`avatar av${p.avatar}`}>{AVATARS[p.avatar]}</div>
              <div>
                <b>
                  {p.nickname}
                  {p.id === me?.id ? " (você)" : ""}
                </b>
                <small>{p.score} PONTOS</small>
              </div>
              <div className="stats">
                <span>
                  <b>{p.stats.letters}</b> letras
                </span>
                <span>
                  <b>{p.stats.words}</b> palavras
                </span>
                <span>
                  <b>{p.stats.errors}</b> erros
                </span>
                <span>
                  <b>
                    {p.stats.guesses
                      ? Math.round(
                          (100 * p.stats.correctGuesses) / p.stats.guesses,
                        )
                      : 0}
                    %
                  </b>{" "}
                  palpites
                </span>
              </div>
            </article>
          ))}
        </div>
        <div className="results-actions">
          {me?.isHost && (
            <button className="primary" onClick={() => onAction("rematch")}>
              <RotateCcw /> JOGAR NOVAMENTE
            </button>
          )}
          <button className="secondary" onClick={() => onAction("lobby")}>
            <Users /> VOLTAR À SALA
          </button>
          <button className="ghost" onClick={onLeave}>
            <LogOut /> SAIR
          </button>
        </div>
      </section>
    </main>
  );
}
function Loading({ message }: { message: string }) {
  return (
    <main className="center-shell">
      <div className="loader">
        <Brand />
        <div className="spin" />
        <p>{message}</p>
      </div>
    </main>
  );
}
