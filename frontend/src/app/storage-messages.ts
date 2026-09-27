export const storageEn = {
  "storage.latestOnly":
    "The server automatically removes superseded packages and their old add-on recovery data. Campaign recovery, current saves and backups are kept. Unfinished update reviews expire after 30 minutes.",
  "storage.preserved":
    "Kept locally: a recovery point needs this build and no durable release source is recorded.",
  "storage.automatic":
    "Old package files are removed automatically after a successful update. The current build and recovery records are kept.",
  "storage.manual": "Automatic package cleanup is disabled by the server configuration.",
  "storage.history": "Previous builds",
  "storage.historyHelp":
    "Older files are removed when recoverable from their recorded source. Download an exact build to review and activate it again.",
  "storage.pending": "The server is retrying removal of old package files automatically.",
  "storage.retry": "Retry file cleanup",
  "storage.restore": "Download and review",
  "storage.manualZip":
    "No download source is recorded. Upload the ZIP with this exact checksum through Add add-on.",
  "storage.required": "Add-ons required by this recovery point",
  "storage.prepare": "Prepare required packages",
  "storage.prepareHelp":
    "Prepare all required packages, then review and activate the listed builds in Add-ons. Return here and refresh before restoring the campaign. Dependencies and saved data must remain compatible.",
  "storage.review": "Review activation",
  "storage.current": "Already active",
  "storage.ready": "Package ready",
  "storage.loading": "Checking package files…",
  "storage.failed":
    "Package files could not be prepared. Retry, or supply the matching ZIP through Add-ons.",
  "storage.stale": "The recovery point or campaign changed. Refresh and review again.",
  "storage.prepareFirst": "Prepare or upload the exact package before reviewing its activation.",
} as const;
export const storageCs: Record<keyof typeof storageEn, string> = {
  "storage.latestOnly":
    "Server automaticky odstraňuje nahrazené balíčky a jejich stará data obnovy doplňků. Obnova kampaně, současná uložená data a zálohy zůstanou zachovány. Nedokončené kontroly aktualizací vyprší po 30 minutách.",
  "storage.preserved":
    "Uloženo místně: bod obnovy vyžaduje toto sestavení a trvalý zdroj vydání není zaznamenán.",
  "storage.automatic":
    "Staré soubory balíčků se po úspěšné aktualizaci automaticky odstraní. Aktuální sestavení a záznamy obnovy zůstanou zachovány.",
  "storage.manual": "Automatické čištění balíčků je vypnuté v konfiguraci serveru.",
  "storage.history": "Předchozí sestavení",
  "storage.historyHelp":
    "Staré soubory se odstraní, pokud je lze obnovit ze zaznamenaného zdroje. Pro kontrolu a opětovnou aktivaci stáhněte přesné sestavení.",
  "storage.pending": "Server automaticky opakuje odstranění starých souborů balíčků.",
  "storage.retry": "Zopakovat čištění souborů",
  "storage.restore": "Stáhnout a zkontrolovat",
  "storage.manualZip":
    "Zdroj stažení není zaznamenán. Přes Přidat doplněk nahrajte ZIP s tímto přesným kontrolním součtem.",
  "storage.required": "Doplňky požadované tímto bodem obnovy",
  "storage.prepare": "Připravit požadované balíčky",
  "storage.prepareHelp":
    "Připravte všechny požadované balíčky, pak v Doplňcích zkontrolujte a aktivujte uvedená sestavení. Před obnovou kampaně se vraťte sem a obnovte seznam. Závislosti a uložená data musí zůstat kompatibilní.",
  "storage.review": "Zkontrolovat aktivaci",
  "storage.current": "Již aktivní",
  "storage.ready": "Balíček připraven",
  "storage.loading": "Kontrola souborů balíčků…",
  "storage.failed":
    "Soubory balíčků se nepodařilo připravit. Zkuste to znovu nebo přes Doplňky nahrajte odpovídající ZIP.",
  "storage.stale": "Bod obnovy nebo kampaň se změnily. Obnovte seznam a proveďte kontrolu znovu.",
  "storage.prepareFirst": "Před kontrolou aktivace připravte nebo nahrajte přesný balíček.",
};
