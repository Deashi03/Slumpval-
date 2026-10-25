/* Slumpval: no analytics, network, external libraries, or server persistence. */
"use strict";
(() => {
  const DB_NAME = "slumpval-local-vault-v1";
  const STORE = "vault";
  const ITERATIONS = 250000;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const $ = id => document.getElementById(id);
  let db = null;
  let vaultKey = null;
  let items = [];
  let selection = null;
  let busy = false;
  let locking = false;
  let hasVault = false;
  let currentView = "draw";
  let vaultFormat = 0;
  let setupMode = "new";
  let firstPattern = null;
  let setupBoard;
  let unlockBoard;
  let toastTimer;
  const DURATIONS = new Set([0,900000,3600000,14400000,43200000,86400000]);
  let unlockDuration = 0;
  let authenticatedAt = 0;
  let unlockedUntil = 0;
  let expiryTimer = null;
  let discardOnDeferredLock = false;
  let resuming = false;

  function showScreen(id) {
    for (const name of ["loading", "setup", "unlock", "app"]) {
      $("screen-" + name).classList.toggle("hidden", name !== id);
    }
    $("bottomNav").classList.toggle("hidden", id !== "app");
  }

  function toast(message) {
    const element = $("toast");
    element.textContent = message;
    element.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.add("hidden"), 3200);
  }

  function errorMessage(error) {
    console.error("Slumpval:", error && error.name ? error.name : "unexpected error");
    toast("Åtgärden misslyckades. Listan har inte ändrats.");
  }

  function request(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Databasfel"));
    });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error("Lokal lagring kan inte öppnas"));
      req.onblocked = () => reject(new Error("Lagringen är låst av en annan flik"));
    });
  }

  async function getValue(name) {
    return request(db.transaction(STORE, "readonly").objectStore(STORE).get(name));
  }

  function u8ToBase64(bytes) {
    let str = "";
    for (const byte of bytes) str += String.fromCharCode(byte);
    return btoa(str);
  }

  function base64ToU8(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function secureRandom(length) {
    return crypto.getRandomValues(new Uint8Array(length));
  }

  async function deriveKey(password, salt) {
    const passwordKey = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
      passwordKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
  }

  async function encryptJSON(value, key) {
    const iv = secureRandom(12);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(value)));
    return { iv: u8ToBase64(iv), data: u8ToBase64(new Uint8Array(ciphertext)) };
  }

  async function decryptJSON(cipher, key) {
    const bytes = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToU8(cipher.iv) }, key, base64ToU8(cipher.data)
    );
    return JSON.parse(dec.decode(bytes));
  }

  function validateItems(data) {
    if (!data || !Array.isArray(data.items)) throw new Error("Ogiltigt sparat format");
    for (const item of data.items) {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string") throw new Error("Ogiltigt alternativ");
    }
    return data.items;
  }

  function writeInitialVault(meta, payload) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(meta, "meta");
      store.put(payload, "payload");
      store.put(0, "revision");
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("Kunde inte skapa valvet"));
      tx.onerror = () => {};
    });
  }

  async function readSnapshot(key = vaultKey) {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const [payload, revision] = await Promise.all([request(store.get("payload")), request(store.get("revision"))]);
    if (!payload) throw new Error("Sparad lista saknas");
    const data = await decryptJSON(payload, key);
    return { items: validateItems(data), revision: Number(revision || 0) };
  }

  // Optimistic compare-and-swap prevents a stale browser tab from restoring deleted items.
  function commitIfCurrent(expectedRevision, cipher) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let conflicted = false;
      const req = store.get("revision");
      req.onsuccess = () => {
        if (Number(req.result || 0) !== expectedRevision) {
          conflicted = true;
          tx.abort();
          return;
        }
        store.put(cipher, "payload");
        store.put(expectedRevision + 1, "revision");
      };
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => conflicted ? resolve(false) : reject(tx.error || new Error("Kunde inte spara"));
      tx.onerror = () => {};
    });
  }

  // Change the entire encrypted vault and its keying metadata in one transaction.
  // Older browser tabs cannot write an outdated snapshot after the revision changes.
  function rotateVault(expectedRevision, cipher, meta) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      let conflict = false;
      const req = store.get("revision");
      req.onsuccess = () => {
        if (Number(req.result || 0) !== expectedRevision) {
          conflict = true;
          tx.abort();
          return;
        }
        store.put(meta, "meta");
        store.put(cipher, "payload");
        store.put(expectedRevision + 1, "revision");
      };
      tx.oncomplete = () => resolve(true);
      tx.onabort = () => conflict ? resolve(false) : reject(tx.error || new Error("Kunde inte byta lås"));
    });
  }

  function showAuth() {
    if (!hasVault) {
      beginPatternSetup("new");
      return;
    }
    const isPattern = vaultFormat === 2;
    $("unlockPatternArea").classList.toggle("hidden", !isPattern);
    $("legacyUnlockArea").classList.toggle("hidden", isPattern);
    $("unlockDescription").textContent = isPattern
      ? "Rita ditt sparade mönster för att öppna listan."
      : "Ange ditt tidigare lösenord en sista gång för att övergå till mönsterlås utan att förlora listan.";
    $("unlockStatus").textContent = "Dra mönstret mellan punkterna.";
    unlockBoard?.reset();
    showScreen("unlock");
  }

  function beginPatternSetup(mode) {
    setupMode = mode;
    firstPattern = null;
    setupBoard?.reset();
    $("setupTitle").textContent = mode === "migrate" ? "Byt till mönsterlås" : "Skapa ditt mönsterlås";
    $("setupDescription").textContent = mode === "migrate"
      ? "Din befintliga lista bevaras. Dra ett nytt 3×3-mönster med minst fyra streck (fem punkter)."
      : "Dra fingret över punkterna. Minst fyra streck (fem punkter) krävs för att skapa ditt privata valv.";
    $("setupStatus").textContent = "Rita ditt nya mönster.";
    showScreen("setup");
  }

  async function completePatternSetup(pattern) {
    if (busy) return;
    busy = true;
    setupBoard.setEnabled(false);
    try {
      const salt = secureRandom(16);
      const key = await deriveKey("slumpval-pattern-v2:" + pattern, salt);
      const meta = { version: 2, salt: u8ToBase64(salt) };
      if (setupMode === "migrate") {
        if (!vaultKey) throw new Error("Du behöver låsa upp ditt tidigare valv först");
        const snapshot = await readSnapshot(vaultKey);
        const cipher = await encryptJSON({ items: snapshot.items }, key);
        if (!await rotateVault(snapshot.revision, cipher, meta)) {
          throw new Error("Listan ändrades samtidigt, försök igen");
        }
        items = snapshot.items;
      } else {
        if (await getValue("meta")) throw new Error("Ett valv finns redan");
        const cipher = await encryptJSON({ items: [] }, key);
        await writeInitialVault(meta, cipher);
        items = [];
      }
      vaultKey = key;
      vaultFormat = 2;
      hasVault = true;
      await recordUnlock();
      firstPattern = null;
      selection = null;
      showScreen("app");
      changeView(setupMode === "migrate" ? "list" : "add");
      render();
      $("saveState").textContent = "Sparad på enheten";
      toast(setupMode === "migrate" ? "Mönsterlåset är aktiverat. Listan är bevarad." : "Mönsterlåset är skapat.");
    } catch (error) {
      errorMessage(error);
      // In a failed migration the existing password key and encrypted list remain intact.
      firstPattern = null;
      $("setupStatus").textContent = "Kunde inte spara mönstret. Rita ett nytt mönster.";
    } finally {
      busy = false;
      setupBoard.setEnabled(true);
      if (locking) finishDeferredLock();
      else if (vaultKey && !$("screen-app").classList.contains("hidden")) render();
    }
  }

  function onSetupPattern(points) {
    if (busy) return;
    if (points.length < 5) {
      $("setupStatus").textContent = "För kort mönster. Dra minst fyra streck mellan fem punkter.";
      return;
    }
    const pattern = points.join("-");
    if (firstPattern === null) {
      firstPattern = pattern;
      $("setupStatus").textContent = "Bra! Rita exakt samma mönster en gång till.";
      return;
    }
    if (firstPattern !== pattern) {
      firstPattern = null;
      $("setupStatus").textContent = "Mönstren skilde sig. Börja om med ett nytt mönster.";
      return;
    }
    firstPattern = null;
    void completePatternSetup(pattern);
  }

  async function unlockPattern(points) {
    if (busy) return;
    if (points.length < 5) {
      $("unlockStatus").textContent = "Rita minst fyra streck (fem punkter).";
      return;
    }
    busy = true;
    unlockBoard.setEnabled(false);
    const pattern = points.join("-");
    try {
      const meta = await getValue("meta");
      if (!meta || meta.version !== 2) throw new Error("Fel typ av valv");
      const candidate = await deriveKey("slumpval-pattern-v2:" + pattern, base64ToU8(meta.salt));
      const snapshot = await readSnapshot(candidate);
      vaultKey = candidate;
      await recordUnlock();
      items = snapshot.items;
      selection = null;
      showScreen("app");
      changeView("draw");
      render();
      $("saveState").textContent = "Sparad på enheten";
    } catch (error) {
      vaultKey = null;
      $("unlockStatus").textContent = "Fel mönster. Försök igen.";
    } finally {
      busy = false;
      unlockBoard.setEnabled(true);
      if (locking) finishDeferredLock();
      else if (vaultKey && !$("screen-app").classList.contains("hidden")) render();
    }
  }


  function durationFrom(value) {
    const ms = Number(value);
    return DURATIONS.has(ms) ? ms : 0;
  }

  function clearExpiryTimer() {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function expired() {
    if (unlockDuration > 0 && vaultKey && Date.now() >= unlockedUntil) {
      lock(true);
      return true;
    }
    return false;
  }

  function scheduleExpiry() {
    clearExpiryTimer();
    if (vaultKey && unlockDuration > 0) {
      const timeLeft = unlockedUntil - Date.now();
      if (timeLeft <= 0) { lock(true); return; }
      expiryTimer = setTimeout(() => {
        if (expired()) return;
        scheduleExpiry();
      }, Math.min(timeLeft + 25, 2147483647));
    }
  }

  function showSessionStatus() {
    $("sessionDuration").value = String(unlockDuration);
    $("sessionStatus").textContent = unlockDuration === 0
      ? "Appen låses när du lämnar den."
      : unlockedUntil > Date.now()
        ? "Upplåst till " + new Date(unlockedUntil).toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" }) + "."
        : "Upplåsningstiden har gått ut.";
  }

  // Safari/iPhone supports structured-cloning non-extractable CryptoKeys into IndexedDB.
  // Note: a locally stored key *does* reduce protection during the selected time window.
  function saveSessionSettings(duration, authTime, key, salt) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const store = tx.objectStore(STORE);
      store.put(duration, "lockDuration");
      if (duration > 0 && key && authTime + duration > Date.now()) {
        store.put({ key, expiresAt: authTime + duration, authAt: authTime, salt }, "session");
      } else {
        store.delete("session");
      }
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("Kunde inte spara upplåsningstiden"));
    });
  }

  function deleteSavedSession() {
    if (!db) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete("session");
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error || new Error("Kunde inte stänga sessionen"));
    });
  }

  async function recordUnlock() {
    authenticatedAt = Date.now();
    unlockedUntil = unlockDuration ? authenticatedAt + unlockDuration : 0;
    const meta = await getValue("meta");
    try {
      await saveSessionSettings(unlockDuration, authenticatedAt, vaultKey, meta.salt);
    } catch (error) {
      // Fail closed for persistent sessions: unlock only in current foreground.
      unlockDuration = 0;
      unlockedUntil = 0;
      console.warn("Kan inte spara tidsbegränsad inloggning:", error?.name);
      toast("Tillfällig upplåsning: välj tidsgränsen igen om du vill spara den.");
    }
    scheduleExpiry();
  }

  async function changeDuration(value) {
    if (!vaultKey || busy || expired()) return;
    const duration = durationFrom(value);
    const oldValue = unlockDuration;
    busy = true;
    $("sessionDuration").disabled = true;
    try {
      const meta = await getValue("meta");
      await saveSessionSettings(duration, authenticatedAt, vaultKey, meta.salt);
      unlockDuration = duration;
      unlockedUntil = duration ? authenticatedAt + duration : 0;
      if (duration > 0 && Date.now() >= unlockedUntil) {
        lock(true);
        return;
      }
      scheduleExpiry();
      showSessionStatus();
      toast("Upplåsningstiden är sparad.");
    } catch (error) {
      unlockDuration = oldValue;
      errorMessage(error);
      showSessionStatus();
    } finally {
      busy = false;
      $("sessionDuration").disabled = false;
      if (locking) finishDeferredLock();
    }
  }

  async function resumeSavedSession() {
    if (resuming || !db || vaultKey || busy) return false;
    resuming = true;
    try {
      const record = await getValue("session");
      const meta = await getValue("meta");
      if (!record || !meta || meta.version !== 2 || unlockDuration === 0) return false;
      if (record.salt !== meta.salt || record.expiresAt !== record.authAt + unlockDuration ||
        !Number.isFinite(record.authAt) || record.authAt > Date.now() || record.expiresAt <= Date.now()) {
        await deleteSavedSession();
        return false;
      }
      const snapshot = await readSnapshot(record.key);
      if (record.expiresAt <= Date.now() || document.hidden) return false;
      vaultKey = record.key;
      authenticatedAt = record.authAt;
      unlockedUntil = record.expiresAt;
      items = snapshot.items;
      selection = null;
      showScreen("app");
      changeView("draw");
      render();
      scheduleExpiry();
      $("saveState").textContent = "Sparad på enheten";
      return true;
    } catch (error) {
      try { await deleteSavedSession(); } catch (_) {}
      return false;
    } finally {
      resuming = false;
    }
  }

  function finishDeferredLock() {
    if (!locking) return;
    const discard = discardOnDeferredLock;
    discardOnDeferredLock = false;
    performLock(discard);
    if (!discard && !document.hidden) void resumeSavedSession();
  }

  async function mutate(buildChange) {
    if (busy || !vaultKey || expired()) return { ok: false };
    busy = true;
    render();
    $("saveState").textContent = "Sparar lokalt…";
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        const snapshot = await readSnapshot();
        const change = buildChange(snapshot.items);
        if (!change.changed) {
          items = snapshot.items;
          render();
          return { ok: true, value: change.value };
        }
        const cipher = await encryptJSON({ items: change.next }, vaultKey);
        if (await commitIfCurrent(snapshot.revision, cipher)) {
          items = change.next;
          render();
          return { ok: true, value: change.value };
        }
      }
      throw new Error("Samtidig redigering, försök igen");
    } catch (error) {
      errorMessage(error);
      try { items = (await readSnapshot()).items; } catch (_) { /* Stay locked or show prior safe state. */ }
      render();
      return { ok: false };
    } finally {
      busy = false;
      $("saveState").textContent = "Sparad på enheten";
      render();
      if (locking) finishDeferredLock();
    }
  }

  function uniformIndex(length) {
    if (!length) return -1;
    const range = 4294967296;
    const cutoff = Math.floor(range / length) * length;
    const array = new Uint32Array(1);
    do { crypto.getRandomValues(array); } while (array[0] >= cutoff);
    return array[0] % length;
  }

  function splitLines(text) {
    return text.split(/\r\n|\n|\r/u).map(line => line.trim()).filter(line => line.length > 0);
  }

  function newId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return [...secureRandom(16)].map(x => x.toString(16).padStart(2, "0")).join("");
  }

  async function copyText(text) {
    try {
      if (!text) { toast("Det finns inget att kopiera."); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const success = document.execCommand("copy");
        textarea.remove();
        if (!success) throw new Error("Clipboard unavailable");
      }
      toast("Kopierat till urklipp.");
    } catch (error) {
      console.error("Clipboard:", error && error.name ? error.name : "unavailable");
      toast("Kunde inte kopiera. Kontrollera behörigheten.");
    }
  }

  function renderSelection() {
    const label = $("selectionLabel");
    const text = $("selectionText");
    const button = $("copySelectedBtn");
    button.classList.toggle("hidden", !selection);
    if (selection) {
      label.textContent = "Valt och borttaget från listan";
      text.textContent = selection;
      text.classList.remove("placeholder");
    } else {
      label.textContent = items.length ? "Redo att slumpa" : "Listan är tom";
      text.textContent = items.length
        ? "Tryck på knappen för att välja ett alternativ från listan."
        : "Lägg till alternativ för att börja slumpa.";
      text.classList.add("placeholder");
    }
  }

  function renderList() {
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
      const li = document.createElement("li");
      li.className = "item";
      const span = document.createElement("span");
      span.className = "item-text";
      span.textContent = item.text;
      const button = document.createElement("button");
      button.className = "item-remove";
      button.type = "button";
      button.textContent = "×";
      button.title = "Radera alternativ";
      button.setAttribute("aria-label", "Radera alternativ: " + item.text);
      button.disabled = busy;
      button.addEventListener("click", () => removeItem(item.id));
      li.append(span, button);
      fragment.appendChild(li);
    });
    $("listItems").replaceChildren(fragment);
    $("listEmpty").classList.toggle("hidden", items.length !== 0);
  }

  function render() {
    if (!vaultKey) return;
    $("remainingCount").textContent = String(items.length);
    $("listCount").textContent = items.length + " st";
    $("drawBtn").disabled = busy || items.length === 0;
    $("drawBtn").textContent = items.length === 0 ? "Listan är tom" : "Slumpa nästa →";
    $("copySelectedBtn").disabled = busy;
    $("copyAllBtn").disabled = busy || items.length === 0;
    $("clearAllBtn").disabled = busy || items.length === 0;
    $("addItemsBtn").disabled = busy || splitLines($("bulkInput").value).length === 0;
    renderSelection();
    if (currentView === "list") renderList();
  }

  function changeView(view) {
    currentView = view;
    for (const name of ["draw", "list", "add", "settings"]) {
      $("view-" + name).classList.toggle("hidden", name !== view);
      const tab = $("tab" + name[0].toUpperCase() + name.slice(1));
      tab.classList.toggle("active", name === view);
      if (name === view) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (view === "list") refreshList();
    if (view === "settings") showSessionStatus();
    window.scrollTo(0, 0);
  }

  async function refreshList() {
    if (!vaultKey || busy || expired()) return;
    try {
      const snapshot = await readSnapshot();
      if (!vaultKey) return;
      items = snapshot.items;
      render();
    } catch (error) { errorMessage(error); }
  }

  async function draw() {
    const result = await mutate(source => {
      if (source.length === 0) return { changed: false };
      const chosen = source[uniformIndex(source.length)];
      return { changed: true, next: source.filter(x => x.id !== chosen.id), value: chosen.text };
    });
    if (result.ok && typeof result.value === "string" && vaultKey) {
      selection = result.value;
      render();
    } else if (result.ok && !items.length) {
      selection = null;
      render();
    }
  }

  async function removeItem(id) {
    const result = await mutate(source => {
      const next = source.filter(item => item.id !== id);
      return { changed: next.length !== source.length, next };
    });
    if (result.ok) toast("Alternativet har raderats ur listan.");
  }

  async function clearList() {
    const result = await mutate(source => ({ changed: source.length > 0, next: [] }));
    if (result.ok) {
      selection = null;
      render();
      toast("Hela listan har raderats.");
    }
  }

  async function addItems() {
    const lines = splitLines($("bulkInput").value);
    if (!lines.length) return;
    const added = lines.map(text => ({ id: newId(), text }));
    const result = await mutate(source => ({ changed: true, next: source.concat(added) }));
    if (result.ok) {
      $("bulkInput").value = "";
      updateInputCount();
      toast(added.length + " alternativ tillagda.");
      changeView("list");
    }
  }

  function updateInputCount() {
    const count = splitLines($("bulkInput").value).length;
    $("inputCount").textContent = count + (count === 1 ? " alternativ" : " alternativ") + " att lägga till";
    $("addItemsBtn").disabled = busy || count === 0;
  }

  function copyAll() {
    // Clipboard writes must start while the user's click activation is active.
    if (vaultKey && !busy && !expired()) void copyText(items.map(x => x.text).join("\n"));
  }

  function performLock(discardSession = true) {
    if (discardSession) void deleteSavedSession().catch(error => console.error("Session:", error.name));
    clearExpiryTimer();
    vaultKey = null;
    unlockedUntil = 0;
    authenticatedAt = 0;
    items = [];
    selection = null;
    firstPattern = null;
    locking = false;
    setupBoard?.reset();
    unlockBoard?.reset();
    $("unlockPass").value = "";
    $("bulkInput").value = "";
    $("listItems").replaceChildren();
    $("selectionText").textContent = "";
    $("toast").classList.add("hidden");
    updateInputCount();
    $("saveState").textContent = "Privat på enheten";
    showAuth();
  }

  function lock(discardSession = true) {
    if (busy) {
      locking = true;
      discardOnDeferredLock = discardSession;
      $("unlockPass").value = "";
      return;
    }
    if (vaultKey) {
      performLock(discardSession);
    } else {
      if (discardSession) void deleteSavedSession().catch(() => {});
      firstPattern = null;
      $("unlockPass").value = "";
      setupBoard?.reset();
      unlockBoard?.reset();
      showAuth();
    }
  }

  // Used only for previously created password-based (version 1) vaults.
  async function unlockVault(event) {
    event.preventDefault();
    if (busy) return;
    const submittedPassword = $("unlockPass").value;
    busy = true;
    $("unlockBtn").disabled = true;
    try {
      const meta = await getValue("meta");
      if (!meta || meta.version === 2) throw new Error("Lösenordsvalvet finns inte");
      const oldKey = await deriveKey(submittedPassword, base64ToU8(meta.salt));
      const snapshot = await readSnapshot(oldKey);
      vaultKey = oldKey;
      items = snapshot.items;
      $("unlockPass").value = "";
      beginPatternSetup("migrate");
    } catch (error) {
      vaultKey = null;
      toast("Fel tidigare lösenord eller skadat valv.");
    } finally {
      busy = false;
      $("unlockBtn").disabled = false;
      if (locking) finishDeferredLock();
    }
  }

  async function resetVault() {
    if (busy) return;
    if (!window.confirm("Radera det lokala valvet och ALLA återstående alternativ? Detta går inte att ångra.")) return;
    busy = true;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error("Kunde inte återställa valvet"));
      });
      vaultKey = null;
      clearExpiryTimer();
      hasVault = false;
      items = [];
      selection = null;
      $("unlockPass").value = "";
      vaultFormat = 0;
      unlockDuration = 0;
      authenticatedAt = 0;
      unlockedUntil = 0;
      firstPattern = null;
      beginPatternSetup("new");
      toast("Det lokala valvet har raderats.");
    } catch (error) { errorMessage(error); }
    finally { busy = false; }
  }

  function bind() {
    setupBoard = window.SlumpvalPattern.mount($("setupPattern"), onSetupPattern);
    unlockBoard = window.SlumpvalPattern.mount($("unlockPattern"), points => { void unlockPattern(points); });
    $("unlockForm").addEventListener("submit", unlockVault);
    $("resetVaultBtn").addEventListener("click", resetVault);
    $("lockBtn").addEventListener("click", () => lock(true));
    $("lockNowBtn").addEventListener("click", () => lock(true));
    $("sessionDuration").addEventListener("change", () => { void changeDuration($("sessionDuration").value); });
    $("tabDraw").addEventListener("click", () => changeView("draw"));
    $("tabList").addEventListener("click", () => changeView("list"));
    $("tabAdd").addEventListener("click", () => changeView("add"));
    $("tabSettings").addEventListener("click", () => changeView("settings"));
    $("goToListBtn").addEventListener("click", () => changeView("list"));
    $("drawBtn").addEventListener("click", draw);
    $("copySelectedBtn").addEventListener("click", () => { if (selection) copyText(selection); });
    $("copyAllBtn").addEventListener("click", copyAll);
    $("clearAllBtn").addEventListener("click", clearList);
    $("addItemsBtn").addEventListener("click", addItems);
    $("bulkInput").addEventListener("input", updateInputCount);
    $("clearInputBtn").addEventListener("click", () => { $("bulkInput").value = ""; updateInputCount(); });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) lock(false);
      else if (vaultKey) { if (!expired()) refreshList(); }
      else void resumeSavedSession();
    });
    window.addEventListener("pagehide", () => lock(false));
  }

  async function main() {
    bind();
    if (!window.indexedDB || !window.crypto || !crypto.subtle) {
      $("screen-loading").querySelector("h1").textContent = "Webbläsaren stöds inte";
      $("screen-loading").querySelector("p").textContent = "Slumpval behöver lokal databas och Web Crypto över HTTPS. Öppna appen i en modern Safari.";
      return;
    }
    try {
      db = await openDatabase();
      const meta = await getValue("meta");
      hasVault = Boolean(meta);
      vaultFormat = meta?.version === 2 ? 2 : 1;
      unlockDuration = durationFrom(await getValue("lockDuration"));
      if (!await resumeSavedSession()) showAuth();
    } catch (error) {
      $("screen-loading").querySelector("h1").textContent = "Kan inte öppna lokal lagring";
      $("screen-loading").querySelector("p").textContent = "Kontrollera att webbläsaren tillåter lagring och att du inte använder privat läge.";
      console.error("Startup:", error && error.name ? error.name : "storage failed");
    }
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => { /* Online app still works. */ });
    }
  }

  main();
})();