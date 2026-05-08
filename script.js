/**
 * SCRIPT DE GESTION DE RÉGATE - CVBS
 * Version 4.0
 *
 * Corrections v4 :
 * - Broadcast état complet à chaque changement (display.html se met à jour en temps réel)
 * - Bouton Options/Annuler caché pendant le paramétrage, visible après ouverture ligne
 * - Fix display.html : reçoit l'état immédiatement à la connexion
 */

let ws, connected = false, mockMode = false;

// État global complet — envoyé à display.html à chaque changement
let currentState = {
  flags:     {},
  header:    "⛵ Régate CBVS",
  countdown: ""
};

let tProcedure, tStart, tRecall, tFinish, tRecallIndTimer, tRecallGenTimer;

let finishStarted = false, raceStartTime = null, finishList = [];
let recallIndActive = false, recallGenActive = false;
let lineOpen = false, raceEnded = false;

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
      // Envoyer l'état actuel dès la connexion
      broadcastState();
    };
    ws.onerror = ws.onclose = () => enableMock();
    ws.onmessage = (e) => {
      let d = JSON.parse(e.data);
      if (d.type === "RESET")             resetAll();
      if (d.type === "RECALL_INDIVIDUAL") handleRecallIndividual();
      if (d.type === "RECALL_GENERAL")    handleRecallGeneral();
      // Quand display.html se connecte, il envoie REQUEST_STATE
      if (d.type === "REQUEST_STATE")     broadcastState();
    };
  } catch(e) { enableMock(); }
}
connectWS();

function enableMock() { if (mockMode) return; mockMode = true; setStatus("⚠️ Mode simulation PC"); }
function setStatus(t) { document.getElementById("status").innerText = t; }

function send(msg) {
  if (mockMode) { console.log("MOCK:", msg); return; }
  if (connected) ws.send(JSON.stringify(msg));
}

/**
 * Diffuse l'état complet à tous les clients connectés (dont display.html)
 */
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
  if (x)     html += '<img src="images/Pav_X.svg"         alt="Rappel individuel">';
  if (ap)    html += '<img src="images/1er_substitut.svg" alt="Rappel général">';
  if (bleu)  html += '<img src="images/Pav_bleur.svg" alt="Drapeau bleu">';
  if (n)     html += '<img src="images/Pav_N.svg"         alt="Pavillon N">';
  if (a)     html += '<img src="images/Pav_A.svg"         alt="Pavillon A">';
  if (apert) html += '<img src="images/Pav_A.svg"    alt="Aperçu">';
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

  // Afficher le bouton Options maintenant que la course est lancée
  showBtn("btnOptions");

  let delay = parseInt(document.getElementById("openToProcedure").value || 1) * 60;
  setHeader("🚩 Ligne ouverte");
  updateFlags({ orange:true });
  showBtn("btnApercu");
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  startProcedure(delay);
}

// ===================== APERÇU =====================
function sendApercu() {
  clearInterval(tProcedure); clearInterval(tStart);
  setHeader("⚓ Aperçu — Retard de départ");
  updateFlags({ orange:true, apert:true });
  send({ type:"BEEP_DOUBLE" }); playSequence("SON_COURT", 2);
  document.getElementById("countdown").innerText = "";
  currentState.countdown = "";
  hideBtn("btnApercu");
  showBtn("btnAffaleeApercu");
}

