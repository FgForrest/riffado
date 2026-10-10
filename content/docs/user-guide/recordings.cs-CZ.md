---
title: Nahrávky
description: Seznam nahrávek, přehrávač, nahrávání souborů, složky, mazání a kolik stojí AI.

---

<span id="the-recording-list" />

## Seznam nahrávek

Seznam vlevo v části **Nahrávky** zobrazuje Vaše nejnovější nahrávky jako první, seskupené podle dne. Každý řádek ukazuje název a první slova přepisu, nebo délku a datum, pokud ještě není přepis k dispozici.

![Seznam nahrávek s filtrem Potřebuje zkontrolovat](images/recording-list-needs-review.png)

- **Hledat** vyhledává slova v názvech a přepisech. Prohledává opravené přepisy, takže pokud opravíte např. jméno, najde je podle Vašeho zápisu. E-mail najde podle odesílatele a podle toho, co píše on sám, ne podle citovaných dřívějších zpráv, podpisu ani právního dovětku.
- **Nejnovější** mění pořadí: od nejnovějších, od nejstarších nebo podle názvu.
- **Potřebuje zkontrolovat** se zobrazí, když má Learn návrhy čekající na schválení v některých nahrávkách, a zobrazí pouze tyto nahrávky. Viz [Learn](learn.md).
- **Organizovat** přepne seznam do režimu složek. Viz [Soubory](#folders).
- Nabídka **⋯** na řádku otevře detail nahrávky, stáhne zvuk nebo ji odstraní.

<span id="adding-recordings" />

## Přidávání nahrávek

Nahrávky přibývají dvěma způsoby:

- **Z Vašeho záznamníku.** Riffado stahuje nové nahrávky z cloudu Vašeho záznamníku podle plánu, při otevření aplikace a pokaždé, když kliknete na **Synchronizovat zařízení**. Nastavení → Synchronizace určuje četnost.
- **Nahráním souboru.** Klikněte na **Nahrát** a vyberte zvukový nebo video soubor. U videa si Riffado ponechá pouze zvuk: soubor se nahraje, zvuk se na pozadí oddělí a dostanete zprávu, až bude připravený. Jedno video se převádí vždy pouze jedno najednou. Nahrané nahrávky jsou automaticky přepsány, pokud je zapnutá funkce **Automaticky přepsat nové nahrávky** (Nastavení → Přepisování).

Pořizujete záznam schůzky v prohlížeči na Linuxu? Váš administrátor Vám může poskytnout **meetrec**, malý program z příkazového řádku, který zaznamená Vás i ostatní účastníky do jednoho souboru vhodného pro nahrání. Viz [Pro administrátory](administrators.md#meeting-recorder-meetrec).

<span id="the-recording-page" />

## Stránka nahrávky

Klikněte na konkrétní nahrávku a otevře se napravo.

![Nahrávka](images/dashboard.png)

Nahoře naleznete:

- **Název.** Kliknutím na tužku vedle názvu jej můžete přejmenovat. Vlastnoručně zadaný název nebude nikdy přepsán automaticky generovaným.
- **Kdy, jak dlouhá, jak velká.**
- **Odhadovaná spotřeba AI** (viz níže).
- **Štítky složek** s přiřazenými složkami a možnost **Přidat do složky**.
- **Vymazat** vpravo (viz níže).

Pod tím jsou přehrávač, [přepis](transcripts.md) a [souhrn](summaries-and-tasks.md).

<span id="the-player" />

### Přehrávač

Přehrávač zobrazuje nahrávku jako zvukovou vlnu. Kliknutím kamkoli skočíte na zvolené místo. **1x** mění rychlost, ikona reproduktoru a posuvník nastavují hlasitost a ikona stahování uloží původní zvukový soubor. Preferujete-li jednoduchý indikátor postupu, nastavte si ho v **Nastavení → Přehrávání → Styl posuvníku**.

<span id="what-the-ai-cost" />

### Kolik stojí AI

![Odhadovaná spotřeba AI, rozbaleno](images/ai-spend.png)

Kliknutím na **Odhadovaná spotřeba AI** zjistíte, kolik stála jednotlivá zpracování u této nahrávky: přepis, souhrn, témata, Learn i název. Dole pak vidíte, který poskytovatel a model danou operaci provedli. Ceny jsou dle oficiálního ceníku každého poskytovatele, nebo podle ceny, kterou jste zadali v nastavení poskytovatele (viz [Poskytovatelé AI](settings.md#ai-providers)). U Claude Code a Codex, které běží na základě předplatného, zobrazená částka ukazuje, kolik by to stálo přes API; není to poplatek. Požadavky uskutečněné před zavedením sledování nákladů nejsou započítány.

<span id="erasing" />

### Mazání

![Nabídka Vymazat](images/erase-menu.png)

**Vymazat** odstraní části nahrávky a zbytek ponechá:

- **Vymazat místní zvuk** odstraní kopii nahrávky uloženou v Riffado. Přepis a souhrn zůstávají zachovány. Pokud je originál stále ve Vašem cloudu nahrávače, **Obnovit zvuk z Plaud** jej vrátí zpět.
- **Vymazat přepisy** a **Vymazat souhrny** odstraní pouze tyto položky.
- **Smazat všechna místní data** vymaže nahrávku z Riffado, ale originál zůstane ve Vašem cloudu rekordéru.
- **Přemístit originál Plaud do Koše** přesune originál do Koše na Vašem cloudu rekordéru.
- **Smazat všude** provede obojí. Akci potvrdíte opsáním názvu nahrávky.

Nahrávka sdílená s organizací je nejprve odebrána z organizace. Viz [Organizace](organization.md).

<span id="folders" />

## Složky

Klikněte na **Organizovat** nad seznamem pro zobrazení svých složek.

![Složky](images/folders.png)

- **Soukromé** obsahují Vaše vlastní složky. Každá nahrávka je vždy ve složce Soukromé, bez ohledu na to, kde jinde se nachází.
- **Organizace** obsahuje složky sdílené s kolegy. Zobrazí se pouze, když má Vaše instance nastavenou Organizaci. Viz [Organizace](organization.md).

Nahrávku zařadíte do složky tak, že ji přetáhnete na příslušnou složku, nebo přímo v detailu nahrávky použijete **Přidat do složky**:

![Přidat do složky](images/add-to-folder.png)

Jedna nahrávka může být ve více složkách najednou. Kliknutím na **×** u štítku složky ji odeberete z konkrétní složky.

Pro správu složek použijte nabídku **⋯** vedle složky: **Nová podsložka**, **Přejmenovat**, **Přesunout do…** a **Odstranit**. Můžete také složky přetahovat pro změnu pořadí nebo vnoření. Smazáním složky nesmažete nahrávky v ní obsažené.

Kliknutím na složku zobrazíte její nahrávky v tabulce, kterou lze řadit podle názvu, data, délky nebo velikosti:

![Složka](images/folder-pane.png)

**Nastavení** u složky umožní export složky na disk nebo na Google Drive. Viz [Exporty, zálohy a uchovávání](exports-backups-retention.md#folder-exports).

Další: [Přepisy](transcripts.md)
