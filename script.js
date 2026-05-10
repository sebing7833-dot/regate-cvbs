/**
 * SCRIPT DE GESTION DE RÉGATE - CVBS
 * Version 6.0 — Conforme aux procédures FFVoile officielles
 *
 * Corrections v6 :
 * - Drapeau bleu déplacé à la fermeture de ligne (pas au 1er arrivant)
 * - Retrait automatique rappel individuel à 4 min (RCV 29.1)
 * - Menu Options : 3 cas distincts N / N sur H / N sur A
 * - N seul : orange reste envoyé + relance procédure dans 1 min
 * - Pavillon H ajouté dans updateFlags()
 */

let ws, connected = false, mockMode = false;

let currentState = { flags:{}, header:"⛵ Régate CBVS", countdown:"" };

let tProcedure, tStart, tRecall, tFinish, tRecallIndTimer, tRecallGenTimer;

let finishStarted   = false;
let raceStartTime   = null;
let finishList      = [];
let recallIndActive = false;
let recallGenActive = false;
let lineOpen        = false;
let raceEnded       = false;
let affaleeContext  = ""; // "apercu" ou "general" ou "n"

// ===================== AUDIO =====================
let audioCtx;
document.addEventListener("click", () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
});

function playSound(event) {
  if (!audioCtx) return;
  const config = {
    SON_COURT: { freq:700, dur:0.25 },
    SON_LONG:  { freq:700, dur:0.6  }
  };
  let s = config[event] || { freq:700, dur:0.2 };
  let osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = "sine"; osc.frequency.value = s.freq; gain.gain.value = 0.25;
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(); osc.stop(audioCtx.currentTime + s.dur);
}

function playSequence(event, count, gap = 400) {
  for (let i = 0; i < count; i++) setTimeout(() => playSound(event), i * gap);
}

// ===================== WEBSOCKET =====================
let timeout = setTimeout(() => { if (!connected) enableMock(); }, 1500);

function connectWS() {
  try {
    ws = new WebSocket("ws://" + location.hostname + ":81/");
    ws.onopen = () => {
      connected = true;
      clearTimeout(timeout);
      setStatus("🟢 ESP32 connecté");
      broadcastState();
    };
    ws.onerror = ws.onclose = () => enableMock();
    ws.onmessage = (e) => {
      let d = JSON.parse(e.data);
      if (d.type === "RESET")             resetAll();
      if (d.type === "RECALL_INDIVIDUAL") handleRecallIndividual();
      if (d.type === "RECALL_GENERAL")    handleRecallGeneral();
      if (d.type === "REQUEST_STATE")     broadcastState();
    };
  } catch(e) { enableMock(); }
}
connectWS();

function enableMock() {
  if (mockMode) return;
  mockMode = true;
  setStatus("⚠️ Mode simulation PC");
}
function setStatus(t) { document.getElementById("status").innerText = t; }

function send(msg) {
  if (mockMode) { console.log("MOCK:", msg); return; }
  if (connected) ws.send(JSON.stringify(msg));
}

function broadcastState() {
  send({
    type:      "STATE",
    flags:     currentState.flags,
    header:    currentState.header,
    countdown: currentState.countdown
  });
}

// ===================== PAVILLONS =====================
/**
 * Met à jour les pavillons affichés
 * orange    : Pavillon orange (ligne ouverte / arrivée)
 * classFlag : Pavillon de classe (VNO)
 * prep      : Préparatoire (P, I, U, BLACK)
 * x         : Pavillon X (rappel individuel)
 * ap        : 1er substitut (rappel général)
 * bleu      : Pavillon bleu (ligne d'arrivée ouverte)
 * n         : Pavillon N (annulation)
 * a         : Pavillon A (plus de courses aujourd'hui)
 * h         : Pavillon H (signaux à terre)
 * apert     : Aperçu (retard)
 */
function updateFlags({ orange, classFlag, prep, x, ap, bleu, n, a, h, apert } = {}) {
  currentState.flags = { orange, classFlag, prep, x, ap, bleu, n, a, h, apert };
  let html = "";
  if (orange)    html += '<img src="images/Pav_orange.svg"  alt="Orange">';
  if (classFlag) html += '<img src="images/Pav_VNO.svg"     alt="Classe">';
  if (prep) {
    let file = { "P":"Pav_P.svg","I":"Pav_I.svg","U":"Pav_U.svg","BLACK":"Pav_noir.svg" }[prep];
    if (file) html += `<img src="images/${file}" alt="${prep}">`;
  }
  if (x)     html += '<img src="images/Pav_X.svg"          alt="Rappel individuel">';
  if (ap)    html += '<img src="images/1er_substitut.svg"  alt="Rappel général">';
  if (bleu)  html += '<img src="images/Pav_bleu.svg"       alt="Pavillon bleu">';
  if (n)     html += '<img src="images/Pav_N.svg"          alt="Pavillon N">';
  if (a)     html += '<img src="images/Pav_A.svg"          alt="Pavillon A">';
  if (h)     html += '<img src="images/Pav_H.svg"          alt="Pavillon H">';
  if (apert) html += '<img src="images/Pav_apercu.svg"     alt="Aperçu">';
  document.getElementById("flags").innerHTML = html;
  broadcastState();
}

