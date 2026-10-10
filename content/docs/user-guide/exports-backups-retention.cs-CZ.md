---
title: Exporty, zálohy a uchovávání dat
description: Exporty složek na disk nebo Google Drive, zálohy a automatické mazání starých dat.
---

<span id="folder-exports" />

## Exporty složek

Export složky uchovává kopii nahrávek složky mimo Riffado, na disku nebo v Google Drive, a udržuje ji aktuální. Váš administrátor rozhoduje, kterou z těchto dvou možností vaše instance nabízí.

Otevřete složku (viz [Složky](recordings.md#folders)) a klikněte na **Nastavení**:

![Nastavení exportu složek](images/folder-export.png)

<span id="to-a-disk" />

### Na disk

Klikněte na **Přidat export do souborového systému**, zadejte název složky v exportním adresáři instance a zvolte, co exportovat:

![Export do souborového systému](images/folder-export-filesystem.png)

- **Audio**: originální nahrávka.
- **Přepis**: přepis, ve všech jeho formách.
- **Souhrn**: souhrn, ve všech jeho formách.
- **Pošta** (kde vaše instance přijímá poštu): každý e-mail tak, jak přišel (`message.eml` i s přílohami), a jako čitelný `mail.md` se souhrnem a úkoly. Je vypnutá, dokud ji nezapnete; export jen pošty je v pořádku.

Klikněte na **Uložit export**. Export zahrnuje složku a všechny složky uvnitř ní. Soubory jsou pojmenovány podle názvů nahrávek.

<span id="to-google-drive" />

### Do Google Drive

Nejprve propojte svůj Google účet v **Nastavení → Google účet**. Poté klikněte na **Přidat export na Google Drive**, vyberte složku na Drive a u přepisů i souhrnů si zvolte, zda má být exportován soubor ve formátu Markdown, Google Docs, nebo oba. Riffado má přístup právě jen k této složce a k souborům, které zde samo vytvoří. Dokumenty Google jsou přepsány vždy, když se nahrávka změní, takže vaše úpravy budou přepsány.

<span id="how-an-export-stays-up-to-date" />

### Jak se export udržuje aktuální

- Nahrávka, kterou zařadíte do složky, je zapsána; pokud ji odstraníte, soubor se vymaže.
- Nahrávka, kterou přesunete nebo přejmenujete, způsobí přesun/přejmenování jejích souborů místo nového vytvoření.
- Soubory smazaných nahrávek, odstraněných přepisů nebo souhrnů, nebo druhů, které jste vypnuli, jsou z exportu vymazány.
- Nahrávka zařazená do více složek má kopii v každé z nich.
- Riffado se nikdy nedotýká souborů, které samo nevytvořilo. Audio, které [uchovávání](#deleting-old-data-automatically) odstranilo z Riffado, zůstává v exportu.
- Export účtu organizace zapisuje u sdíleného e-mailu jen `mail.md` se skrytými tajnými adresami: zpráva tak, jak přišla, zůstává jejímu odesílateli.
- **Synchronizovat** zkontroluje export a znovu zapíše to, co chybí.

<span id="backups" />

## Zálohy

![Export a záloha](images/settings-export.png)

V **Nastavení → Export/Záloha** si můžete vzít svá data s sebou:

- **Exportovat text** vám okamžitě stáhne přepisy a souhrny ve **výchozím exportním formátu** (JSON, TXT, SRT nebo VTT).
- **Vytvořit úplnou zálohu** vytvoří jeden archiv obsahující vše: audio, přepisy, souhrny, Váš Almanac, Learn recenze a úkoly. Velké knihovny mohou zabrat pár minut; jakmile je záloha připravena, přijde vám e-mail a objeví se tlačítko **Stáhnout**.
- **Frekvence zálohování** vytváří archiv denně, týdně nebo měsíčně – bez nutnosti si na to vzpomenout.

Každý archiv zůstává ke stažení po dobu sedmi dnů. Záloha obsahuje vaše vlastní nahrávky, včetně sdílených, ale bez toho, co do nich přidali kolegové. Záloha účtu organizace obsahuje všechny sdílené nahrávky, včetně jejich vlastníka.

<span id="deleting-old-data-automatically" />

## Automatické mazání starých dat

![Automatické mazání starých dat](images/settings-retention.png)

**Nastavení → Úložiště → Automatické mazání starých dat** maže staré kopie podle plánu. Každý druh má vlastní období, od 1 do 365 dní, a dokud jej nezapnete, je funkce vypnuta:

- **Vzdálený originál**: přesune originální soubor v cloudu vašeho rekordéru do Koše, ale až poté, co má Riffado vlastní kopii.
- **Místní audio**: kopie zvuku uložená v Riffado.
- **Místní přepis** a **Místní souhrn**: lze je vytvořit znovu, pokud zůstává zvuk.

Nahrávka zůstává ve vaší knihovně s poznámkou o tom, co bylo odstraněno, a Riffado ji samo znovu nenastahuje. V horní části stránky Úložiště vidíte, kolik místa vaše nahrávky zabírají a které jsou největší.

Pokračujte na: [Nastavení](settings.md)
