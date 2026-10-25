import { test, expect } from "@playwright/test";

const PASSWORD = "Only-for-smoke-tests-123!";
const PATTERN = [0, 1, 2, 5, 8];
const WRONG = [0, 3, 6, 7, 8];

// Real mouse/pointer motion through the same SVG coordinates as an iPhone swipe.
async function drawPattern(page, selector, path = PATTERN) {
  const rect = await page.locator(selector + " svg").boundingBox();
  if (!rect) throw Error("Pattern board not visible");
  const position = i => ({
    x: rect.x + (50 + 100 * (i % 3)) * rect.width / 300,
    y: rect.y + (50 + 100 * Math.floor(i / 3)) * rect.height / 300
  });
  const first = position(path[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const dot of path.slice(1)) {
    const point = position(dot);
    await page.mouse.move(point.x, point.y, { steps: 5 });
  }
  await page.mouse.up();
}

const FIRST = "En ovanligt lång fråga som naturligt kan radbrytas på flera visuella rader utan att bli ett nytt val";
const SECOND = "日本語 glosa";
const THIRD = "RB 24:7";

async function createVault(page) {
  await page.goto("/");
  await expect(page.locator("#screen-setup")).toBeVisible();
  await drawPattern(page, "#setupPattern");
  await expect(page.locator("#setupStatus")).toContainText("samma mönster");
  await drawPattern(page, "#setupPattern");
  await expect(page.locator("#screen-app")).toBeVisible();
}

async function addThree(page) {
  await page.locator("#tabAdd").click();
  await page.locator("#bulkInput").fill(`${FIRST}\n\n${SECOND}\r\n${THIRD}\n`);
  await expect(page.locator("#inputCount")).toContainText("3 alternativ");
  await page.locator("#addItemsBtn").click();
  await expect(page.locator("#remainingCount")).toHaveText("3");
  await expect(page.locator("#listItems .item-text")).toHaveCount(3);
}

test("private list, newlines, random removal, and persistence across reload", async ({ page }) => {
  console.log("smoke: create");
  await createVault(page);
  console.log("smoke: created");
  await addThree(page);
  console.log("smoke: added");
  await expect(page.locator("#listItems .item-text")).toHaveText([FIRST, SECOND, THIRD]);
  console.log("smoke: opening draw");
  await page.locator("#tabDraw").click();
  console.log("smoke: draw opened");
  await page.locator("#drawBtn").click();
  console.log("smoke: drawn");
  await expect(page.locator("#remainingCount")).toHaveText("2");
  const selected = await page.locator("#selectionText").textContent();
  expect([FIRST, SECOND, THIRD]).toContain(selected);
  console.log("smoke: opening list");
  await page.locator("#tabList").click();
  console.log("smoke: list opened");
  await expect(page.locator("#listItems .item-text")).toHaveCount(2);
  const remaining = await page.locator("#listItems .item-text").allTextContents();
  expect(remaining).not.toContain(selected);

  console.log("smoke: reloading");
  await page.reload();
  console.log("smoke: reloaded");
  await expect(page.locator("#screen-unlock")).toBeVisible();
  await drawPattern(page, "#unlockPattern", WRONG);
  await expect(page.locator("#unlockStatus")).toContainText("Fel mönster");
  await expect(page.locator("#screen-app")).toBeHidden();
  await drawPattern(page, "#unlockPattern");
  console.log("smoke: unlocked");
  await expect(page.locator("#screen-app")).toBeVisible();
  await expect(page.locator("#remainingCount")).toHaveText("2");
  await page.locator("#tabList").click();
  await expect(page.locator("#listItems .item-text")).toHaveText(remaining);
});

test("local database stores only encrypted entries, not list plaintext", async ({ page }) => {
  await createVault(page);
  await addThree(page);
  const payload = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("slumpval-local-vault-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction("vault", "readonly");
      const req = tx.objectStore("vault").get("payload");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return result;
  });
  expect(payload).toHaveProperty("iv");
  expect(payload).toHaveProperty("data");
  const raw = JSON.stringify(payload);
  expect(raw).not.toContain(FIRST);
  expect(raw).not.toContain(SECOND);
  expect(raw).not.toContain(THIRD);
});

