import type { ReactiveController, ReactiveControllerHost } from "lit";

export type UiLocale = "en" | "cs";

interface PluralForms {
  readonly one: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

type Message = string | PluralForms;

const enCatalog = {
  "shell.skip": "Skip to campaign content",
  "shell.campaignArchive": "Campaign archive",
  "shell.openOverview": "Open campaign overview",
  "shell.addons": "Add-ons",
  "shell.noAddonPages": "No add-on pages are active.",
  "shell.signInForTools": "Sign in to open campaign tools.",
  "shell.addonsIdle": "Add-ons are idle",
  "shell.addonsLoading": "Loading add-ons…",
  "shell.addonGenerationsActive": { one: "{n} add-on generation active", other: "{n} add-on generations active" },
  "shell.addonsActiveFailed": "{active} active · {failed} failed",
  "shell.addonsAttention": "Add-ons need attention",
  "shell.campaignAddons": "Campaign add-ons",
  "shell.recordAddons": "Record add-ons",
  "shell.addonPage": "Add-on page",
  "shell.dismiss": "Dismiss",
  "shell.campaign": "Campaign",
  "shell.world": "World",
  "shell.compendium": "Compendium",
  "shell.closeMenu": "Close menu",
  "shell.overview": "Overview",
  "shell.search": "Search",
  "shell.party": "The party",
  "shell.settings": "Settings",
  "shell.people": "People",
  "shell.places": "Places",
  "shell.primaryNavigation": "Primary campaign navigation",
  "shell.checkingSession": "Checking session…",
  "shell.privateArchive": "Private archive",
  "shell.passwordLabel": "DM or player password",
  "shell.passwordPlaceholder": "Campaign password",
  "shell.signIn": "Sign in",
  "shell.viewingAs": "Viewing as",
  "shell.player": "player",
  "shell.viewAs": "View as {role}",
  "shell.signOut": "Sign out",
  "shell.menu": "Menu",
  "shell.dmMenu": "DM menu",
  "shell.playerMenu": "Player menu",
  "shell.checkingHost": "Checking host",
  "shell.hostUnavailable": "Host unavailable",
  "shell.connecting": "Connecting",
  "shell.live": "Live",
  "shell.reconnecting": "Reconnecting",
  "shell.openingCampaign": "Opening the campaign chronicle…",
  "shell.campaignOpenFailed": "The chronicle could not be opened.",
  "shell.tryAgain": "Try again",
  "shell.signInSettings": "Sign in to open settings.",
  "shell.settingsAuthHint": "Personal preferences are available to everyone; campaign configuration requires a DM session.",
  "shell.signInAddon": "Sign in to open this page.",
  "shell.addonRoleHint": "Add-on tools inherit your current campaign role.",
  "shell.openingAddon": "Opening add-on page…",
  "shell.pageMissing": "This page is not in the index.",
  "shell.pageMissingHint": "The address may be old or incomplete.",
  "shell.returnOverview": "Return to overview",
  "collection.characters.one": "Character",
  "collection.characters.other": "Characters",
  "collection.locations.one": "Location",
  "collection.locations.other": "Locations",
  "collection.events.one": "Event",
  "collection.events.other": "Events",
  "collection.mysteries.one": "Mystery",
  "collection.mysteries.other": "Mysteries",
  "collection.factions.one": "Faction",
  "collection.factions.other": "Factions",
  "collection.pantheon.one": "Deity",
  "collection.pantheon.other": "Pantheon",
  "collection.artifacts.one": "Artifact",
  "collection.artifacts.other": "Artifacts",
  "collection.history.one": "Historical event",
  "collection.history.other": "History",
  "collection.companions.one": "Companion",
  "collection.companions.other": "Companions",
  "dashboard.campaignOverview": "Campaign overview",
  "dashboard.partyTitle": "The party",
  "dashboard.partyIntro": "The adventurers and companions at the center of the campaign.",
  "dashboard.taglinePlaceholder": "Campaign tagline",
  "map.world": "World map",
  "map.show": "Show on map",
  "map.search": "Find a place…",
  "map.noResults": "No matching places on this map.",
  "map.fit": "Whole map",
  "map.add": "Add place",
  "map.placeExisting": "Place existing location…",
  "map.saveView": "Save view",
  "map.viewName": "Name this map view",
  "map.savedView": "Saved map view",
  "map.editView": "Edit view: {name}",
  "map.viewIcon": "View icon",
  "map.captureView": "Use current map area",
  "map.previewView": "Show saved area",
  "map.viewBounds": "Area: {x1}%, {y1}% to {x2}%, {y2}%",
  "map.viewBoundsUnavailable": "Move back over the map image before saving its visible area.",
  "map.deleteView": "Delete view",
  "map.deleteViewConfirm": "Delete the saved view “{name}”?",
  "map.eventPaths": "Event paths",
  "map.storyPath": "Story path",
  "map.inSession": "Session event",
  "map.pastEvent": "Past event",
  "map.noEvents": "No placed events on this map.",
  "map.placeEvent": "Place event pin",
  "map.moveEvent": "Move event pin",
  "map.pickEvent": "Place an event",
  "map.eventPosition": "Event map position",
  "map.eventArticle": "Open event article",
  "map.chooseEventPosition": "Choose position on map",
  "map.removeEvent": "Remove event pin",
  "map.eventUnavailable": "This event or its pin is unavailable on this map.",
  "map.settings": "Maps",
  "map.selectMap": "Select a map",
  "map.previewImage": "Map image preview",
  "map.openMap": "Open map",
  "map.configInvalid": "This map configuration has an invalid stored shape and was left untouched.",
  "map.markerZoom": "Marker scaling with zoom",
  "map.markerZoomHint": "0% keeps markers the same size on screen. 100% scales them with the map. Values in between give a gentler change.",
  "map.savedViews": "Saved views",
  "map.noViews": "No saved views for this map.",
  "map.manageViews": "Manage views on map",
  "map.placeHint": "Click the map to place the marker.",
  "map.panHint": "Drag to pan · Scroll to zoom",
  "map.edit": "Edit map",
  "map.done": "Done",
  "map.upload": "Upload map image",
  "map.canvas": "Interactive campaign map",
  "map.zoomIn": "Zoom in",
  "map.zoomOut": "Zoom out",
  "map.zoom": "Map zoom",
  "map.actualSize": "Actual image size",
  "map.loading": "Opening map…",
  "map.empty": "No map image is available yet.",
  "map.missing": "This location is unavailable.",
  "map.failed": "The map image could not be loaded.",
  "map.location": "Map location",
  "map.close": "Close location panel",
  "map.article": "Open location",
  "map.local": "Local map",
  "map.position": "Edit position",
  "map.name": "Name",
  "map.x": "Horizontal position (%)",
  "map.y": "Vertical position (%)",
  "map.removePin": "Remove from map",
  "map.stale": "This map entry changed. Your draft is kept; cancel and reopen it to review the current version.",
  "map.saveFailed": "The map change could not be saved. Check the values and try again; your draft is kept.",
  "dashboard.editName": "Edit campaign name",
  "dashboard.editTagline": "Edit campaign tagline",
  "dashboard.dmIdentity": "Campaign name and tagline require DM mode.",
  "dashboard.save": "Save",
  "dashboard.saving": "Saving…",
  "dashboard.cancel": "Cancel",
  "dashboard.add": "Add",
  "dashboard.addPartyMember": "Add party member",
  "dashboard.identityStale": "Campaign details changed. Your draft is kept; copy any text you need, then cancel and reopen to review the current version.",
  "dashboard.identityInvalid": "Enter a campaign name and use at most 500 characters per field, on one line.",
  "dashboard.identityFailed": "Campaign details could not be saved. Your draft is kept; try again.",
  "dashboard.company": "Our party",
  "dashboard.openRoster": "Whole party →",
  "dashboard.emptyParty": "No party members have been recorded yet.",
  "dashboard.partyCompanions": "Party companions",
  "dashboard.lastSession": "Last session",
  "dashboard.emptySession": "There are no events with an assigned session yet.",
  "dashboard.openTimeline": "View events →",
  "dashboard.session": "Session {n}",
  "dashboard.characterCount": { one: "{n} character", other: "{n} characters" },
  "dashboard.placeCount": { one: "{n} place", other: "{n} places" },
  "dashboard.recent": "Recent changes",
  "dashboard.archiveIndex": "Campaign archive index",
  "dashboard.today": "today",
  "dashboard.yesterday": "yesterday",
  "dashboard.daysAgo": "{n} days ago",
  "search.kicker": "Campaign index",
  "search.title": "Search the chronicle",
  "search.intro": "Find people, places, events, mysteries, factions, lore, and companions in your current view.",
  "search.label": "Search the campaign",
  "search.placeholder": "Name, title, tag, or remembered phrase",
  "search.prompt": "Begin typing to search every visible part of the campaign archive.",
  "search.empty": "Nothing in the current campaign view matches “{query}”.",
  "search.count": { one: "{n} entry found", other: "{n} entries found" },
  "settings.kicker": "Campaign administration",
  "settings.title": "Settings",
  "settings.intro": "Choose your reading language and manage the campaign’s shared presentation and vocabulary.",
  "settings.categories": "Settings categories",
  "settings.language": "Language",
  "settings.languageIntro": "Choose the language used by this browser. It does not change campaign data or another player’s preference.",
  "settings.languageLabel": "Interface language",
  "settings.languageProgress": "The shell, dashboard, search, and personal settings are translated. Record editors and campaign configuration remain in English while their catalog migration continues.",
  "settings.appearance": "Appearance",
  "settings.appearanceIntro": "The campaign theme is shared by everyone. Only the DM can change it.",
  "settings.appearanceLabel": "Campaign theme",
  "settings.appearanceClassic": "Classic archive",
  "settings.appearanceClassicHint": "The original dark brown canvas, parchment text, and gold headings.",
  "settings.appearanceMoonlit": "Moonlit archive",
  "settings.appearanceMoonlitHint": "Dark slate surfaces with silver blue headings.",
  "settings.saveAppearance": "Save appearance",
  "branding.title": "Site branding",
  "branding.intro": "Choose the logo and wordmark shown in the sidebar and the browser tab. Save to apply your changes.",
  "branding.logo": "Campaign logo",
  "branding.customLogo": "Custom logo",
  "branding.defaultLogo": "Default logo",
  "branding.upload": "Upload logo",
  "branding.restoreLogo": "Use default logo",
  "branding.name": "Site name",
  "branding.subtitle": "Subtitle",
  "branding.invalid": "The branding settings are invalid. Check the stored values before saving.",
  "branding.stale": "Branding changed. Your draft is kept; cancel to review the current values.",
  "branding.failed": "Branding could not be saved. Your draft and selected file are kept; try again.",
  "sidebar.title": "Sidebar",
  "sidebar.addonPages": "Add-on pages",
  "sidebar.addonHint": "Choose which installed pages appear in the sidebar. Add-on role restrictions still apply.",
  "sidebar.noAddons": "No active add-on pages.",
  "sidebar.addonVisibility": "Visibility of {name}",
  "sidebar.everyone": "Everyone",
  "sidebar.intro": "Arrange pages and sections by dragging or using the arrow and move controls. Save to update the shared sidebar.",
  "sidebar.addSection": "Add section",
  "sidebar.defaults": "Reset layout",
  "sidebar.hidden": "Hidden pages",
  "sidebar.sectionName": "Section name",
  "sidebar.icon": "Section icon",
  "sidebar.sectionUp": "Move section {name} up",
  "sidebar.sectionDown": "Move section {name} down",
  "sidebar.deleteSection": "Delete section {name}",
  "sidebar.collapsible": "Collapsible",
  "sidebar.defaultOpen": "Open by default",
  "sidebar.dmOnly": "DM only",
  "sidebar.unavailable": "This page is not available yet.",
  "sidebar.pageUp": "Move {name} up",
  "sidebar.pageDown": "Move {name} down",
  "sidebar.movePage": "Move {name} to",
  "sidebar.newSection": "New section",
  "sidebar.dropHere": "Drop a page here",
  "sidebar.confirmDefaults": "Reset the sidebar layout? You can cancel before saving.",
  "sidebar.invalid": "The saved sidebar layout is invalid. It has been kept unchanged.",
  "sidebar.stale": "The sidebar changed. Your draft is kept; cancel to review the current layout.",
  "sidebar.failed": "The sidebar could not be saved. Your draft is kept; try again.",
  "settings.playerParty": "Player party",
  "settings.partyIntro": "Set the party name, symbol, and colors used throughout the campaign.",
  "settings.partyName": "Name",
  "settings.partyIcon": "Icon / emoji",
  "settings.partyColor": "Color (glow / chip)",
  "settings.partyTextColor": "Text color",
  "settings.partyMembers": { one: "{n} party member", other: "{n} party members" },
  "settings.partyMembersHint": "To add or remove a member, change the faction on their character page.",
  "settings.partyNoMembers": "No members yet.",
  "settings.partyOpen": "Open →",
  "settings.partyInvalid": "The party settings are invalid. Check the name, symbol, and colors before saving.",
  "settings.partyStale": "The party settings changed. Your draft is kept; cancel to review the current values before saving.",
  "settings.partyFailed": "The party settings could not be saved. Your draft is kept; try again.",
  "settings.saving": "Saving…",
} satisfies Record<string, Message>;

export type MessageKey = keyof typeof enCatalog;

const csCatalog = {
  "shell.skip": "Přeskočit na obsah kampaně",
  "shell.campaignArchive": "Archiv kampaně",
  "shell.openOverview": "Otevřít přehled kampaně",
  "shell.addons": "Doplňky",
  "shell.noAddonPages": "Nejsou aktivní žádné stránky doplňků.",
  "shell.signInForTools": "Přihlas se pro přístup k nástrojům kampaně.",
  "shell.addonsIdle": "Doplňky jsou nečinné",
  "shell.addonsLoading": "Načítám doplňky…",
  "shell.addonGenerationsActive": { one: "Aktivní je {n} generace doplňku", few: "Aktivní jsou {n} generace doplňků", other: "Aktivních generací doplňků: {n}" },
  "shell.addonsActiveFailed": "Aktivní: {active} · selhalo: {failed}",
  "shell.addonsAttention": "Doplňky vyžadují pozornost",
  "shell.campaignAddons": "Doplňky kampaně",
  "shell.recordAddons": "Doplňky záznamu",
  "shell.addonPage": "Stránka doplňku",
  "shell.dismiss": "Skrýt",
  "shell.campaign": "Kampaň",
  "shell.world": "Svět",
  "shell.compendium": "Kompendium",
  "shell.closeMenu": "Zavřít nabídku",
  "shell.overview": "Přehled",
  "shell.search": "Hledat",
  "shell.party": "Družina",
  "shell.settings": "Nastavení",
  "shell.people": "Postavy",
  "shell.places": "Místa",
  "shell.primaryNavigation": "Hlavní navigace kampaně",
  "shell.checkingSession": "Ověřuji přihlášení…",
  "shell.privateArchive": "Soukromý archiv",
  "shell.passwordLabel": "Heslo DM nebo hráče",
  "shell.passwordPlaceholder": "Heslo kampaně",
  "shell.signIn": "Přihlásit se",
  "shell.viewingAs": "Zobrazení jako",
  "shell.player": "hráč",
  "shell.viewAs": "Zobrazit jako {role}",
  "shell.signOut": "Odhlásit se",
  "shell.menu": "Menu",
  "shell.dmMenu": "Menu DM",
  "shell.playerMenu": "Menu hráče",
  "shell.checkingHost": "Ověřuji server",
  "shell.hostUnavailable": "Server není dostupný",
  "shell.connecting": "Připojuji",
  "shell.live": "Živě",
  "shell.reconnecting": "Obnovuji spojení",
  "shell.openingCampaign": "Otevírám kroniku kampaně…",
  "shell.campaignOpenFailed": "Kroniku se nepodařilo otevřít.",
  "shell.tryAgain": "Zkusit znovu",
  "shell.signInSettings": "Přihlas se pro nastavení kampaně.",
  "shell.settingsAuthHint": "Osobní volby jsou dostupné všem; nastavení kampaně vyžaduje přihlášení DM.",
  "shell.signInAddon": "Přihlas se pro otevření této stránky.",
  "shell.addonRoleHint": "Nástroje doplňků používají tvou současnou roli v kampani.",
  "shell.openingAddon": "Otevírám stránku doplňku…",
  "shell.pageMissing": "Tato stránka není v rejstříku.",
  "shell.pageMissingHint": "Adresa může být stará nebo neúplná.",
  "shell.returnOverview": "Zpět na přehled",
  "collection.characters.one": "Postava",
  "collection.characters.other": "Postavy",
  "collection.locations.one": "Místo",
  "collection.locations.other": "Místa",
  "collection.events.one": "Událost",
  "collection.events.other": "Události",
  "collection.mysteries.one": "Záhada",
  "collection.mysteries.other": "Záhady",
  "collection.factions.one": "Frakce",
  "collection.factions.other": "Frakce",
  "collection.pantheon.one": "Božstvo",
  "collection.pantheon.other": "Panteon",
  "collection.artifacts.one": "Artefakt",
  "collection.artifacts.other": "Artefakty",
  "collection.history.one": "Historická událost",
  "collection.history.other": "Historie",
  "collection.companions.one": "Společník",
  "collection.companions.other": "Společníci",
  "dashboard.campaignOverview": "Přehled kampaně",
  "dashboard.partyTitle": "Družina",
  "dashboard.partyIntro": "Dobrodruzi a společníci v centru kampaně.",
  "dashboard.taglinePlaceholder": "Podtitul kampaně",
  "map.world": "Mapa světa",
  "map.show": "Zobrazit na mapě",
  "map.search": "Najít místo…",
  "map.noResults": "Na této mapě nejsou odpovídající místa.",
  "map.fit": "Celá mapa",
  "map.add": "Přidat místo",
  "map.placeExisting": "Umístit existující místo…",
  "map.saveView": "Uložit pohled",
  "map.viewName": "Název pohledu na mapu",
  "map.savedView": "Uložený pohled na mapu",
  "map.editView": "Upravit pohled: {name}",
  "map.viewIcon": "Ikona pohledu",
  "map.captureView": "Použít aktuální oblast mapy",
  "map.previewView": "Zobrazit uloženou oblast",
  "map.viewBounds": "Oblast: {x1} %, {y1} % až {x2} %, {y2} %",
  "map.viewBoundsUnavailable": "Před uložením viditelné oblasti se vrať nad obrázek mapy.",
  "map.deleteView": "Smazat pohled",
  "map.deleteViewConfirm": "Smazat uložený pohled „{name}“?",
  "map.eventPaths": "Cesty událostí",
  "map.storyPath": "Cesta příběhu",
  "map.inSession": "Událost sezení",
  "map.pastEvent": "Minulá událost",
  "map.noEvents": "Na této mapě nejsou umístěné události.",
  "map.placeEvent": "Umístit událost na mapu",
  "map.moveEvent": "Přesunout značku události",
  "map.pickEvent": "Umístit událost",
  "map.eventPosition": "Poloha události na mapě",
  "map.eventArticle": "Otevřít článek události",
  "map.chooseEventPosition": "Vybrat polohu na mapě",
  "map.removeEvent": "Odebrat značku události",
  "map.eventUnavailable": "Tato událost nebo její značka není na této mapě dostupná.",
  "map.settings": "Mapy",
  "map.selectMap": "Vybrat mapu",
  "map.previewImage": "Náhled obrázku mapy",
  "map.openMap": "Otevřít mapu",
  "map.configInvalid": "Uložené nastavení této mapy má neplatný formát a zůstalo beze změny.",
  "map.markerZoom": "Změna velikosti značek při přiblížení",
  "map.markerZoomHint": "0 % zachová stejnou velikost značek na obrazovce. 100 % mění velikost spolu s mapou. Hodnoty mezi tím změnu zmírní.",
  "map.savedViews": "Uložené pohledy",
  "map.noViews": "Pro tuto mapu nejsou uložené pohledy.",
  "map.manageViews": "Spravovat pohledy na mapě",
  "map.placeHint": "Kliknutím do mapy umístíš značku.",
  "map.panHint": "Tažením posunout · Kolečkem přiblížit",
  "map.edit": "Upravit mapu",
  "map.done": "Hotovo",
  "map.upload": "Nahrát obrázek mapy",
  "map.canvas": "Interaktivní mapa kampaně",
  "map.zoomIn": "Přiblížit",
  "map.zoomOut": "Oddálit",
  "map.zoom": "Přiblížení mapy",
  "map.actualSize": "Původní velikost obrázku",
  "map.loading": "Otevírání mapy…",
  "map.empty": "Mapa zatím nemá obrázek.",
  "map.missing": "Toto místo není dostupné.",
  "map.failed": "Obrázek mapy se nepodařilo načíst.",
  "map.location": "Místo na mapě",
  "map.close": "Zavřít panel místa",
  "map.article": "Otevřít místo",
  "map.local": "Místní mapa",
  "map.position": "Upravit polohu",
  "map.name": "Název",
  "map.x": "Vodorovná poloha (%)",
  "map.y": "Svislá poloha (%)",
  "map.removePin": "Odebrat z mapy",
  "map.stale": "Záznam mapy se změnil. Rozepsané změny zůstávají zachovány. Zruš úpravu a znovu ji otevři pro zobrazení aktuální verze.",
  "map.saveFailed": "Změnu mapy se nepodařilo uložit. Zkontroluj hodnoty a zkus to znovu. Rozepsané změny zůstávají zachovány.",
  "dashboard.editName": "Upravit název kampaně",
  "dashboard.editTagline": "Upravit podtitul kampaně",
  "dashboard.dmIdentity": "Název a podtitul kampaně lze upravit v režimu DM.",
  "dashboard.save": "Uložit",
  "dashboard.saving": "Ukládání…",
  "dashboard.cancel": "Zrušit",
  "dashboard.add": "Přidat",
  "dashboard.addPartyMember": "Přidat člena družiny",
  "dashboard.identityStale": "Údaje kampaně se změnily. Rozepsaný text zůstává zachován. Zkopíruj si potřebný text, zruš úpravu a znovu ji otevři pro zobrazení aktuální verze.",
  "dashboard.identityInvalid": "Vyplň název kampaně. Každé pole může mít nejvýše 500 znaků na jednom řádku.",
  "dashboard.identityFailed": "Údaje kampaně se nepodařilo uložit. Rozepsaný text zůstává zachován; zkus to znovu.",
  "dashboard.company": "Družina",
  "dashboard.openRoster": "Otevřít seznam družiny",
  "dashboard.emptyParty": "Zatím nejsou zapsáni žádní členové družiny.",
  "dashboard.partyCompanions": "Společníci družiny",
  "dashboard.lastSession": "Poslední sezení",
  "dashboard.emptySession": "Zatím nejsou žádné události s přiřazeným sezením.",
  "dashboard.openTimeline": "Zobrazit události →",
  "dashboard.session": "Sezení {n}",
  "dashboard.characterCount": { one: "{n} postava", few: "{n} postavy", other: "{n} postav" },
  "dashboard.placeCount": { one: "{n} místo", few: "{n} místa", other: "{n} míst" },
  "dashboard.recent": "Nedávno změněno",
  "dashboard.archiveIndex": "Rejstřík archivu kampaně",
  "dashboard.today": "dnes",
  "dashboard.yesterday": "včera",
  "dashboard.daysAgo": "před {n} dny",
  "search.kicker": "Rejstřík kampaně",
  "search.title": "Hledat v kronice",
  "search.intro": "Najdi postavy, místa, události, záhady, frakce, příběhy a společníky v aktuálním zobrazení.",
  "search.label": "Hledat v kampani",
  "search.placeholder": "Jméno, titul, štítek nebo zapamatovaná fráze",
  "search.prompt": "Začni psát a prohledej všechny viditelné části archivu kampaně.",
  "search.empty": "V aktuálním zobrazení kampaně nic neodpovídá „{query}“.",
  "search.count": { one: "Nalezen {n} záznam", few: "Nalezeny {n} záznamy", other: "Nalezeno {n} záznamů" },
  "settings.kicker": "Správa kampaně",
  "settings.title": "Kniha nastavení",
  "settings.intro": "Vyber jazyk rozhraní a spravuj společný vzhled a pojmy kampaně.",
  "settings.categories": "Kategorie nastavení",
  "settings.language": "Jazyk",
  "settings.languageIntro": "Vyber jazyk pro tento prohlížeč. Data kampaně ani volbu jiného hráče to nezmění.",
  "settings.languageLabel": "Jazyk rozhraní",
  "settings.languageProgress": "Přeložen je základ aplikace, přehled, hledání a osobní nastavení. Editory záznamů a nastavení kampaně zůstávají během převodu katalogu v angličtině.",
  "settings.appearance": "Vzhled",
  "settings.appearanceIntro": "Vzhled kampaně je společný pro všechny. Změnit jej může pouze DM.",
  "settings.appearanceLabel": "Vzhled kampaně",
  "settings.appearanceClassic": "Klasický archiv",
  "settings.appearanceClassicHint": "Původní tmavě hnědé pozadí, pergamenový text a zlaté nadpisy.",
  "settings.appearanceMoonlit": "Měsíční archiv",
  "settings.appearanceMoonlitHint": "Tmavé břidlicové plochy se stříbřitě modrými nadpisy.",
  "settings.saveAppearance": "Uložit vzhled",
  "branding.title": "Značka webu",
  "branding.intro": "Vyberte logo a název v postranním panelu a na kartě prohlížeče. Změny potvrďte uložením.",
  "branding.logo": "Logo kampaně",
  "branding.customLogo": "Vlastní logo",
  "branding.defaultLogo": "Výchozí logo",
  "branding.upload": "Nahrát logo",
  "branding.restoreLogo": "Použít výchozí logo",
  "branding.name": "Název webu",
  "branding.subtitle": "Podtitulek",
  "branding.invalid": "Nastavení značky není platné. Před uložením zkontrolujte uložené hodnoty.",
  "branding.stale": "Značka se změnila. Rozepsané úpravy zůstaly zachovány; tlačítkem Zrušit načtete aktuální hodnoty.",
  "branding.failed": "Značku se nepodařilo uložit. Rozepsané úpravy i vybraný soubor zůstaly zachovány; zkuste to znovu.",
  "sidebar.title": "Postranní panel",
  "sidebar.addonPages": "Stránky doplňků",
  "sidebar.addonHint": "Vyberte stránky nainstalovaných doplňků do postranního panelu. Omezení rolí doplňku stále platí.",
  "sidebar.noAddons": "Žádné aktivní stránky doplňků.",
  "sidebar.addonVisibility": "Viditelnost stránky {name}",
  "sidebar.everyone": "Všichni",
  "sidebar.intro": "Stránky a sekce uspořádáte přetažením, šipkami nebo výběrem cílové sekce. Uložením změníte společný postranní panel.",
  "sidebar.addSection": "Přidat sekci",
  "sidebar.defaults": "Obnovit rozložení",
  "sidebar.hidden": "Skryté stránky",
  "sidebar.sectionName": "Název sekce",
  "sidebar.icon": "Ikona sekce",
  "sidebar.sectionUp": "Posunout sekci {name} nahoru",
  "sidebar.sectionDown": "Posunout sekci {name} dolů",
  "sidebar.deleteSection": "Smazat sekci {name}",
  "sidebar.collapsible": "Sbalovací",
  "sidebar.defaultOpen": "Ve výchozím stavu otevřená",
  "sidebar.dmOnly": "Pouze DM",
  "sidebar.unavailable": "Tato stránka zatím není dostupná.",
  "sidebar.pageUp": "Posunout {name} nahoru",
  "sidebar.pageDown": "Posunout {name} dolů",
  "sidebar.movePage": "Přesunout {name} do",
  "sidebar.newSection": "Nová sekce",
  "sidebar.dropHere": "Sem přetáhněte stránku",
  "sidebar.confirmDefaults": "Obnovit rozložení postranního panelu? Před uložením můžete změny zrušit.",
  "sidebar.invalid": "Uložené rozložení postranního panelu není platné. Zůstalo beze změny.",
  "sidebar.stale": "Postranní panel se změnil. Rozepsané úpravy zůstaly zachovány; tlačítkem Zrušit načtete aktuální rozložení.",
  "sidebar.failed": "Postranní panel se nepodařilo uložit. Rozepsané úpravy zůstaly zachovány; zkuste to znovu.",
  "settings.playerParty": "Hráčská družina",
  "settings.partyIntro": "Nastavte název, symbol a barvy družiny používané v celé kampani.",
  "settings.partyName": "Název",
  "settings.partyIcon": "Ikona / emoji",
  "settings.partyColor": "Barva (záře / štítek)",
  "settings.partyTextColor": "Barva textu",
  "settings.partyMembers": { one: "{n} člen družiny", few: "{n} členové družiny", other: "{n} členů družiny" },
  "settings.partyMembersHint": "Člena přidáte nebo odeberete změnou frakce na stránce jeho postavy.",
  "settings.partyNoMembers": "Zatím žádní členové.",
  "settings.partyOpen": "Otevřít →",
  "settings.partyInvalid": "Nastavení družiny není platné. Před uložením zkontrolujte název, symbol a barvy.",
  "settings.partyStale": "Nastavení družiny se změnilo. Rozepsané úpravy zůstaly zachovány; tlačítkem Zrušit načtete aktuální hodnoty.",
  "settings.partyFailed": "Nastavení družiny se nepodařilo uložit. Rozepsané úpravy zůstaly zachovány; zkuste to znovu.",
  "settings.saving": "Ukládám…",
} satisfies Record<MessageKey, Message>;

const catalogs: Readonly<Record<UiLocale, Readonly<Record<MessageKey, Message>>>> = Object.freeze({
  en: Object.freeze(enCatalog),
  cs: Object.freeze(csCatalog),
});

export const availableUiLocales = Object.freeze([
  Object.freeze({ id: "en" as const, endonym: "English" }),
  Object.freeze({ id: "cs" as const, endonym: "Čeština" }),
]);

const localeChangeTarget = new EventTarget();
let activeLocale: UiLocale = resolveUiLocale(readStorage("codex_lang"));

export class UiLocalizationController implements ReactiveController {
  readonly #host: ReactiveControllerHost;
  readonly #onChange = (): void => { this.#host.requestUpdate(); };

