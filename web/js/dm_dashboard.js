// ═══════════════════════════════════════════════════════════════
//  DM DASHBOARD — landing page for DM-only content at #/dm.
//
//  MVP: a quick at-a-glance count of DM-only entries per collection,
//  plus stub links to future DM-only pages (plot tracker, session
//  notes, encounters). Each future phase plants its own renderer
//  module and adds a link here.
//
//  Defence in depth: navigate() in app.js short-circuits to a "jen
//  pro DM" stub when !Role.isDM(). The DM links never appear in the
//  sidebar for non-DM viewers (role gating in applySidebarVisibility +
//  CSS body:not(.is-dm) rules), but a player who pasted the URL still
//  gets a polite refusal rather than a render of the DM panel.
// ═══════════════════════════════════════════════════════════════

import { Store } from './store.js';
import { Role } from './role.js';
import { esc } from './utils.js';
import { I18n } from './i18n.js';

export const DmDashboard = (() => {

  function render() {
    const main = document.getElementById('main-content');
    if (!main) return;
    if (!Role.isDM()) {
      main.innerHTML = `
        <div class="dm-panel">
          <h1>🛡 ${esc(I18n.t('nav.dmPanel'))}</h1>
          <p class="dm-stub">${esc(I18n.t('dm.refusal'))}</p>
        </div>
      `;
      return;
    }
    const counts = _dmOnlyCounts();
    const totalDm = counts.reduce((acc, c) => acc + c.dmOnly, 0);
    main.innerHTML = `
      <div class="dm-panel">
        <h1>🛡 ${esc(I18n.t('nav.dmPanel'))}</h1>
        <p class="dm-stub">${esc(I18n.t('dm.intro'))}</p>

        <section class="dm-section">
          <h2>${esc(I18n.t('dm.hiddenContent'))}</h2>
          <p class="dm-section-hint">
            ${totalDm === 0
              ? esc(I18n.t('dm.hiddenContentEmpty'))
              : esc(I18n.plural('dm.hiddenContentCount', totalDm))}
          </p>
          <div class="dm-grid">
            ${counts.map(_renderCountCard).join('')}
          </div>
        </section>

        <section class="dm-section">
          <h2>${esc(I18n.t('dm.futureTools'))}</h2>
          <ul class="dm-stub-list">
            <li>📓 ${esc(I18n.t('dm.toolSessionNotes'))}</li>
            <li>📋 ${esc(I18n.t('dm.toolPlotTracker'))}</li>
            <li>🗺 ${esc(I18n.t('dm.toolMapLayer'))}</li>
            <li>📚 ${esc(I18n.t('dm.toolContentPacks'))}</li>
          </ul>
        </section>
      </div>
    `;
  }

  // Walk the collections that participate in the visibility model
  // and tally up DM-only records per collection. The dataset the
  // client holds is the DM-filtered payload (we already gated this
  // call on Role.isDM()), so the count reflects truth.
  function _dmOnlyCounts() {
    const out = [];
    const lists = [
      { key: 'characters',       label: I18n.t('nav.characters'),  route: '#/postavy',  getter: Store.getCharacters       },
      { key: 'locations',        label: I18n.t('nav.locations'),   route: '#/mista',    getter: Store.getLocations        },
      { key: 'events',           label: I18n.t('dm.collEvents'),   route: '#/casova-osa', getter: Store.getEvents          },
      { key: 'mysteries',        label: I18n.t('nav.mysteries'),   route: '#/zahady',   getter: Store.getMysteries        },
      { key: 'pantheon',         label: I18n.t('nav.pantheon'),    route: '#/panteon',  getter: Store.getPantheon         },
      { key: 'artifacts',        label: I18n.t('nav.artifacts'),   route: '#/artefakty', getter: Store.getArtifacts        },
      { key: 'historicalEvents', label: I18n.t('dm.collHistoricalEvents'), route: '#/historie', getter: Store.getHistoricalEvents },
    ];
    for (const c of lists) {
      let total = 0, dmOnly = 0;
      const arr = c.getter ? c.getter() : [];
      for (const e of arr || []) {
        total++;
        if (e && e.visibility === 'dm') dmOnly++;
      }
      out.push({ ...c, total, dmOnly });
    }
    // Factions are a keyed-object collection.
    const factions = Store.getFactions ? Store.getFactions() : {};
    let fTotal = 0, fDm = 0;
    for (const f of Object.values(factions || {})) {
      fTotal++;
      if (f && f.visibility === 'dm') fDm++;
    }
    out.push({ key: 'factions', label: I18n.t('nav.factions'), route: '#/frakce', total: fTotal, dmOnly: fDm });
    return out;
  }

  function _renderCountCard(c) {
    const hasDm = c.dmOnly > 0;
    return `
      <a class="dm-count-card${hasDm ? ' has-dm' : ''}" href="${esc(c.route)}">
        <span class="dm-count-label">${esc(c.label)}</span>
        <span class="dm-count-numbers">
          <strong>${c.dmOnly}</strong> / ${c.total}
        </span>
        <span class="dm-count-meta">${esc(I18n.t('dm.onlyDmMeta'))}</span>
      </a>
    `;
  }

  return { render };
})();
