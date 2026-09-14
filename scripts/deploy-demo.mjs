#!/usr/bin/env node
/** Explicit manual static-demo delivery; no backend, bindings, or secrets. */
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--dry-run'))throw new Error('Usage: npm run deploy:demo -- [--dry-run]');
execFileSync(process.execPath,['scripts/build-demo.mjs'],{cwd,stdio:'inherit'});
execFileSync('wrangler',['deploy','--config','wrangler.demo.jsonc',...args],{cwd,stdio:'inherit'});
