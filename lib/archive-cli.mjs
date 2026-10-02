// The export, import, secrets and backup commands of cli.mjs. cli.mjs passes its argument list and its run-lock wrapper.
import path from 'node:path';
import { exportArchive, importArchive, defaultExportName, FORMAT_V1 } from './archive.mjs';
import { backup, listBackups, restore, fmtBytes } from './backup.mjs';
import { exportSecrets, importSecrets, readPassphrase } from './secrets.mjs';
import { writeApplicationsCsv } from './csv.mjs';
import { today } from './config.mjs';

const USAGE = {
  export: 'node cli.mjs export [--out <file.zip|folder>] [--data-only]   or   node cli.mjs export --csv <file.csv>',
  import: 'node cli.mjs import --from <file.zip|file.tar.gz|folder> [--dry-run] [--on-conflict keep|theirs|both] [--data-only]',
  'export-secrets': 'node cli.mjs export-secrets --out <file>   (passphrase from the terminal or JOBPILOT_SECRETS_PASSPHRASE)',
  'import-secrets': 'node cli.mjs import-secrets --from <file> [--dry-run] [--force]',
  restore: 'node cli.mjs restore <backup> [--dry-run]   (a name from node cli.mjs backups, or the path of any jobpilot export)',
};
const countsLine = counts => Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing';
const list = (items, max = 30) => items.slice(0, max).map(x => `  ${x}`).join('\n') + (items.length > max ? `\n  ... and ${items.length - max} more` : '');

/** Print an import plan; returns nothing. */
export function printPlan(r, { from, say = console.log } = {}) {
  const m = r.manifest, p = r.plan;
  const what = m.format === FORMAT_V1 ? 'jobpilot-export v1' : `jobpilot-export v${m.version}, jobpilot ${m.app_version || '?'}`;
  say(`${r.dryRun ? 'Dry run, nothing written. ' : ''}${from} (${what}, exported ${m.exported_at || '?'}${m.source_host ? ` on ${m.source_host}` : ''}${m.label ? `, label ${m.label}` : ''})`);
  say(`  ${p.add.length} new, ${p.same.length} identical, ${p.conflict.length} conflicting${p.skipped.length ? `, ${p.skipped.length} left out` : ''}`);
  if (p.add.length && r.dryRun) say(`New:\n${list(p.add)}`);
  const how = c => (c.action === 'keep' ? 'keep yours' : c.action === 'theirs' ? 'replace with the archived copy' : c.action === 'both' ? `keep yours; the archived copy goes to ${path.relative(process.cwd(), c.as) || c.as}` : 'needs --on-conflict keep, theirs or both');
  if (p.conflict.length) say(`Conflicts:\n${list(p.conflict.map(c => `${c.rel}: ${how(c)}`))}`);
  if (p.skipped.length) say(`Left out:\n${list(p.skipped.map(x => `${x.rel}: ${x.why}`), 30)}`);
  if (r.saved) say(`The replaced files were saved first to ${r.saved}`);
}