  constructor(host: ReactiveControllerHost) {
    this.#host = host;
    host.addController(this);
  }

  hostConnected(): void { localeChangeTarget.addEventListener("change", this.#onChange); }
  hostDisconnected(): void { localeChangeTarget.removeEventListener("change", this.#onChange); }
  get locale(): UiLocale { return activeLocale; }
  t(key: MessageKey, parameters: Readonly<Record<string, string | number>> = {}): string {
    return uiText(key, parameters);
  }
  plural(key: MessageKey, count: number, parameters: Readonly<Record<string, string | number>> = {}): string {
    return uiPlural(key, count, parameters);
  }
  relativeDate(value: string | undefined): string { return uiRelativeDate(value); }
  setLocale(locale: UiLocale): void { setUiLocale(locale); }
}

export function initializeUiLocalization(): void { applyLocale(); }

export function resolveUiLocale(stored: string | null | undefined): UiLocale {
  return stored === "cs" ? "cs" : "en";
}

export function currentUiLocale(): UiLocale { return activeLocale; }

export function setUiLocale(locale: UiLocale): void {
  if (locale === activeLocale) return;
  activeLocale = locale;
  writeStorage("codex_lang", locale);
  applyLocale();
  localeChangeTarget.dispatchEvent(new Event("change"));
}

export function uiText(
  key: MessageKey,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const message = catalogs[activeLocale][key] ?? catalogs.en[key];
  const template = typeof message === "string" ? message : message.other;
  return interpolate(template, parameters);
}

export function uiPlural(
  key: MessageKey,
  count: number,
  parameters: Readonly<Record<string, string | number>> = {},
): string {
  const message = catalogs[activeLocale][key] ?? catalogs.en[key];
  if (typeof message === "string") return interpolate(message, { n: count, ...parameters });
  const category = new Intl.PluralRules(activeLocale).select(Math.abs(count));
  const template = category === "one" ? message.one
    : category === "few" ? message.few ?? message.other
      : category === "many" ? message.many ?? message.other
        : message.other;
  return interpolate(template, { n: count, ...parameters });
}

export function uiCollectionLabel(pageID: string, form: "one" | "other"): string {
  const key = collectionKeys[pageID]?.[form];
  return key === undefined ? pageID : uiText(key);
}

export function uiRelativeDate(value: string | undefined, now = Date.now()): string {
  if (value === undefined) return "";
  const instant = Date.parse(value);
  const elapsed = now - instant;
  if (!Number.isFinite(elapsed) || elapsed < 0) return formatDate(instant);
  const days = Math.floor(elapsed / 86_400_000);
  if (days === 0) return uiText("dashboard.today");
  if (days === 1) return uiText("dashboard.yesterday");
  if (days < 14) return uiText("dashboard.daysAgo", { n: days });
  return formatDate(instant);
}

const collectionKeys: Readonly<Record<string, Readonly<Record<"one" | "other", MessageKey>>>> = Object.freeze({
  characters: Object.freeze({ one: "collection.characters.one", other: "collection.characters.other" }),
  locations: Object.freeze({ one: "collection.locations.one", other: "collection.locations.other" }),
  events: Object.freeze({ one: "collection.events.one", other: "collection.events.other" }),
  mysteries: Object.freeze({ one: "collection.mysteries.one", other: "collection.mysteries.other" }),
  factions: Object.freeze({ one: "collection.factions.one", other: "collection.factions.other" }),
  pantheon: Object.freeze({ one: "collection.pantheon.one", other: "collection.pantheon.other" }),
  artifacts: Object.freeze({ one: "collection.artifacts.one", other: "collection.artifacts.other" }),
  history: Object.freeze({ one: "collection.history.one", other: "collection.history.other" }),
  companions: Object.freeze({ one: "collection.companions.one", other: "collection.companions.other" }),
});

function interpolate(template: string, parameters: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(parameters, key) ? String(parameters[key]) : match);
}

function formatDate(instant: number): string {
  try { return new Intl.DateTimeFormat(activeLocale).format(new Date(instant)); }
  catch { return new Date(instant).toLocaleDateString(); }
}

function applyLocale(): void {
  if (typeof document !== "undefined") document.documentElement.lang = activeLocale;
}

function readStorage(key: string): string | null {
  try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); }
  catch { return null; }
}

function writeStorage(key: string, value: string): void {
  try { if (typeof window !== "undefined") window.localStorage.setItem(key, value); }
  catch { /* A blocked preference store must not break the campaign UI. */ }
}
