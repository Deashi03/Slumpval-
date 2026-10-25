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
  let toastTimer;

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

  async function readSnapshot() {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const [payload, revision] = await Promise.all([request(store.get("payload")), request(store.get("revision"))]);
    if (!payload) throw new Error("Sparad lista saknas");
    const data = await decryptJSON(payload, vaultKey);
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

  async function mutate(buildChange) {
    if (busy || !vaultKey) return { ok: false };
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
      if (locking) performLock();
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
    for (const name of ["draw", "list", "add"]) {
      $("view-" + name).classList.toggle("hidden", name !== view);
      const tab = $("tab" + name[0].toUpperCase() + name.slice(1));
      tab.classList.toggle("active", name === view);
      if (name === view) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    }
    if (view === "list") refreshList();
    window.scrollTo(0, 0);
  }

  async function refreshList() {
    if (!vaultKey || busy) return;
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
    if (vaultKey && !busy) void copyText(items.map(x => x.text).join("\n"));
  }

  function performLock() {
    vaultKey = null;
    items = [];
    selection = null;
    locking = false;
    $("setupPass").value = "";
    $("setupPassAgain").value = "";
    $("unlockPass").value = "";
    $("bulkInput").value = "";
    $("listItems").replaceChildren();
    $("selectionText").textContent = "";
    $("toast").classList.add("hidden");
    updateInputCount();
    $("saveState").textContent = "Privat på enheten";
    showScreen(hasVault ? "unlock" : "setup");
  }

  function lock() {
    if (!vaultKey) {
      if (busy) locking = true;
      $("setupPass").value = "";
      $("setupPassAgain").value = "";
      $("unlockPass").value = "";
      return;
    }
    if (busy) locking = true;
    else performLock();
  }

  async function createVault(event) {
    event.preventDefault();
    if (busy) return;
    const password = $("setupPass").value;
    if (password.length < 8) { toast("Använd minst 8 tecken i lösenordet."); return; }
    if (password !== $("setupPassAgain").value) { toast("Lösenorden stämmer inte överens."); return; }
    busy = true;
    $("setupBtn").disabled = true;
    try {
      if (await getValue("meta")) { hasVault = true; toast("Valvet finns redan. Lås upp det."); showScreen("unlock"); return; }
      const salt = secureRandom(16);
      const key = await deriveKey(password, salt);
      const payload = await encryptJSON({ items: [] }, key);
      await writeInitialVault({ version: 1, salt: u8ToBase64(salt) }, payload);
      vaultKey = key;
      hasVault = true;
      items = [];
      selection = null;
      showScreen("app");
      changeView("add");
      toast("Ditt privata valv är skapat.");
      $("setupPass").value = "";
      $("setupPassAgain").value = "";
    } catch (error) {
      errorMessage(error);
    } finally {
      busy = false;
      $("setupBtn").disabled = false;
      if (locking) performLock();
    }
  }

  async function unlockVault(event) {
    event.preventDefault();
    if (busy) return;
    const submittedPassword = $("unlockPass").value;
    busy = true;
    $("unlockBtn").disabled = true;
    try {
      const meta = await getValue("meta");
      if (!meta || !meta.salt) throw new Error("Inget valv hittades");
      const key = await deriveKey(submittedPassword, base64ToU8(meta.salt));
      vaultKey = key;
      const snapshot = await readSnapshot();
      items = snapshot.items;
      selection = null;
      $("unlockPass").value = "";
      showScreen("app");
      changeView("draw");
      render();
      $("saveState").textContent = "Sparad på enheten";
    } catch (error) {
      vaultKey = null;
      console.error("Unlock:", error && error.name ? error.name : "unavailable");
      toast("Fel lösenord eller skadat lokalt valv.");
    } finally {
      busy = false;
      $("unlockBtn").disabled = false;
      if (locking) performLock();
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
      hasVault = false;
      items = [];
      selection = null;
      $("unlockPass").value = "";
      showScreen("setup");
      toast("Det lokala valvet har raderats.");
    } catch (error) { errorMessage(error); }
    finally { busy = false; }
  }

  function bind() {
    $("setupForm").addEventListener("submit", createVault);
    $("unlockForm").addEventListener("submit", unlockVault);
    $("resetVaultBtn").addEventListener("click", resetVault);
    $("lockBtn").addEventListener("click", lock);
    $("tabDraw").addEventListener("click", () => changeView("draw"));
    $("tabList").addEventListener("click", () => changeView("list"));
    $("tabAdd").addEventListener("click", () => changeView("add"));
    $("goToListBtn").addEventListener("click", () => changeView("list"));
    $("drawBtn").addEventListener("click", draw);
    $("copySelectedBtn").addEventListener("click", () => { if (selection) copyText(selection); });
    $("copyAllBtn").addEventListener("click", copyAll);
    $("clearAllBtn").addEventListener("click", clearList);
    $("addItemsBtn").addEventListener("click", addItems);
    $("bulkInput").addEventListener("input", updateInputCount);
    $("clearInputBtn").addEventListener("click", () => { $("bulkInput").value = ""; updateInputCount(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) lock(); else if (vaultKey) refreshList(); });
    window.addEventListener("pagehide", lock);
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
      hasVault = Boolean(await getValue("meta"));
      showScreen(hasVault ? "unlock" : "setup");
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