export function archiveCommands({ rest, locked }) {
  const opt = name => { const i = rest.indexOf(name); return i < 0 ? undefined : rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : null; };
  const has = name => rest.includes(name);
  const usage = cmd => { console.log(`Usage: ${USAGE[cmd]}`); return 1; };
  const stopped = (what, e) => { console.log(`${what} stopped: ${e.message}`); return 1; };
  return {
    export: locked(async () => {
      if (opt('--csv') === null || opt('--out') === null) return usage('export');
      try {
        if (opt('--csv')) { const r = writeApplicationsCsv(opt('--csv')); console.log(`Wrote ${r.rows} application(s) to ${r.out}`); return 0; }
        const r = await exportArchive({ out: opt('--out') || defaultExportName(), dataOnly: has('--data-only') });
        console.log(`Exported ${r.files} file(s) to ${r.out}${r.bytes != null ? ` (${fmtBytes(r.bytes)})` : ''}: ${countsLine(r.counts)}.`);
        console.log('Not included: .env and saved login sessions (node cli.mjs export-secrets), backups/.');
        return 0;
      } catch (e) { return stopped('Export', e); }
    }),
    import: locked(async () => {
      const from = opt('--from'); if (!from) return usage('import');
      const onConflict = opt('--on-conflict') || (has('--force') ? 'theirs' : null);
      if (opt('--on-conflict') === null) return usage('import');
      try {
        const r = await importArchive({ from, dryRun: has('--dry-run'), onConflict, dataOnly: has('--data-only') });
        printPlan(r, { from });
        if (r.dryRun && r.needsChoice.length) console.log('Profile or settings files differ: add --on-conflict keep, theirs or both (or --data-only) to import.');
        if (!r.dryRun) console.log(`Imported ${r.plan.add.length + r.plan.conflict.filter(c => c.action !== 'keep').length} file(s).`);
        return 0;
      } catch (e) {
        if (e.result) printPlan(e.result, { from });
        return stopped('Import', e);
      }
    }),
    'export-secrets': async () => {
      const out = opt('--out') ?? `jobpilot-secrets-${today()}.enc`; if (!out) return usage('export-secrets');
      try {
        const r = exportSecrets({ out, passphrase: await readPassphrase({ confirm: true }) });
        console.log(`Encrypted ${r.files.join(', ')} to ${r.out}. Keep the passphrase somewhere safe: without it the file cannot be read.`);
        return 0;
      } catch (e) { return stopped('Secrets export', e); }
    },
    'import-secrets': locked(async () => {
      const from = opt('--from'); if (!from) return usage('import-secrets');
      try {
        const r = importSecrets({ from, passphrase: await readPassphrase(), force: has('--force'), dryRun: has('--dry-run') });
        const parts = [['new', r.add], ['identical', r.same], ['different', r.conflict], ['not known here', r.skipped]].filter(([, l]) => l.length).map(([k, l]) => `${k}: ${l.join(', ')}`);
        console.log(`${r.dryRun ? 'Dry run, nothing written. ' : 'Imported secrets. '}${parts.join('; ') || 'nothing in the file'}${r.replaced.length ? `. Old files kept as ${r.replaced.join(', ')}` : ''}`);
        return 0;
      } catch (e) { return stopped('Secrets import', e); }
    }),
    backup: locked(async () => {
      if (opt('--label') === null) { console.log('Usage: node cli.mjs backup [--label <text>]'); return 1; }
      try {
        const r = await backup({ label: opt('--label') });
        console.log(`Backup: ${r.file} (${fmtBytes(r.bytes)}, ${r.files} files)${r.pruned.length ? `; removed ${r.pruned.length} old backup(s)` : ''}${r.copied === 'failed' ? '; the offsite copy failed (see above)' : r.copied === 'copied' ? '; copied offsite' : ''}`);
        return 0;
      } catch (e) { return stopped('Backup', e); }
    }),
    backups: () => {
      const all = listBackups();
      if (!all.length) { console.log('No backups yet. node cli.mjs backup makes one; the evening run makes one every night.'); return 0; }
      for (const b of all) console.log(`${b.date} ${b.time.replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3')}  v${b.version.padEnd(8)} ${fmtBytes(b.bytes).padStart(9)}  ${(b.label || '').padEnd(22)} ${b.name}`);
      return 0;
    },
    restore: locked(async () => {
      const ref = rest.find(a => !a.startsWith('--')); if (!ref) return usage('restore');
      try {
        const r = await restore({ ref, dryRun: has('--dry-run') });
        printPlan(r.result, { from: path.basename(r.from) });
        console.log(`${r.notInBackup} file(s) here are not in the backup; they stay as they are.`);
        if (r.pre) console.log(`Restored. The state before the restore is in ${r.pre.file}`);
        return 0;
      } catch (e) { return stopped('Restore', e); }
    }),
  };
}