// ===================== OUVERTURE LIGNE =====================
function openLine() {
  send({ type:"OPEN_LINE" });
  openLineUI();
}

function openLineUI() {
  hideSetup();
  raceEnded = false;
  showBtn("btnOptions");
  let delay = parseInt(document.getElementById("openToProcedure").value || 1) * 60;
  setHeader("🚩 Ligne ouverte");
  updateFlags({ orange:true });
  showBtn("btnApercu");
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  startProcedure(delay);
}

// ===================== APERÇU (RETARD) =====================
/**
 * RCV 27.3 — Aperçu = retard
 * 2 sons au hissage, 1 son à l'affalée
 * Relance signal avertissement 1 min après affalée
 */
function sendApercu() {
  clearInterval(tProcedure);
  clearInterval(tStart);
  affaleeContext = "apercu";
  setHeader("⚓ Aperçu — Retard de départ");
  updateFlags({ orange:true, apert:true });
  send({ type:"BEEP_DOUBLE" }); playSequence("SON_COURT", 2);
  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  hideBtn("btnApercu");
  document.getElementById("btnAffalee").innerText = "🔽 Descendre l'aperçu (1 son)";
  showBtn("btnAffalee");
}

// ===================== AFFALÉE UNIQUE (APERÇU / 1er SUBSTITUT / N) =====================
/**
 * Comportement selon affaleeContext :
 * "apercu"  → relance T-5 dans 1 min
 * "general" → relance T-5 dans 1 min (orange reste envoyé)
 * "n"       → relance T-5 dans 1 min (orange reste envoyé)
 */
function affaleeAction() {
  hideBtn("btnAffalee");
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");

  if (affaleeContext === "apercu") {
    updateFlags({ orange:true });
    setHeader("⏳ Signal avertissement dans 1 min");
  } else if (affaleeContext === "general") {
    updateFlags({ orange:true });
    setHeader("⏳ Relance procédure dans 1 min");
  } else if (affaleeContext === "n") {
    // Après N seul : orange reste, relance dans 1 min
    updateFlags({ orange:true });
    setHeader("⏳ Signal avertissement dans 1 min");
  }

  // Dans tous les cas : 1 min → relance T-5
  let sec = 60;
  clearInterval(tProcedure);
  tProcedure = setInterval(() => {
    updateCountdown(sec, "Signal avertissement dans");
    if (sec <= 0) {
      clearInterval(tProcedure);
      startProcedureUI();
    }
    sec--;
  }, 1000);

  affaleeContext = "";
}

// ===================== PROCÉDURE =====================
function startProcedure(sec) {
  clearInterval(tProcedure);
  tProcedure = setInterval(() => {
    updateCountdown(sec, "Procédure de départ dans");
    if (sec <= 0) { clearInterval(tProcedure); startProcedureUI(); }
    sec--;
  }, 1000);
}

// ===================== T-5 SIGNAL AVERTISSEMENT =====================
/**
 * RCV 26 — 1 son au hissage du pavillon de classe
 */
