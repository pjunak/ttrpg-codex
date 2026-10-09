export const storageEn = {
  "storage.automatic":
    "After a successful update the server removes the previous build and its old add-on recovery data. Campaign recovery, current saves and backups are kept. Every build stays available as a GitHub release, so an older one can be installed again.",
  "storage.manual": "Automatic package cleanup is disabled by the server configuration.",
  "storage.pending": "The server is retrying removal of old package files automatically.",
  "storage.failed": "Package cleanup status could not be loaded.",
} as const;
export const storageCs: Record<keyof typeof storageEn, string> = {
  "storage.automatic":
    "Po úspěšné aktualizaci server odstraní předchozí sestavení a jeho stará data obnovy doplňku. Obnova kampaně, současná uložená data a zálohy zůstanou zachovány. Každé sestavení zůstává dostupné jako vydání na GitHubu, takže starší lze znovu nainstalovat.",
  "storage.manual": "Automatické čištění balíčků je vypnuté v konfiguraci serveru.",
  "storage.pending": "Server automaticky opakuje odstranění starých souborů balíčků.",
  "storage.failed": "Stav čištění balíčků se nepodařilo načíst.",
};
