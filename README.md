# Slumpval

Privat, installerbar svensk slumpgenerator för iPhone, byggd med HTML/CSS/JavaScript. Du kan lägga till en radseparerad lista, slumpa utan återläggning, kopiera den valda posten, öppna och granska hela listan, radera enskilda poster, kopiera den kvarvarande listan och radera hela listan.

## Publicera på GitHub Pages

1. Gå till **Settings → Pages** i det här repositoriet.
2. Under **Build and deployment**, välj **Deploy from a branch**, därefter **main** och **/(root)**. Klicka **Save**.
3. Besök **https://deashi03.github.io/Slumpval-/** i Safari på din iPhone.
4. Välj **Dela → Lägg till på hemskärmen**.
5. **Öppna appen från hemskärmen** och skapa ditt mönsterlås och din lista där. Safari-fliken och hemskärmsappen kan ha olika separat lagring.


## Upplåsningstid som gäller även när appen stängs

Öppna **Inställn. → Hur länge ska appen vara upplåst?** och välj **Lås direkt när jag lämnar appen** (standard), **15 minuter**, **1 timme**, **4 timmar**, **12 timmar** eller **24 timmar**. Tiden räknas från **senaste lyckade upplåsningen med mönstret**, inte från senaste appöppning. Om tiden inte löpt ut kan samma installerade app på samma iPhone återöppnas utan nytt mönster efter att den stängts. När tiden gått ut krävs mönstret igen. **Lås appen nu** och hänglåset på startsidan avslutar upplåsningen omedelbart, oavsett vald tid.

För tidsgränser över 0 lagrar appen en **icke-exporterbar Web Crypto-nyckel** lokalt i IndexedDB, tillsammans med en tidpunkt då upplåsningen ska sluta gälla. Detta är avsiktligt mindre säkert än att låsa varje gång, eftersom andra processer och skript med tillgång till appens lokala data kan komma åt nyckeln under denna period. Webbläsarens lagringsrensning kan göra att upplåsningen upphör tidigare. Tidsgränsen är en lokal appkontroll, inte en garanti mot manipulering av enhetens klocka eller forensisk åtkomst. **Välj standardinställningen om sekretess är högsta prioritet.**

## Funktioner och integritet

- Enter (LF/CRLF/CR) separerar alternativ. Varje icke-tom rad är ett eget alternativ; långa rader radbryts visuellt.
- Slumpning väljer jämnt med Web Crypto, **sparar listan utan den valda posten i en IndexedDB-transaktion och visar den först efter att skrivningen har lyckats**. Ingen valhistorik lagras.
- Listan kan öppnas och redigeras. Radera allt utförs med ett tryck utan ångra.
- Listan sparas **endast på enheten**, krypterad med AES-256-GCM. Nya valv låses upp med ett 3×3-mönster med minst **fyra streck (fem punkter)** som ritas två gånger vid skapandet. En ny slumpmässig salt + PBKDF2-SHA256 (250 000 iterationer) används för att härleda nyckeln. Mönstret krävs igen efter låsning och kan inte återställas.
- Om ett äldre lösenordsvalv finns kvar uppmanas du ange ditt tidigare lösenord en sista gång och välja ett nytt mönster. Appen byter sedan kryptering atomiskt utan att ta bort kvarvarande poster.
- Ingen backend, synkronisering, statistik, serverlagring, spårning eller externa skript. GitHub innehåller bara appkoden. Appens service worker cachelagrar endast offentliga programfiler.
- Om iOS rensar webbplatsdata eller mönstret glöms bort går kvarvarande innehåll förlorat.
- **Viktig säkerhetsavvägning:** Ett mönster med bara fyra streck har betydligt färre möjliga kombinationer än ett starkt lösenord. Krypteringen hindrar inte en angripare som får tag på lokala krypterade data från att försöka gissa mönster offline. Appens skydd är därför inte likvärdigt med ett långt, unikt lösenord. Använd inte den här varianten för mycket känsligt material.

**Raderingsbegränsning:** Appen har ingen papperskorg eller historik och kan inte själv återställa borttagna poster. Webbläsaren, iOS, lagringsmediet eller säkerhetskopior kan emellertid lämna äldre krypterade block efter sig. En webbapp kan inte garantera absolut fysisk och forensiskt oåterkallelig radering. Text som kopieras till urklippet ligger utanför appens kontroll. Den dragna posten syns i aktuell session för att kunna kopieras, men finns inte i den kvarvarande sparade listan.

Läsbar kod: `index.html`, `style.css`, `pattern.js`, `app.js`, `sw.js`, `manifest.webmanifest`.
