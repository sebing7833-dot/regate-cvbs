/**
 * SCRIPT DE GESTION DE RÉGATE - CVBS
 * Ce fichier gère la logique du chronomètre, l'interface utilisateur
 * et la communication WebSocket avec l'ESP32.
 */

let ws;
let connected = false; // État de la connexion avec l'ESP32
let mockMode = false;  // Mode simulation si l'ESP32 n'est pas trouvé

// Variables pour les timers (intervalles)
let tProcedure, tStart, tRecall, tFinish;

// État de la phase d'arrivée
let finishStarted = false;

// =====================
// 🔊 MOTEUR SONORE (Navigateur)
// =====================
// [Technique] Utilise l'API Web Audio pour générer des sons sans fichiers MP3.
let audioCtx;

// Débloquer l'audio au premier clic (exigence de sécurité des navigateurs mobiles)
document.addEventListener("click", () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
});

/**
 * Génère un bip sonore sur le haut-parleur du téléphone.
 * [Fonctionnel] Permet au comité de course d'entendre le signal même s'il est loin du klaxon.
 */
function playSound(event) {
  if (!audioCtx) return;

  const config = {
    SON_COURT: { freq: 700, dur: 0.25 },
    SON_LONG: { freq: 700, dur: 0.5 },
  };

  let s = config[event] || { freq: 700, dur: 0.2 };

  let osc = audioCtx.createOscillator();
  let gain = audioCtx.createGain();

  osc.type = "sine";
  osc.frequency.value = s.freq;
  gain.gain.value = 0.25;

  osc.connect(gain);
  gain.connect(audioCtx.destination);

  osc.start();
  osc.stop(audioCtx.currentTime + s.dur);
}

/**
 * Joue une série de bips (ex: 2 bips pour un rappel général).
 */
function playSequence(event, count, gap = 400) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => {
      playSound(event);
    }, i * gap);
  }
}

// =====================
// 🌐 COMMUNICATION WEBSOCKET
// =====================

/**
 * Tente de se connecter à l'ESP32.
 * [Technique] Si pas de réponse après 1.5s, on bascule en mode Simulation.
 */
let timeout = setTimeout(() => {
  if (!connected) enableMock();
}, 1500);

function connectWS() {
  try {
    // Connexion sur le port 81 (défini dans le code ESP32)
    ws = new WebSocket("ws://" + location.hostname + ":81/");

    ws.onopen = () => {
      connected = true;
      clearTimeout(timeout);
      setStatus("🟢 ESP32 connecté");
    };

    ws.onerror = ws.onclose = () => enableMock();

    // Réception de messages venant de l'ESP32 (si besoin)
    ws.onmessage = (e) => {
      let d = JSON.parse(e.data);
      if (d.type === "RESET") resetAll();
      if (d.type === "RECALL_INDIVIDUAL") handleRecallIndividual();
      if (d.type === "RECALL_GENERAL") handleRecallGeneral();
    };

  } catch (e) {
    enableMock();
  }
}

connectWS();

/**
 * Mode Simulation : Permet de tester l'interface sur un ordinateur sans ESP32.
 */
function enableMock() {
  if (mockMode) return;
  mockMode = true;
  setStatus("⚠️ Mode simulation PC (Pas de klaxon)");
}

function setStatus(t) {
  document.getElementById("status").innerText = t;
}

/**
 * Envoie une commande à l'ESP32 au format JSON.
 */
function send(msg) {
  if (mockMode) {
    console.log("MOCK SEND:", msg);
    // En mode simulation, on exécute l'UI localement
    if (msg.type === "OPEN_LINE") openLineUI();
    if (msg.type === "RECALL_INDIVIDUAL") handleRecallIndividual();
    if (msg.type === "RECALL_GENERAL") handleRecallGeneral();
    if (msg.type === "FINISH") handleFinish();
    if (msg.type === "RESET") resetAll();
    return;
  }
  if (connected) ws.send(JSON.stringify(msg));
}

// =====================
// 🚩 GESTION DES PAVILLONS
// =====================

/**
 * Met à jour les images des drapeaux affichées à l'écran.
 * [Fonctionnel] Reflète l'état officiel de la procédure de course.
 */
function updateFlags({ orange, classFlag, prep, x, ap }) {
  let html = "";
  // Les images doivent être dans un dossier /images/ sur le LittleFS
  if (orange) html += '<img src="images/Pav_orange.svg" title="Ligne ouverte">';
  if (classFlag) html += '<img src="images/Pav_VNO.svg" title="Classe">';

  if (prep) {
    let file = {
      "P": "Pav_P.svg",
      "I": "Pav_I.svg",
      "U": "Pav_U.svg",
      "BLACK": "Pav_noir.svg"
    }[prep];
    if (file) html += `<img src="images/${file}" title="Préparatoire">`;
  }

  if (x) html += '<img src="images/Pav_X.svg" title="Rappel Individuel">';
  if (ap) html += '<img src="images/1er_substitut.svg" title="Rappel Général">';

  document.getElementById("flags").innerHTML = html;
}

// =====================
// ⏱️ LOGIQUE DE COURSE (RÈGLE 26)
// =====================

/**
 * Phase 1 : Ouverture de la ligne.
 * L'officier appuie sur le bouton pour lancer le cycle.
 */
function openLine() {
  send({ type: "OPEN_LINE" });
  openLineUI(); // Lance l'affichage immédiatement
}

function openLineUI() {
  hideSetup();
  let delay = parseInt(document.getElementById("openToProcedure").value || 1) * 60;
  setHeader("🚩 Ligne ouverte");
  updateFlags({ orange: true });
  playSound("SON_COURT");
  startProcedure(delay);
}

