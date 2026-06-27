// Fragment-override demo — Phase 6 reference addon.
//
// Decomposed built-in surfaces emit NAMED fragments (e.g. the character
// article main column: `characters:section:vazby`, `characters:section:otazky`,
// `characters:body`, …). An addon claims an op on a fragment id:
//   • wrap    — wrap the current html. STACKABLE + ordered → never conflicts.
//   • insert  — add a sibling before/after a fragment. Additive → never conflicts.
//   • replace — substitute the fragment.  EXCLUSIVE per target.
//   • hide    — drop the fragment.        EXCLUSIVE per target.
//
// Two addons claiming an EXCLUSIVE op on the SAME fragment is a detected
// conflict: the host renders the BUILT-IN (safe default) and surfaces the clash
// in Nastavení → Doplňky → Konflikty for the DM to resolve — never a silent
// last-wins clobber. This demo uses the safe `wrap` op so it composes with
// anything. Build HTML with host.h + design tokens (var(--…)).
export default function register(host) {
  host.registerFragmentOp('characters:body', {
    op: 'wrap',
    // render(innerHtml, ctx) → string. ctx carries { entity, kind, target }.
    render: (html) => `
      <div style="border:1px solid rgba(var(--accent-gold-rgb),0.3);border-radius:var(--radius);
                  padding:var(--space-3);position:relative;margin-top:var(--space-2)">
        <span style="position:absolute;top:calc(-1 * var(--space-2));left:var(--space-3);
                     background:var(--bg-base);padding:0 var(--space-1);
                     font-size:var(--text-xs);color:var(--text-muted)">🖼 rámeček doplňku</span>
        ${html}
      </div>`,
  });
}
