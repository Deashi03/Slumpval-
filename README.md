# Slumpval

Privat, installerbar svensk slumpgenerator för iPhone, byggd med HTML/CSS/JavaScript. Du kan lägga till en radseparerad lista, slumpa utan återläggning, kopiera den valda posten, öppna och granska hela listan, radera enskilda poster, kopiera den kvarvarande listan och radera hela listan.

## Publicera på GitHub Pages

1. Gå till **Settings → Pages** i det här repositoriet.
2. Under **Build and deployment**, välj **Deploy from a branch**, därefter **main** och **/(root)**. Klicka **Save**.
3. Besök **https://deashi03.github.io/Slumpval-/** i Safari på din iPhone.
4. Välj **Dela → Lägg till på hemskärmen**.
5. **Öppna appen från hemskärmen** och skapa ditt lösenord och din lista där. Safari-fliken och hemskärmsappen kan ha olika separat lagring.

## Funktioner och integritet

- Enter (LF/CRLF/CR) separerar alternativ. Varje icke-tom rad är ett eget alternativ; långa rader radbryts visuellt.
- Slumpning väljer jämnt med Web Crypto, **sparar listan utan den valda posten i en IndexedDB-transaktion och visar den först efter att skrivningen har lyckats**. Ingen valhistorik lagras.
- Listan kan öppnas och redigeras. Radera allt utförs med ett tryck utan ångra.
- Listan sparas **endast på enheten**, krypterad med AES-GCM 256 och ett lösenord härlett med PBKDF2-SHA256. Lösenordet krävs efter att appen låsts och kan inte återställas.
- Ingen backend, synkronisering, statistik, serverlagring, spårning eller externa skript. GitHub innehåller bara appkoden. Appens service worker cachelagrar endast offentliga programfiler.
- Om iOS rensar webbplatsdata eller lösenordet glöms bort går kvarvarande innehåll förlorat.

**Raderingsbegränsning:** Appen har ingen papperskorg eller historik och kan inte själv återställa borttagna poster. Webbläsaren, iOS, lagringsmediet eller säkerhetskopior kan emellertid lämna äldre krypterade block efter sig. En webbapp kan inte garantera absolut fysisk och forensiskt oåterkallelig radering. Text som kopieras till urklippet ligger utanför appens kontroll. Den dragna posten syns i aktuell session för att kunna kopieras, men finns inte i den kvarvarande sparade listan.

Läsbar kod: `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`.
