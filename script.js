/**
 * SCRIPT DE GESTION DE RÉGATE - CVBS
 * Version 5.0
 *
 * Modifications v5 :
 * - Rappel général : arrête tous les timers de course
 * - Affalée 1er substitut (rappel général) : 1 son → relance procédure 1 min après
 * - Renommage bouton "Affalée aperçu" → contexte selon usage (aperçu ou rappel général)
 * - Nettoyage et cohérence générale
 */

let ws, connected = false, mockMode = false;

// État global complet — envoyé à display.html à chaque changement
let currentState = {
  flags:     {},
  header:    "⛵ Régate CBVS",
  countdown: ""
};

let tProcedure, tStart, tRecall, tFinish, tRecallIndTimer, tRecallGenTimer;

let finishStarted   = false;
let raceStartTime   = null;
let finishList      = [];
let recallIndActive = false;
let recallGenActive = false;
let lineOpen        = false;
let raceEnded       = false;

// Contexte du bouton "Descendre pavillon" :
// "apercu" ou "general" — détermine le comportement à l'affalée
let affaleeContext  = "";

// ===================== AUDIO =====================
let audioCtx;
document.addEventListener("click", () => {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
});

function playSound(event) {
  if (!audioCtx) return;
  const config = { SON_COURT: { freq:700, dur:0.25 }, SON_LONG: { freq:700, dur:0.6 } };
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
function updateFlags({ orange, classFlag, prep, x, ap, bleu, n, a, apert } = {}) {
  currentState.flags = { orange, classFlag, prep, x, ap, bleu, n, a, apert };
  let html = "";
  if (orange)    html += '<img src="images/Pav_orange.svg"  alt="Orange">';
  if (classFlag) html += '<img src="images/Pav_VNO.svg"     alt="Classe">';
  if (prep) {
    let file = { "P":"Pav_P.svg","I":"Pav_I.svg","U":"Pav_U.svg","BLACK":"Pav_noir.svg" }[prep];
    if (file) html += `<img src="images/${file}" alt="${prep}">`;
  }
  if (x)     html += '<img src="images/Pav_X.svg"          alt="Rappel individuel">';
  if (ap)    html += '<img src="images/1er_substitut.svg"  alt="Rappel général">';
  if (bleu)  html += '<img src="images/Pav_bleu.svg"      alt="Drapeau bleu">';
  if (n)     html += '<img src="images/Pav_N.svg"          alt="Pavillon N">';
  if (a)     html += '<img src="images/Pav_A.svg"          alt="Pavillon A">';
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

// ===================== APERÇU (RETARD AVANT DÉPART) =====================
/**
 * Aperçu = retard de départ avant T0
 * 2 sons au hissage, 1 son à l'affalée
 * 1 min après affalée → signal d'avertissement (relance T-5)
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
  // Bouton affalée avec libellé aperçu
  document.getElementById("btnAffalee").innerText = "🔽 Descendre l'aperçu (1 son)";
  showBtn("btnAffalee");
}

// ===================== AFFALÉE (APERÇU OU 1er SUBSTITUT) =====================
/**
 * Bouton unique d'affalée — comportement selon contexte :
 * - "apercu"  : affalée du pavillon aperçu → relance procédure dans 1 min
 * - "general" : affalée du 1er substitut  → relance procédure dans 1 min
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
  }

  // Dans les 2 cas : compte à rebours 1 min → relance T-5
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
function startProcedureUI() {
  showBtn("btnApercu");
  setHeader("⚠️ Procèdure de départ — T-5");
  updateFlags({ orange:true, classFlag:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  startStart(300);
}

// ===================== TIMER T-5 → T0 =====================
function startStart(sec) {
  clearInterval(tStart);
  tStart = setInterval(() => {
    updateCountdown(sec, "DÉPART DANS");

    // T-4 : Pavillon préparatoire
    if (sec === 240) {
      updateFlags({ orange:true, classFlag:true, prep:document.getElementById("prepFlag").value });
      send({ type:"BEEP_COURT" }); playSound("SON_COURT");
    }

    // T-1 : Affalée pavillon préparatoire
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

// ===================== FERMETURE LIGNE (4 MIN) =====================
function startRecallTimer(sec) {
  clearInterval(tRecall);
  tRecall = setInterval(() => {
    if (sec <= 0) {
      clearInterval(tRecall);
      document.getElementById("countdown").innerText = "";
      currentState.countdown = "";
      hideBtn("btnRecallInd");
      hideBtn("btnRecallGen");
      hideBtn("btnCancelRecallInd");
      updateFlags({ orange:false });
      updateFlags({ bleu:true });
      lineOpen = false;
      setHeader("🔒 Ligne départ fermée");
      showBtn("btnFinish");
      return;
    }
    updateCountdown(sec, "Fermeture ligne départ dans");
    sec--;
  }, 1000);
}

// ===================== RAPPEL INDIVIDUEL =====================
/**
 * Rappel individuel = Pavillon X
 * 1 son — le comité a ~45s pour l'identifier
 * Retrait manuel = 1 son — masque tous les boutons rappel après
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
  clearTimeout(tRecallIndTimer);
  tRecallIndTimer = setTimeout(() => {
    if (recallIndActive) setHeader("⚠️ Rappel individuel — 45s dépassées");
  }, 45000);
}

/**
 * Retirer le rappel individuel
 * 1 son — masque tous les boutons rappel
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

// ===================== RAPPEL GÉNÉRAL =====================
/**
 * Rappel général = 1er substitut
 * 2 sons au hissage
 * ARRÊTE tous les timers de course (chrono, fermeture ligne)
 * Affalée = 1 son → relance procédure 1 min après
 */
function recallGeneral() {
  send({ type:"RECALL_GENERAL" });
  handleRecallGeneral();
}

function handleRecallGeneral() {
  recallGenActive = true;

  // ARRÊTER tous les timers de course
  clearInterval(tRecall);
  clearInterval(tFinish);
  clearTimeout(tRecallIndTimer);

  // Vider countdown ET heure de départ
  document.getElementById("countdown").innerText        = "";
  document.getElementById("startTimeDisplay").innerText = ""; // ← ajouter cette ligne
  currentState.countdown = "";
  raceStartTime = null; // ← réinitialiser aussi l'heure de départ

  updateFlags({ orange:true, ap:true });
  send({ type:"BEEP_DOUBLE" }); playSequence("SON_COURT", 2);
  setHeader("🚨 Rappel général — En attente d'affalée");

  // Masquer tous les boutons rappel et course
  hideBtn("btnRecallInd");
  hideBtn("btnRecallGen");
  hideBtn("btnCancelRecallInd");
  hideBtn("btnFinish");

  clearTimeout(tRecallGenTimer);
  tRecallGenTimer = setTimeout(() => {
    if (recallGenActive) setHeader("🚨 Rappel général — 105s dépassées");
  }, 105000);

  // Bouton affalée avec libellé 1er substitut
  affaleeContext = "general";
  document.getElementById("btnAffalee").innerText = "🔽 Descendre le 1er substitut (1 son)";
  showBtn("btnAffalee");
}

// ===================== ARRIVÉES =====================
function finishRace() { send({ type:"FINISH" }); handleFinish(); }

function handleFinish() {
  let now = new Date();

  if (!finishStarted) {
    finishStarted = true;
   
    let sec = parseInt(document.getElementById("finishLimit").value || 20) * 60;
    setHeader("🏁 Arrivées en cours");
    clearInterval(tFinish);
    tFinish = setInterval(() => {
      if (sec <= 0) {
        clearInterval(tFinish);
        updateFlags({ orange:false });
        setHeader("⛔ Course terminée");
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

  send({ type:"BEEP_COURT" }); playSound("SON_COURT");

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

function cancelRace() {
  hideCancelMenu();
  clearInterval(tProcedure); clearInterval(tStart);
  clearInterval(tRecall);    clearInterval(tFinish);
  updateFlags({ a:true, n:true });
  playSequence("SON_COURT", 3, 500);
  send({ type:"BEEP_TRIPLE" });
  setHeader("🚫 Course annulée — Pav. N/A");
  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  broadcastState();
  document.getElementById("raceBtns").style.display = "none";
  hideBtn("btnApercu"); hideBtn("btnAffalee"); hideBtn("btnFinish");
  showBtn("btnRestart");
  raceEnded = true;
}

function endRegatta() {
  hideCancelMenu();
  clearInterval(tProcedure); clearInterval(tStart);
  clearInterval(tRecall);    clearInterval(tFinish);
  updateFlags({ a:true, n:true });
  playSequence("SON_COURT", 3, 500);
  send({ type:"BEEP_TRIPLE" });
  setHeader("🏴 Régate terminée — Pav. N/A");
  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  broadcastState();
  document.getElementById("raceBtns").style.display = "none";
  hideBtn("btnApercu"); hideBtn("btnAffalee"); hideBtn("btnFinish");
  raceEnded = true;
}

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
  finishStarted   = false; finishList = []; raceStartTime = null;
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