test("one tap clears entire list; you can add again and remove a single item", async ({ page }) => {
  await createVault(page);
  await addThree(page);
  let dialogCount = 0;
  page.on("dialog", dialog => { dialogCount++; dialog.dismiss(); });
  await page.locator("#clearAllBtn").click();
  await expect(page.locator("#remainingCount")).toHaveText("0");
  await expect(page.locator("#listEmpty")).toBeVisible();
  expect(dialogCount).toBe(0);
  await page.reload();
  await drawPattern(page, "#unlockPattern");
  await expect(page.locator("#remainingCount")).toHaveText("0");

  await page.locator("#tabAdd").click();
  await page.locator("#bulkInput").fill("A\nB");
  await page.locator("#addItemsBtn").click();
  await expect(page.locator("#remainingCount")).toHaveText("2");
  await page.locator("#listItems .item-remove").first().click();
  await expect(page.locator("#remainingCount")).toHaveText("1");
  await expect(page.locator("#listItems .item-text")).toHaveText(["B"]);
});

test("copy remaining list and isolate a different device/browser profile", async ({ page, browser, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await createVault(page);
  await addThree(page);
  await page.locator("#copyAllBtn").click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe([FIRST, SECOND, THIRD].join("\n"));

  const independentContext = await browser.newContext();
  try {
    const other = await independentContext.newPage();
    await other.goto("/");
    await expect(other.locator("#screen-setup")).toBeVisible();
    await expect(other.locator("#screen-unlock")).toBeHidden();
    await expect(other.locator("#screen-app")).toBeHidden();
  } finally {
    await independentContext.close();
  }
});

test("old password vault migrates to a four-stroke pattern without losing remaining items", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#screen-setup")).toBeVisible();
  await page.evaluate(async password => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const importKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({name:"PBKDF2", salt, iterations:250000, hash:"SHA-256"}, importKey, {name:"AES-GCM", length:256}, false, ["encrypt"]);
    const ct = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM", iv}, key, encoder.encode(JSON.stringify({
      items:[{id:"legacy-a",text:"Gammal glosa"},{id:"legacy-b",text:"Behåll mig"}]
    }))));
    const b64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(""));
    const db = await new Promise((resolve,reject) => {
      const request = indexedDB.open("slumpval-local-vault-v1", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve,reject) => {
      const tx = db.transaction("vault", "readwrite");
      tx.objectStore("vault").put({version:1,salt:b64(salt)}, "meta");
      tx.objectStore("vault").put({iv:b64(iv),data:b64(ct)}, "payload");
      tx.objectStore("vault").put(7, "revision");
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    db.close();
  }, PASSWORD);
  await page.reload();
  await expect(page.locator("#legacyUnlockArea")).toBeVisible();
  await expect(page.locator("#unlockPatternArea")).toBeHidden();
  await page.locator("#unlockPass").fill(PASSWORD);
  await page.locator("#unlockBtn").click();
  await expect(page.locator("#screen-setup")).toBeVisible();
  await expect(page.locator("#setupTitle")).toContainText("mönsterlås");
  await drawPattern(page, "#setupPattern");
  await drawPattern(page, "#setupPattern");
  await expect(page.locator("#screen-app")).toBeVisible();
  await expect(page.locator("#remainingCount")).toHaveText("2");
  await expect(page.locator("#listItems .item-text")).toHaveText(["Gammal glosa", "Behåll mig"]);
  await page.reload();
  await expect(page.locator("#unlockPatternArea")).toBeVisible();
  await expect(page.locator("#legacyUnlockArea")).toBeHidden();
  await drawPattern(page, "#unlockPattern");
  await expect(page.locator("#remainingCount")).toHaveText("2");
});