function startProcedureUI() {
  showBtn("btnApercu");
  setHeader("⚠️ Signal d'Avertissement — T-5");
  updateFlags({ orange:true, classFlag:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  startStart(300);
}

// ===================== TIMER T-5 → T0 =====================
/**
 * RCV 26 :
 * T-4 : hissage préparatoire — 1 son
 * T-1 : affalée préparatoire — 1 son long
 * T0  : affalée classe — 1 son (départ)
 */
function startStart(sec) {
  clearInterval(tStart);
  tStart = setInterval(() => {
    updateCountdown(sec, "DÉPART DANS");

    // T-4 : Signal préparatoire
    if (sec === 240) {
      updateFlags({ orange:true, classFlag:true, prep:document.getElementById("prepFlag").value });
      send({ type:"BEEP_COURT" }); playSound("SON_COURT");
    }

    // T-1 : Affalée préparatoire
    if (sec === 60) {
      updateFlags({ orange:true, classFlag:true, prep:null });
      send({ type:"BEEP_LONG" }); playSound("SON_LONG");
    }

    // T0 : DÉPART
    if (sec === 0) {
      clearInterval(tStart);
      hideBtn("btnApercu");
      startRaceUI();
      return;
    }
    sec--;
  }, 1000);
}

// ===================== COURSE EN COURS =====================
function startRaceUI() {
  setHeader("🏁 Course en cours");
  updateFlags({ orange:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  lineOpen      = true;
  raceStartTime = new Date();
  document.getElementById("startTimeDisplay").innerText =
    "⏱ Départ officiel : " + raceStartTime.toLocaleTimeString();
  document.getElementById("raceBtns").style.display = "block";
  showBtn("btnRecallInd");
  showBtn("btnRecallGen");
  startRecallTimer(240);
}

// ===================== FERMETURE LIGNE 4 MIN (RCV 29.1) =====================
/**
 * RCV 29.1 : pavillon X affalé au plus tard 4 min après départ
 * Pavillon orange affalé = fermeture ligne de départ
 * Pavillon bleu envoyé = ligne d'arrivée ouverte (procédure arrivée FFVoile)
 */
function startRecallTimer(sec) {
  clearInterval(tRecall);
  tRecall = setInterval(() => {
    if (sec <= 0) {
      clearInterval(tRecall);

      // ✅ CORRECTION : retrait automatique rappel individuel à 4 min (RCV 29.1)
      if (recallIndActive) {
        recallIndActive = false;
        clearTimeout(tRecallIndTimer);
        setHeader("🔒 Ligne départ fermée");
      } else {
        setHeader("🔒 Ligne départ fermée");
      }

      hideBtn("btnRecallInd");
      hideBtn("btnRecallGen");
      hideBtn("btnCancelRecallInd");

      // ✅ CORRECTION : orange affalé, pavillon bleu hissé à fermeture (procédure arrivée FFVoile)
      updateFlags({ bleu:true });

      lineOpen = false;

      document.getElementById("countdown").innerText = "";
      currentState.countdown = "";

      // Bouton arrivée visible maintenant
      showBtn("btnFinish");
      return;
    }
    updateCountdown(sec, "Fermeture ligne dans");
    sec--;
  }, 1000);
}

// ===================== RAPPEL INDIVIDUEL (RCV 29.1) =====================
/**
 * 1 son au hissage du pavillon X
 * Pavillon X affalé automatiquement à 4 min (géré par startRecallTimer)
 * ou manuellement avec 1 son
 */
function recallIndividual() {
  send({ type:"RECALL_INDIVIDUAL" });
  handleRecallIndividual();
}

function handleRecallIndividual() {
  recallIndActive = true;
  updateFlags({ orange:true, x:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  setHeader("⚠️ Rappel individuel");
  hideBtn("btnRecallInd");
  hideBtn("btnRecallGen");
  showBtn("btnCancelRecallInd");

  // Alerte à 45s (délai recommandé)
  clearTimeout(tRecallIndTimer);
  tRecallIndTimer = setTimeout(() => {
    if (recallIndActive) setHeader("⚠️ Rappel individuel — 45s dépassées");
  }, 45000);
}

/**
 * Retrait manuel rappel individuel — 1 son
 * Masque tous les boutons rappel après (bateaux rappelés ou non identifiés)
 */
function cancelRecallIndividual() {
  recallIndActive = false;
  clearTimeout(tRecallIndTimer);
  updateFlags({ orange:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  setHeader("🏁 Course en cours");
  hideBtn("btnCancelRecallInd");
  hideBtn("btnRecallInd");
  hideBtn("btnRecallGen");
}

// ===================== RAPPEL GÉNÉRAL (RCV 29.2) =====================
/**
 * 1er substitut — 2 sons au hissage
 * Arrête tous les timers de course
 * 1 son à l'affalée → relance procédure 1 min après
 */
function recallGeneral() {
  send({ type:"RECALL_GENERAL" });
  handleRecallGeneral();
}

function handleRecallGeneral() {
  recallGenActive = true;

  // Arrêter tous les timers de course
  clearInterval(tRecall);
  clearInterval(tFinish);
  clearTimeout(tRecallIndTimer);

  // Vider countdown et heure de départ (départ annulé)
  document.getElementById("countdown").innerText        = "";
  document.getElementById("startTimeDisplay").innerText = "";
  currentState.countdown = "";
  raceStartTime = null;

  updateFlags({ orange:true, ap:true });
  send({ type:"BEEP_DOUBLE" }); playSequence("SON_COURT", 2);
  setHeader("🚨 Rappel général — En attente d'affalée");

  hideBtn("btnRecallInd");
  hideBtn("btnRecallGen");
  hideBtn("btnCancelRecallInd");
  hideBtn("btnFinish");

  // Alerte à 105s (délai recommandé)
  clearTimeout(tRecallGenTimer);
  tRecallGenTimer = setTimeout(() => {
    if (recallGenActive) setHeader("🚨 Rappel général — 105s dépassées");
  }, 105000);

  affaleeContext = "general";
  document.getElementById("btnAffalee").innerText = "🔽 Descendre le 1er substitut (1 son)";
  showBtn("btnAffalee");
}

// ===================== ARRIVÉES =====================
function finishRace() {
  send({ type:"FINISH" });
  handleFinish();
}

function handleFinish() {
  let now = new Date();

  // Premier arrivant : lancer le timer temps limite
  // Le pavillon bleu est déjà hissé depuis la fermeture de ligne
  if (!finishStarted) {
    finishStarted = true;
    let sec = parseInt(document.getElementById("finishLimit").value || 20) * 60;
    setHeader("🏁 Arrivées en cours");
    clearInterval(tFinish);
    tFinish = setInterval(() => {
      if (sec <= 0) {
        clearInterval(tFinish);
        // Affalée pavillon bleu et orange = fermeture ligne d'arrivée
        updateFlags({});
        setHeader("⛔ Ligne d'arrivée fermée");
        document.getElementById("countdown").innerText = "";
        currentState.countdown = "";
        broadcastState();
        hideBtn("btnFinish");
        raceEnded = true;
        return;
      }
      updateCountdown(sec, "Temps limite arrivée");
      sec--;
    }, 1000);
  }

  // 1 son à chaque arrivée (courtoisie, non obligatoire selon FFVoile)
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");

  // Calcul temps de course
  let elapsedMs = now - raceStartTime;
  let totalSec  = Math.floor(elapsedMs / 1000);
  let raceTime  = `${Math.floor(totalSec/60)}:${(totalSec%60).toString().padStart(2,"0")}`;
  finishList.push({ realTime: now.toLocaleTimeString(), raceTime });
  renderFinishList();
}

function renderFinishList() {
  let html = "<h3>🏁 Arrivées</h3>";
  finishList.forEach((f,i) => {
    html += `<div class="finish-item">#${i+1} — ${f.realTime} — Temps : ${f.raceTime}</div>`;
  });
  document.getElementById("finishList").innerHTML = html;
}

// ===================== MENU OPTIONS =====================
function showCancelMenu() {
  document.getElementById("menuRelancerCourse").style.display = raceEnded ? "block" : "none";
  document.getElementById("cancelMenu").style.display = "block";
}

function hideCancelMenu() {
  document.getElementById("cancelMenu").style.display = "none";
}

function goToSetup() {
  hideCancelMenu();
  resetAll();
}

// ===================== ANNULATION N SEUL (RCV 27.3) =====================
/**
 * N seul = annulation, retour zone départ
 * Orange RESTE envoyé
 * 3 sons
 * Signal avertissement 1 min après affalée du N
 */
function cancelRaceN() {
  hideCancelMenu();
  clearInterval(tProcedure); clearInterval(tStart);
  clearInterval(tRecall);    clearInterval(tFinish);

  // Orange reste, N envoyé
  updateFlags({ orange:true, n:true });
  playSequence("SON_COURT", 3, 500);
  send({ type:"BEEP_TRIPLE" });
  setHeader("🚫 Annulation — Pav. N (retour zone départ)");

  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  document.getElementById("startTimeDisplay").innerText = "";
  broadcastState();

  document.getElementById("raceBtns").style.display = "none";
  hideBtn("btnApercu"); hideBtn("btnAffalee"); hideBtn("btnFinish");

  // Bouton affalée du N → relance dans 1 min
  affaleeContext = "n";
  document.getElementById("btnAffalee").innerText = "🔽 Descendre Pav. N (1 son) → relance dans 1 min";
  showBtn("btnAffalee");

  raceEnded = false; // relance possible
}

// ===================== ANNULATION N SUR H (RCV 32.1) =====================
/**
 * N/H = toutes courses annulées, signaux ultérieurs à terre
 * 3 sons
 */
function cancelRaceNH() {
  hideCancelMenu();
  clearInterval(tProcedure); clearInterval(tStart);
  clearInterval(tRecall);    clearInterval(tFinish);

  updateFlags({ n:true, h:true });
  playSequence("SON_COURT", 3, 500);
  send({ type:"BEEP_TRIPLE" });
  setHeader("🏠 Pav. N/H — Signaux ultérieurs à terre");

  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  document.getElementById("startTimeDisplay").innerText = "";
  broadcastState();

  document.getElementById("raceBtns").style.display = "none";
  hideBtn("btnApercu"); hideBtn("btnAffalee"); hideBtn("btnFinish");

  raceEnded = true;
}

// ===================== FIN DE RÉGATE N SUR A (RCV 32.1) =====================
/**
 * N/A = toutes courses annulées, plus de courses aujourd'hui
 * 3 sons
 */
function endRegattaNA() {
  hideCancelMenu();
  clearInterval(tProcedure); clearInterval(tStart);
  clearInterval(tRecall);    clearInterval(tFinish);

  updateFlags({ n:true, a:true });
  playSequence("SON_COURT", 3, 500);
  send({ type:"BEEP_TRIPLE" });
  setHeader("🏴 Pav. N/A — Plus de courses aujourd'hui");

  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  document.getElementById("startTimeDisplay").innerText = "";
  broadcastState();

  document.getElementById("raceBtns").style.display = "none";
  hideBtn("btnApercu"); hideBtn("btnAffalee"); hideBtn("btnFinish");

  raceEnded = true;
}

// ===================== RELANCER UNE COURSE =====================
function relancerCourse() {
  hideCancelMenu();
  _resetRaceData();
  hideBtn("btnRestart"); hideBtn("btnFinish");
  hideBtn("btnApercu");  hideBtn("btnAffalee"); hideBtn("btnCancelRecallInd");
  document.getElementById("raceBtns").style.display = "block";
  showBtn("btnRecallInd"); showBtn("btnRecallGen");
  openLineUI();
}

function restartProcedure() {
  hideBtn("btnRestart");
  _resetRaceData();
  updateFlags({ orange:true });
  setHeader("🚩 Relance — Ligne ouverte");
  document.getElementById("raceBtns").style.display = "block";
  showBtn("btnRecallInd"); showBtn("btnRecallGen"); showBtn("btnApercu");
  let delay = parseInt(document.getElementById("openToProcedure").value || 1) * 60;
  startProcedure(delay);
}

function _resetRaceData() {
  finishStarted   = false; finishList = []; raceStartTime = null;
  recallIndActive = false; recallGenActive = false;
  lineOpen = false; raceEnded = false; affaleeContext = "";
  document.getElementById("finishList").innerHTML       = "";
  document.getElementById("startTimeDisplay").innerHTML = "";
  document.getElementById("countdown").innerText        = "";
  currentState.countdown = "";
}

// ===================== UI =====================
function setHeader(t) {
  currentState.header = t;
  document.getElementById("header").innerText = t;
  broadcastState();
}

function updateCountdown(sec, label) {
  let m = Math.floor(sec/60), s = sec%60;
  let txt = `${label} ${m}:${s.toString().padStart(2,"0")}`;
  currentState.countdown = txt;
  document.getElementById("countdown").innerText = txt;
  broadcastState();
}

function showBtn(id) { let el = document.getElementById(id); if (el) el.style.display = "block"; }
function hideBtn(id) { let el = document.getElementById(id); if (el) el.style.display = "none";  }

// ===================== RESET COMPLET =====================
function resetAll() {
  clearInterval(tProcedure); clearInterval(tStart);
  clearInterval(tRecall);    clearInterval(tFinish);
  clearTimeout(tRecallIndTimer); clearTimeout(tRecallGenTimer);
  finishStarted = false; finishList = []; raceStartTime = null;
  recallIndActive = false; recallGenActive = false;
  lineOpen = false; raceEnded = false; affaleeContext = "";

  setHeader("⛵ Paramétrage Régate ⛵");
  currentState.flags     = {};
  currentState.countdown = "";

  document.getElementById("raceBtns").style.display     = "none";
  document.getElementById("countdown").innerText        = "";
  document.getElementById("flags").innerHTML            = "";
  document.getElementById("finishList").innerHTML       = "";
  document.getElementById("startTimeDisplay").innerHTML = "";
  document.getElementById("cancelMenu").style.display   = "none";

  hideBtn("btnOptions");
  hideBtn("btnApercu"); hideBtn("btnAffalee");
  hideBtn("btnCancelRecallInd"); hideBtn("btnFinish"); hideBtn("btnRestart");
  showBtn("btnRecallInd"); showBtn("btnRecallGen");

  broadcastState();
  showSetup();
}

function hideSetup() {
  document.getElementById("setup").style.display   = "none";
  document.getElementById("openBtn").style.display = "none";
}
function showSetup() {
  document.getElementById("setup").style.display   = "block";
  document.getElementById("openBtn").style.display = "block";
}

function cancelAll() { showCancelMenu(); }