/**
 * Compte à rebours avant le signal d'avertissement (T-5 min).
 */
function startProcedure(sec) {
  clearInterval(tProcedure);
  tProcedure = setInterval(() => {
    updateCountdown(sec, "Procédure de départ dans");
    if (sec <= 0) {
      clearInterval(tProcedure);
      startProcedureUI(); // Passage auto à T-5
    }
    sec--;
  }, 1000);
}

/**
 * Signal d'avertissement (T-5 min).
 * [Fonctionnel] Envoi du pavillon de classe + 1 son court.
 */
function startProcedureUI() {
  setHeader("⚠️ Signal d'Avertissement (T-5)");
  updateFlags({ orange: true, classFlag: true });
  send({ type: "BEEP_COURT" }); // Klaxon réel
  playSound("SON_COURT");       // Son téléphone
  startStart(300);
}

/**
 * Séquence de départ (T-5 à T-0).
 */
function startStart(sec) {
  clearInterval(tStart);
  tStart = setInterval(() => {
    updateCountdown(sec, "DÉPART DANS");

    // T-4 min : Signal préparatoire
    if (sec === 240) {
      updateFlags({
        orange: true,
        classFlag: true,
        prep: document.getElementById("prepFlag").value
      });
      send({ type: "BEEP_COURT" });
      playSound("SON_COURT");
    }

    // T-1 min : Signal de la dernière minute (Affalage préparatoire)
    if (sec === 60) {
      updateFlags({ orange: true, classFlag: true, prep: null });
      send({ type: "BEEP_LONG" });
      playSound("SON_LONG");
    }

    // T-0 : LE DÉPART
    if (sec <= 0) {
      clearInterval(tStart);
      startRaceUI();
    }
    sec--;
  }, 1000);
}

/**
 * Course lancée.
 * [Fonctionnel] On affiche les boutons de rappel et d'arrivée.
 */
function startRaceUI() {
  setHeader("🏁 Course en cours");
  updateFlags({ orange: true });
  send({ type: "BEEP_COURT" });
  playSound("SON_COURT");
  document.getElementById("raceBtns").style.display = "block";
  startRecallTimer(240); // Chrono de 4 min pour la fermeture de ligne
}

/**
 * Timer de fermeture de ligne (4 minutes après le départ).
 */
function startRecallTimer(sec) {
  clearInterval(tRecall);
  tRecall = setInterval(() => {
    if (sec <= 0) {
      clearInterval(tRecall);
      document.getElementById("countdown").innerText = "";
      return;
    }
    updateCountdown(sec, "Fermeture ligne dans");
    sec--;
  }, 1000);
}

// =====================
// 📢 RAPPELS ET ARRIVÉES
// =====================

function handleRecallIndividual() {
  updateFlags({ orange: true, x: true });
  send({ type: "BEEP_COURT" });
  playSound("SON_COURT");
  setHeader("⚠️ Rappel individuel");
}

function handleRecallGeneral() {
  updateFlags({ orange: true, ap: true });
  send({ type: "BEEP_DOUBLE" }); // Séquence gérée côté ESP32
  playSequence("SON_COURT", 2);  // Son téléphone
  setHeader("🚨 Rappel général");
}

/**
 * Gère les arrivées des bateaux.
 * [Fonctionnel] Le 1er clic lance le chrono de fin de course.
 * Les clics suivants font juste un bip pour chaque bateau.
 */
function handleFinish() {
  if (!finishStarted) {
    finishStarted = true;
    let minutes = parseInt(document.getElementById("finishLimit").value || 20);
    let sec = minutes * 60;
    setHeader("🏁 Arrivées en cours");
    send({ type: "BEEP_COURT" });
    playSound("SON_COURT");

    tFinish = setInterval(() => {
      if (sec <= 0) {
        clearInterval(tFinish);
        updateFlags({ orange: false });
        setHeader("⛔ Course terminée");
        document.getElementById("countdown").innerText = "";
        return;
      }
      updateCountdown(sec, "Temps limite arrivée");
      sec--;
    }, 1000);
  } else {
    // Bips pour les bateaux suivants
    send({ type: "BEEP_COURT" });
    playSound("SON_COURT");
  }
}

// =====================
// 🛠️ OUTILS INTERFACE (UI)
// =====================

function setHeader(t) {
  document.getElementById("header").innerText = t;
}

/**
 * Formate les secondes en minutes:secondes (ex: 04:59).
 */
function updateCountdown(sec, label) {
  let m = Math.floor(sec / 60);
  let s = sec % 60;
  document.getElementById("countdown").innerText =
    `${label} ${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Réinitialise tout le système (Annulation).
 */
function resetAll() {
  clearInterval(tProcedure);
  clearInterval(tStart);
  clearInterval(tRecall);
  clearInterval(tFinish);
  finishStarted = false;
  setHeader("⛵ Paramétrage Régate ⛵");
  document.getElementById("raceBtns").style.display = "none";
  document.getElementById("countdown").innerText = "";
  document.getElementById("flags").innerHTML = "";
  showSetup();
}

function hideSetup() {
  document.getElementById("setup").style.display = "none";
  document.getElementById("openBtn").style.display = "none";
}

function showSetup() {
  document.getElementById("setup").style.display = "block";
  document.getElementById("openBtn").style.display = "block";
}

// Liaisons boutons HTML -> Fonctions JS
function recallIndividual() { send({ type: "RECALL_INDIVIDUAL" }); handleRecallIndividual(); }
function recallGeneral()    { send({ type: "RECALL_GENERAL" }); handleRecallGeneral(); }
function finishRace()       { send({ type: "FINISH" }); handleFinish(); }
function cancelAll()        { send({ type: "RESET" }); resetAll(); }
