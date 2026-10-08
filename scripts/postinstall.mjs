// Prints a one-line nudge after install. Never fails the install.
try {
  if (process.env.CI) process.exit(0);
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = process.env.INIT_CWD || process.cwd();
  if (existsSync(join(dir, '.claude', 'helpers', 'symgraph-statusline.cjs'))) process.exit(0);
  console.log('\n  Symgraph installed. Run `npx symgraph init` to enable the Claude Code integration (statusline + hooks + auto-sync).\n');
} catch {
  /* never fail an install */
}