function affaleeApercu() {
  hideBtn("btnAffaleeApercu");
  updateFlags({ orange:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  setHeader("⏳ Signal avertissement dans 1 min");
  let sec = 60;
  clearInterval(tProcedure);
  tProcedure = setInterval(() => {
    updateCountdown(sec, "Signal avertissement dans");
    if (sec <= 0) { clearInterval(tProcedure); startProcedureUI(); }
    sec--;
  }, 1000);
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

function startProcedureUI() {
  showBtn("btnApercu");
  setHeader("⚠️ Signal d'Avertissement — T-5");
  updateFlags({ orange:true, classFlag:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  startStart(300);
}

// ===================== TIMER T-5 → T0 =====================
function startStart(sec) {
  clearInterval(tStart);
  tStart = setInterval(() => {
    updateCountdown(sec, "DÉPART DANS");
    if (sec === 240) {
      updateFlags({ orange:true, classFlag:true, prep:document.getElementById("prepFlag").value });
      send({ type:"BEEP_COURT" }); playSound("SON_COURT");
    }
    if (sec === 60) {
      updateFlags({ orange:true, classFlag:true, prep:null });
      send({ type:"BEEP_LONG" }); playSound("SON_LONG");
    }
    if (sec === 0) { clearInterval(tStart); hideBtn("btnApercu"); startRaceUI(); return; }
    sec--;
  }, 1000);
}

// ===================== COURSE =====================
function startRaceUI() {
  setHeader("🏁 Course en cours");
  updateFlags({ orange:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  lineOpen = true;
  raceStartTime = new Date();
  document.getElementById("startTimeDisplay").innerText = "⏱ Départ officiel : " + raceStartTime.toLocaleTimeString();
  document.getElementById("raceBtns").style.display = "block";
  showBtn("btnRecallInd"); showBtn("btnRecallGen");
  startRecallTimer(240);
}

// ===================== FERMETURE LIGNE =====================
function startRecallTimer(sec) {
  clearInterval(tRecall);
  tRecall = setInterval(() => {
    if (sec <= 0) {
      clearInterval(tRecall);
      document.getElementById("countdown").innerText = "";
      currentState.countdown = "";
      hideBtn("btnRecallInd"); hideBtn("btnRecallGen"); hideBtn("btnCancelRecallInd");
      updateFlags({ orange:false });
      lineOpen = false;
      setHeader("🔒 Ligne fermée");
      showBtn("btnFinish");
      return;
    }
    updateCountdown(sec, "Fermeture ligne dans");
    sec--;
  }, 1000);
}

// ===================== RAPPEL INDIVIDUEL =====================
function recallIndividual() { send({ type:"RECALL_INDIVIDUAL" }); handleRecallIndividual(); }

function handleRecallIndividual() {
  recallIndActive = true;
  updateFlags({ orange:true, x:true });
  send({ type:"BEEP_COURT" }); playSound("SON_COURT");
  setHeader("⚠️ Rappel individuel");
  hideBtn("btnRecallGen");
  showBtn("btnCancelRecallInd");
  hideBtn("btnRecallInd");
  clearTimeout(tRecallIndTimer);
  tRecallIndTimer = setTimeout(() => {
    if (recallIndActive) setHeader("⚠️ Rappel individuel — 45s dépassées");
  }, 45000);
}

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
function recallGeneral() { send({ type:"RECALL_GENERAL" }); handleRecallGeneral(); }

function handleRecallGeneral() {
  recallGenActive = true;
  updateFlags({ orange:true, ap:true });
  send({ type:"BEEP_DOUBLE" }); playSequence("SON_COURT", 2);
  setHeader("🚨 Rappel général");
  hideBtn("btnRecallInd"); hideBtn("btnCancelRecallInd");
  clearTimeout(tRecallGenTimer);
  tRecallGenTimer = setTimeout(() => {
    if (recallGenActive) setHeader("🚨 Rappel général — 105s dépassées");
  }, 105000);
  showBtn("btnAffaleeApercu");
}

// ===================== ARRIVÉES =====================
function finishRace() { send({ type:"FINISH" }); handleFinish(); }

function handleFinish() {
  let now = new Date();
  if (!finishStarted) {
    finishStarted = true;
    updateFlags({ bleu:true });
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
  hideBtn("btnApercu"); hideBtn("btnAffaleeApercu"); hideBtn("btnFinish");
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
  hideBtn("btnApercu"); hideBtn("btnAffaleeApercu"); hideBtn("btnFinish");
  raceEnded = true;
}

function relancerCourse() {
  hideCancelMenu();
  _resetRaceData();
  hideBtn("btnRestart"); hideBtn("btnFinish");
  hideBtn("btnApercu"); hideBtn("btnAffaleeApercu"); hideBtn("btnCancelRecallInd");
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

// Réinitialise uniquement les données de course (pas l'UI globale)
function _resetRaceData() {
  finishStarted = false; finishList = []; raceStartTime = null;
  recallIndActive = false; recallGenActive = false;
  lineOpen = false; raceEnded = false;
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
  lineOpen = false; raceEnded = false;

  setHeader("⛵ Paramétrage Régate ⛵");
  currentState.flags    = {};
  currentState.countdown = "";

  document.getElementById("raceBtns").style.display     = "none";
  document.getElementById("countdown").innerText        = "";
  document.getElementById("flags").innerHTML            = "";
  document.getElementById("finishList").innerHTML       = "";
  document.getElementById("startTimeDisplay").innerHTML = "";
  document.getElementById("cancelMenu").style.display   = "none";

  hideBtn("btnOptions");        // cacher le bouton Options pendant le paramétrage
  hideBtn("btnApercu"); hideBtn("btnAffaleeApercu");
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
