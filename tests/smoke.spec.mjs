import { test, expect } from "@playwright/test";

const PASSWORD = "Only-for-smoke-tests-123!";
const FIRST = "En ovanligt lång fråga som naturligt kan radbrytas på flera visuella rader utan att bli ett nytt val";
const SECOND = "日本語 glosa";
const THIRD = "RB 24:7";

async function createVault(page) {
  await page.goto("/");
  await expect(page.locator("#screen-setup")).toBeVisible();
  await page.locator("#setupPass").fill(PASSWORD);
  await page.locator("#setupPassAgain").fill(PASSWORD);
  await page.locator("#setupBtn").click();
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
  await createVault(page);
  await addThree(page);
  await expect(page.locator("#listItems .item-text")).toHaveText([FIRST, SECOND, THIRD]);
  await page.locator("#tabDraw").click();
  await page.locator("#drawBtn").click();
  await expect(page.locator("#remainingCount")).toHaveText("2");
  const selected = await page.locator("#selectionText").textContent();
  expect([FIRST, SECOND, THIRD]).toContain(selected);
  await page.locator("#tabList").click();
  await expect(page.locator("#listItems .item-text")).toHaveCount(2);
  const remaining = await page.locator("#listItems .item-text").allTextContents();
  expect(remaining).not.toContain(selected);

  await page.reload();
  await expect(page.locator("#screen-unlock")).toBeVisible();
  await page.locator("#unlockPass").fill("incorrect-password");
  await page.locator("#unlockBtn").click();
  await expect(page.locator("#screen-app")).toBeHidden();
  await page.locator("#unlockPass").fill(PASSWORD);
  await page.locator("#unlockBtn").click();
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
  await page.locator("#unlockPass").fill(PASSWORD);
  await page.locator("#unlockBtn").click();
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
