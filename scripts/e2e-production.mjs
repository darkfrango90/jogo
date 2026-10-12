const BASE = (process.env.BASE_URL || "https://hangman-arena.vercel.app").replace(/\/$/, "");
const runId = Date.now().toString(36).slice(-6);
const checks = [];

function check(condition, label) {
  if (!condition) throw new Error(`FALHOU: ${label}`);
  checks.push(label);
  console.log(`✓ ${label}`);
}

async function post(data) {
  const response = await fetch(`${BASE}/api/game`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  return { status: response.status, ok: response.ok, body };
}

async function get(session, clientId = session.clientId) {
  const query = new URLSearchParams({
    code: session.code,
    token: session.token,
    clientId,
  });
  const response = await fetch(`${BASE}/api/game?${query}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json();
  return { status: response.status, ok: response.ok, body };
}

async function create(name, avatar = 0) {
  const clientId = `e2e-${runId}-${crypto.randomUUID()}`;
  const result = await post({ type: "create", nickname: name, avatar, clientId });
  check(result.ok, `criar sala para ${name}`);
  return {
    code: result.body.code,
    token: result.body.token,
    playerId: result.body.playerId,
    clientId,
    state: result.body.state,
  };
}

async function join(host, name, avatar = 0) {
  const clientId = `e2e-${runId}-${crypto.randomUUID()}`;
  const result = await post({
    type: "join",
    code: host.code,
    nickname: name,
    avatar,
    clientId,
  });
  check(result.ok, `entrar como ${name}`);
  return {
    code: host.code,
    token: result.body.token,
    playerId: result.body.playerId,
    clientId,
    state: result.body.state,
  };
}

async function action(session, type, payload = {}) {
  return post({
    type,
    code: session.code,
    token: session.token,
    clientId: session.clientId,
    ...payload,
  });
}

function sessionFor(sessions, playerId) {
  const session = sessions.find((item) => item.playerId === playerId);
  if (!session) throw new Error(`Sessão não encontrada para ${playerId}`);
  return session;
}

async function testStaticFiles() {
  const [home, manifestResponse, worker, icon192, icon512, maskable] = await Promise.all([
    fetch(`${BASE}/`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${BASE}/manifest.webmanifest`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${BASE}/sw.js`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${BASE}/icon-192.png`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${BASE}/icon-512.png`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${BASE}/icon-maskable-512.png`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  const html = await home.text();
  const manifest = await manifestResponse.json();
  check(
    home.ok && /DESENVOLVIDO[\s\S]*RODRIGO RODRIGUES/i.test(html),
    "página inicial e crédito do autor",
  );
  check(manifestResponse.ok && manifest.display === "standalone", "manifesto PWA standalone");
  check(worker.ok, "service worker publicado");
  check(icon192.ok && icon192.headers.get("content-type")?.includes("image/png"), "ícone PWA 192x192");
  check(icon512.ok && icon512.headers.get("content-type")?.includes("image/png"), "ícone PWA 512x512");
  check(maskable.ok && manifest.icons.some((icon) => icon.purpose === "maskable"), "ícone PWA maskable");
}

async function testFourPlayers() {
  const host = await create(`H${runId}`, 0);
  const duplicate = await post({
    type: "join",
    code: host.code,
    nickname: `h${runId}`,
    avatar: 1,
    clientId: `duplicate-${runId}`,
  });
  check(duplicate.status === 400, "bloquear apelido duplicado sem diferenciar maiúsculas");

  const p2 = await join(host, `B${runId}`, 1);
  const p3 = await join(host, `C${runId}`, 2);
  const p4 = await join(host, `D${runId}`, 3);
  const sessions = [host, p2, p3, p4];
  const overflow = await post({
    type: "join",
    code: host.code,
    nickname: `E${runId}`,
    avatar: 0,
    clientId: `overflow-${runId}`,
  });
  check(overflow.status === 400, "limitar a sala a quatro jogadores");

  const forbiddenStart = await action(p2, "start");
  check(forbiddenStart.status === 400, "impedir não-host de iniciar");
  const started = await action(host, "start");
  check(started.ok && started.body.players.length === 4, "iniciar partida com quatro jogadores");
  check(started.body.round === 1 && started.body.difficulty === "média", "primeira rodada em dificuldade média");
  check(!Object.hasOwn(started.body, "word"), "não revelar a palavra secreta durante a rodada");
  check(started.body.hint && started.body.category, "enviar dica e categoria");
  check(started.body.players.every((player) => Number.isInteger(player.avatar)), "persistir avatares dos jogadores");

  let state = started.body;
  const outOfTurn = sessions.find((item) => item.playerId !== state.activePlayerId);
  const refused = await action(outOfTurn, "letter", { letter: "A" });
  check(refused.status === 400, "recusar jogada fora do turno");

  const active = sessionFor(sessions, state.activePlayerId);
  const simultaneous = await Promise.all([
    action(active, "letter", { letter: "A" }),
    action(active, "letter", { letter: "A" }),
  ]);
  check(simultaneous.filter((result) => result.ok).length === 1, "serializar ações simultâneas duplicadas");
  state = simultaneous.find((result) => result.ok).body;

  let retained = false;
  for (const letter of ["E", "I", "O", "U", "A"]) {
    if (state.usedLetters.includes(letter) || state.status !== "playing") continue;
    const turn = sessionFor(sessions, state.activePlayerId);
    const before = state.players.find((player) => player.id === turn.playerId).score;
    const result = await action(turn, "letter", { letter });
    check(result.ok, `processar tentativa da letra ${letter}`);
    state = result.body;
    const after = state.players.find((player) => player.id === turn.playerId).score;
    if (after > before) {
      check(state.activePlayerId === turn.playerId, "manter turno e reiniciar cronômetro após acerto");
      retained = true;
      break;
    }
  }
  check(retained, "encontrar e pontuar uma letra correta");

  const nonHost = sessions.find((item) => item.playerId !== host.playerId);
  const forcedLobby = await action(nonHost, "lobby");
  check(forcedLobby.status === 400, "impedir participante de encerrar a partida voltando ao lobby");

  const polls = await Promise.all(sessions.map((session) => get(session)));
  check(polls.every((result) => result.ok), "sincronizar quatro jogadores em paralelo");
}

async function testRoundLifecycle() {
  const host = await create(`T${runId}`, 0);
  const guest = await join(host, `U${runId}`, 1);
  const sessions = [host, guest];
  let result = await action(host, "start");
  check(result.ok, "iniciar partida com dois jogadores");
  let state = result.body;

  let wrongLetter;
  for (const letter of "ZKWYXQJVBFPGH") {
    if (state.status !== "playing") break;
    const turn = sessionFor(sessions, state.activePlayerId);
    const beforeErrors = state.errors;
    result = await action(turn, "letter", { letter });
    check(result.ok, `aceitar tentativa da letra ${letter}`);
    state = result.body;
    if (state.errors > beforeErrors) {
      wrongLetter = letter;
      break;
    }
  }
  check(Boolean(wrongLetter), "registrar letra incorreta");
  const errorsBeforeRepeat = state.errors;
  const repeatTurn = sessionFor(sessions, state.activePlayerId);
  result = await action(repeatTurn, "letter", { letter: wrongLetter });
  check(result.ok && result.body.errors === errorsBeforeRepeat + 1, "permitir erro repetido por outro jogador");
  check(result.body.wrongAttempts.at(-1).letter === wrongLetter, "registrar autor do erro repetido");
  state = result.body;

  const activeBeforeTimeout = state.activePlayerId;
  const errorsBeforeTimeout = state.errors;
  await new Promise((resolve) => setTimeout(resolve, 10_600));
  result = await get(host);
  check(result.ok, "sincronizar depois do timeout");
  state = result.body;
  check(state.activePlayerId !== activeBeforeTimeout, "passar o turno após dez segundos");
  check(state.errors === errorsBeforeTimeout, "não contar timeout como erro da forca");

  const invalidReconnect = await get(host, `wrong-${host.clientId}`);
  check(invalidReconnect.status === 401, "recusar token em outro dispositivo");
  const reconnect = await get(host);
  check(reconnect.ok && reconnect.body.code === host.code, "reconectar sessão válida");
  state = reconnect.body;

  let guessIndex = 0;
  while (state.status === "playing") {
    const turn = sessionFor(sessions, state.activePlayerId);
    result = await action(turn, "guess", { guess: `PALPITEINVALIDO${guessIndex++}` });
    check(result.ok, `processar palpite incorreto ${guessIndex}`);
    state = result.body;
  }
  check(state.status === "round_end" && state.errors === 6, "encerrar rodada ao completar seis erros");
  check(state.roundEndReason === "hangman" && !state.masked.includes("_"), "revelar palavra somente no fim da rodada");
  const gap = state.roundEndsAt - Date.now();
  check(gap > 8_000 && gap <= 10_500, "exibir ranking por dez segundos entre rodadas");

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, gap + 500)));
  result = await get(host);
  check(result.ok && result.body.round === 2 && result.body.status === "playing", "iniciar segunda rodada automaticamente");
  check(result.body.difficulty === "difícil", "alternar para dificuldade difícil na segunda rodada");
  check(!Object.hasOwn(result.body, "word"), "manter palavra da segunda rodada protegida");
}

async function testThreePlayers() {
  const host = await create(`M${runId}`, 0);
  const p2 = await join(host, `N${runId}`, 1);
  await join(host, `P${runId}`, 2);
  const started = await action(host, "start");
  check(started.ok && started.body.players.length === 3, "iniciar e sincronizar partida com três jogadores");
  const wrongClient = await action({ ...p2, clientId: `clone-${p2.clientId}` }, "letter", { letter: "A" });
  check(wrongClient.status === 400, "bloquear ação com sessão clonada");
}

try {
  console.log(`Testando ${BASE}`);
  await testStaticFiles();
  await testFourPlayers();
  await testRoundLifecycle();
  await testThreePlayers();
  console.log(`\n${checks.length} verificações concluídas com sucesso.`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.stack : error}`);
  process.exitCode = 1;
}
